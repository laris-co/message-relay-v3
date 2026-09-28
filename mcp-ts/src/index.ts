#!/usr/bin/env bun
// message-relay-v3 MCP server (stdio), read-only: agents read the timeline, never write to it.
// Env: PB_URL (default http://127.0.0.1:8789), and PB_EMAIL + PB_PASSWORD of a users or superuser
// account (a users account is enough: the collection's read rule is "signed in").
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import PocketBase from "pocketbase";
import { z } from "zod";
import { filterOf, render, type Row } from "./query.ts";

const pb = new PocketBase(process.env.PB_URL || "http://127.0.0.1:8789");
pb.autoCancellation(false);

async function signIn() {
  if (pb.authStore.isValid) return;
  const email = process.env.PB_EMAIL, password = process.env.PB_PASSWORD;
  if (!email || !password) throw new Error("PB_EMAIL and PB_PASSWORD must be set");
  try {
    await pb.collection("users").authWithPassword(email, password);
  } catch {
    await pb.collection("_superusers").authWithPassword(email, password);
  }
}

const FIELDS = "id,ts,provider,channel,group_id,group_label,sender,sender_label,type,text";
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "message-relay-v3", version: "0.1.0" });

const common = {
  provider: z.string().optional().describe("line · github · generic · or an imported provider"),
  channel: z.string().optional().describe("bot / endpoint name, repo owner, or the imported source"),
  group: z.string().optional().describe("group id or its label"),
  since: z.string().optional().describe("ISO-8601: only messages at or after this"),
  before: z.string().optional().describe("ISO-8601: only messages before this"),
  limit: z.number().int().min(1).max(500).optional().describe("default 50"),
};

server.registerTool(
  "messages_recent",
  {
    description: "Newest messages of the relay timeline (returned oldest first), optionally narrowed by provider, channel, group or time.",
    inputSchema: common,
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    await signIn();
    const f = filterOf(a);
    const res = await pb.collection("messages").getList<Row>(1, a.limit ?? 50, {
      sort: "-ts,-id", fields: FIELDS, skipTotal: true, filter: f.expr ? pb.filter(f.expr, f.params) : "",
    });
    return text(render(res.items));
  },
);

server.registerTool(
  "messages_search",
  {
    description: "Messages whose text, sender or group label contains q (case-insensitive substring), newest first.",
    inputSchema: { q: z.string().min(1), ...common },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    await signIn();
    const f = filterOf(a);
    const res = await pb.collection("messages").getList<Row>(1, a.limit ?? 50, {
      sort: "-ts,-id", fields: FIELDS, skipTotal: true, filter: pb.filter(f.expr, f.params),
    });
    return text(render(res.items));
  },
);

server.registerTool(
  "timeline_groups",
  {
    description: "Every provider / channel / group with its message count and last activity, most recent first.",
    inputSchema: { provider: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    await signIn();
    const rows = await pb.collection("timeline_groups").getList<{ provider: string; channel: string; group_id: string; group_label: string; n: number; last_ts: string }>(
      1, a.limit ?? 200, { sort: "-last_ts", filter: a.provider ? pb.filter("provider = {:p}", { p: a.provider }) : "" },
    ).then((r) => r.items);
    return text(rows.map((g) => `${String(g.last_ts).slice(0, 16)}  ${g.provider}/${g.channel}/${g.group_label || g.group_id}  (${g.n})`).join("\n") || "(none)");
  },
);

await server.connect(new StdioServerTransport());
