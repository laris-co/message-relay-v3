/// <reference path="../pb_data/types.d.ts" />
// Promote what the UI queries often out of `raw` (JSON path filters scan every row: ~0.5 s at 230k):
//   sender_picture  a column (backfilled here; the create hook in pb_hooks fills new rows from raw)
//   sender_label    an index (search by sender)
//   timeline_groups a view collection: provider / channel / group counts for the filter panel
migrate(
  (app) => {
    const m = app.findCollectionByNameOrId("messages");
    m.fields.add(new TextField({ name: "sender_picture", max: 2048 }));
    m.indexes.push("CREATE INDEX idx_messages_sender_label ON messages (sender_label)");
    app.save(m);
    app
      .db()
      .newQuery(
        `UPDATE messages SET sender_picture = json_extract(raw, '$.sender_picture')
         WHERE json_extract(raw, '$.sender_picture') LIKE 'https://%'`,
      )
      .execute();

    app.save(
      new Collection({
        type: "view",
        name: "timeline_groups",
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        viewQuery: `SELECT MIN(id) AS id, provider, channel, group_id, MAX(group_label) AS group_label,
                           COUNT(*) AS n, MAX(ts) AS last_ts
                    FROM messages GROUP BY provider, channel, group_id`,
      }),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("timeline_groups"));
    const m = app.findCollectionByNameOrId("messages");
    m.fields.removeByName("sender_picture");
    m.indexes = m.indexes.filter((i) => !i.includes("idx_messages_sender_label"));
    app.save(m);
  },
);
