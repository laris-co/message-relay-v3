// UI updates: the add-on loads a release of laris-co/message-relay-v3-ui at start (run.sh,
// ui_version). This notices a newer release while it runs, tells Home Assistant (a persistent
// notification), and on a superuser's click swaps the new build in place — no restart.
//
//   RELAY_UI_DIR      where run.sh keeps the loaded build (<dir>/current); unset = not managed here
//   RELAY_UI_CHANNEL  ui_version: "latest" follows new releases; a tag or URL is pinned (never offered)
//   SUPERVISOR_TOKEN  set inside a Home Assistant add-on (homeassistant_api): the notification
//
// The pure helpers at the top are unit-tested (tests/uiupdate.test.ts); the rest runs in PocketBase.

const REPO = "laris-co/message-relay-v3-ui";
const NOTE_ID = "message_relay_v3_ui";
const CHECK_EVERY_MS = 15 * 60 * 1000;

/** The release tag a build carries: <meta name="relay-ui-version" content="v0.2.1">; "" if none. */
function versionOf(html) {
  const m = /<meta\s+name="relay-ui-version"\s+content="([^"]*)"/i.exec(String(html || ""));
  return m && m[1] !== "%VITE_UI_VERSION%" ? m[1] : "";
}

/** A tag safe to put in a URL and a shell line: v1.2.3, v1.2.3-rc.1. */
const validTag = (t) => /^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(String(t || ""));

/** Is tag a newer than tag b? Numeric by part (v0.10.0 > v0.9.9); an unknown b counts as older. */
function isNewer(a, b) {
  if (!validTag(a)) return false;
  if (!validTag(b)) return true;
  const n = (t) => t.slice(1).split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const zipUrl = (tag) => `https://github.com/${REPO}/releases/download/${tag}/dist.zip`;

// ── inside PocketBase ───────────────────────────────────────────────────────
function env() {
  return {
    dir: ($os.getenv("RELAY_UI_DIR") || "").trim(),
    channel: ($os.getenv("RELAY_UI_CHANNEL") || "").trim() || "latest",
    token: ($os.getenv("SUPERVISOR_TOKEN") || "").trim(),
  };
}

function installed(dir) {
  try {
    return versionOf(toString($os.readFile(`${dir}/current/index.html`)));
  } catch (_) {
    return "";
  }
}

/** The newest release tag on GitHub (unauthenticated: 60 requests an hour; this asks 4). */
function latestTag() {
  const res = $http.send({
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
    headers: { accept: "application/vnd.github+json", "user-agent": "message-relay-v3" },
    timeout: 15,
  });
  if (res.statusCode !== 200) throw new Error(`GitHub releases: HTTP ${res.statusCode}`);
  return String((res.json && res.json.tag_name) || "");
}

/** Home Assistant's notification panel (the bell), through the Supervisor's proxy to Core. */
function notify(token, service, body) {
  if (!token) return;
  try {
    $http.send({
      url: `http://supervisor/core/api/services/persistent_notification/${service}`,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      timeout: 10,
    });
  } catch (err) {
    console.log(`ui-update: HA notification failed: ${err}`);
  }
}

/** What the UI shows: {managed, channel, installed, latest, update}. Checks GitHub at most every 15 min. */
function status(app, force) {
  const { dir, channel, token } = env();
  if (!dir) return { managed: false, channel: "", installed: "", latest: "", update: false };
  const store = app.store();
  const now = Date.now();
  const have = installed(dir);
  let latest = store.get("ui.latest") || "";
  if (channel === "latest" && (force || now - (store.get("ui.checkedAt") || 0) > CHECK_EVERY_MS)) {
    store.set("ui.checkedAt", now);
    try {
      latest = latestTag();
      store.set("ui.latest", latest);
    } catch (err) {
      console.log(`ui-update: ${err}`);
    }
  }
  const update = channel === "latest" && isNewer(latest, have);
  if (update && store.get("ui.notified") !== latest) {
    store.set("ui.notified", latest);
    notify(token, "create", {
      notification_id: NOTE_ID,
      title: "Message Relay v3: a new UI is out",
      message: `UI ${latest} is available (this relay runs ${have || "an older one"}). Open the Relay v3 panel and click Update — no restart needed.`,
    });
    console.log(`ui-update: ${latest} is available (running ${have})`);
  }
  return { managed: true, channel, installed: have, latest, update };
}

/** Download the newest release and swap it in: <dir>/new -> <dir>/current, the old one kept as <dir>/old. */
function update(app) {
  const s = status(app, true);
  if (!s.managed) throw new Error("the UI is not managed here (no RELAY_UI_DIR)");
  if (!s.update) return s;
  if (!validTag(s.latest)) throw new Error(`bad release tag: ${s.latest}`);
  const { dir, token } = env();
  const script = [
    `set -e`,
    `rm -rf '${dir}/new' /tmp/ui-update.zip && mkdir -p '${dir}/new'`,
    `curl -fsSL --max-time 60 -o /tmp/ui-update.zip '${zipUrl(s.latest)}'`,
    `unzip -q /tmp/ui-update.zip -d '${dir}/new'`,
    `test -f '${dir}/new/index.html'`,
    // now as the files' date: unzip keeps the build's, and a page dated older than the browser's copy
    // would be answered 304 (Not Modified) — the old page would stay
    `find '${dir}/new' -type f -exec touch {} +`,
    `rm -rf '${dir}/old' && mv '${dir}/current' '${dir}/old' && mv '${dir}/new' '${dir}/current'`,
  ].join(" && ");
  const out = $os.cmd("sh", "-c", script).combinedOutput();
  const now = installed(dir);
  if (now !== s.latest) throw new Error(`update did not take: ${toString(out)}`);
  notify(token, "dismiss", { notification_id: NOTE_ID });
  console.log(`ui-update: ${s.installed} -> ${now}`);
  return Object.assign({}, s, { installed: now, update: false });
}

module.exports = { versionOf, validTag, isNewer, zipUrl, status, update };

// ── the add-on itself (Home Assistant Supervisor, hassio_api + hassio_role manager) ──
function supervisor(method, path) {
  const { token } = env();
  if (!token) return null;
  const res = $http.send({ url: `http://supervisor${path}`, method, headers: { authorization: `Bearer ${token}` }, timeout: 20 });
  if (res.statusCode >= 300) throw new Error(`Supervisor ${path}: HTTP ${res.statusCode}`);
  return (res.json && res.json.data) || {};
}

/** {managed, slug, version, latest, update}; managed=false outside Home Assistant. */
function addonStatus() {
  const d = supervisor("GET", "/addons/self/info");
  if (!d) return { managed: false, slug: "", version: "", latest: "", update: false };
  return { managed: true, slug: d.slug, version: d.version, latest: d.version_latest, update: !!d.update_available };
}

/** Ask the Supervisor to update this add-on. It stops and restarts us: the answer may never arrive. */
function addonUpdate() {
  const s = addonStatus();
  if (!s.managed) throw new Error("not a Home Assistant add-on");
  if (!s.update) return s;
  supervisor("POST", `/store/addons/${s.slug}/update`);
  return Object.assign({}, s, { updating: true });
}

module.exports.addonStatus = addonStatus;
module.exports.addonUpdate = addonUpdate;
