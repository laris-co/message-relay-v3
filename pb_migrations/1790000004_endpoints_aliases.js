/// <reference path="../pb_data/types.d.ts" />
// endpoints: the webhook senders, managed in the UI / dashboard instead of env (no restart to add a
//   bot). The secret is a hidden field: only superusers ever read it. URL: <appURL>/w/<kind>/<name>.
// aliases: id -> human name, for senders and groups (LINE webhooks carry only ids). Seeded from the
//   names the v2 import already carried; a hook relabels messages when an alias changes.
migrate(
  (app) => {
    app.save(
      new Collection({
        type: "base",
        name: "endpoints",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: "name", type: "text", required: true, pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", max: 64 },
          { name: "kind", type: "select", required: true, values: ["line", "github", "generic"], maxSelect: 1 },
          { name: "secret", type: "text", required: true, hidden: true, max: 512 },
          { name: "enabled", type: "bool" },
          { name: "note", type: "text", max: 500 },
          { name: "created", type: "autodate", onCreate: true, onUpdate: false },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_endpoints_kind_name ON endpoints (kind, name)"],
      }),
    );

    const signedIn = '@request.auth.id != ""';
    app.save(
      new Collection({
        type: "base",
        name: "aliases",
        listRule: signedIn,
        viewRule: signedIn,
        createRule: signedIn,
        updateRule: signedIn,
        deleteRule: signedIn,
        fields: [
          { name: "kind", type: "select", required: true, values: ["sender", "group"], maxSelect: 1 },
          { name: "provider", type: "text", max: 32 },
          { name: "value", type: "text", required: true, max: 512 },
          { name: "label", type: "text", required: true, max: 200 },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_aliases_key ON aliases (kind, provider, value)"],
      }),
    );

    // relabelling by id needs these
    const m = app.findCollectionByNameOrId("messages");
    m.indexes.push("CREATE INDEX idx_messages_sender ON messages (provider, sender)");
    app.save(m);

    const id = "substr(lower(hex(randomblob(8))), 1, 15)";
    const now = "strftime('%Y-%m-%d %H:%M:%fZ', 'now')";
    app
      .db()
      .newQuery(
        `INSERT OR IGNORE INTO aliases (id, kind, provider, value, label, updated)
         SELECT ${id}, 'sender', provider, sender, MAX(sender_label), ${now}
         FROM messages WHERE sender != '' AND sender_label != '' GROUP BY provider, sender`,
      )
      .execute();
    app
      .db()
      .newQuery(
        `INSERT OR IGNORE INTO aliases (id, kind, provider, value, label, updated)
         SELECT ${id}, 'group', provider, group_id, MAX(group_label), ${now}
         FROM messages WHERE group_id != '' AND group_label != '' GROUP BY provider, group_id`,
      )
      .execute();
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("aliases"));
    app.delete(app.findCollectionByNameOrId("endpoints"));
    const m = app.findCollectionByNameOrId("messages");
    m.indexes = m.indexes.filter((i) => !i.includes("idx_messages_sender "));
    app.save(m);
  },
);
