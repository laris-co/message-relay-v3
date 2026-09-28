import { describe, expect, test } from "bun:test";
import { buildFilter, emptyFilter, insertByTime, isEmpty, matches, olderThan, stateOf, toggle, type MessageRecord } from "./filter.ts";

const rec = (o: Partial<MessageRecord>): MessageRecord => ({
  id: "a", ts: "2026-09-28 00:00:00.000Z", provider: "line", endpoint: "bot", channel: "bot", group_id: "G1",
  group_label: "", sender: "U1", sender_label: "", type: "text", text: "", reply_to: "", source_event_id: "k", ...o,
});

describe("toggle", () => {
  test("only, again clears", () => {
    let f = toggle(emptyFilter(), "provider", "line", "only");
    expect(stateOf(f, "provider", "line")).toBe("only");
    f = toggle(f, "provider", "line", "only");
    expect(stateOf(f, "provider", "line")).toBeNull();
    expect(isEmpty(f)).toBe(true);
  });
  test("hide replaces only", () => {
    let f = toggle(emptyFilter(), "group_id", "G1", "only");
    f = toggle(f, "group_id", "G1", "hide");
    expect(f.only.group_id).toEqual([]);
    expect(f.hide.group_id).toEqual(["G1"]);
  });
});

describe("buildFilter", () => {
  test("empty", () => expect(buildFilter(emptyFilter())).toEqual({ expr: "", params: {} }));
  test("only is OR within a dimension, AND across; hide is AND", () => {
    let f = toggle(emptyFilter(), "provider", "line", "only");
    f = toggle(f, "provider", "github", "only");
    f = toggle(f, "group_id", "G9", "hide");
    const { expr, params } = buildFilter({ ...f, q: " น้ำ " });
    expect(expr).toBe(
      "(provider = {:p0} || provider = {:p1}) && group_id != {:p2} && (text ~ {:p3} || sender_label ~ {:p3} || sender ~ {:p3} || group_label ~ {:p3})",
    );
    expect(params).toEqual({ p0: "line", p1: "github", p2: "G9", p3: "น้ำ" });
  });
  test("values are params, never spliced into the expression", () => {
    const f = toggle(emptyFilter(), "channel", `x" || 1=1 || "`, "only");
    expect(buildFilter(f).expr).toBe("(channel = {:p0})");
  });
});

describe("matches", () => {
  test("mirrors buildFilter", () => {
    let f = toggle(emptyFilter(), "provider", "line", "only");
    f = toggle(f, "group_id", "G2", "hide");
    expect(matches(f, rec({}))).toBe(true);
    expect(matches(f, rec({ provider: "github" }))).toBe(false);
    expect(matches(f, rec({ group_id: "G2" }))).toBe(false);
    expect(matches({ ...f, q: "HELLO" }, rec({ text: "say hello" }))).toBe(true);
    expect(matches({ ...f, q: "สวัสดี" }, rec({ sender_label: "สวัสดีครับ" }))).toBe(true);
    expect(matches({ ...f, q: "zzz" }, rec({ text: "say hello" }))).toBe(false);
  });
});

test("olderThan", () => {
  expect(olderThan({ ts: "T", id: "I" })).toEqual({ expr: "(ts < {:cts} || (ts = {:cts} && id < {:cid}))", params: { cts: "T", cid: "I" } });
});

test("insertByTime", () => {
  const a = { id: "a", ts: "2026-09-28 03:00:00.000Z" }, b = { id: "b", ts: "2026-09-28 02:00:00.000Z" };
  expect(insertByTime([a, b], { id: "n", ts: "2026-09-28 04:00:00.000Z" }, false).map((x) => x.id)).toEqual(["n", "a", "b"]);
  expect(insertByTime([a, b], { id: "m", ts: "2026-09-28 02:30:00.000Z" }, false).map((x) => x.id)).toEqual(["a", "m", "b"]);
  expect(insertByTime([a, b], { id: "o", ts: "2020-01-01 00:00:00.000Z" }, false).map((x) => x.id)).toEqual(["a", "b"]);
  expect(insertByTime([a, b], { id: "o", ts: "2020-01-01 00:00:00.000Z" }, true).map((x) => x.id)).toEqual(["a", "b", "o"]);
  expect(insertByTime([a, b], a, false)).toEqual([a, b]);
});
