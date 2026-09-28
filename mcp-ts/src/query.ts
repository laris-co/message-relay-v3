// Pure parts of the MCP server: the PocketBase filter for a tool call and the text an agent reads.

export interface Row {
  id: string;
  ts: string;
  provider: string;
  channel: string;
  group_id: string;
  group_label: string;
  sender: string;
  sender_label: string;
  type: string;
  text: string;
}

export interface Args {
  provider?: string;
  channel?: string;
  group?: string;
  q?: string;
  since?: string;
  before?: string;
}

/** A filter expression with {:name} params (for pb.filter). Every value is a param. */
export function filterOf(a: Args): { expr: string; params: Record<string, string> } {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (a.provider) (parts.push("provider = {:provider}"), (params.provider = a.provider));
  if (a.channel) (parts.push("channel = {:channel}"), (params.channel = a.channel));
  if (a.group) (parts.push("(group_id = {:group} || group_label = {:group})"), (params.group = a.group));
  if (a.q) (parts.push("(text ~ {:q} || sender_label ~ {:q} || group_label ~ {:q})"), (params.q = a.q));
  if (a.since) (parts.push("ts >= {:since}"), (params.since = pbTime(a.since)));
  if (a.before) (parts.push("ts < {:before}"), (params.before = pbTime(a.before)));
  return { expr: parts.join(" && "), params };
}

/** ISO-8601 -> PocketBase's "yyyy-mm-dd hh:mm:ss.sssZ"; anything unparseable is passed as given. */
export function pbTime(s: string): string {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace("T", " ") : s;
}

/** One line per message, oldest first, Bangkok time: what an agent reads. */
export function render(rows: Row[]): string {
  if (rows.length === 0) return "(no messages)";
  return [...rows]
    .reverse()
    .map((r) => {
      const t = new Date(r.ts.replace(" ", "T")).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16);
      const where = `${r.provider}/${r.channel}/${r.group_label || r.group_id}`;
      const who = r.sender_label || r.sender || "?";
      const body = r.text ? r.text.replace(/\s+/g, " ") : `[${r.type}]`;
      return `${t} ${where} ${who}: ${body}`;
    })
    .join("\n");
}
