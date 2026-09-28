import { expect, test } from "bun:test";
import { filterOf, pbTime, render, type Row } from "./query.ts";

test("filterOf: values are params", () => {
  expect(filterOf({})).toEqual({ expr: "", params: {} });
  const f = filterOf({ provider: "line", group: "Team room", q: `"; drop`, since: "2026-09-01T00:00:00+07:00" });
  expect(f.expr).toBe(
    "provider = {:provider} && (group_id = {:group} || group_label = {:group}) && (text ~ {:q} || sender_label ~ {:q} || group_label ~ {:q}) && ts >= {:since}",
  );
  expect(f.params).toEqual({ provider: "line", group: "Team room", q: `"; drop`, since: "2026-08-31 17:00:00.000Z" });
});

test("pbTime passes junk through", () => expect(pbTime("soon")).toBe("soon"));

test("render: oldest first, Bangkok time, label over id", () => {
  const r = (o: Partial<Row>): Row => ({
    id: "1", ts: "2026-09-28 01:00:00.000Z", provider: "line", channel: "bot", group_id: "G", group_label: "",
    sender: "U", sender_label: "", type: "text", text: "", ...o,
  });
  expect(render([])).toBe("(no messages)");
  expect(
    render([
      r({ id: "2", ts: "2026-09-28 02:00:00.000Z", text: "second\nline", sender_label: "Nat", group_label: "Ops" }),
      r({ id: "1", type: "sticker" }),
    ]),
  ).toBe("2026-09-28 08:00 line/bot/G U: [sticker]\n2026-09-28 09:00 line/bot/Ops Nat: second line");
});
