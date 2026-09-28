/// <reference path="../pb_data/types.d.ts" />
// Media: where a message's picture / file lives at its source (media_kind, thumb_url, media_url), and
// our own copies (thumb, media: PocketBase files, so they land in the configured S3, e.g. RustFS),
// fetched by scripts/media-fetch.ts. Existing rows are backfilled from raw (v2's MediaOut: an
// archived row's thumb_url is v2's signed, expiring URL, so its source_thumb_url is used).
migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("messages");
    c.fields.add(new TextField({ name: "media_kind", max: 32 }));
    c.fields.add(new TextField({ name: "thumb_url", max: 2048 }));
    c.fields.add(new TextField({ name: "media_url", max: 2048 }));
    c.fields.add(
      new FileField({
        name: "thumb",
        maxSelect: 1,
        maxSize: 10 << 20,
        mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        protected: false,
      }),
    );
    c.fields.add(new FileField({ name: "media", maxSelect: 1, maxSize: 50 << 20, protected: false }));
    c.indexes.push("CREATE INDEX idx_messages_media_todo ON messages (media_kind, thumb)");
    app.save(c);

    app
      .db()
      .newQuery(
        `UPDATE messages SET
           media_kind = COALESCE(json_extract(raw, '$.media.kind'), ''),
           thumb_url = COALESCE(
             CASE WHEN json_extract(raw, '$.media.archived') = 1 THEN json_extract(raw, '$.media.source_thumb_url') END,
             CASE WHEN json_extract(raw, '$.media.thumb_url') LIKE 'https://%' THEN json_extract(raw, '$.media.thumb_url') END,
             json_extract(raw, '$.media.source_thumb_url'), ''),
           media_url = CASE WHEN json_extract(raw, '$.media.file_url') LIKE 'https://%'
                            THEN json_extract(raw, '$.media.file_url') ELSE '' END
         WHERE json_extract(raw, '$.media') IS NOT NULL`,
      )
      .execute();
  },
  (app) => {
    const c = app.findCollectionByNameOrId("messages");
    for (const f of ["media_kind", "thumb_url", "media_url", "thumb", "media"]) c.fields.removeByName(f);
    c.indexes = c.indexes.filter((i) => !i.includes("idx_messages_media_todo"));
    app.save(c);
  },
);
