#!/usr/bin/env bash
# End-to-end: start the stock pocketbase (JS migrations + JS hooks) on a throwaway data dir, send signed LINE / GitHub / generic
# webhooks twice each, and check that the first lands, the repeat is a duplicate, a bad signature is
# 401, and an anonymous reader sees nothing. Uses throwaway secrets, never real ones.
set -euo pipefail
BIN=${1:-pocketbase}
PORT=${E2E_PORT:-18099}
DIR=$(mktemp -d)
URL=http://127.0.0.1:$PORT
trap 'kill $PID 2>/dev/null || true; rm -rf "$DIR"' EXIT

# a clean env: never the caller's .env (just loads it) — only what this test sets
env -u RELAY_S3_ENDPOINT -u RELAY_PUBLIC_URL -u GITHUB_SECRET -u GENERIC_TOKEN \
RELAY_ADMIN_EMAIL=e2e@relay.test RELAY_ADMIN_PASSWORD=e2e-password-123 \
LINE_SECRET_E2EBOT=line-e2e GITHUB_SECRET=gh-e2e GENERIC_TOKEN=gen-e2e \
  "$BIN" serve --dir "$DIR" --migrationsDir pb_migrations --hooksDir pb_hooks --publicDir frontend/dist \
    --automigrate=false --http 127.0.0.1:$PORT >"$DIR/log" 2>&1 &
PID=$!
for _ in $(seq 50); do curl -sf -o /dev/null $URL/api/health && break; sleep 0.2; done

fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2, want $3"; fail=1; fi; }

LB='{"destination":"Ubot","events":[{"type":"message","webhookEventId":"01E2E","timestamp":1790000000000,"source":{"type":"group","groupId":"Ce2e","userId":"Ue2e"},"message":{"type":"text","id":"1","text":"สวัสดี e2e"}}]}'
LS=$(printf %s "$LB" | openssl dgst -sha256 -hmac line-e2e -binary | base64)
check "line first"  "$(curl -s -XPOST $URL/w/line/e2ebot -H "x-line-signature: $LS" -d "$LB" | jq -c '[.new,.duplicate]')" "[1,0]"
check "line repeat" "$(curl -s -XPOST $URL/w/line/e2ebot -H "x-line-signature: $LS" -d "$LB" | jq -c '[.new,.duplicate]')" "[0,1]"
check "line bad sig" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $URL/w/line/e2ebot -H 'x-line-signature: AAAA' -d "$LB")" "401"
check "line unknown endpoint" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $URL/w/line/other -H "x-line-signature: $LS" -d "$LB")" "404"

GB='{"action":"opened","issue":{"number":1,"title":"e2e"},"repository":{"full_name":"laris-co/e2e"},"sender":{"login":"e2e"}}'
GS=sha256=$(printf %s "$GB" | openssl dgst -sha256 -hmac gh-e2e | awk '{print $NF}')
gh() { curl -s -XPOST $URL/w/github/gh -H "x-hub-signature-256: $GS" -H 'x-github-event: issues' -H 'x-github-delivery: e2e-1' -d "$GB" | jq -c '[.new,.duplicate]'; }
check "github first"  "$(gh)" "[1,0]"
check "github repeat" "$(gh)" "[0,1]"

gen() { curl -s -XPOST $URL/w/generic/ops -H 'authorization: Bearer gen-e2e' -H 'x-event-id: e2e-9' -d '{"text":"hi","from":"ci"}' | jq -c '[.new,.duplicate]'; }
check "generic first"  "$(gen)" "[1,0]"
check "generic repeat" "$(gen)" "[0,1]"
check "generic bad token" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $URL/w/generic/ops -H 'authorization: Bearer nope' -d x)" "401"

LONG=$(printf "ก%.0s" $(seq 6000))
check "long text (6000 chars)" "$(curl -s -XPOST $URL/w/generic/ops -H 'authorization: Bearer gen-e2e' -d "{\"text\":\"$LONG\"}" | jq -c '[.new,.duplicate]')" "[1,0]"

TOK=$(curl -s -XPOST $URL/api/collections/_superusers/auth-with-password -H 'content-type: application/json' \
  -d '{"identity":"e2e@relay.test","password":"e2e-password-123"}' | jq -r .token)
check "stored rows" "$(curl -s "$URL/api/collections/messages/records?perPage=1" -H "authorization: $TOK" | jq .totalItems)" "4"
ROW='{"rows":[{"id":"e2e-v2-1","ts":"2026-09-01T00:00:00Z","provider":"example","channel":"source-a","group_id":"G","text":"pic","type":"image","sender_picture":"https://example.invalid/p.webp","media":{"kind":"image","file_url":"https://example.invalid/a.jpg","thumb_url":"https://example.invalid/a_thumb.webp"}}]}'
check "import with media" "$(curl -s -XPOST $URL/api/relay/import -H "authorization: $TOK" -H 'content-type: application/json' -d "$ROW" | jq -c '[.new,.duplicate]')" "[1,0]"
check "hook linked attachment" "$(curl -s "$URL/api/collections/attachments/records?filter=kind%3D%22image%22" -H "authorization: $TOK" | jq -c '[.totalItems, .items[0].status]')" '[1,"pending"]'
check "import repeat" "$(curl -s -XPOST $URL/api/relay/import -H "authorization: $TOK" -H 'content-type: application/json' -d "$ROW" | jq -c '[.new,.duplicate]')" "[0,1]"
check "stored rows" "$(curl -s "$URL/api/collections/messages/records?perPage=1" -H "authorization: $TOK" | jq .totalItems)" "5"
# endpoints collection: a bot added at runtime, no restart, no env
check "add endpoint" "$(curl -s -XPOST $URL/api/collections/endpoints/records -H "authorization: $TOK" -H 'content-type: application/json' -d '{"name":"newbot","kind":"generic","secret":"runtime-tok","enabled":true}' | jq -r .name)" "newbot"
check "webhook via endpoint row" "$(curl -s -XPOST $URL/w/generic/newbot -H 'authorization: Bearer runtime-tok' -d '{"text":"hi","from":"Uxyz","chat":"G1"}' | jq -c '[.new,.duplicate]')" "[1,0]"
check "anonymous endpoints" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/collections/endpoints/records")" "403"
# aliases: relabel existing messages, and label new ones on create
check "alias create" "$(curl -s -XPOST $URL/api/collections/aliases/records -H "authorization: $TOK" -H 'content-type: application/json' -d '{"kind":"sender","provider":"generic","value":"Uxyz","label":"Alice"}' | jq -r .label)" "Alice"
check "alias relabels old" "$(curl -s "$URL/api/collections/messages/records?filter=sender%3D%22Uxyz%22&fields=sender_label" -H "authorization: $TOK" | jq -r '.items[0].sender_label')" "Alice"
curl -s -XPOST $URL/w/generic/newbot -H 'authorization: Bearer runtime-tok' -d '{"text":"again","from":"Uxyz","chat":"G1"}' >/dev/null
check "alias labels new" "$(curl -s "$URL/api/collections/messages/records?filter=text%3D%22again%22&fields=sender_label" -H "authorization: $TOK" | jq -r '.items[0].sender_label')" "Alice"
check "stored rows now" "$(curl -s "$URL/api/collections/messages/records?perPage=1" -H "authorization: $TOK" | jq .totalItems)" "7"
check "anonymous sees none" "$(curl -s "$URL/api/collections/messages/records" | jq .totalItems)" "0"
check "anonymous groups view" "$(curl -s "$URL/api/collections/timeline_groups/records" | jq .totalItems)" "0"
check "groups view" "$(curl -s "$URL/api/collections/timeline_groups/records?filter=provider%3D%22example%22" -H "authorization: $TOK" | jq -c '[.totalItems, .items[0].n]')" "[1,1]"
check "promoted sender_picture" "$(curl -s "$URL/api/collections/messages/records?filter=provider%3D%22example%22&fields=sender_picture" -H "authorization: $TOK" | jq -r '.items[0].sender_picture')" "https://example.invalid/p.webp"
check "anonymous create" "$(curl -s -o /dev/null -w '%{http_code}' -XPOST $URL/api/collections/messages/records -H 'content-type: application/json' -d '{"provider":"x","source_event_id":"y","ts":"2026-01-01 00:00:00Z"}')" "403"
check "ui served" "$(curl -s -o /dev/null -w '%{http_code}' $URL/)" "200"
exit $fail
