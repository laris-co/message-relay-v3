// Pure mapping + signature logic for the webhook routes (main.pb.js). No PocketBase globals in
// here: crypto is passed in as `crypto = {hs256, sha256, equal}` (hex HMAC-SHA256, hex SHA-256,
// constant-time string compare) so the same code could run under a plain JS test runner too.
//
// A "message" is the flat object main.pb.js saves into the `messages` collection:
//   {ts, provider, endpoint, channel, group_id, sender, sender_label, type, text, reply_to,
//    source_event_id, raw, media_kind, thumb_url, media_url}
// source_event_id is the idempotency key (UNIQUE). Every key is scoped to the endpoint, as in v2:
// the holder of one endpoint's secret must never be able to make another endpoint's event a
// silent "duplicate".

const ENDPOINT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEXT_MAX = 100000;
const SHORT_MAX = 2048;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);
const get = (o, ...path) => {
  let cur = o;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};
const clip = (s, max) => (typeof s === "string" && s.length > max ? s.slice(0, max) : s || "");
const clipText = (s) => clip(s, TEXT_MAX);
const clipShort = (s) => clip(s, SHORT_MAX);
/** https URL only: a relative or signed (v2/other relay) link is not a lasting source. */
const https = (s) => (typeof s === "string" && s.indexOf("https://") === 0 ? s : "");

function validEndpoint(ep) {
  return typeof ep === "string" && ENDPOINT_RE.test(ep);
}

// ── secrets ──────────────────────────────────────────────────────────────────
// LINE_SECRET_<EP> · GITHUB_SECRET_<EP> (fallback GITHUB_SECRET) · GENERIC_TOKEN_<EP> (fallback
// GENERIC_TOKEN). <EP> is the endpoint upper-cased with "-" as "_". LINE has no fallback: every
// LINE channel has its own secret.
function envKey(ep) {
  return ep.toUpperCase().replace(/-/g, "_");
}
function secretFor(kind, ep, getenv) {
  const k = envKey(ep);
  switch (kind) {
    case "line":
      return getenv("LINE_SECRET_" + k) || "";
    case "github":
      return getenv("GITHUB_SECRET_" + k) || getenv("GITHUB_SECRET") || "";
    case "generic":
      return getenv("GENERIC_TOKEN_" + k) || getenv("GENERIC_TOKEN") || "";
  }
  return "";
}

// ── encoding ─────────────────────────────────────────────────────────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function hexToBase64(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return "";
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

// ── signatures (fail closed) ─────────────────────────────────────────────────
/** LINE: x-line-signature = base64(HMAC-SHA256(channelSecret, rawBody)). */
function verifyLine(secret, rawBody, signature, crypto) {
  if (!secret || typeof signature !== "string" || signature.trim() === "") return false;
  const expected = hexToBase64(crypto.hs256(rawBody, secret));
  return expected !== "" && crypto.equal(expected, signature.trim());
}

/** GitHub: x-hub-signature-256 = "sha256=" + hex(HMAC-SHA256(secret, rawBody)). */
function verifyGithub(secret, rawBody, header, crypto) {
  if (!secret || typeof header !== "string") return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  return crypto.equal(crypto.hs256(rawBody, secret).toLowerCase(), m[1].toLowerCase());
}

/** Generic: `authorization: Bearer <token>` or `x-relay-token: <token>`. */
function verifyGeneric(token, authHeader, tokenHeader, crypto) {
  if (!token) return false;
  let given = typeof tokenHeader === "string" ? tokenHeader.trim() : "";
  if (!given && typeof authHeader === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m) given = m[1].trim();
  }
  return given !== "" && crypto.equal(given, token);
}

// ── LINE ─────────────────────────────────────────────────────────────────────
function lineBody(ev) {
  const type = str(ev.type) || "unknown";
  if (type === "message" && isObj(ev.message)) {
    const m = ev.message;
    const mtype = str(m.type) || "unknown";
    let text = "";
    switch (mtype) {
      case "text":
        text = typeof m.text === "string" ? m.text : "";
        break;
      case "file":
        text = str(m.fileName) || "";
        break;
      case "sticker":
        text = str(m.text) || "";
        break;
      case "location":
        text = [str(m.title), str(m.address)].filter(Boolean).join(" — ");
        break;
    }
    return { type: mtype, text, reply_to: str(m.quotedMessageId) || "" };
  }
  let text = "";
  if (type === "postback" && isObj(ev.postback) && typeof ev.postback.data === "string") text = ev.postback.data;
  const reply_to = isObj(ev.unsend) ? str(ev.unsend.messageId) || "" : "";
  return { type, text, reply_to };
}

function isoFromMs(v, now) {
  if (typeof v === "number" && isFinite(v) && v > 0) return new Date(v).toISOString();
  return now().toISOString();
}

/** One message per LINE event. Events without webhookEventId (very old API versions) are keyed
 * by a hash of the event itself, so a retry still dedups. */
function lineMessages(payload, endpoint, crypto, now) {
  if (!isObj(payload) || !Array.isArray(payload.events)) return [];
  const destination = str(payload.destination) || "";
  const out = [];
  for (const ev of payload.events) {
    if (!isObj(ev)) continue;
    const src = isObj(ev.source) ? ev.source : {};
    const b = lineBody(ev);
    const eventId = str(ev.webhookEventId);
    out.push({
      ts: isoFromMs(ev.timestamp, now),
      provider: "line",
      endpoint,
      channel: endpoint,
      group_id: str(src.groupId) || str(src.roomId) || str(src.userId) || "",
      sender: str(src.userId) || "",
      sender_label: "",
      type: b.type,
      text: clipText(b.text),
      reply_to: b.reply_to,
      source_event_id: eventId
        ? "line:" + endpoint + ":evt:" + eventId
        : "line:" + endpoint + ":sha256:" + crypto.sha256(JSON.stringify(ev)),
      raw: { destination, event: ev },
    });
  }
  return out;
}

// ── GitHub ───────────────────────────────────────────────────────────────────
function githubSummary(event, action, p) {
  const kind = action ? event + "." + action : event;
  const body = str(get(p, "comment", "body")) || str(get(p, "review", "body"));
  if (body) return body;
  const title = str(get(p, "pull_request", "title")) || str(get(p, "issue", "title")) || str(get(p, "release", "name"));
  if (title) return kind + ": " + title;
  if (event === "push") {
    const commits = get(p, "commits");
    const n = Array.isArray(commits) ? commits.length : 0;
    return "push " + (str(get(p, "ref")) || "") + " (" + n + " commit" + (n === 1 ? "" : "s") + ")";
  }
  if (event === "ping") return str(get(p, "zen")) || "ping";
  return kind;
}

/** headers: lower-case name -> value. */
function githubMessage(payload, headers, endpoint, rawBody, crypto, now) {
  const p = isObj(payload) ? payload : {};
  const event = (headers["x-github-event"] || "").trim() || "unknown";
  const delivery = (headers["x-github-delivery"] || "").trim();
  const action = str(p.action);
  const repo = str(get(p, "repository", "full_name")) || str(get(p, "organization", "login")) || "";
  const login = str(get(p, "sender", "login")) || "unknown";
  const replyTo = get(p, "comment", "in_reply_to_id");
  return {
    ts: now().toISOString(),
    provider: "github",
    endpoint,
    channel: repo ? repo.split("/")[0] : endpoint,
    group_id: repo || "github:" + endpoint,
    sender: login,
    sender_label: login,
    type: "event",
    text: clipText(githubSummary(event, action, p)),
    reply_to: typeof replyTo === "number" || typeof replyTo === "string" ? String(replyTo) : "",
    source_event_id: delivery
      ? "github:" + endpoint + ":delivery:" + delivery
      : "github:" + endpoint + ":sha256:" + crypto.sha256(rawBody),
    raw: { event, action: action || "", delivery, payload: p },
  };
}

// ── generic ──────────────────────────────────────────────────────────────────
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && isFinite(v)) return String(v);
  }
  return undefined;
}

/** Any JSON object (or text) -> one message. x-event-id header is the sender's own key. */
function genericMessage(parsed, headers, endpoint, rawBody, crypto, now) {
  const obj = isObj(parsed) ? parsed : undefined;
  const text = typeof parsed === "string" ? parsed : obj ? pick(obj, ["text", "message", "content", "body"]) : undefined;
  const sender = (obj && pick(obj, ["from", "user", "sender", "author"])) || "unknown";
  const evt = (headers["x-event-id"] || "").trim();
  let ts = now().toISOString();
  const t = obj && pick(obj, ["ts", "timestamp", "time"]);
  if (t && isFinite(Date.parse(t))) ts = new Date(Date.parse(t)).toISOString();
  return {
    ts,
    provider: "generic",
    endpoint,
    channel: endpoint,
    group_id: (obj && pick(obj, ["chat", "chat_id", "channel", "room", "group"])) || endpoint,
    sender,
    sender_label: (obj && pick(obj, ["sender_label", "name", "display_name"])) || "",
    type: text !== undefined ? "text" : "event",
    text: clipText(text),
    reply_to: (obj && pick(obj, ["reply_to", "in_reply_to", "replyTo"])) || "",
    source_event_id: evt
      ? "generic:" + endpoint + ":evt:" + evt
      : "generic:" + endpoint + ":sha256:" + crypto.sha256(rawBody),
    raw: obj ? obj : { text: typeof parsed === "string" ? parsed : null },
  };
}

// ── v2 import ────────────────────────────────────────────────────────────────
/**
 * One row of v2's GET /api/messages -> a message + its attachment (if any). v2's list answer
 * carries no source_event_id, so the key is v2's own message id ("v2:<id>"): re-running the
 * import dedups, but a message that also reached v3 by webhook is not recognised as the same one
 * (v3 takes no live traffic yet). Returns null for a row that cannot be stored.
 * v2's MediaOut: an archived row's thumb_url is v2's own signed, expiring URL, so the source's
 * source_thumb_url (when present) is kept instead.
 */
function v2Message(row, groupLabel) {
  if (!isObj(row) || !str(row.id) || !str(row.ts) || !isFinite(Date.parse(row.ts))) return null;
  let mediaKind = "", thumbUrl = "", mediaUrl = "";
  if (isObj(row.media) && str(row.media.kind)) {
    mediaKind = row.media.kind;
    mediaUrl = https(row.media.file_url);
    thumbUrl = https(row.media.thumb_url);
    if (row.media.archived === true || thumbUrl === "") thumbUrl = https(row.media.source_thumb_url) || thumbUrl;
  }
  return {
    ts: new Date(Date.parse(row.ts)).toISOString(),
    provider: str(row.provider) || "unknown",
    endpoint: "v2-import",
    channel: str(row.channel) || "",
    group_id: str(row.group_id) || "",
    group_label: str(groupLabel) || "",
    sender: str(row.sender) || "",
    sender_label: str(row.sender_label) || "",
    type: str(row.type) || "",
    text: clipText(typeof row.text === "string" ? row.text : ""),
    reply_to: str(row.reply_to) || "",
    source_event_id: "v2:" + row.id,
    raw: row,
    media_kind: mediaKind,
    thumb_url: thumbUrl,
    media_url: mediaUrl,
  };
}

/** Lower-cased header map from a {name: value | [value]} object. */
function lowerHeaders(h) {
  const out = {};
  if (!isObj(h)) return out;
  for (const k of Object.keys(h)) {
    const v = h[k];
    out[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  }
  return out;
}

module.exports = {
  validEndpoint,
  secretFor,
  hexToBase64,
  verifyLine,
  verifyGithub,
  verifyGeneric,
  lineMessages,
  githubMessage,
  genericMessage,
  v2Message,
  lowerHeaders,
  clipShort,
  clipText,
  https,
};
