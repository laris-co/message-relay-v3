#!/usr/bin/env bash
# Read-only tour of the REST API against a running v3 (just dev), with curl + jq — what the SDK
# does under the hood. Env: PB_URL (default http://127.0.0.1:8789), PB_EMAIL, PB_PASSWORD.
# The password goes to curl on stdin, never argv; the token is never printed.
set -euo pipefail
PB=${PB_URL:-http://127.0.0.1:8789}
: "${PB_EMAIL:?}" "${PB_PASSWORD:?}"
q() { jq -rn --arg v "$1" '$v|@uri'; }                       # url-encode a filter
get() { curl -sf "$PB$1" -H "Authorization: $TOKEN"; }

echo "── 1. health (no auth)"
curl -sf "$PB/api/health" | jq -r .message

echo "── 2. log in: POST /api/collections/_superusers/auth-with-password"
TOKEN=$(jq -n --arg e "$PB_EMAIL" --arg p "$PB_PASSWORD" '{identity:$e,password:$p}' \
  | curl -sf -X POST "$PB/api/collections/_superusers/auth-with-password" -H 'content-type: application/json' -d @- | jq -r .token)
[ -n "$TOKEN" ] && echo "token ok (${#TOKEN} chars, not shown)"

echo "── 3. count: GET /api/collections/messages/records?perPage=1"
get "/api/collections/messages/records?perPage=1&fields=id" | jq '"messages: \(.totalItems)"' -r

echo "── 4. newest 3: ?sort=-ts&perPage=3&fields=..."
get "/api/collections/messages/records?sort=-ts&perPage=3&skipTotal=1&fields=ts,provider,sender_label,text" \
  | jq -r '.items[] | "\(.ts[:16])  \(.provider)  \(.sender_label)  \(.text[:50] | gsub("\n";" "))"'

Q=${API_CHECK_Q:-http}                                      # any word; default: messages with a link
echo "── 5. filter, text search: text ~ \"$Q\""
get "/api/collections/messages/records?perPage=1&fields=id&filter=$(q "text ~ \"$Q\"")" | jq -r '"matches: \(.totalItems)"'

echo "── 6. filter inside the raw JSON: raw.media.kind = \"video\""
get "/api/collections/messages/records?perPage=1&fields=id&filter=$(q 'raw.media.kind = "video"')" | jq -r '"videos: \(.totalItems)"'

echo "── 7. relation expand: one image message + its attachment"
get "/api/collections/messages/records?perPage=1&skipTotal=1&filter=$(q 'media_kind = "image"')&expand=attachments_via_message&fields=id,text,expand.attachments_via_message.status,expand.attachments_via_message.thumb" \
  | jq -c '.items[0] | {id, attachment: .expand.attachments_via_message[0]}'

echo "── 8. view collection: top 5 groups"
get "/api/collections/timeline_groups/records?sort=-n&perPage=5&skipTotal=1" \
  | jq -r '.items[] | "\(.n)\t\(.provider)/\(.group_label // .group_id)"'

echo "── 9. security: the same list without a token"
curl -sf "$PB/api/collections/messages/records?perPage=1" | jq -r '"anonymous sees: \(.totalItems) messages"'
echo "   endpoints without a token: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$PB/api/collections/endpoints/records")"
