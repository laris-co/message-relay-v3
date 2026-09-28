/// <reference path="../pb_data/types.d.ts" />
// attachments: one row per picture / video / file of a message: where it lives at the source, our
// copy (file, thumb: PocketBase files, so they land in the configured S3, e.g. RustFS) and a status,
// so a file the source no longer has is marked `gone` once instead of being retried forever.
// messages keeps its source links (media_kind, thumb_url, media_url: the import writes them); its
// copies move here: rows are seeded from the links (status pending: the few copies already made are
// fetched again into this collection) and the file fields thumb / media are dropped from messages.
// scripts/media-fetch.ts (pocketbase SDK) links later media messages and fetches the files.
migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    const c = new Collection({
      type: "base",
      name: "attachments",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "message", type: "relation", collectionId: messages.id, maxSelect: 1, cascadeDelete: true, required: true },
        { name: "kind", type: "text", max: 32 },
        { name: "source_url", type: "text", max: 2048 },
        { name: "thumb_url", type: "text", max: 2048 },
        { name: "file", type: "file", maxSelect: 1, maxSize: 50 << 20 },
        {
          name: "thumb",
          type: "file",
          maxSelect: 1,
          maxSize: 10 << 20,
          mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        },
        { name: "status", type: "select", values: ["pending", "stored", "gone", "failed"], maxSelect: 1 },
        { name: "error", type: "text", max: 512 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_attachments_msg_src ON attachments (message, source_url, thumb_url)",
        "CREATE INDEX idx_attachments_status ON attachments (status)",
      ],
    });
    app.save(c);

    // one attachment per message that had media (15-char lowercase ids, as PocketBase makes them)
    app
      .db()
      .newQuery(
        `INSERT INTO attachments (id, message, kind, source_url, thumb_url, file, thumb, status, error, created, updated)
         SELECT substr(lower(hex(randomblob(8))), 1, 15), id, media_kind, media_url, thumb_url, '', '', 'pending', '',
                strftime('%Y-%m-%d %H:%M:%fZ', 'now'), strftime('%Y-%m-%d %H:%M:%fZ', 'now')
         FROM messages WHERE media_kind != ''`,
      )
      .execute();

    const m = app.findCollectionByNameOrId("messages");
    m.indexes = m.indexes.filter((i) => !i.includes("idx_messages_media_todo"));
    m.indexes.push("CREATE INDEX idx_messages_media_kind ON messages (media_kind)");
    for (const f of ["thumb", "media"]) m.fields.removeByName(f);
    app.save(m);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("attachments"));
    const m = app.findCollectionByNameOrId("messages");
    m.indexes = m.indexes.filter((i) => !i.includes("idx_messages_media_kind"));
    app.save(m);
  },
);
