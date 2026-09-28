// The Chats view without React: the filter chips (a source row, then each source's channels), the
// list filter, and time in words, Asia/Bangkok. After v2's Explorer (ui/src/lib/conversations.ts)
// and v1's Chat. Tested by chats.test.ts.
import type { Chat } from "./pb.ts";

// ── sources ─────────────────────────────────────────────────────────────────
/** Sources known by name; any other provider shows as it is stored. */
const LABELS: Record<string, string> = {
  line: "LINE", github: "GitHub", messenger: "Messenger", generic: "Generic", discord: "Discord", telegram: "Telegram", slack: "Slack",
};
export const sourceLabel = (provider: string) => LABELS[provider] ?? provider;

/** A chat's channels ("hermes,hermes2" -> ["hermes", "hermes2"]). */
export const channelsOf = (c: Pick<Chat, "channels">): string[] => (c.channels ? c.channels.split(",").filter(Boolean) : []);

// ── filters ─────────────────────────────────────────────────────────────────
export interface Filters {
  /** a provider, "" = every source */
  source: string;
  /** a channel, "" = every channel */
  channel: string;
  /** words in the name, the id or a channel */
  q: string;
}
export const noFilters = (): Filters => ({ source: "", channel: "", q: "" });
export const isFiltered = (f: Filters) => !!(f.source || f.channel || f.q.trim());

export function filterChats(all: readonly Chat[], f: Filters): Chat[] {
  const q = f.q.trim().toLowerCase();
  return all.filter(
    (c) =>
      (!f.source || c.provider === f.source) &&
      (!f.channel || channelsOf(c).includes(f.channel)) &&
      (!q || [c.group_label, c.group_id, c.channels].some((s) => (s || "").toLowerCase().includes(q))),
  );
}

export interface Chip {
  value: string;
  /** chats */
  n: number;
}
const byCount = (a: Chip, b: Chip) => b.n - a.n || a.value.localeCompare(b.value, "en", { numeric: true });

/** The source row: one chip per provider, most chats first. */
export function sourceChips(all: readonly Chat[]): Chip[] {
  const n = new Map<string, number>();
  for (const c of all) n.set(c.provider, (n.get(c.provider) ?? 0) + 1);
  return [...n].map(([value, n]) => ({ value, n })).sort(byCount);
}

/**
 * A row of channel chips per source that offers a choice (two channels or more) — only the picked
 * source's row once a source is picked. A picked channel keeps its chip, so it can be turned off.
 * Rows follow the source row's order.
 */
export function channelRows(all: readonly Chat[], source: string, channel: string): { source: string; chips: Chip[] }[] {
  const by = new Map<string, Map<string, number>>();
  for (const c of all) {
    if (source && c.provider !== source) continue;
    const m = by.get(c.provider) ?? new Map<string, number>();
    by.set(c.provider, m);
    for (const ch of channelsOf(c)) m.set(ch, (m.get(ch) ?? 0) + 1);
  }
  const order = sourceChips(all).map((s) => s.value);
  return [...by]
    .filter(([, m]) => m.size > 1 || (channel !== "" && m.has(channel)))
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([source, m]) => ({ source, chips: [...m].map(([value, n]) => ({ value, n })).sort(byCount) }));
}

// ── names ───────────────────────────────────────────────────────────────────
/** A chat's name, or "" when it has none but its id. */
export const chatName = (c: Pick<Chat, "group_label" | "group_id">) => (c.group_label && c.group_label !== c.group_id ? c.group_label : "");

/** "Cd2694…3f5d" for an opaque id too long to read (a LINE id); "owner/repo" or a name stays whole. */
export const shortId = (id: string) => (/^[A-Za-z0-9_-]{25,}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/** Body types in words, for a message with nothing else to show. */
export const TYPE_WORD: Readonly<Record<string, string>> = {
  image: "Photo", video: "Video", audio: "Voice message", file: "File", sticker: "Sticker", location: "Location", call: "Call",
};

/** Events that are nobody's words (LINE's vocabulary): a centred line, not a message. */
const EVENTS: Readonly<Record<string, string>> = {
  join: "The bot joined", leave: "The bot left", memberJoined: "A member joined", memberLeft: "A member left",
  follow: "Followed the bot", unfollow: "Blocked the bot", unsend: "unsent a message",
};
/** An event row in words ("A member joined", "Nat unsent a message"); null for a message. */
export function eventText(type: string, who: string): string | null {
  const t = EVENTS[type];
  if (!t) return null;
  return type === "unsend" ? `${who || "Someone"} ${t}` : t;
}

/** A list preview: the view writes "[image]" for a message without text; say it in words. */
export function previewOf(text: string): { text: string; word: boolean } {
  const m = /^\[(\w+)\]$/.exec(text);
  if (!m) return { text, word: false };
  return { text: TYPE_WORD[m[1]!] ?? eventText(m[1]!, "") ?? m[1]!, word: true };
}

// ── time, Asia/Bangkok ──────────────────────────────────────────────────────
const BKK = "Asia/Bangkok";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** PocketBase's "2026-09-28 09:15:00.000Z" (or a Date / ms) as a Date. */
const toDate = (ts: string | number | Date) => (typeof ts === "string" ? new Date(ts.replace(" ", "T")) : new Date(ts));

/** "2026-09-28": the day in Bangkok. */
export const dayKey = (ts: string | number | Date) => toDate(ts).toLocaleDateString("en-CA", { timeZone: BKK });

/** "14:02" in Bangkok. */
export const timeOf = (ts: string) => toDate(ts).toLocaleTimeString("en-GB", { timeZone: BKK, hour: "2-digit", minute: "2-digit" });

const daysBetween = (later: string, earlier: string) => Math.round((Date.parse(later) - Date.parse(earlier)) / 86_400_000);
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/** A day separator: "28 Sep 2026 (Mon) — today", "— yesterday", "— 6d ago" (v1, v2). */
export function dayLabel(ts: string, now: number = Date.now()): string {
  const day = dayKey(ts);
  const [y, m, d] = parts(day);
  const diff = daysBetween(dayKey(now), day);
  const when = diff <= 0 ? "today" : diff === 1 ? "yesterday" : `${diff}d ago`;
  return `${d} ${MONTHS[m - 1]} ${y} (${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}) — ${when}`;
}

/** Last activity in the list: "14:02" today, else "yesterday", else "3 Sep (22d)" (v2). */
export function lastSeen(ts: string, now: number = Date.now()): string {
  if (!ts) return "—";
  const day = dayKey(ts);
  const diff = daysBetween(dayKey(now), day);
  if (diff <= 0) return timeOf(ts);
  if (diff === 1) return "yesterday";
  const [, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1]} (${diff}d)`;
}

/** The months a chat was active: "Sep 2026", "Feb–Sep 2026", "Oct 2025–Sep 2026" (v2). */
export function spanOf(first: string, last: string): string {
  if (!first && !last) return "";
  const [ay, am] = parts(dayKey(first || last));
  const [by, bm] = parts(dayKey(last || first));
  if (ay === by && am === bm) return `${MONTHS[bm - 1]} ${by}`;
  return ay === by ? `${MONTHS[am - 1]}–${MONTHS[bm - 1]} ${by}` : `${MONTHS[am - 1]} ${ay}–${MONTHS[bm - 1]} ${by}`;
}

/** "1 chat", "497 chats", "262,462 messages". */
export const counted = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
