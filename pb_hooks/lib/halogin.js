// Home Assistant ingress auto-login: a user already signed in to HA who opens the relay's sidebar
// panel is signed in to the relay as its admin, no second password.
//
// Trust comes from the CONNECTION, not the headers: Supervisor's ingress proxy connects from
// 172.30.32.2 and adds X-Ingress-Path + X-Remote-User-Id. The add-on also publishes its port (for
// webhooks), so anyone who can reach that port could send those headers — they are only believed
// when the TCP peer itself is the ingress proxy. Optional allowlist of HA user ids (ha_user_ids).
//
//   RELAY_INGRESS_AUTO_LOGIN  "true" to enable (add-on option auto_login, default true)
//   RELAY_INGRESS_PEER        the ingress proxy address (default 172.30.32.2; tests use 127.0.0.1)
//   RELAY_HA_USER_IDS         comma-separated HA user ids allowed; empty = any HA user ingress lets in
//                             (the panel is admin-only, and Supervisor ingress needs an HA admin)

/** "1.2.3.4:5678" / "[::1]:5678" -> the host part. */
function peerHost(remoteAddr) {
  const s = String(remoteAddr || "");
  if (s.charAt(0) === "[") return s.slice(1, s.indexOf("]"));
  const i = s.lastIndexOf(":");
  return i > 0 && s.indexOf(":") === i ? s.slice(0, i) : s;
}

/** Pure decision. -> {ok: true} | {status, error} */
function decide({ enabled, peer, trustedPeer, userId, ingressPath, allowlist }) {
  if (!enabled) return { status: 404, error: "auto-login is off" };
  if (!peer || peer !== trustedPeer) return { status: 403, error: "not via Home Assistant ingress" };
  if (!userId || !ingressPath) return { status: 403, error: "no Home Assistant identity" };
  if (allowlist.length && allowlist.indexOf(userId) < 0) return { status: 403, error: "HA user not allowed" };
  return { ok: true };
}

function parseAllowlist(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** GET /api/relay/ha-login (runs inside PocketBase). */
function haLogin(e) {
  const d = decide({
    enabled: ($os.getenv("RELAY_INGRESS_AUTO_LOGIN") || "").trim().toLowerCase() === "true",
    peer: peerHost(e.request.remoteAddr),
    trustedPeer: ($os.getenv("RELAY_INGRESS_PEER") || "172.30.32.2").trim(),
    userId: (e.request.header.get("X-Remote-User-Id") || "").trim(),
    ingressPath: (e.request.header.get("X-Ingress-Path") || "").trim(),
    allowlist: parseAllowlist($os.getenv("RELAY_HA_USER_IDS")),
  });
  if (!d.ok) return e.json(d.status, { error: d.error });
  const email = ($os.getenv("RELAY_ADMIN_EMAIL") || "").trim();
  let admin;
  try {
    admin = e.app.findAuthRecordByEmail("_superusers", email);
  } catch (_) {
    return e.json(503, { error: "no relay admin configured (admin_email / admin_password)" });
  }
  const who = e.request.header.get("X-Remote-User-Name") || e.request.header.get("X-Remote-User-Id");
  console.log(`ha-login: HA user ${who} signed in as ${email} via ingress`);
  return $apis.recordAuthResponse(e, admin, "ha-ingress");
}

module.exports = { peerHost, decide, parseAllowlist, haLogin };
