# message-relay-v3 — run `just` for the list.
# Secrets come from env or `pass`, never argv or committed files. A local `.env` (gitignored) is loaded.
set dotenv-load := true

addr := env_var_or_default("RELAY_HTTP", "127.0.0.1:8789")
data := env_var_or_default("RELAY_DATA", "pb_data")
admin_email := env_var_or_default("RELAY_ADMIN_EMAIL", "admin@relay.local")
admin_pass_entry := "message-relay-v3/local-admin"
v2_token_entry := env_var_or_default("V2_TOKEN_PASS", "message-relay-v2/api-token")
# local RustFS for file storage + backups (unset RELAY_S3_ENDPOINT="" in .env to keep local disk)
s3_endpoint := env_var_or_default("RELAY_S3_ENDPOINT", "")
s3_bucket := env_var_or_default("RELAY_S3_BUCKET", "message-relay-v3")
s3_key_entry := env_var_or_default("S3_KEY_PASS", "rustfs/access-key")
s3_secret_entry := env_var_or_default("S3_SECRET_PASS", "rustfs/secret-key")

default:
    @just --list

# Build the React UI into frontend/dist (committed: the add-on image needs no Node). PocketBase
# serves it with --publicDir.
ui-build:
    cd frontend && bun install --frozen-lockfile && bun run build

pb := "pocketbase serve --dir " + data + " --migrationsDir pb_migrations --hooksDir pb_hooks --publicDir frontend/dist"

# Run the stock PocketBase on {{addr}}: JS migrations applied, JS hooks loaded, timeline at /, admin at /_/.
dev: ui-build
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${RELAY_ADMIN_PASSWORD:-}" ] && pass show {{admin_pass_entry}} >/dev/null 2>&1; then
      export RELAY_ADMIN_EMAIL="{{admin_email}}" RELAY_ADMIN_PASSWORD="$(pass show {{admin_pass_entry}} | head -1)"
    fi
    if [ -n "{{s3_endpoint}}" ] && pass show {{s3_key_entry}} >/dev/null 2>&1; then
      export RELAY_S3_ENDPOINT="{{s3_endpoint}}" RELAY_S3_BUCKET="{{s3_bucket}}" \
        RELAY_S3_ACCESS_KEY="$(pass show {{s3_key_entry}} | head -1)" RELAY_S3_SECRET="$(pass show {{s3_secret_entry}} | head -1)"
    fi
    exec {{pb}} --http {{addr}}

# UI with hot reload on :5173 (run `just dev` beside it for the API).
ui-dev:
    cd frontend && bun run dev

# Provision the local superuser: a new random password in pass ({{admin_pass_entry}}), never printed.
superuser email=admin_email:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! pass show {{admin_pass_entry}} >/dev/null 2>&1; then
      openssl rand -base64 24 | tr -d '/+=' | head -c 28 | pass insert -m {{admin_pass_entry}} >/dev/null
      echo "new password stored in pass: {{admin_pass_entry}}"
    fi
    pocketbase superuser upsert "{{email}}" "$(pass show {{admin_pass_entry}} | head -1)" --dir {{data}} >/dev/null
    echo "superuser {{email}} ready in {{data}}  (password: pass show {{admin_pass_entry}})"

# Import v2's messages (idempotent). v3 must be running (`just dev`). Args: --month=yyyy-mm --provider=x
import-v2 *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export V2_TOKEN="$(pass show {{v2_token_entry}} | head -1)"
    export PB_URL="http://{{addr}}" PB_EMAIL="{{admin_email}}" PB_PASSWORD="$(pass show {{admin_pass_entry}} | head -1)"
    bun scripts/import-v2.ts {{args}}

# Copy pictures into v3 (thumb + full images) — into RustFS when S3 is on. Resumable. Args: --limit=N --thumbs-only
media-fetch *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export PB_URL="http://{{addr}}" PB_EMAIL="{{admin_email}}" PB_PASSWORD="$(pass show {{admin_pass_entry}} | head -1)"
    cd scripts && bun install --frozen-lockfile >/dev/null && bun media-fetch.ts {{args}}

# Read-only tour of the REST API against the running instance (curl + jq; password via stdin).
api-check:
    PB_URL="http://{{addr}}" PB_EMAIL="{{admin_email}}" PB_PASSWORD="$(pass show {{admin_pass_entry}} | head -1)" scripts/api-check.sh

# Unit tests (hook mapping + signatures, UI filter, MCP) and the end-to-end webhook check.
test:
    bun test tests
    cd frontend && bun test src
    cd mcp-ts && bun test
    scripts/e2e.sh

# The read-only MCP server over stdio (PB_URL, PB_EMAIL, PB_PASSWORD from env).
mcp:
    cd mcp-ts && bun src/index.ts

# Build the add-on image locally for one arch (CI builds and pushes both to GHCR).
image arch="amd64":
    docker build --platform linux/{{arch}} --build-arg BUILD_ARCH={{arch}} -f haos/addon/Dockerfile -t message-relay-v3:{{arch}} .
