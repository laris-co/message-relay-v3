import { useEffect, useState, type ReactNode } from "react";
import { pb } from "./pb.ts";
import { CopyButton, Header } from "./ui.tsx";

// Endpoints (superusers), as v1 and v2 do it: type a name, Generate, paste the URL. The URL is the auth
// (<base>/w/<name>/<token>); LINE, GitHub or anything else is told apart by the body.
// The URL base is PocketBase's Settings → Application URL (the public address), else this page's.

interface Endpoint { id: string; name: string; kind: string; token: string; enabled: boolean }

function randomToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "").slice(0, 24);
}

export function Endpoints({ nav }: { nav: ReactNode }) {
  const [rows, setRows] = useState<Endpoint[]>([]);
  const [base, setBase] = useState(new URL(".", window.location.href).href.replace(/\/$/, ""));
  const [baseSet, setBaseSet] = useState(false);
  const [name, setName] = useState("");
  const [made, setMade] = useState("");
  const [error, setError] = useState("");

  const load = () => pb.collection("endpoints").getFullList<Endpoint>({ sort: "-created" }).then(setRows).catch((e) => setError(String(e)));
  useEffect(() => {
    void load();
    pb.settings.getAll().then((s) => {
      const u = (s.meta?.appURL || "").replace(/\/$/, "");
      if (u && !/^https?:\/\/(localhost|127\.|\[?::1)/i.test(u)) (setBase(u), setBaseSet(true)); // a loopback address is no public URL
    }).catch(() => {});
  }, []);

  const urlOf = (e: Endpoint) => (e.token ? `${base}/w/${e.name}/${e.token}` : `${base}/w/${e.kind}/${e.name}`);

  const generate = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError("");
    const n = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
    if (!n) return;
    try {
      const r = await pb.collection("endpoints").create<Endpoint>({ name: n, kind: "auto", token: randomToken(), enabled: true });
      setMade(urlOf(r));
      setName("");
      void load();
    } catch (e) {
      setError(rows.some((x) => x.name === n) ? `“${n}” is taken, pick another name.` : e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="app">
      <Header nav={nav} />
      <main className="endpoints">
        <h1>Endpoints</h1>
        <form className="card gen" onSubmit={generate}>
          <h2>Generate a webhook URL</h2>
          <div className="gen-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name, e.g. hermes or my-repo" aria-label="Endpoint name" required autoFocus />
            <button className="btn primary">Generate</button>
          </div>
          <p className="muted">Paste it into LINE (Webhook URL), GitHub (Payload URL) or anything that can POST. The relay tells which it is. The URL is the password: keep it private.</p>
          {!baseSet && <p className="warn">No public address set, so this uses {base}. Set it in <a href="./_/#/settings" target="_blank" rel="noreferrer">PocketBase → Settings → Application URL</a>.</p>}
          {made && (
            <div className="made">
              <code>{made}</code> <CopyButton text={made} />
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </form>

        {rows.length > 0 && (
          <div className="card flush">
            <table>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={e.enabled ? "" : "off"}>
                    <td className="ep-name">{e.name}</td>
                    <td><code>{urlOf(e)}</code></td>
                    <td>
                      <CopyButton text={urlOf(e)} />
                      <button className="btn quiet small" onClick={() => pb.collection("endpoints").update(e.id, { enabled: !e.enabled }).then(load)}>
                        {e.enabled ? "Turn off" : "Turn on"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
