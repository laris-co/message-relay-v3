/// <reference path="../pb_data/types.d.ts" />
// The one collection v3 has. Read: any signed-in user (users collection) or a superuser.
// Create/update/delete: nobody through the API (null rules = superuser only); rows come in through
// the webhook routes in pb_hooks/, which save with the app's own rights, and the v2 import route.
migrate(
  (app) => {
    // max 0 means PocketBase's default of 5000 characters: too short for chat text, so every limit is explicit.
    const text = (name, extra) => Object.assign({ name, type: "text", max: 2048 }, extra || {});
    const c = new Collection({
      type: "base",
      name: "messages",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "ts", type: "date", required: true },
        text("provider", { required: true }),
        text("endpoint"),
        text("channel"),
        text("group_id"),
        text("group_label"),
        text("sender"),
        text("sender_label"),
        text("type"),
        text("text", { max: 100000 }), // = relay.TextMax
        text("reply_to"),
        text("source_event_id", { required: true }),
        { name: "raw", type: "json", maxSize: 2000000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_messages_source_event_id ON messages (source_event_id)",
        "CREATE INDEX idx_messages_ts ON messages (ts DESC, id DESC)",
        "CREATE INDEX idx_messages_pivot ON messages (provider, channel, group_id)",
        "CREATE INDEX idx_messages_group ON messages (group_id)",
      ],
    });
    app.save(c);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("messages"));
  },
);
