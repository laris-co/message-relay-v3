#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Reads this add-on's options at start (never baked into the image) and starts the relay.
set -eu

# bashio renders an unset optional as the literal "null".
opt() {
    local v
    v="$(bashio::config "$1")"
    [ "${v}" = "null" ] && v=""
    printf '%s' "${v}"
}

export RELAY_ADMIN_EMAIL="$(opt admin_email)"
export RELAY_ADMIN_PASSWORD="$(opt admin_password)"
export RELAY_PUBLIC_URL="$(opt public_url)"
export RELAY_INGRESS_AUTO_LOGIN="$(bashio::config 'auto_login')"
export RELAY_HA_USER_IDS="$(opt ha_user_ids)"
export GITHUB_SECRET="$(opt github_secret)"
export GENERIC_TOKEN="$(opt generic_token)"
export RELAY_S3_ENDPOINT="$(opt s3_endpoint)"
export RELAY_S3_BUCKET="$(opt s3_bucket)"
export RELAY_S3_ACCESS_KEY="$(opt s3_access_key)"
export RELAY_S3_SECRET="$(opt s3_secret)"

n=0
for i in $(seq 0 $(( $(bashio::config 'line_channels | length') - 1 ))); do
    ep="$(bashio::config "line_channels[${i}].endpoint")"
    secret="$(bashio::config "line_channels[${i}].secret")"
    key="$(printf '%s' "${ep}" | tr 'a-z-' 'A-Z_')"
    export "LINE_SECRET_${key}=${secret}"
    n=$((n + 1))
done

if [ -z "${RELAY_ADMIN_EMAIL}" ] || [ -z "${RELAY_ADMIN_PASSWORD}" ]; then
    bashio::log.warning "admin_email / admin_password not set: no superuser is created."
    bashio::log.warning "Set both in the Configuration tab and restart, to sign in to the timeline and /_/."
fi
bashio::log.info "LINE channels: ${n} · GitHub: $([ -n "${GITHUB_SECRET}" ] && echo on || echo off) · generic: $([ -n "${GENERIC_TOKEN}" ] && echo on || echo off)"

exec /app/pocketbase serve --dir /data/pb_data --migrationsDir /app/pb_migrations --hooksDir /app/pb_hooks \
    --publicDir /app/public --automigrate=false --http 0.0.0.0:8789
