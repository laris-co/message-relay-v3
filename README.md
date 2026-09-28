# message-relay v3

A deliberately small message relay: webhooks in, one **messages** collection, one live **timeline**.
[PocketBase](https://pocketbase.io) is the whole backend (DB, auth, API, realtime, admin UI): the
**stock `pocketbase` binary**, unmodified. Everything of ours is JavaScript: migrations for the schema,
a few JS hooks for what must run on the server, and the PocketBase JS SDK everywhere else. No Go.

Brief: [laris-co/message-relay#12](https://github.com/laris-co/message-relay/issues/12).
Siblings: v1 [`laris-co/message-relay`](https://github.com/laris-co/message-relay) (SQLite, production),
v2 [`laris-co/message-relay-v2`](https://github.com/laris-co/message-relay-v2) (LanceDB on RustFS, pollers, imports).
v3 is the simple counterpart. It does not replace v2's pipelines.

This repo is a **GitHub template**: "Use this template" gives you a new relay repo.

```
pb_migrations/    the schema, as JS migrations: messages, attachments (run on every start)
pb_hooks/         JS hooks inside PocketBase (server-side only because they must be):
  main.pb.js        webhook routes (LINE / GitHub / generic, signature checks), facets, v2 import route,
                    create hook (message with media -> attachments row), cron (fetch newest pending)
  lib/              relay.js (pure mapping + signatures, unit-tested), store.js, media.js, boot.js
frontend/         React + pocketbase SDK
  src/              timeline: newest first, infinite scroll, only/hide filter, search, realtime
  dist/             the build (committed; served by PocketBase --publicDir)
mcp-ts/           read-only MCP server (pocketbase SDK): recent · search · groups
scripts/          import-v2.ts (v2 -> v3), media-fetch.ts (SDK: bulk picture backlog), e2e.sh
tests/            unit tests for pb_hooks/lib/relay.js (bun test)
haos/             Home Assistant add-on (stock binary + these dirs; image built by CI, pushed to GHCR)
repository.yaml   makes this repo a Home Assistant add-on store
```

**Why hooks at all?** The SDK is a client: it can read, write, subscribe and upload, but it cannot be
the URL LINE and GitHub POST to, and signatures must be checked before anything is stored. That is
the one job of `pb_hooks/`. Hooks never download (a slow source would block the save): the create
hook only adds a `pending` attachment, and fetching runs in a cron hook (newest, 30/min) and in
`just media-fetch` (the backlog, in parallel).

## Run

Needs `pocketbase` 0.40.x on PATH (`brew install pocketbase`) and Bun (UI build, tests, scripts).

```sh
just superuser     # once: random password into pass (message-relay-v3/local-admin), never printed
just dev           # builds the UI, runs pocketbase on http://127.0.0.1:8789 (timeline /, dashboard /_/)
just test          # hook + UI + MCP unit tests, then scripts/e2e.sh against the stock binary
just import-v2     # v2's messages → v3 (v3 must be running; reads the v2 token from pass)
just media-fetch   # copy pending attachments (thumbnail + full image) into storage; resumable
just api-check     # read-only tour of the REST API with curl + jq (login, filter, JSON path, expand, view, 403s)
just ui-dev        # React with hot reload on :5173, API proxied to :8789
just mcp           # MCP server over stdio (PB_URL, PB_EMAIL, PB_PASSWORD)
```

**Storage and backups.** Set `RELAY_S3_ENDPOINT`, `RELAY_S3_BUCKET`, `RELAY_S3_ACCESS_KEY` and `RELAY_S3_SECRET`
(optionally `RELAY_S3_REGION`, `RELAY_BACKUP_CRON` = `0 3 * * *`, `RELAY_BACKUP_KEEP` = 7), and every start points
PocketBase file storage (the pictures) at that bucket, and nightly backups at a separate one, `RELAY_BACKUP_S3_BUCKET`
(default `<bucket>-backups`), with path-style addressing. `just dev` uses the local RustFS
from `RELAY_S3_*` in `.env`, with the keys read from `pass` (entry names are set in `.env`, see the justfile). To stay
on local disk, leave `RELAY_S3_ENDPOINT` empty.

**Endpoints.** Add a bot on the timeline's **Endpoints** page (superusers): pick LINE / GitHub / generic and a name, and
you get the webhook URL to paste, `<Application URL>/w/<kind>/<name>`. The URL base comes from PocketBase's Settings →
Application URL. For LINE, paste the channel secret. For GitHub and generic, a secret is generated and shown once. It
takes effect at once, with no restart. Secrets live in the `endpoints` collection (a hidden field, superusers only). Env
vars still work as a fallback, and the add-on options set them.

**Aliases.** The `aliases` collection maps an id to a name (`kind` sender | group, `provider`, `value`, `label`, plus a
sender photo as a PocketBase `file`). Click a name in the timeline to rename it. A hook relabels every message with that
id, and new messages get their label on create. The migration seeds it from the names already in `messages`.

Webhook secrets never go in committed files.

| route | auth | secret env |
|---|---|---|
| `POST /w/line/<endpoint>` | `x-line-signature` = base64 HMAC-SHA256 of the body | `LINE_SECRET_<ENDPOINT>` (one per LINE channel) |
| `POST /w/github/<endpoint>` | `x-hub-signature-256` | `GITHUB_SECRET_<ENDPOINT>`, else `GITHUB_SECRET` |
| `POST /w/generic/<endpoint>` | `Authorization: Bearer <token>` or `x-relay-token` | `GENERIC_TOKEN_<ENDPOINT>`, else `GENERIC_TOKEN` |
| `POST /api/relay/import` | superuser | `{rows: [v2 /api/messages rows], labels}` |

`<ENDPOINT>` is the endpoint upper-cased, with `-` written as `_`. An endpoint with no secret answers 404, and a bad
signature answers 401. A webhook answers `200 {new, duplicate}`.

**Dedup.** `source_event_id` is UNIQUE, and every key is scoped to its endpoint, as in v2:
- LINE: `line:<ep>:evt:<webhookEventId>`
- GitHub: `github:<ep>:delivery:<X-GitHub-Delivery>`
- generic: `generic:<ep>:evt:<x-event-id>`, else a SHA-256 of the body
- v2 import: `v2:<v2 id>`

A redelivery, or a re-run import, stores nothing new.

**Collection `messages`.**
- Fields: `ts`, `provider`, `endpoint`, `channel`, `group_id`, `group_label`, `sender`, `sender_label`, `type`,
  `text`, `reply_to`, `source_event_id` (unique), `raw` (JSON).
- Reading needs a signed-in user (`users` or a superuser).
- Nobody can create, update or delete through the API. Rows come only through the routes above.
- Change the schema by adding a JS migration in `pb_migrations/` (`pocketbase migrate create <name> --migrationsDir pb_migrations`).
  With `just dev`, dashboard changes also write a migration file there (automigrate); commit it.
- `timeline_groups` (view collection): one row per provider / channel / group with `n` and `last_ts`: the filter panel.
- **Querying JSON.** Everything the source sent stays in `raw`; filter it with dot paths (`raw.media.kind = "video"`),
  which scans every row (~0.5 s at 230k). Fields queried often are promoted: a migration adds the column + index and
  backfills from `raw`, and `pb_hooks/lib/promote.js` copies it on create (so far: `sender_picture`; indexed:
  `sender_label`, `media_kind`). Aggregates are view collections.
- `attachments`: one row per picture / file of a message (`kind`, `source_url`, `thumb_url`, our copies `thumb` /
  `file`, `status` pending · stored · gone · failed). `gone` = the source answered 404/410: never retried.

**v2 import.**
- The script reads v2 one request at a time: `/api/tree`, `/api/groups`, then `/api/messages` pages per month and
  provider.
- It ends with a table comparing v2's rows, the rows read, and the rows v3 holds.
- v2's list answer has no `source_event_id`, so imported rows are keyed `v2:<id>`. A message that later arrives by
  webhook as well is not matched to its imported copy.

## Home Assistant

1. CI (`.github/workflows/addon-image.yml`) builds `ghcr.io/laris-co/{amd64,aarch64}-addon-message-relay-v3:<version>`:
   the stock PocketBase release (sha256-pinned) plus `pb_migrations/`, `pb_hooks/` and `frontend/dist`. No on-device build.
2. In HA, go to Settings → Add-ons → Add-on Store → ⋮ → Repositories, and add this repo's URL.
3. Install **Message Relay v3**. Set `admin_email`, `admin_password`, `line_channels`, and the other secrets in
   Configuration, then start it. The timeline appears in the sidebar through ingress. Webhooks use port 8789.

**Inside Home Assistant.** Already signed in to HA? Opening the **Relay v3** sidebar panel signs you in to the relay
as its admin, with no second password (`auto_login`, on by default). It's trusted only when the connection comes from
Supervisor's ingress proxy (172.30.32.2), never from the published port, and can be limited with `ha_user_ids`
(comma-separated HA user ids). **PocketBase ↗** in the top bar opens this relay's PocketBase dashboard, already signed
in. PocketBase 0.40 keeps the dashboard login under a path-scoped key, so it doesn't clash with the other PocketBase
add-ons on the same HA.

**Visibility.** Supervisor clones add-on stores and pulls images anonymously, so the repo and both GHCR packages
(`{amd64,aarch64}-addon-message-relay-v3`) must be public. A fork that stays private needs a public store repo plus
`ha docker registries add ghcr.io` with a `read:packages` token.

Release by bumping `version:` in `haos/message_relay_v3/config.yaml`.

## Not in v3 (by design)

- Pollers for sources that don't push (v3 only receives webhooks and imports), and chat-export importers.
- Downloading LINE media content (it needs the channel access token): a LINE image is stored as a `[image]` message.
  Pictures are kept when the source gives a link (`thumb_url`, `media_url`): `attachments` rows, fetched into
  PocketBase files by the cron hook and `just media-fetch` (thumbnails and full images, not videos).
- Outbound replies and sinks.
- Group tags and a day/month catalog.
- Full-text ranking. Search is a case-insensitive substring (`~`), which is enough at this size.
- A LINE bot-name lookup. The channel is the endpoint name you give each bot.
- Cutover of any live webhook: v1 stays production.
