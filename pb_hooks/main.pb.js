/// <reference path="../pb_data/types.d.ts" />
// The relay's own routes, as JS hooks inside the stock `pocketbase` binary — no Go. Each handler
// runs in its own VM, so every handler requires what it uses.
//
//   POST /w/line/{endpoint}     LINE Messaging API webhook   x-line-signature
//   POST /w/github/{endpoint}   GitHub webhook               x-hub-signature-256
//   POST /w/generic/{endpoint}  any JSON / text              Bearer or x-relay-token
//   POST /w/{endpoint}/{token}  any of the above, detected   the URL is the auth
//   The secret: the enabled `endpoints` row (kind, name), else env LINE_SECRET_<EP> / GITHUB_SECRET[_<EP>] /
//   GENERIC_TOKEN[_<EP>] (the add-on options).
// The UI reads the `chats` view collection (a migration), not a route.
//   POST /api/relay/import      {rows:[v2 /api/messages rows], labels:{"<provider>\t<group>": label}} (superuser)
// Webhooks answer 200 {new, duplicate}; 401 bad signature; 404 unknown/unconfigured endpoint.

onBootstrap((e) => {
  e.next();
  const boot = require(`${__hooks}/lib/boot.js`);
  // each step on its own: a bad env value is logged, never a reason not to start
  for (const [name, step] of [["superuser", boot.upsertSuperuser], ["S3", boot.applyS3], ["app", boot.applyApp]]) {
    try {
      step(e.app);
    } catch (err) {
      console.log(`boot ${name} failed: ${err}`);
    }
  }
});

// Promoted fields: copied out of `raw` before a new message is saved, whatever created it, so no
// import or webhook code has to remember them (pb_migrations/1790000003_promote.js backfilled the rest).
onRecordCreate((e) => {
  require(`${__hooks}/lib/promote.js`).promote(e.record);
  require(`${__hooks}/lib/aliases.js`).fill(e.app, e.record);
  e.next();
}, "messages");

// An alias saved (UI / dashboard / SDK): every message of that id shows the new name.
onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/lib/aliases.js`).relabel(e.app, e.record);
  e.next();
}, "aliases");
onRecordAfterUpdateSuccess((e) => {
  require(`${__hooks}/lib/aliases.js`).relabel(e.app, e.record);
  e.next();
}, "aliases");

// Every new message with media gets its attachments row, whatever created it (webhook, import,
// dashboard, SDK). Downloading is NOT done here: it would block the save for seconds.
onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/lib/media.js`).link(e.app, e.record);
  e.next();
}, "messages");

// New pending attachments (last 2 h), every minute, a few at a time (the backlog: scripts/media-fetch.ts).
cronAdd("attachments-fetch", "* * * * *", () => {
  const r = require(`${__hooks}/lib/media.js`).fetchPending($app, 30);
  if (r.checked) console.log(`attachments-fetch: ${JSON.stringify(r)}`);
});

cronAdd("avatars-fetch", "* * * * *", () => {
  const r = require(`${__hooks}/lib/media.js`).fetchAvatars($app, 20);
  if (r.checked) console.log(`avatars-fetch: ${JSON.stringify(r)}`);
});

// The UI must never come from a stale cache: every build renames its bundle, and a cached old
// index.html asks for a bundle that is gone (the SPA fallback then answers HTML and nothing mounts —
// seen on the first add-on update). no-cache = always revalidate (a cheap 304 when unchanged).
routerUse((e) => {
  const p = e.request.url.path;
  if (!p.startsWith("/api/") && !p.startsWith("/w/") && !p.startsWith("/_/")) {
    e.response.header().set("Cache-Control", "no-cache");
  }
  return e.next();
});

// Home Assistant ingress auto-login (lib/halogin.js: trusted only from the ingress proxy's address).
routerAdd("GET", "/api/relay/ha-login", (e) => require(`${__hooks}/lib/halogin.js`).haLogin(e));

routerAdd("POST", "/w/line/{endpoint}", (e) => require(`${__hooks}/lib/ingress.js`).ingress(e, "line"));
routerAdd("POST", "/w/github/{endpoint}", (e) => require(`${__hooks}/lib/ingress.js`).ingress(e, "github"));
routerAdd("POST", "/w/generic/{endpoint}", (e) => require(`${__hooks}/lib/ingress.js`).ingress(e, "generic"));
// the link: the URL is the auth, the body says what it is (the Endpoints page makes these)
routerAdd("POST", "/w/{endpoint}/{token}", (e) => require(`${__hooks}/lib/ingress.js`).linkIngress(e));

routerAdd(
  "POST",
  "/api/relay/import",
  (e) => {
    const relay = require(`${__hooks}/lib/relay.js`);
    const { storeAll } = require(`${__hooks}/lib/store.js`);
    let body;
    try {
      body = JSON.parse(toString(e.request.body, 64 << 20));
    } catch (_) {
      return e.json(400, { error: "body is not JSON" });
    }
    const rows = Array.isArray(body && body.rows) ? body.rows : [];
    const labels = (body && body.labels) || {};
    const messages = [];
    let invalid = 0;
    for (const row of rows) {
      const m = relay.v2Message(row, row ? labels[row.provider + "\t" + row.group_id] : "");
      if (m) messages.push(m);
      else invalid++;
    }
    const counts = storeAll(e.app, messages);
    return e.json(200, { new: counts.new, duplicate: counts.duplicate, invalid });
  },
  $apis.requireSuperuserAuth(),
);
