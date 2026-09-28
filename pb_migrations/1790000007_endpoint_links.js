/// <reference path="../pb_data/types.d.ts" />
// Endpoint links, as v1 and v2 do it: one URL per endpoint, <appURL>/w/<name>/<token>, and the URL is
// the auth. The body says what it is (LINE, GitHub, anything else), so no kind or secret to pick.
//   token   the link's secret part (hidden: superusers only)
//   kind    gains "auto"; secret is optional (kept for the signed /w/<kind>/<name> routes)
migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("endpoints");
    c.fields.add(new TextField({ name: "token", hidden: true, max: 128 }));
    const kind = c.fields.getByName("kind");
    kind.values = ["auto", "line", "github", "generic"];
    c.fields.getByName("secret").required = false;
    c.indexes.push("CREATE UNIQUE INDEX idx_endpoints_token ON endpoints (token) WHERE token != ''");
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("endpoints");
    c.fields.removeByName("token");
    c.fields.getByName("kind").values = ["line", "github", "generic"];
    c.indexes = c.indexes.filter((i) => !i.includes("idx_endpoints_token"));
    app.save(c);
  },
);
