// Saving messages (their attachment rows come from the create hook in main.pb.js). Runs only inside PocketBase (uses Record and the
// app's own DAO) — imported by main.pb.js, never loaded directly by a test runner.

const MESSAGE_FIELDS = [
  "ts", "provider", "endpoint", "channel", "group_id", "group_label", "sender", "sender_label",
  "type", "text", "reply_to", "source_event_id", "raw", "media_kind", "thumb_url", "media_url",
];

/** Save one message unless its source_event_id is stored already. -> "new" | "duplicate" */
function storeMessage(app, messages, m) {
  try {
    app.findFirstRecordByData(messages, "source_event_id", m.source_event_id);
    return "duplicate";
  } catch (_) {
    // not found: store it
  }
  const r = new Record(messages);
  for (const f of MESSAGE_FIELDS) r.set(f, m[f] === undefined ? "" : m[f]);
  try {
    app.save(r);
  } catch (err) {
    // two deliveries of one event racing: the UNIQUE index keeps one
    if (String(err).indexOf("source_event_id") >= 0 || String(err).toLowerCase().indexOf("unique") >= 0) return "duplicate";
    throw err;
  }
  return "new";
}

/** Save many in one transaction. -> {new, duplicate} */
function storeAll(app, ms) {
  const counts = { new: 0, duplicate: 0 };
  if (ms.length === 0) return counts;
  app.runInTransaction((tx) => {
    const messages = tx.findCollectionByNameOrId("messages");
    for (const m of ms) counts[storeMessage(tx, messages, m)]++;
  });
  return counts;
}

module.exports = { storeAll };
