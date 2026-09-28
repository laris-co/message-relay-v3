// Unit tests for pb_hooks/lib/relay.js (the pure mapping + signature code the JS hooks run).
// Crypto is injected, so here it is node:crypto standing in for PocketBase's $security.
import { expect, test, describe } from "bun:test";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const relay = require("../pb_hooks/lib/relay.js");

const crypto = {
  hs256: (text: string, secret: string) => createHmac("sha256", secret).update(text).digest("hex"),
  sha256: (text: string) => createHash("sha256").update(text).digest("hex"),
  equal: (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)),
};
const NOW = new Date("2026-09-28T03:00:00Z");
const now = () => NOW;
const lineSig = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64");
const ghSig = (secret: string, body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

test("validEndpoint", () => {
  for (const [ep, want] of [["bot1", true], ["my-bot_2", true], ["", false], ["Bot", false], ["-x", false], ["a/b", false], ["a".repeat(65), false]] as const)
    expect(relay.validEndpoint(ep)).toBe(want);
});

test("secretFor: per endpoint, LINE has no fallback", () => {
  const env: Record<string, string> = { LINE_SECRET_MY_BOT: "l", GITHUB_SECRET: "g", GITHUB_SECRET_ORG: "go", GENERIC_TOKEN: "t" };
  const get = (k: string) => env[k] ?? "";
  expect(relay.secretFor("line", "my-bot", get)).toBe("l");
  expect(relay.secretFor("line", "other", get)).toBe("");
  expect(relay.secretFor("github", "org", get)).toBe("go");
  expect(relay.secretFor("github", "any", get)).toBe("g");
  expect(relay.secretFor("generic", "ops", get)).toBe("t");
});

test("hexToBase64 matches Buffer", () => {
  for (const hex of ["", "00", "ff00", "0102030405", createHash("sha256").update("x").digest("hex")])
    expect(relay.hexToBase64(hex)).toBe(Buffer.from(hex, "hex").toString("base64"));
  expect(relay.hexToBase64("zz")).toBe("");
});

describe("signatures fail closed", () => {
  const body = `{"events":[]}`;
  test("line", () => {
    expect(relay.verifyLine("s", body, lineSig("s", body), crypto)).toBe(true);
    for (const sig of ["", "nope", lineSig("other", body), lineSig("s", body + " ")])
      expect(relay.verifyLine("s", body, sig, crypto)).toBe(false);
    expect(relay.verifyLine("", body, lineSig("", body), crypto)).toBe(false);
  });
  test("github", () => {
    expect(relay.verifyGithub("s", body, ghSig("s", body), crypto)).toBe(true);
    expect(relay.verifyGithub("s", body, "sha256=" + ghSig("s", body).slice(7).toUpperCase(), crypto)).toBe(true);
    for (const sig of ["", "sha256=", "sha1=abc", ghSig("t", body)]) expect(relay.verifyGithub("s", body, sig, crypto)).toBe(false);
    expect(relay.verifyGithub("", body, ghSig("", body), crypto)).toBe(false);
  });
  test("generic", () => {
    expect(relay.verifyGeneric("tok", "Bearer tok", "", crypto)).toBe(true);
    expect(relay.verifyGeneric("tok", "", "tok", crypto)).toBe(true);
    expect(relay.verifyGeneric("tok", "bearer  tok ", "", crypto)).toBe(true);
    expect(relay.verifyGeneric("tok", "Bearer nope", "", crypto)).toBe(false);
    expect(relay.verifyGeneric("tok", "", "", crypto)).toBe(false);
    expect(relay.verifyGeneric("", "Bearer ", "", crypto)).toBe(false);
  });
});

const lineBody = {
  destination: "Ubot",
  events: [
    { type: "message", webhookEventId: "01ABC", timestamp: 1790000000000, source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
      message: { type: "text", id: "m1", text: "สวัสดี", quotedMessageId: "m0" } },
    { type: "message", timestamp: 1790000001000, source: { type: "user", userId: "Uuser" },
      message: { type: "location", id: "m2", title: "Office", address: "1 Main St" } },
    { type: "postback", webhookEventId: "01DEF", source: { type: "room", roomId: "Rroom" }, postback: { data: "a=1" } },
    { type: "unsend", webhookEventId: "01GHI", source: { type: "group", groupId: "Cgroup", userId: "Uuser" }, unsend: { messageId: "m1" } },
    "junk",
  ],
};

test("lineMessages", () => {
  const ms = relay.lineMessages(lineBody, "bot1", crypto, now);
  expect(ms.length).toBe(4);
  expect(ms[0]).toMatchObject({ provider: "line", channel: "bot1", group_id: "Cgroup", sender: "Uuser", type: "text",
    text: "สวัสดี", reply_to: "m0", source_event_id: "line:bot1:evt:01ABC", ts: new Date(1790000000000).toISOString() });
  expect(ms[1]).toMatchObject({ type: "location", text: "Office — 1 Main St", group_id: "Uuser" });
  expect(ms[1].source_event_id).toStartWith("line:bot1:sha256:");
  expect(ms[2]).toMatchObject({ type: "postback", text: "a=1", group_id: "Rroom", ts: NOW.toISOString() });
  expect(ms[3]).toMatchObject({ type: "unsend", reply_to: "m1" });
  // same body again (a redelivery): same keys
  const again = relay.lineMessages(lineBody, "bot1", crypto, () => new Date(NOW.getTime() + 3600e3));
  expect(again.map((m: { source_event_id: string }) => m.source_event_id)).toEqual(ms.map((m: { source_event_id: string }) => m.source_event_id));
  // scoped to the endpoint
  expect(relay.lineMessages(lineBody, "bot2", crypto, now)[0].source_event_id).not.toBe(ms[0].source_event_id);
});

test("githubMessage", () => {
  const p = { action: "created", issue: { number: 12, title: "v3" }, comment: { body: "looks good", in_reply_to_id: 77 },
    repository: { full_name: "laris-co/message-relay" }, sender: { login: "nazt" } };
  const m = relay.githubMessage(p, { "x-github-event": "issue_comment", "x-github-delivery": "d-1" }, "gh", JSON.stringify(p), crypto, now);
  expect(m).toMatchObject({ provider: "github", channel: "laris-co", group_id: "laris-co/message-relay", sender: "nazt",
    text: "looks good", reply_to: "77", source_event_id: "github:gh:delivery:d-1", type: "event" });
  const push = { ref: "refs/heads/main", commits: [{}, {}], repository: { full_name: "a/b" } };
  const pm = relay.githubMessage(push, { "x-github-event": "push" }, "gh", JSON.stringify(push), crypto, now);
  expect(pm.text).toBe("push refs/heads/main (2 commits)");
  expect(pm.source_event_id).toStartWith("github:gh:sha256:");
  expect(relay.githubMessage({ zen: "Keep it simple." }, { "x-github-event": "ping", "x-github-delivery": "d-2" }, "gh", "{}", crypto, now))
    .toMatchObject({ text: "Keep it simple.", group_id: "github:gh", channel: "gh" });
});

test("genericMessage", () => {
  const body = { text: "deploy ok", from: "ci", chat: "ops-room", name: "CI bot", ts: "2026-09-01T00:00:00Z", reply_to: 7 };
  const m = relay.genericMessage(body, {}, "ops", JSON.stringify(body), crypto, now);
  expect(m).toMatchObject({ provider: "generic", text: "deploy ok", sender: "ci", group_id: "ops-room", sender_label: "CI bot",
    reply_to: "7", type: "text", ts: "2026-09-01T00:00:00.000Z" });
  expect(m.source_event_id).toStartWith("generic:ops:sha256:");
  expect(relay.genericMessage("plain text", { "x-event-id": " e-9 " }, "ops", "plain text", crypto, now))
    .toMatchObject({ text: "plain text", type: "text", source_event_id: "generic:ops:evt:e-9", group_id: "ops", sender: "unknown" });
  expect(relay.genericMessage({ status: "up" }, {}, "ops", "{}", crypto, now)).toMatchObject({ type: "event", text: "" });
});

describe("v2Message", () => {
  const row = { id: "0199abc", ts: "2026-09-27T01:02:03.456Z", provider: "example", channel: "source-a", group_id: "Cxyz",
    sender: "Uab", sender_label: "Alice", type: "text", text: "สวัสดี", reply_to: "" };
  test("plain row", () => {
    expect(relay.v2Message(row, "Team room")).toMatchObject({ source_event_id: "v2:0199abc", provider: "example",
      channel: "source-a", group_label: "Team room", sender_label: "Alice", text: "สวัสดี", endpoint: "v2-import", media_kind: "" });
    expect(relay.v2Message({ id: "x", ts: "yesterday" }, "")).toBeNull();
    expect(relay.v2Message({ ts: "2026-09-27T01:02:03Z" }, "")).toBeNull();
  });
  test("media links: https only; archived uses the source's source_thumb_url", () => {
    const withMedia = (media: object) => relay.v2Message({ ...row, media }, "");
    expect(withMedia({ kind: "image", file_url: "https://c.org/u/1.jpg", thumb_url: "https://c.org/u/1_thumb.webp" }))
      .toMatchObject({ media_kind: "image", media_url: "https://c.org/u/1.jpg", thumb_url: "https://c.org/u/1_thumb.webp" });
    expect(withMedia({ kind: "image", archived: true, thumb_url: "https://relay-v2/media/x?sig=s", source_thumb_url: "https://c.org/u/2_thumb.webp" }).thumb_url)
      .toBe("https://c.org/u/2_thumb.webp");
    expect(withMedia({ kind: "video", thumb_url: "/media/x", file_url: "http://insecure/x.mp4" }))
      .toMatchObject({ media_kind: "video", thumb_url: "", media_url: "" });
  });
});

test("clipText keeps at most 100000 characters", () => {
  expect(relay.clipText("ก".repeat(100005)).length).toBe(100000);
});
