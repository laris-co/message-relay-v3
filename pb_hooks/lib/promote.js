// Fields copied out of `raw` into real (indexed / cheap) columns on create. Add a line here and a
// migration (column + backfill) to promote another one.
const PROMOTE = [
  // [column, path in raw, only when it is an https URL]
  ["sender_picture", ["sender_picture"], true],
];

function promote(record) {
  let raw;
  try {
    raw = JSON.parse(record.getString("raw") || "null"); // a json field reads back as its JSON text
  } catch (_) {
    return;
  }
  if (!raw || typeof raw !== "object") return;
  for (const [col, path, httpsOnly] of PROMOTE) {
    if (record.getString(col)) continue;
    let v = raw;
    for (const k of path) v = v && typeof v === "object" ? v[k] : undefined;
    if (typeof v !== "string" || !v) continue;
    if (httpsOnly && v.indexOf("https://") !== 0) continue;
    record.set(col, v);
  }
}

module.exports = { promote };
