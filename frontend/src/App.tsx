import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aliases as loadAliases, checkAuth, haLogin, pb, facets as loadFacets, saveAlias, signIn, type Alias, type Facet } from "./pb.ts";
import { Endpoints } from "./Endpoints.tsx";
import { EMBEDDED, Header, Icon, Tabs, type Page } from "./ui.tsx";
import { buildFilter, emptyFilter, insertByTime, matches, olderThan, stateOf, toggle, type Dim, type Filter, type MessageRecord } from "./filter.ts";

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
  const [page, setPage] = useState<Page>("timeline");
  if (!authed && starting) return <main className="login"><p className="muted">Signing in…</p></main>;
  if (!authed) return <Login />;
  const nav = <Tabs page={page} setPage={setPage} />;
  return page === "endpoints" ? <Endpoints nav={nav} /> : <Timeline nav={nav} onAddEndpoint={() => setPage("endpoints")} />;
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

/** A media query as state. */
function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

const PANEL_KEY = "relay_filters_panel";

function Timeline({ nav, onAddEndpoint }: { nav: ReactNode; onAddEndpoint: () => void }) {
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

  // Filters: a side panel only on a wide standalone screen (and only while it's kept open); inside
  // Home Assistant or on a narrow screen, a Filters button in the header opens the same panel as a popover.
  const wide = useMedia("(min-width: 1100px)");
  const [panelPref, setPanelPref] = useState(() => localStorage.getItem(PANEL_KEY) ?? "open");
  const setPanel = (v: "open" | "closed") => { localStorage.setItem(PANEL_KEY, v); setPanelPref(v); };
  const sidePanel = !EMBEDDED && wide && panelPref === "open";
  const [popover, setPopover] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => { if (pop.current && !pop.current.contains(e.target as Node)) setPopover(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPopover(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [popover]);
  useEffect(() => { if (sidePanel) setPopover(false); }, [sidePanel]);

  const chips = useMemo(() => {
    const out: { dim: Dim; value: string; mode: "only" | "hide"; label: string }[] = [];
    for (const mode of ["only", "hide"] as const)
      for (const dim of ["provider", "channel", "group_id"] as const)
        for (const value of filter[mode][dim]) {
          const g = dim === "group_id" ? groups.find((x) => x.group_id === value) : undefined;
          out.push({ dim, value, mode, label: g ? labelOf(g) : value });
        }
    return out;
  }, [filter, groups, labelOf]);
  const filtering = chips.length > 0 || q.trim() !== "";
  const firstRun = done && !loading && !error && rows.length === 0 && groups.length === 0 && !filtering;

  const panel = (
    <FiltersPanel
      groups={groups}
      filter={filter}
      labelOf={labelOf}
      onToggle={(d, v, m) => setFilter((f) => toggle(f, d, v, m))}
      onClear={chips.length ? () => setFilter(emptyFilter()) : undefined}
      onCollapse={sidePanel ? () => setPanel("closed") : undefined}
    />
  );

  return (
    <div className="app">
      <Header
        nav={nav}
        tools={
          <>
            <label className="search">
              <Icon name="search" />
              <input type="search" placeholder="Search text, sender, group…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search messages" />
            </label>
            {!sidePanel && (
              <div className="pop-anchor" ref={pop}>
                <button className={popover ? "btn on" : "btn"} aria-expanded={popover} aria-haspopup="dialog" onClick={() => setPopover((v) => !v)}>
                  <Icon name="filter" /> Filters{chips.length > 0 && <span className="count">{chips.length}</span>}
                </button>
                {!EMBEDDED && wide && (
                  <button className="btn icon-only" title="Keep filters open at the side" aria-label="Keep filters open at the side" onClick={() => setPanel("open")}>
                    <Icon name="panel" />
                  </button>
                )}
                {popover && <div className="popover" role="dialog" aria-label="Filters">{panel}</div>}
              </div>
            )}
          </>
        }
        status={
          <span className={live ? "live on" : "live"} role="status" title={live ? "Receiving new messages as they arrive" : "Connection lost, reconnecting"}>
            <span className="dot" aria-hidden="true" />
            {live ? "Live" : "Reconnecting…"}
          </span>
        }
      />
      {!sidePanel && chips.length > 0 && (
        <div className="chips" aria-label="Active filters">
          {chips.map((c) => (
            <button key={c.mode + c.dim + c.value} className={`chip ${c.mode}`} onClick={() => setFilter((f) => toggle(f, c.dim, c.value, c.mode))} title="Remove this filter">
              <span className="chip-mode">{c.mode}</span> {c.label} <Icon name="x" />
            </button>
          ))}
          <button className="btn quiet" onClick={() => setFilter(emptyFilter())}>Clear all</button>
        </div>
      )}
      <div className={sidePanel ? "layout with-panel" : "layout"}>
        {sidePanel && <aside className="panel">{panel}</aside>}
        <main className="feed">
          {firstRun ? (
            <FirstRun canAdd={pb.authStore.isSuperuser} onAdd={onAddEndpoint} />
          ) : (
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
                          return pic ? <img className="avatar" src={pic} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : <span className="avatar blank" aria-hidden="true" />;
                        })()}
                        <span className="sender-name">{alias("sender", r, r.sender)?.label || r.sender_label || r.sender || "—"}</span>
                      </button>
                      <div className="content">
                        {r.text ? <p>{r.text}</p> : !r.media_kind && <p className="muted">[{r.type}]</p>}
                        <Media r={r} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div ref={sentinel} className="foot">
            {error ? (
              <span className="error">{error}</span>
            ) : loading ? (
              <span className="muted">Loading…</span>
            ) : done && rows.length === 0 && !firstRun ? (
              <div className="empty">
                <p className="empty-title">Nothing matches</p>
                <p className="muted">No message fits {q.trim() ? <>“{q.trim()}”</> : "these filters"}{q.trim() && chips.length ? " with these filters" : ""}.</p>
                <div className="empty-actions">
                  {q.trim() && <button className="btn" onClick={() => setSearch("")}>Clear search</button>}
                  {chips.length > 0 && <button className="btn" onClick={() => setFilter(emptyFilter())}>Clear filters</button>}
                </div>
              </div>
            ) : done && rows.length > 0 ? (
              <span className="muted">That's everything.</span>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

/** A fresh install: nothing has arrived yet. Say how messages get here, and where to start. */
function FirstRun({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <h2 id="first-run-title">No messages yet</h2>
      <p>
        Messages arrive by webhook. Add an endpoint, paste its URL into LINE, GitHub or anything that can POST, and every
        message shows up here the moment it lands.
      </p>
      <pre className="pattern"><span className="muted">POST</span> …/w/<b>line</b>|<b>github</b>|<b>generic</b>/<b>&lt;name&gt;</b></pre>
      {canAdd ? (
        <button className="btn primary" onClick={onAdd}><Icon name="plus" /> Add an endpoint</button>
      ) : (
        <p className="muted">An admin adds endpoints on the Endpoints page.</p>
      )}
    </section>
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
          <p key={m.key} className="muted" title="the source no longer has it, and no copy was made">[{m.kind} gone]</p>
        ) : !m.thumb ? (
          m.full ? <a key={m.key} className="file" href={m.full} target="_blank" rel="noreferrer">[{m.kind}] open</a> : <p key={m.key} className="muted">[{m.kind}]</p>
        ) : (
          <a key={m.key} className={`media m-${m.kind}`} href={m.full} target="_blank" rel="noreferrer" title={m.stored ? "stored copy" : "source link"}>
            <img src={m.thumb} alt={m.kind} loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
            {m.kind === "video" && <span className="play"><Icon name="play" /></span>}
          </a>
        ),
      )}
    </>
  );
}

function FiltersPanel(props: {
  groups: Facet[];
  filter: Filter;
  labelOf: (g: Facet) => string;
  onToggle: (d: Dim, v: string, m: "only" | "hide") => void;
  onClear?: () => void;
  onCollapse?: () => void;
}) {
  const [find, setFind] = useState("");
  return (
    <div className="filters">
      <div className="filters-head">
        <span className="filters-title">Filters</span>
        {props.onClear && <button className="btn quiet" onClick={props.onClear}>Clear</button>}
        {props.onCollapse && (
          <button className="btn icon-only quiet" onClick={props.onCollapse} title="Hide the filter panel" aria-label="Hide the filter panel">
            <Icon name="chevron" className="flip" />
          </button>
        )}
      </div>
      {props.groups.length > 12 && (
        <label className="search small">
          <Icon name="search" />
          <input type="search" placeholder="Find a source or group…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a source or group" />
        </label>
      )}
      {props.groups.length === 0 ? (
        <p className="muted filters-empty">Sources and groups appear here as messages arrive.</p>
      ) : (
        <Facets {...props} query={find} />
      )}
    </div>
  );
}

function Facets(props: {
  groups: Facet[];
  filter: Filter;
  labelOf: (g: Facet) => string;
  onToggle: (d: Dim, v: string, m: "only" | "hide") => void;
  query: string;
}) {
  const { groups, filter, onToggle, labelOf } = props;
  const q = props.query.trim().toLowerCase();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const hit = (...xs: string[]) => !q || xs.some((x) => x.toLowerCase().includes(q));
    const t = new Map<string, { n: number; channels: Map<string, { n: number; groups: Facet[] }> }>();
    for (const g of groups) {
      if (!hit(g.provider, g.channel, labelOf(g), g.group_id)) continue;
      const p = t.get(g.provider) ?? { n: 0, channels: new Map() };
      p.n += g.n;
      const c = p.channels.get(g.channel) ?? { n: 0, groups: [] };
      c.n += g.n;
      c.groups.push(g);
      p.channels.set(g.channel, c);
      t.set(g.provider, p);
    }
    return t;
  }, [groups, q, labelOf]);
  const isOpen = (k: string) => q !== "" || open.has(k); // while finding, every match is shown opened
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  if (!tree.size) return <p className="muted filters-empty">Nothing called “{props.query.trim()}”.</p>;
  return (
    <nav className="facets" aria-label="Sources and groups">
      {[...tree].map(([prov, p]) => (
        <div key={prov} className="lvl0">
          <Row label={prov} n={p.n} state={stateOf(filter, "provider", prov)} onToggle={(m) => onToggle("provider", prov, m)}
            open={isOpen(prov)} onOpen={() => flip(prov)} />
          {isOpen(prov) &&
            [...p.channels].map(([chan, c]) => (
              <div key={chan} className="lvl1">
                <Row label={chan || "—"} n={c.n} state={stateOf(filter, "channel", chan)} onToggle={(m) => onToggle("channel", chan, m)}
                  open={isOpen(prov + "/" + chan)} onOpen={() => flip(prov + "/" + chan)} />
                {isOpen(prov + "/" + chan) &&
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
        <button className="twisty" onClick={onOpen} aria-expanded={open} aria-label={open ? `Collapse ${label}` : `Expand ${label}`}>
          <Icon name="chevron" className={open ? "down" : ""} />
        </button>
      ) : <span className="twisty" />}
      <span className="name" title={title ?? label}>{label}</span>
      <span className="n">{n.toLocaleString()}</span>
      <span className="togs">
        <button className={state === "only" ? "tog on" : "tog"} aria-pressed={state === "only"} onClick={() => onToggle("only")} title={`Show only ${label}`}>only</button>
        <button className={state === "hide" ? "tog on" : "tog"} aria-pressed={state === "hide"} onClick={() => onToggle("hide")} title={`Hide ${label}`}>hide</button>
      </span>
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
