/// <reference path="../pb_data/types.d.ts" />
// A sender's photo, stored once per person on their alias: picture_url (the source link, backfilled
// from messages.sender_picture) and picture (our copy, a PocketBase file: bytes in the configured
// storage, e.g. RustFS; the row keeps only the file name). Fetched by the cron hook.
migrate(
  (app) => {
    const a = app.findCollectionByNameOrId("aliases");
    a.fields.add(new TextField({ name: "picture_url", max: 2048 }));
    a.fields.add(
      new FileField({
        name: "picture",
        maxSelect: 1,
        maxSize: 5 << 20,
        mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
      }),
    );
    app.save(a);
    app
      .db()
      .newQuery(
        `UPDATE aliases SET picture_url = COALESCE((SELECT MAX(sender_picture) FROM messages m
           WHERE m.provider = aliases.provider AND m.sender = aliases.value AND m.sender_picture != ''), '')
         WHERE kind = 'sender'`,
      )
      .execute();
  },
  (app) => {
    const a = app.findCollectionByNameOrId("aliases");
    a.fields.removeByName("picture_url");
    a.fields.removeByName("picture");
    app.save(a);
  },
);
