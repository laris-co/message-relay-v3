import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aliases as loadAliases, checkAuth, haLogin, openDashboard, pb, facets as loadFacets, saveAlias, signIn, type Alias, type Facet } from "./pb.ts";
import { Endpoints } from "./Endpoints.tsx";
import { buildFilter, emptyFilter, insertByTime, isEmpty, matches, olderThan, stateOf, toggle, type Dim, type Filter, type MessageRecord } from "./filter.ts";

const PAGE = 50;
const FIELDS =
  "id,collectionId,ts,provider,endpoint,channel,group_id,group_label,sender,sender_label,type,text,reply_to,source_event_id," +
  "sender_picture,media_kind,thumb_url,media_url,expand.attachments_via_message";

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
  const [page, setPage] = useState<"timeline" | "endpoints">("timeline");
  if (!authed && starting) return <main className="login"><p className="type">Signing in…</p></main>;
  if (!authed) return <Login />;
  return (
    <>
      {pb.authStore.isSuperuser && (
        <nav className="pages">
          <button className={page === "timeline" ? "on" : ""} onClick={() => setPage("timeline")}>Timeline</button>
          <button className={page === "endpoints" ? "on" : ""} onClick={() => setPage("endpoints")}>Endpoints</button>
        </nav>
      )}
      {page === "endpoints" ? <Endpoints /> : <Timeline />}
    </>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <form
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
        <h1>message-relay v3</h1>
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

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Timeline() {
  const [filter, setFilter] = useState<Filter>(emptyFilter);
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 300);
  const active = useMemo(() => ({ ...filter, q }), [filter, q]);

  const [rows, setRows] = useState<MessageRecord[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Facet[]>([]);
  const [names, setNames] = useState<Map<string, Alias>>(new Map());
  const refreshNames = useCallback(() => loadAliases().then(setNames).catch(() => {}), []);
  useEffect(() => void refreshNames(), [refreshNames]);
  const alias = (kind: "sender" | "group", r: { provider: string }, value: string) =>
    names.get(`${kind}\t${r.provider}\t${value}`) ?? names.get(`${kind}\t\t${value}`);
  const rename = async (kind: "sender" | "group", r: MessageRecord) => {
    const value = kind === "sender" ? r.sender : r.group_id;
    const a = alias(kind, r, value);
    const label = window.prompt(`Name for ${value}`, a?.label ?? (kind === "sender" ? r.sender_label : r.group_label) ?? "");
    if (!label || label === a?.label) return;
    await saveAlias(kind, r.provider, value, label.trim(), a);
    await refreshNames();
    setRows((prev) => prev.map((x) => ((kind === "sender" ? x.sender : x.group_id) === value && x.provider === r.provider
      ? { ...x, [kind === "sender" ? "sender_label" : "group_label"]: label.trim() } : x)));
    void refreshFacets();
  };
  const gen = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshFacets = useCallback(() => loadFacets().then(setGroups).catch(() => {}), []);
  useEffect(() => void refreshFacets(), [refreshFacets]);
  // a bulk import fires one realtime event per row: refresh the counts at most every 3 s
  const facetsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const facetsSoon = useCallback(() => {
    if (facetsTimer.current) return;
    facetsTimer.current = setTimeout(() => {
      facetsTimer.current = null;
      void refreshFacets();
    }, 3000);
  }, [refreshFacets]);

  const loadMore = useCallback(
    async (reset: boolean) => {
      const my = reset ? ++gen.current : gen.current;
      setLoading(true);
      setError("");
      try {
        const f = buildFilter(activeRef.current);
        const parts = f.expr ? [f.expr] : [];
        let params = f.params;
        const last = reset ? undefined : rowsRef.current[rowsRef.current.length - 1];
        if (last) {
          const k = olderThan(last);
          parts.push(k.expr);
          params = { ...params, ...k.params };
        }
        const res = await pb.collection("messages").getList<MessageRecord>(1, PAGE, {
          sort: "-ts,-id",
          filter: parts.length ? pb.filter(parts.join(" && "), params) : "",
          fields: FIELDS,
          expand: "attachments_via_message",
          skipTotal: true,
        });
        if (my !== gen.current) return;
        setRows((prev) => (reset ? res.items : [...prev, ...res.items]));
        setDone(res.items.length < PAGE);
      } catch (e) {
        if (my === gen.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (my === gen.current) setLoading(false);
      }
    },
    [],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    setRows([]);
    setDone(false);
    void loadMore(true);
  }, [active, loadMore]);

  // live: new records that pass the current filter go in at their time. The SSE connection drops now
  // and then (idle timeout, sleep, server restart) and the SDK reconnects; events in the gap are not
  // replayed, so every reconnect catches up by asking for anything newer than the top row.
  const catchUp = useCallback(async () => {
    const newest = rowsRef.current[0];
    if (!newest) return;
    const f = buildFilter(activeRef.current);
    const parts = f.expr ? [f.expr, "ts > {:since}"] : ["ts > {:since}"];
    const res = await pb.collection("messages").getList<MessageRecord>(1, 200, {
      sort: "-ts,-id",
      filter: pb.filter(parts.join(" && "), { ...f.params, since: newest.ts }),
      fields: FIELDS,
      expand: "attachments_via_message",
      skipTotal: true,
    });
    if (!res.items.length) return;
    setRows((prev) => res.items.reduce((acc, r) => insertByTime(acc, r, doneRef.current), prev));
    setFresh((s) => { const n = new Set(s); res.items.forEach((r) => n.add(r.id)); return n; });
    facetsSoon();
  }, [facetsSoon]);

  useEffect(() => {
    let unsubMsgs: (() => void) | undefined;
    let unsubConnect: (() => void) | undefined;
    let connectedOnce = false;
    pb.realtime.onDisconnect = () => setLive(false);
    pb.realtime
      .subscribe("PB_CONNECT", () => {
        setLive(true);
        if (connectedOnce) void catchUp().catch(() => {});
        connectedOnce = true;
      })
      .then((u) => (unsubConnect = u));
    pb.collection("messages")
      .subscribe<MessageRecord>("*", (e) => {
        if (e.action !== "create") return;
        facetsSoon();
        if (!matches(activeRef.current, e.record)) return;
        setRows((prev) => insertByTime(prev, e.record, doneRef.current));
        setFresh((s) => new Set(s).add(e.record.id));
      })
      .then((u) => {
        unsubMsgs = u;
        setLive(true);
      })
      .catch(() => setLive(false));
    return () => {
      setLive(false);
      unsubMsgs?.();
      unsubConnect?.();
      pb.realtime.onDisconnect = undefined;
    };
  }, [facetsSoon, catchUp]);

  // infinite scroll
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es[0]?.isIntersecting && !loading && !done && rowsRef.current.length > 0) void loadMore(false);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, done, loadMore]);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) if (g.group_label) m.set(g.provider + "\t" + g.group_id, g.group_label);
    return (r: { provider: string; group_id: string; group_label?: string }) =>
      r.group_label || m.get(r.provider + "\t" + r.group_id) || r.group_id;
  }, [groups]);

  return (
    <div className="shell">
      <aside>
        <header className="brand">
          <strong>message-relay</strong> <span>v3</span>
        </header>
        <Facets groups={groups} filter={filter} labelOf={labelOf} onToggle={(d, v, m) => setFilter((f) => toggle(f, d, v, m))} />
        {!isEmpty({ ...filter, q: "" }) && (
          <button className="clear" onClick={() => setFilter(emptyFilter())}>
            Clear filters
          </button>
        )}
      </aside>
      <main>
        <div className="bar">
          <input
            type="search"
            placeholder="Search text, sender, group…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
          <span className={live ? "live on" : "live"} title={live ? "Receiving new messages" : "Not connected"}>
            {live ? "● live" : "○ reconnecting…"}
          </span>
          {pb.authStore.isSuperuser && (
            <button className="link" onClick={openDashboard} title="PocketBase dashboard (collections, logs, backups, settings)">
              PocketBase ↗
            </button>
          )}
          <button className="link" onClick={() => pb.authStore.clear()}>
            Sign out
          </button>
        </div>
        <ol className="timeline">
          {rows.map((r, i) => {
            const day = dayOf(r.ts);
            const newDay = i === 0 || dayOf(rows[i - 1]!.ts) !== day;
            return (
              <li key={r.id} className={fresh.has(r.id) ? "msg fresh" : "msg"}>
                {newDay && <h2 className="day">{day}</h2>}
                <div className="meta">
                  <time dateTime={r.ts} title={r.ts}>{timeOf(r.ts)}</time>
                  <span className={`prov p-${r.provider}`}>{r.provider}</span>
                  <span className="chan">{r.channel}</span>
                  <button className="grp name" title={`${r.group_id} · click to rename`} onClick={() => void rename("group", r)}>{labelOf(r)}</button>
                </div>
                <div className="body">
                  <button className="sender name" title={`${r.sender} · click to rename`} onClick={() => void rename("sender", r)}>
                    {(() => {
                      const a = alias("sender", r, r.sender);
                      const pic = (a?.picture && pb.files.getURL(a, a.picture, { thumb: "64x64" })) || r.sender_picture;
                      return pic ? <img className="avatar" src={pic} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : null;
                    })()}
                    {alias("sender", r, r.sender)?.label || r.sender_label || r.sender || "—"}
                  </button>
                  <div>
                    {r.text ? <p>{r.text}</p> : !r.media_kind && <p className="type">[{r.type}]</p>}
                    <Media r={r} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <div ref={sentinel} className="foot">
          {error ? <span className="error">{error}</span> : loading ? "Loading…" : done ? (rows.length ? "End of timeline" : "No messages match") : ""}
        </div>
      </main>
    </div>
  );
}

/** A message's pictures: from its `attachments` (our copy first, else the source link); before the
 * attachment exists, the links on the message itself. */
function Media({ r }: { r: MessageRecord }) {
  const atts = r.expand?.attachments_via_message ?? [];
  if (!atts.length && !r.media_kind) return null;
  const list = atts.length
    ? atts.map((a) => ({
        key: a.id,
        kind: a.kind,
        gone: a.status === "gone" && !a.thumb && !a.file,
        stored: Boolean(a.thumb || a.file),
        thumb: (a.thumb && pb.files.getURL(a, a.thumb)) || a.thumb_url,
        full: (a.file && pb.files.getURL(a, a.file)) || a.source_url || (a.thumb && pb.files.getURL(a, a.thumb)) || a.thumb_url,
      }))
    : [{ key: r.id, kind: r.media_kind!, gone: false, stored: false, thumb: r.thumb_url || "", full: r.media_url || r.thumb_url || "" }];
  return (
    <>
      {list.map((m) =>
        m.gone ? (
          <p key={m.key} className="type" title="the source no longer has it, and no copy was made">[{m.kind} gone]</p>
        ) : !m.thumb ? (
          m.full ? <a key={m.key} className="file" href={m.full} target="_blank" rel="noreferrer">[{m.kind}] open</a> : <p key={m.key} className="type">[{m.kind}]</p>
        ) : (
          <a key={m.key} className={`media m-${m.kind}`} href={m.full} target="_blank" rel="noreferrer" title={m.stored ? "stored copy" : "source link"}>
            <img src={m.thumb} alt={m.kind} loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
            {m.kind === "video" && <span className="play">▶</span>}
          </a>
        ),
      )}
    </>
  );
}

function Facets(props: {
  groups: Facet[];
  filter: Filter;
  labelOf: (g: Facet) => string;
  onToggle: (d: Dim, v: string, m: "only" | "hide") => void;
}) {
  const { groups, filter, onToggle, labelOf } = props;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const t = new Map<string, { n: number; channels: Map<string, { n: number; groups: Facet[] }> }>();
    for (const g of groups) {
      const p = t.get(g.provider) ?? { n: 0, channels: new Map() };
      p.n += g.n;
      const c = p.channels.get(g.channel) ?? { n: 0, groups: [] };
      c.n += g.n;
      c.groups.push(g);
      p.channels.set(g.channel, c);
      t.set(g.provider, p);
    }
    return t;
  }, [groups]);
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <nav className="facets" aria-label="Filter">
      {[...tree].map(([prov, p]) => (
        <div key={prov} className="lvl0">
          <Row label={prov} n={p.n} state={stateOf(filter, "provider", prov)} onToggle={(m) => onToggle("provider", prov, m)}
            open={open.has(prov)} onOpen={() => flip(prov)} />
          {open.has(prov) &&
            [...p.channels].map(([chan, c]) => (
              <div key={chan} className="lvl1">
                <Row label={chan || "—"} n={c.n} state={stateOf(filter, "channel", chan)} onToggle={(m) => onToggle("channel", chan, m)}
                  open={open.has(prov + "/" + chan)} onOpen={() => flip(prov + "/" + chan)} />
                {open.has(prov + "/" + chan) &&
                  c.groups.map((g) => (
                    <div key={g.group_id} className="lvl2">
                      <Row label={labelOf(g)} title={g.group_id} n={g.n} state={stateOf(filter, "group_id", g.group_id)}
                        onToggle={(m) => onToggle("group_id", g.group_id, m)} />
                    </div>
                  ))}
              </div>
            ))}
        </div>
      ))}
    </nav>
  );
}

function Row(props: {
  label: string; title?: string; n: number; state: "only" | "hide" | null;
  onToggle: (m: "only" | "hide") => void; open?: boolean; onOpen?: () => void;
}) {
  const { label, title, n, state, onToggle, open, onOpen } = props;
  return (
    <div className={`row ${state ?? ""}`}>
      {onOpen ? (
        <button className="twisty" onClick={onOpen} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▸"}
        </button>
      ) : <span className="twisty" />}
      <span className="name" title={title ?? label}>{label}</span>
      <span className="n">{n.toLocaleString()}</span>
      <button className={state === "only" ? "tog on" : "tog"} onClick={() => onToggle("only")} title="Show only this">only</button>
      <button className={state === "hide" ? "tog on" : "tog"} onClick={() => onToggle("hide")} title="Hide this">hide</button>
    </div>
  );
}

const BKK = "Asia/Bangkok";
const parse = (ts: string) => new Date(ts.replace(" ", "T"));
function dayOf(ts: string): string {
  return parse(ts).toLocaleDateString("en-GB", { timeZone: BKK, weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function timeOf(ts: string): string {
  return parse(ts).toLocaleTimeString("en-GB", { timeZone: BKK, hour: "2-digit", minute: "2-digit" });
}
