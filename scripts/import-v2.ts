#!/usr/bin/env bun
// Import v2's messages into v3, idempotently (key "v2:<v2 message id>"; a re-run stores 0 new).
//
// Reads v2 one request at a time: GET /api/tree (what v2 holds per month and provider), GET
// /api/groups (group labels), then GET /api/messages?month=&provider=&limit=500 pages, each posted
// to v3's POST /api/relay/import. Ends with a table: v2 rows vs rows read vs rows v3 holds.
//
// Env (secrets from env only, never argv):
//   V2_URL      v2's base URL (required; e.g. in the gitignored .env)
//   V2_TOKEN    v2 bearer token        (just import-v2 reads it from pass)
//   PB_URL      default http://127.0.0.1:8789
//   PB_EMAIL / PB_PASSWORD   a v3 superuser
// Flags: --page=N (rows per v2 request, default 500)  --by-day (one day per query)  --month=yyyy-mm  --provider=<p>  (only those leaves)  --full (re-read leaves v3 already holds in full)
const V2 = (process.env.V2_URL || (console.error("V2_URL is not set (put it in .env)"), process.exit(2))).replace(/\/$/, "");
const PB = (process.env.PB_URL || "http://127.0.0.1:8789").replace(/\/$/, "");
const need = (k: string) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
const V2_TOKEN = need("V2_TOKEN");
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const onlyMonth = arg("month");
const onlyProvider = arg("provider");
const PAGE = Number(arg("page") ?? 500);
const BY_DAY = process.argv.includes("--by-day");

async function v2<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(V2 + path, { headers: { authorization: `Bearer ${V2_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  v2 ${path}: ${(e as Error).name}, retry ${attempt}/3`);
      await Bun.sleep(5000 * attempt);
      continue;
    }
    if (r.ok) return (await r.json()) as T;
    if (attempt >= 4 || (r.status < 500 && r.status !== 429)) throw new Error(`v2 ${path}: ${r.status} ${await r.text()}`);
    await Bun.sleep(1000 * attempt);
  }
}

async function pbToken(): Promise<string> {
  const r = await fetch(PB + "/api/collections/_superusers/auth-with-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: need("PB_EMAIL"), password: need("PB_PASSWORD") }),
  });
  if (!r.ok) throw new Error(`v3 sign-in: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

interface Tree { month: string; providers: { provider: string; rows: number }[] }
interface Group { provider: string; group_id: string; label?: string | null }
interface Page { messages: Record<string, unknown>[]; next_before: string | null; degraded?: boolean; lake_error?: string }
interface Counts { new: number; duplicate: number; invalid: number }

const token = await pbToken();
const tree = await v2<Tree[]>("/api/tree");
const labels: Record<string, string> = {};
for (const g of await v2<Group[]>("/api/groups")) if (g.label) labels[`${g.provider}\t${g.group_id}`] = g.label;

const leaves = tree
  .flatMap((m) => m.providers.map((p) => ({ month: m.month, provider: p.provider, rows: p.rows })))
  .filter((l) => (!onlyMonth || l.month === onlyMonth) && (!onlyProvider || l.provider === onlyProvider));

const total = { v2: 0, read: 0, new: 0, duplicate: 0, invalid: 0 };
const perProvider: Record<string, { v2: number; read: number }> = {};
const problems: string[] = [];
console.log(`importing ${leaves.length} month/provider leaves (${leaves.reduce((s, l) => s + l.rows, 0)} rows in v2's tree)`);

/** Rows v3 already holds from one v2 leaf: its Bangkok month, its provider, endpoint v2-import. */
async function heldInV3(month: string, provider: string): Promise<number> {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const utc = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1) - 7 * 3600_000).toISOString().replace("T", " ");
  const from = utc(y, m), to = m === 12 ? utc(y + 1, 1) : utc(y, m + 1);
  const filter = `endpoint = "v2-import" && provider = "${provider}" && ts >= "${from}" && ts < "${to}"`;
  const r = await fetch(`${PB}/api/collections/messages/records?perPage=1&fields=id&filter=${encodeURIComponent(filter)}`, {
    headers: { authorization: token },
  });
  if (!r.ok) throw new Error(`v3 count: ${r.status}`);
  return ((await r.json()) as { totalItems: number }).totalItems;
}

let skipped = 0;
for (const leaf of leaves) {
  // resume: a leaf v3 already holds in full is not read from v2 again (--full reads every leaf)
  if (!process.argv.includes("--full")) {
    const held = await heldInV3(leaf.month, leaf.provider);
    if (held >= leaf.rows) {
      (perProvider[leaf.provider] ??= { v2: 0, read: 0 }).v2 += leaf.rows;
      perProvider[leaf.provider]!.read += held;
      total.v2 += leaf.rows;
      total.read += held;
      total.duplicate += held;
      skipped++;
      console.log(`${leaf.month} ${leaf.provider.padEnd(10)} held ${String(held).padStart(7)}  (already in v3, skipped)`);
      continue;
    }
  }
  let read = 0;
  const c: Counts = { new: 0, duplicate: 0, invalid: 0 };
  // --by-day: one Bangkok day per v2 query, far lighter on v2's Lance reads for a big month
  const [yy, mm] = leaf.month.split("-").map(Number) as [number, number];
  const days = BY_DAY
    ? Array.from({ length: new Date(Date.UTC(yy, mm, 0)).getUTCDate() }, (_, i) => `${leaf.month}-${String(i + 1).padStart(2, "0")}`)
    : [""];
  for (const day of days) {
  let before: string | null = null;
  const readBefore = read;
  do {
    const qs = new URLSearchParams(day ? { day, provider: leaf.provider, limit: String(PAGE) } : { month: leaf.month, provider: leaf.provider, limit: String(PAGE) });
    if (before) qs.set("before", before);
    let page: Page = await v2<Page>(`/api/messages?${qs}`);
    // v2's Lance read can time out under load (a degraded answer): wait and ask again, gently
    for (let t = 1; page.degraded && t <= 5; t++) {
      console.log(`  ${leaf.month}/${leaf.provider}: v2 degraded (${page.lake_error}), retry ${t}/5 in ${5 * t}s`);
      await Bun.sleep(5000 * t);
      page = await v2<Page>(`/api/messages?${qs}`);
    }
    if (page.degraded) {
      problems.push(`${leaf.month}/${leaf.provider}: v2 answered degraded (${page.lake_error}); leaf stopped after ${read} rows`);
      break;
    }
    if (page.messages.length) {
      const r = await fetch(PB + "/api/relay/import", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify({ rows: page.messages, labels }),
      });
      if (!r.ok) throw new Error(`v3 import: ${r.status} ${await r.text()}`);
      const got = (await r.json()) as Partial<Counts>;
      c.new += got.new ?? 0;
      c.duplicate += got.duplicate ?? 0;
      c.invalid += got.invalid ?? 0;
    }
    read += page.messages.length;
    before = page.next_before;
  } while (before);
  if (day) console.log(`  ${day} ${leaf.provider}: ${read - readBefore} rows`);
  }
  const p = (perProvider[leaf.provider] ??= { v2: 0, read: 0 });
  p.v2 += leaf.rows;
  p.read += read;
  total.v2 += leaf.rows;
  total.read += read;
  total.new += c.new;
  total.duplicate += c.duplicate;
  total.invalid += c.invalid;
  const flag = read === leaf.rows ? "" : `  (v2 tree said ${leaf.rows})`;
  console.log(`${leaf.month} ${leaf.provider.padEnd(10)} read ${String(read).padStart(7)}  new ${String(c.new).padStart(7)}  dup ${String(c.duplicate).padStart(7)}  invalid ${c.invalid}${flag}`);
}

// what v3 holds now, per provider (imported rows only: endpoint v2-import)
const facets = (await (await fetch(PB + "/api/collections/timeline_groups/records?perPage=1000&fields=provider,n", { headers: { authorization: token } })).json()) as {
  items: { provider: string; n: number }[];
};
const v3All: Record<string, number> = {};
for (const g of facets.items) v3All[g.provider] = (v3All[g.provider] ?? 0) + g.n;

console.log("\nprovider     v2 tree     read   v3 holds");
for (const [prov, p] of Object.entries(perProvider)) {
  console.log(`${prov.padEnd(10)} ${String(p.v2).padStart(9)} ${String(p.read).padStart(8)} ${String(v3All[prov] ?? 0).padStart(10)}`);
}
console.log(`\nskipped ${skipped} leaves already held in full`);
console.log(`\ntotal: v2 ${total.v2}, read ${total.read}, new ${total.new}, duplicate ${total.duplicate}, invalid ${total.invalid}`);
if (problems.length) console.log("\nproblems:\n  " + problems.join("\n  "));
process.exit(problems.length || total.invalid ? 1 : 0);
