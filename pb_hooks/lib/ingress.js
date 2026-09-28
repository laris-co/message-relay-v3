// The webhook handler. Runs only inside PocketBase; main.pb.js routes to it.

const BODY_MAX = 5 << 20;

function ingress(e, kind) {
  const relay = require(`${__hooks}/lib/relay.js`);
  const { storeAll } = require(`${__hooks}/lib/store.js`);
  const crypto = { hs256: $security.hs256, sha256: $security.sha256, equal: $security.equal };
  const now = () => new Date();

  const endpoint = e.request.pathValue("endpoint");
  if (!relay.validEndpoint(endpoint)) return e.json(404, { error: "unknown endpoint" });
  let secret = "";
  try {
    const ep = e.app.findFirstRecordByFilter("endpoints", "kind = {:k} && name = {:n} && enabled = true", { k: kind, n: endpoint });
    secret = ep.getString("secret");
  } catch (_) {
    secret = relay.secretFor(kind, endpoint, (k) => $os.getenv(k));
  }
  if (!secret) return e.json(404, { error: "endpoint not configured" });

  const raw = toString(e.request.body, BODY_MAX);
  const h = (name) => e.request.header.get(name);
  const ok =
    kind === "line"
      ? relay.verifyLine(secret, raw, h("x-line-signature"), crypto)
      : kind === "github"
        ? relay.verifyGithub(secret, raw, h("x-hub-signature-256"), crypto)
        : relay.verifyGeneric(secret, h("authorization"), h("x-relay-token"), crypto);
  if (!ok) return e.json(401, { error: "bad signature" });

  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    if (kind !== "generic") return e.json(400, { error: "body is not JSON" });
  }
  const headers = {
    "x-github-event": h("x-github-event"),
    "x-github-delivery": h("x-github-delivery"),
    "x-event-id": h("x-event-id"),
  };
  const messages =
    kind === "line"
      ? relay.lineMessages(parsed, endpoint, crypto, now)
      : kind === "github"
        ? [relay.githubMessage(parsed, headers, endpoint, raw, crypto, now)]
        : [relay.genericMessage(parsed, headers, endpoint, raw, crypto, now)];
  return e.json(200, storeAll(e.app, messages));
}

/** What a body is, when the link does not say: LINE's {destination, events}, a GitHub delivery, else generic. */
function detectKind(parsed, h) {
  if (h("x-github-event")) return "github";
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.events) && "destination" in parsed) return "line";
  return "generic";
}

/** POST /w/{endpoint}/{token}: the link is the auth (v1 / v2 style); the body says what it is. */
function linkIngress(e) {
  const relay = require(`${__hooks}/lib/relay.js`);
  const { storeAll } = require(`${__hooks}/lib/store.js`);
  const crypto = { hs256: $security.hs256, sha256: $security.sha256, equal: $security.equal };
  const now = () => new Date();
  const endpoint = e.request.pathValue("endpoint");
  const token = e.request.pathValue("token");
  if (!relay.validEndpoint(endpoint) || !token) return e.json(404, { error: "unknown endpoint" });
  let ep;
  try {
    ep = e.app.findFirstRecordByFilter("endpoints", "name = {:n} && enabled = true && token != ''", { n: endpoint });
  } catch (_) {
    return e.json(404, { error: "unknown endpoint" });
  }
  if (!crypto.equal(ep.getString("token"), token)) return e.json(404, { error: "unknown endpoint" });

  const raw = toString(e.request.body, BODY_MAX);
  const h = (name) => e.request.header.get(name);
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {}
  const kind = detectKind(parsed, h);
  const headers = { "x-github-event": h("x-github-event"), "x-github-delivery": h("x-github-delivery"), "x-event-id": h("x-event-id") };
  const messages =
    kind === "line"
      ? relay.lineMessages(parsed, endpoint, crypto, now)
      : kind === "github"
        ? [relay.githubMessage(parsed, headers, endpoint, raw, crypto, now)]
        : [relay.genericMessage(parsed, headers, endpoint, raw, crypto, now)];
  return e.json(200, storeAll(e.app, messages));
}

module.exports = { ingress, linkIngress, detectKind };
