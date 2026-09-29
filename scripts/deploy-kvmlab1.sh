#!/bin/bash
# Deploy the add-on to kvmlab1: wait for the image of HEAD, then have Home Assistant update to VERSION.
#   scripts/deploy-kvmlab1.sh 0.1.14
V="${1:?usage: scripts/deploy-kvmlab1.sh VERSION}"
cd "$(dirname "$0")/.." || exit 1
SHA=$(git rev-parse HEAD)
for i in $(seq 1 40); do RID=$(gh run list --repo laris-co/message-relay-v3 --workflow addon-image.yml --limit 5 --json databaseId,headSha -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1); [ -n "$RID" ] && break; sleep 3; done
echo "image run: $RID"
gh run watch "$RID" --repo laris-co/message-relay-v3 --exit-status --interval 15 >/dev/null || { echo "IMAGE BUILD FAILED"; exit 2; }
ssh -o BatchMode=yes -o ConnectTimeout=8 kvmlab1 "ha store reload >/dev/null 2>&1; for i in \$(seq 1 12); do v=\$(ha apps info 86a9cd73_message_relay_v3 --raw-json | jq -r .data.version_latest); [ \"\$v\" = \"$V\" ] && break; sleep 5; ha store reload >/dev/null 2>&1; done; echo store sees \$v; ha apps update 86a9cd73_message_relay_v3 2>&1 | tail -1; ha apps info 86a9cd73_message_relay_v3 --raw-json | jq -c '.data | {version, state}'" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g'
for i in $(seq 1 20); do h=$(curl -s -m5 http://kvmlab1.follow-rankine.ts.net:8789/api/health | jq -r .message 2>/dev/null); [ "$h" = "API is healthy." ] && break; sleep 3; done
echo "health: $h"
