import { describe, expect, test } from "bun:test";
import { channelRows, counted, dayLabel, eventText, filterChats, lastSeen, previewOf, shortId, sourceChips, spanOf } from "./chats.ts";
import type { Chat } from "./pb.ts";

const chat = (o: Partial<Chat>): Chat => ({
  id: "x", provider: "line", group_id: "G", group_label: "", channels: "hermes", n: 1,
  first_ts: "2026-09-01 00:00:00.000Z", last_ts: "2026-09-28 02:00:00.000Z", last_sender: "", last_text: "", ...o,
});

const all = [
  chat({ group_id: "G1", group_label: "Maeon craft", channels: "hermes" }),
  chat({ group_id: "G2", channels: "hermes,hermes2" }),
  chat({ group_id: "G3", channels: "xiaoer" }),
  chat({ provider: "github", group_id: "o/r", channels: "o" }),
  chat({ provider: "messenger", group_id: "123", channels: "facebook-oracle" }),
  chat({ provider: "messenger", group_id: "456", channels: "neo-messenger" }),
  chat({ provider: "messenger", group_id: "789", channels: "facebook-oracle" }),
  chat({ provider: "messenger", group_id: "999", channels: "facebook-oracle" }),
];

describe("chips", () => {
  test("sources: most chats first", () => {
    expect(sourceChips(all)).toEqual([{ value: "messenger", n: 4 }, { value: "line", n: 3 }, { value: "github", n: 1 }]);
  });
  test("channel rows: only sources with a choice, in the source order; a moved chat counts on each channel", () => {
    expect(channelRows(all, "", "")).toEqual([
      { source: "messenger", chips: [{ value: "facebook-oracle", n: 3 }, { value: "neo-messenger", n: 1 }] },
      { source: "line", chips: [{ value: "hermes", n: 2 }, { value: "hermes2", n: 1 }, { value: "xiaoer", n: 1 }] },
    ]);
  });
  test("a picked source shows its row only; a picked single channel keeps its chip", () => {
    expect(channelRows(all, "line", "").map((r) => r.source)).toEqual(["line"]);
    expect(channelRows(all, "github", "o")).toEqual([{ source: "github", chips: [{ value: "o", n: 1 }] }]);
    expect(channelRows(all, "github", "")).toEqual([]);
  });
});

describe("filterChats", () => {
  test("source, channel and words in the name, id or channel", () => {
    const f = { source: "", channel: "", q: "" };
    expect(filterChats(all, { ...f, source: "line" }).map((c) => c.group_id)).toEqual(["G1", "G2", "G3"]);
    expect(filterChats(all, { ...f, channel: "hermes2" }).map((c) => c.group_id)).toEqual(["G2"]);
    expect(filterChats(all, { ...f, q: "maeon" }).map((c) => c.group_id)).toEqual(["G1"]);
    expect(filterChats(all, { ...f, q: "  NEO " }).map((c) => c.group_id)).toEqual(["456"]);
    expect(filterChats(all, { ...f, source: "github", q: "maeon" })).toEqual([]);
  });
});

describe("words", () => {
  test("previews and events", () => {
    expect(previewOf("[image]")).toEqual({ text: "Photo", word: true });
    expect(previewOf("[memberJoined]")).toEqual({ text: "A member joined", word: true });
    expect(previewOf("hello [image]")).toEqual({ text: "hello [image]", word: false });
    expect(eventText("unsend", "Nat")).toBe("Nat unsent a message");
    expect(eventText("text", "Nat")).toBeNull();
    expect(shortId("Cd269400000000000000000000003f5d")).toBe("Cd2694…3f5d");
    expect(shortId("123")).toBe("123");
    expect(shortId("dryoungdo-wellness-clinic/odoo-yd")).toBe("dryoungdo-wellness-clinic/odoo-yd");
    expect(shortId("Nat, Mage Pimnalin, Hermes Oracle")).toBe("Nat, Mage Pimnalin, Hermes Oracle");
    expect(counted(1, "chat")).toBe("1 chat");
    expect(counted(262462, "message")).toBe("262,462 messages");
  });
});

describe("time in Bangkok", () => {
  const now = Date.parse("2026-09-28T09:00:00Z"); // 16:00 in Bangkok, Mon 28 Sep
  test("day labels", () => {
    expect(dayLabel("2026-09-28 01:00:00.000Z", now)).toBe("28 Sep 2026 (Mon) — today");
    expect(dayLabel("2026-09-27 16:59:00.000Z", now)).toBe("27 Sep 2026 (Sun) — yesterday"); // 23:59 Bangkok
    expect(dayLabel("2026-09-22 08:49:00.000Z", now)).toBe("22 Sep 2026 (Tue) — 6d ago");
  });
  test("last seen", () => {
    expect(lastSeen("2026-09-28 08:29:00.000Z", now)).toBe("15:29");
    expect(lastSeen("2026-09-27 10:00:00.000Z", now)).toBe("yesterday");
    expect(lastSeen("2026-09-06 10:00:00.000Z", now)).toBe("6 Sep (22d)");
    expect(lastSeen("", now)).toBe("—");
  });
  test("spans", () => {
    expect(spanOf("2026-09-01 00:00:00Z", "2026-09-28 00:00:00Z")).toBe("Sep 2026");
    expect(spanOf("2026-02-10 00:00:00Z", "2026-09-28 00:00:00Z")).toBe("Feb–Sep 2026");
    expect(spanOf("2025-10-10 00:00:00Z", "2026-09-28 00:00:00Z")).toBe("Oct 2025–Sep 2026");
    expect(spanOf("2026-08-31 18:00:00Z", "2026-09-02 00:00:00Z")).toBe("Sep 2026"); // 01:00 on 1 Sep in Bangkok
  });
});
