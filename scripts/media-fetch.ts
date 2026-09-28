#!/usr/bin/env bun
// Bulk copy of messages' pictures, with the pocketbase SDK. Attachment rows come from the migration
// (existing messages) and the create hook in pb_hooks/main.pb.js (new ones); a cron hook there also
// fetches the newest few each minute. This script works through the backlog in parallel:
//   for each pending attachment, download its thumbnail, and the file itself for images
//      (not videos or other files), and upload them to the attachment (the configured storage: S3 /
//      RustFS when RELAY_S3_* is set). Status: stored · gone (the source answers 404/410: never
//      retried) · failed (anything else, with the reason: retried by --retry-failed).
//
// Env: PB_URL (default http://127.0.0.1:8789), PB_EMAIL / PB_PASSWORD (a superuser).
// Flags: --limit=N (attachments this run)  --concurrency=N (default 8)  --retry-failed
import PocketBase, { ClientResponseError } from "pocketbase";

const pb = new PocketBase((process.env.PB_URL || "http://127.0.0.1:8789").replace(/\/$/, ""));
pb.autoCancellation(false);
const need = (k: string) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const has = (f: string) => process.argv.includes(`--${f}`);
const LIMIT = Number(arg("limit") ?? Infinity);
const CONC = Number(arg("concurrency") ?? 8);
const MAX = { thumb: 10 << 20, file: 50 << 20 };
const IMAGE = /^image\/(jpeg|png|webp|gif)$/;

await pb.collection("_superusers").authWithPassword(need("PB_EMAIL"), need("PB_PASSWORD"));

interface Att { id: string; kind: string; source_url: string; thumb_url: string; thumb: string; file: string }

/** PocketBase restarts itself when a pb_hooks file changes: ride out a short outage. */
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let t = 1; ; t++) {
    try {
      return await f();
    } catch (e) {
      const down = e instanceof ClientResponseError && e.status === 0;
      if (!down || t >= 30) throw e;
      await Bun.sleep(2000);
    }
  }
}

const update = (id: string, data: Record<string, unknown>) => retry(() => pb.collection("attachments").update(id, data));

// ── fetch ─────────────────────────────────────────────────────────────────
class Gone extends Error {}

async function download(url: string, max: number, imageOnly: boolean): Promise<File> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (r.status === 404 || r.status === 410) throw new Gone(`${r.status}`);
  if (!r.ok) throw new Error(`${r.status}`);
  const type = (r.headers.get("content-type") || "").split(";")[0]!.trim();
  if (imageOnly && !IMAGE.test(type)) throw new Error(`not an image: ${type || "no type"}`);
  const b = await r.blob();
  if (b.size > max) throw new Error(`too big: ${b.size} B`);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "file").slice(-100);
  return new File([b], name, { type: type || "application/octet-stream" });
}

const stats = { attachments: 0, stored: 0, gone: 0, failed: 0, bytes: 0 };

async function one(a: Att) {
  const wants: [field: "thumb" | "file", url: string, max: number, img: boolean][] = [];
  if (!a.thumb && a.thumb_url.startsWith("https://")) wants.push(["thumb", a.thumb_url, MAX.thumb, true]);
  if (!a.file && a.kind === "image" && a.source_url.startsWith("https://")) wants.push(["file", a.source_url, MAX.file, false]);
  const data: Record<string, unknown> = {};
  const errors: string[] = [];
  let gone = 0, failed = 0;
  for (const [field, url, max, img] of wants) {
    try {
      const f = await download(url, max, img);
      data[field] = f;
      stats.bytes += f.size;
    } catch (e) {
      errors.push(`${field}: ${(e as Error).message}`);
      if (e instanceof Gone) gone++;
      else failed++;
    }
  }
  const got = Object.keys(data).length > 0 || Boolean(a.thumb || a.file);
  data.status = failed ? "failed" : got ? "stored" : "gone"; // gone: every source 404/410, or none at all
  if (wants.length === 0 && !got) errors.push("no https source");
  data.error = errors.join("; ").slice(0, 500);
  try {
    await update(a.id, data);
  } catch (e) {
    // one rejected record must not stop the run: retry once (a concurrent write, e.g. the cron hook
    // taking the same row), then record why and move on (--retry-failed picks it up again)
    await Bun.sleep(1500);
    try {
      await update(a.id, data);
    } catch (e2) {
      const why = e2 instanceof ClientResponseError ? `${e2.status} ${JSON.stringify(e2.response?.data ?? {})}` : String(e2);
      console.log(`  update rejected ${a.id}: ${why.slice(0, 300)}`);
      await update(a.id, { status: "failed", error: ("upload rejected: " + why).slice(0, 500) }).catch(() => {});
      stats.failed++;
      return;
    }
  }
  stats[data.status as "stored" | "gone" | "failed"]++;
  if (failed && stats.failed <= 20) console.log(`  failed ${a.id}: ${data.error}`);
}

async function fetchAll() {
  const statuses = has("retry-failed") ? '(status = "pending" || status = "failed")' : 'status = "pending"';
  let last = "";
  const started = Date.now();
  while (stats.attachments < LIMIT) {
    const res = await retry(() => pb.collection("attachments").getList<Att>(1, 200, {
      filter: pb.filter(`${statuses} && id > {:last}`, { last }),
      sort: "id",
      fields: "id,kind,source_url,thumb_url,thumb,file",
      skipTotal: true,
    }));
    const items = res.items.slice(0, LIMIT - stats.attachments);
    if (!items.length) break;
    for (let i = 0; i < items.length; i += CONC) await Promise.all(items.slice(i, i + CONC).map(one));
    stats.attachments += items.length;
    last = items[items.length - 1]!.id;
    const s = (Date.now() - started) / 1000;
    console.log(
      `${stats.attachments} attachments · ${stats.stored} stored · ${stats.gone} gone · ${stats.failed} failed · ` +
        `${(stats.bytes / 1e6).toFixed(1)} MB · ${(stats.attachments / s).toFixed(1)}/s`,
    );
  }
}

await fetchAll();
console.log(`\ndone: ${JSON.stringify(stats)}`);
