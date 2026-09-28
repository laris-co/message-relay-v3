// The timeline filter: v2's pivot filter (only / hide per provider, channel and group) plus a text
// search. Pure, so the same rules build the PocketBase filter (server side) and match a realtime
// record (client side). Tested by filter.test.ts.

export type Dim = "provider" | "channel" | "group_id";
export type Mode = "only" | "hide";
export const DIMS: Dim[] = ["provider", "channel", "group_id"];

export interface Filter {
  only: Record<Dim, string[]>;
  hide: Record<Dim, string[]>;
  q: string;
}

export interface MessageRecord {
  id: string;
  ts: string;
  provider: string;
  endpoint: string;
  channel: string;
  group_id: string;
  group_label: string;
  sender: string;
  sender_label: string;
  type: string;
  text: string;
  reply_to: string;
  source_event_id: string;
  sender_picture?: string;
  media_kind?: string;
  thumb_url?: string;
  media_url?: string;
  collectionId?: string;
  expand?: { attachments_via_message?: Attachment[] };
}

/** A row of `attachments`: a message's picture / file at its source, and our copy (thumb, file). */
export interface Attachment {
  id: string;
  collectionId: string;
  collectionName: string;
  kind: string;
  source_url: string;
  thumb_url: string;
  thumb: string;
  file: string;
  status: "pending" | "stored" | "gone" | "failed";
}

const none = (): Record<Dim, string[]> => ({ provider: [], channel: [], group_id: [] });
export const emptyFilter = (): Filter => ({ only: none(), hide: none(), q: "" });

export function stateOf(f: Filter, dim: Dim, value: string): Mode | null {
  if (f.only[dim].includes(value)) return "only";
  if (f.hide[dim].includes(value)) return "hide";
  return null;
}

/** Set value to mode on dim; the same mode again clears it. A value is never both only and hidden. */
export function toggle(f: Filter, dim: Dim, value: string, mode: Mode): Filter {
  const was = stateOf(f, dim, value);
  const only = { ...f.only, [dim]: f.only[dim].filter((v) => v !== value) };
  const hide = { ...f.hide, [dim]: f.hide[dim].filter((v) => v !== value) };
  if (was !== mode) (mode === "only" ? only : hide)[dim] = [...(mode === "only" ? only : hide)[dim], value];
  return { ...f, only, hide };
}

export function isEmpty(f: Filter): boolean {
  return f.q.trim() === "" && DIMS.every((d) => f.only[d].length === 0 && f.hide[d].length === 0);
}

/** A PocketBase filter expression with {:pN} placeholders, and its params (for pb.filter). */
export function buildFilter(f: Filter): { expr: string; params: Record<string, string> } {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  let n = 0;
  const p = (v: string) => {
    const k = `p${n++}`;
    params[k] = v;
    return `{:${k}}`;
  };
  for (const d of DIMS) {
    if (f.only[d].length) parts.push("(" + f.only[d].map((v) => `${d} = ${p(v)}`).join(" || ") + ")");
    for (const v of f.hide[d]) parts.push(`${d} != ${p(v)}`);
  }
  const q = f.q.trim();
  if (q) {
    const k = p(q);
    parts.push(`(text ~ ${k} || sender_label ~ ${k} || sender ~ ${k} || group_label ~ ${k})`);
  }
  return { expr: parts.join(" && "), params };
}

/** Does a record (a realtime create) pass the filter? Mirrors buildFilter; `~` is a case-insensitive substring. */
export function matches(f: Filter, r: MessageRecord): boolean {
  for (const d of DIMS) {
    if (f.only[d].length && !f.only[d].includes(r[d])) return false;
    if (f.hide[d].includes(r[d])) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (q) return [r.text, r.sender_label, r.sender, r.group_label].some((s) => (s || "").toLowerCase().includes(q));
  return true;
}

/** Keyset "older than this row" (sort -ts,-id), for infinite scroll. */
export function olderThan(last: { ts: string; id: string }): { expr: string; params: Record<string, string> } {
  return { expr: "(ts < {:cts} || (ts = {:cts} && id < {:cid}))", params: { cts: last.ts, cid: last.id } };
}

/**
 * A realtime row into the loaded timeline (newest first) at its time position. A row older than
 * the last loaded one is left for scrolling to reach, unless the whole timeline is loaded: a bulk
 * import creates old rows, and they must not jump to the top.
 */
export function insertByTime<T extends { id: string; ts: string }>(rows: T[], r: T, allLoaded: boolean): T[] {
  if (rows.some((x) => x.id === r.id)) return rows;
  const i = rows.findIndex((x) => x.ts < r.ts || (x.ts === r.ts && x.id < r.id));
  if (i === -1) return allLoaded ? [...rows, r] : rows;
  return [...rows.slice(0, i), r, ...rows.slice(i)];
}
