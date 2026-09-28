import { useEffect, useState } from "react";
import { checkAuth, haLogin, pb, signIn, type ChatRef } from "./pb.ts";
import { Chats } from "./Chats.tsx";
import { Stream } from "./Stream.tsx";
import { Endpoints } from "./Endpoints.tsx";
import { param, setParams } from "./hooks.ts";
import { Nav, type Page } from "./ui.tsx";

const PAGES: Page[] = ["chats", "stream", "endpoints"];
const pageFromUrl = (): Page => (PAGES.includes(param("view") as Page) ? (param("view") as Page) : "chats");

export function App() {
  const [authed, setAuthed] = useState(pb.authStore.isValid);
  useEffect(() => pb.authStore.onChange(() => setAuthed(pb.authStore.isValid)), []);
  // a stored session is checked with the server; without one, try the Home Assistant session (ingress)
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    void (async () => {
      await checkAuth();
      if (!pb.authStore.isValid) await haLogin();
      setStarting(false);
    })();
  }, []);
  const [page, setPageState] = useState<Page>(pageFromUrl);
  const setPage = (p: Page) => {
    setParams({ view: p === "chats" ? undefined : p });
    setPageState(p);
  };
  const openChat = (c: ChatRef) => {
    setParams({ view: undefined, p: c.provider, g: c.group_id });
    setPageState("chats");
  };

  if (!authed && starting) return <main className="login"><p className="muted">Signing in…</p></main>;
  if (!authed) return <Login />;
  const shown: Page = page === "endpoints" && !pb.authStore.isSuperuser ? "chats" : page;
  const nav = <Nav page={shown} setPage={setPage} />;
  if (shown === "endpoints") return <Endpoints nav={nav} />;
  if (shown === "stream") return <Stream nav={nav} onAddEndpoint={() => setPage("endpoints")} onOpenChat={openChat} />;
  return <Chats nav={nav} onAddEndpoint={() => setPage("endpoints")} />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = new URL(".", window.location.href).href.replace(/\/$/, "");
  return (
    <>
      <header className="topbar">
        <span className="brand">Message Relay <span>v3</span></span>
      </header>
      <main className="landing">
        <h1>Message Relay <span>v3</span></h1>
        <p className="muted">Webhook URLs in, live chats out. The URL is the auth. PocketBase underneath.</p>
        <section className="card landing-usage">
          <h2>Usage</h2>
          <pre><code>POST {base}/w/{"{name}"}/{"{token}"}</code></pre>
          <p className="muted">Webhook URLs are generated on the Endpoints page. LINE, GitHub or any JSON: the relay tells which it is.</p>
        </section>
        <form
          className="card landing-login"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await signIn(email, password);
            } catch {
              setError("Wrong email or password.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Sign in</h2>
          <input type="email" placeholder="Email" aria-label="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password" aria-label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      </main>
    </>
  );
}
