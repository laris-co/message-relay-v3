#!/usr/bin/env bash
# Name this app after its repo: scripts/rename-app.sh OWNER REPO
# Rewrites the add-on's name, slug, sidebar title, image, URLs and the README install buttons.
# Used once by .github/workflows/template-init.yml in a repo made from the template; safe to run by hand.
set -euo pipefail
OWNER="$1"; REPO="$2"
owner_lc=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')
repo_lc=$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g')
slug=$(printf '%s' "$repo_lc" | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
url="https://github.com/$OWNER/$REPO"
url_enc=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")
store_slug="$(python3 -c 'import sys,hashlib; print(hashlib.sha1(sys.argv[1].lower().rstrip("/").encode()).hexdigest()[:8])' "$url")_$slug"
image="ghcr.io/$owner_lc/{arch}-addon-$repo_lc"

c=haos/addon/config.yaml
sed -i.bak -E \
  -e "s#^name: .*#name: \"$REPO\"#" \
  -e "s#^slug: .*#slug: \"$slug\"#" \
  -e "s#^version: .*#version: \"0.1.0\"#" \
  -e "s#^url: .*#url: \"$url\"#" \
  -e "s#^image: .*#image: \"$image\"#" \
  -e "s#^panel_title: .*#panel_title: \"$REPO\"#" \
  -e "s#^(  s3_bucket: )\"message-relay-v3\"#\\1\"$repo_lc\"#" \
  "$c"
sed -i.bak -E -e "s#^name: .*#name: $REPO#" -e "s#^url: .*#url: $url#" -e "s#^maintainer: .*#maintainer: $OWNER#" repository.yaml
sed -i.bak -E "s#org.opencontainers.image.source=\"[^\"]+\"#org.opencontainers.image.source=\"$url\"#" haos/addon/Dockerfile
sed -i.bak -E "1s#.*#\\# $REPO#" haos/addon/DOCS.md
# README: title, and the My Home Assistant buttons between the markers
python3 - "$REPO" "$url" "$url_enc" "$store_slug" <<'PY'
import re, sys
repo, url, enc, slug = sys.argv[1:]
p = "README.md"; s = open(p, encoding="utf-8").read()
s = re.sub(r"^# .*", f"# {repo}", s, count=1, flags=re.M)
buttons = (
    f"[![Add the repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)]"
    f"(https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url={enc})\n"
    f"[![Open the add-on in my Home Assistant](https://my.home-assistant.io/badges/supervisor_addon.svg)]"
    f"(https://my.home-assistant.io/redirect/supervisor_addon/?addon={slug}&repository_url={enc})"
)
s = re.sub(r"(<!-- ha-buttons -->\n).*?(\n<!-- /ha-buttons -->)", lambda m: m.group(1) + buttons + m.group(2), s, flags=re.S)
open(p, "w", encoding="utf-8").write(s)
PY
rm -f "$c.bak" repository.yaml.bak haos/addon/Dockerfile.bak haos/addon/DOCS.md.bak
echo "named: $REPO · slug $slug (store: $store_slug) · image $image"
