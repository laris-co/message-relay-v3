import { useEffect, useState, type ReactNode } from "react";
import { pb } from "./pb.ts";
import { Header, Icon } from "./ui.tsx";

// Webhook endpoints (superusers only): add a bot, get its URL to paste into LINE / GitHub. The URL
// base is PocketBase's Settings → Application → Application URL (the public address), else this page's.

interface Endpoint { id: string; name: string; kind: "line" | "github" | "generic"; enabled: boolean; note: string }

const HELP: Record<Endpoint["kind"], string> = {
  line: "LINE Developers → Messaging API → Webhook URL. Paste the channel secret here.",
  github: "Repo / org → Settings → Webhooks → Payload URL (application/json). Secret: the generated one.",
  generic: "POST JSON or text with header Authorization: Bearer <token>.",
};

function randomSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "").slice(0, 32);
}

export function Endpoints({ nav }: { nav: ReactNode }) {
  const [rows, setRows] = useState<Endpoint[]>([]);
  const [base, setBase] = useState(window.location.origin);
  const [baseSet, setBaseSet] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Endpoint["kind"]>("line");
  const [secret, setSecret] = useState("");
  const [shown, setShown] = useState<{ url: string; secret: string } | null>(null);
  const [error, setError] = useState("");

  const load = () => pb.collection("endpoints").getFullList<Endpoint>({ sort: "kind,name" }).then(setRows).catch((e) => setError(String(e)));
  useEffect(() => {
    void load();
    pb.settings.getAll().then((s) => {
      const u = (s.meta?.appURL || "").replace(/\/$/, "");
      // PocketBase's placeholder is http://localhost:8090: a loopback address is no public URL
      const loopback = /^https?:\/\/(localhost|127\.|\[?::1)/i.test(u);
      if (u && !loopback) (setBase(u), setBaseSet(true));
    }).catch(() => {});
  }, []);

  const urlOf = (e: { kind: string; name: string }) => `${base}/w/${e.kind}/${e.name}`;

  return (
    <div className="app">
    <Header nav={nav} />
    <div className="endpoints">
      <h2>Webhook endpoints</h2>
      {!baseSet && (
        <p className="warn">No public Application URL yet: URLs below use this page's address ({base}). Set the public one in
          {" "}<a href="./_/#/settings" target="_blank" rel="noreferrer">Settings → Application</a>.</p>
      )}
      <table>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.enabled ? "" : "off"}>
              <td><span className={`prov p-${e.kind}`}>{e.kind}</span></td>
              <td>{e.name}</td>
              <td><code>{urlOf(e)}</code></td>
              <td>
                <button className="btn" onClick={() => navigator.clipboard.writeText(urlOf(e))}>Copy URL</button>
                <button className="btn quiet" onClick={() => pb.collection("endpoints").update(e.id, { enabled: !e.enabled }).then(load)}>
                  {e.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="muted">No endpoints yet. Add the first one below.</td></tr>}
        </tbody>
      </table>

      <form
        onSubmit={async (ev) => {
          ev.preventDefault();
          setError("");
          const s = kind === "line" ? secret.trim() : secret.trim() || randomSecret();
          try {
            await pb.collection("endpoints").create({ name, kind, secret: s, enabled: true });
            setShown({ url: urlOf({ kind, name }), secret: kind === "line" ? "" : s });
            setName("");
            setSecret("");
            void load();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <h3>Add endpoint</h3>
        <select value={kind} onChange={(e) => setKind(e.target.value as Endpoint["kind"])}>
          <option value="line">LINE</option>
          <option value="github">GitHub</option>
          <option value="generic">generic</option>
        </select>
        <input placeholder="name (a-z 0-9 - _)" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z0-9][a-z0-9_-]{0,63}" required />
        <input
          placeholder={kind === "line" ? "LINE channel secret" : "secret (empty: generate)"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required={kind === "line"}
        />
        <button className="btn primary"><Icon name="plus" /> Add</button>
        <p className="muted help">{HELP[kind]}</p>
      </form>
      {error && <p className="error">{error}</p>}
      {shown && (
        <div className="shown">
          <p>URL: <code>{shown.url}</code> <button className="btn" onClick={() => navigator.clipboard.writeText(shown.url)}>Copy</button></p>
          {shown.secret && (
            <p>Secret (shown once): <code>{shown.secret}</code> <button className="btn" onClick={() => navigator.clipboard.writeText(shown.secret)}>Copy</button></p>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
