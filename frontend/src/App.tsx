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
  return (
    <main className="login">
      <form
        className="card"
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
        <h1>
          Message Relay <span>v3</span>
        </h1>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
