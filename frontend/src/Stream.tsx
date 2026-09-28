// Stream: every message as it arrives, newest first, across every chat — v1's Stream page. The same
// source / channel chips as Chats, plus a search of the words in the messages. A chat's name opens
// it in Chats; a sender's name renames them.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FIELDS, PAGE, pb, type ChatRef } from "./pb.ts";
import { buildFilter, emptyFilter, insertByTime, matches, olderThan, type Filter, type MessageRecord } from "./filter.ts";
import { chatName, counted, dayKey, dayLabel, eventText, shortId, sourceLabel, timeOf, TYPE_WORD } from "./chats.ts";
import { param, senderOf, setParams, useChats, useDebounced, useLive, useNames, useSlashFocus } from "./hooks.ts";
import { Facets } from "./Chats.tsx";
import { Avatar, FirstRun, Header, Icon, LiveStatus, Media, SourceBadge, senderColor } from "./ui.tsx";

export function Stream({ nav, onAddEndpoint, onOpenChat }: { nav: ReactNode; onAddEndpoint: () => void; onOpenChat: (c: ChatRef) => void }) {
  const { chats, refreshSoon } = useChats();
  const names = useNames();
  const [src, setSrc] = useState(() => ({ source: param("source"), channel: param("ch") }));
  const setSource = (next: { source: string; channel: string }) => {
    setParams({ source: next.source, ch: next.channel });
    setSrc(next);
  };
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 300);
  const active = useMemo<Filter>(() => {
    const f = emptyFilter();
    if (src.source) f.only.provider = [src.source];
    if (src.channel) f.only.channel = [src.channel];
    return { ...f, q };
  }, [src, q]);

  const [rows, setRows] = useState<MessageRecord[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const gen = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const doneRef = useRef(done);
  doneRef.current = done;

  const loadMore = useCallback(async (reset: boolean) => {
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
  }, []);

  useEffect(() => {
    setRows([]);
    setDone(false);
    void loadMore(true);
  }, [active, loadMore]);

  // live: new records that pass the filters go in at their time; a reconnect asks for what it missed
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
    setFresh((s) => new Set([...s, ...res.items.map((r) => r.id)]));
    refreshSoon();
  }, [refreshSoon]);
  const live = useLive(
    (r) => {
      refreshSoon();
      if (!matches(activeRef.current, r)) return;
      setRows((prev) => insertByTime(prev, r, doneRef.current));
      setFresh((s) => new Set(s).add(r.id));
    },
    () => void catchUp().catch(() => {}),
  );

  // more as the end of the list comes into view
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es[0]?.isIntersecting && !loading && !done && rowsRef.current.length > 0) void loadMore(false);
    }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, done, loadMore]);

  const input = useRef<HTMLInputElement>(null);
  useSlashFocus(input);

  const byChat = useMemo(() => new Map((chats ?? []).map((c) => [`${c.provider}/${c.group_id}`, c])), [chats]);
  const chatLabel = (r: MessageRecord) => {
    const c = byChat.get(`${r.provider}/${r.group_id}`);
    return (c && chatName(c)) || (r.group_label && r.group_label !== r.group_id ? r.group_label : "") || shortId(r.group_id);
  };
  // how many messages the source filter holds (no count once a channel or words narrow it further)
  const total = useMemo(() => {
    if (!chats || src.channel || q.trim()) return null;
    return chats.filter((c) => !src.source || c.provider === src.source).reduce((n, c) => n + c.n, 0);
  }, [chats, src, q]);
  const filtering = !!(src.source || src.channel || q.trim());
  const firstRun = chats?.length === 0 && done && rows.length === 0 && !filtering;

  return (
    <div className="app">
      <Header nav={nav} status={<LiveStatus live={live} />} />
      {firstRun ? (
        <FirstRun canAdd={pb.authStore.isSuperuser} onAdd={onAddEndpoint} />
      ) : (
        <main className="stream">
          <div className="stream-intro">
            <h1>Stream</h1>
            <p className="muted">Every message as it arrives, newest first. A chat's name opens it in Chats.</p>
          </div>
          <div className="card stream-filters">
            <label className="search">
              <Icon name="search" />
              <input ref={input} type="search" placeholder="Search the messages: words, sender, chat" value={search} aria-keyshortcuts="/"
                onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && search) { e.preventDefault(); setSearch(""); } }}
                aria-label="Search the messages" />
              <kbd aria-hidden="true">/</kbd>
            </label>
            {chats && <Facets chats={chats} f={src} set={setSource} />}
            <div className="stream-count" role="status">
              {total !== null ? <span>{counted(total, "message")}{src.source ? ` from ${sourceLabel(src.source)}` : ""}</span> : <span>{q.trim() ? `Messages with “${q.trim()}”` : "Filtered"}, newest first</span>}
              {filtering && <button className="btn small" onClick={() => { setSearch(""); setSource({ source: "", channel: "" }); }}>Clear filters</button>}
            </div>
          </div>

          <div className="card msgs">
            <ol className="slist" aria-label="Messages, newest first">
              {rows.map((r, i) => {
                const newDay = i === 0 || dayKey(rows[i - 1]!.ts) !== dayKey(r.ts);
                const who = senderOf(names, r);
                const event = eventText(r.type, who.name);
                return (
                  <Fragment key={r.id}>
                    {newDay && <li className="sep" role="separator"><span>{dayLabel(r.ts)}</span></li>}
                    <li className={fresh.has(r.id) ? "srow fresh" : "srow"}>
                      <time className="srow-time" dateTime={r.ts} title={r.ts}>{timeOf(r.ts)}</time>
                      <div className="srow-main">
                        <div className="srow-head">
                          <SourceBadge provider={r.provider} />
                          <button type="button" className="name srow-chat" title={`${r.group_id} · open this chat`}
                            onClick={() => onOpenChat({ provider: r.provider, group_id: r.group_id })}>
                            {chatLabel(r)}
                          </button>
                          <span className="tag">{r.channel}</span>
                        </div>
                        {event ? (
                          <p className="muted"><i>{event}</i></p>
                        ) : (
                          <div className="srow-body">
                            <button type="button" className="name who" style={{ color: senderColor(r.sender || who.name) }} title={`${r.sender} · click to rename`}
                              onClick={() => void names.rename("sender", r.provider, r.sender, who.name)}>
                              <Avatar src={who.picture} name={who.name} color={senderColor(r.sender || who.name)} size={20} />
                              <span>{who.name}</span>
                            </button>
                            <div className="content">
                              {r.text ? <p>{r.text}</p> : !r.media_kind && !r.expand?.attachments_via_message?.length && <p className="muted"><i>{TYPE_WORD[r.type] ?? r.type}</i></p>}
                              <Media r={r} />
                            </div>
                          </div>
                        )}
                      </div>
                    </li>
                  </Fragment>
                );
              })}
            </ol>
            <div ref={sentinel} className="msgs-foot">
              {error ? (
                <span className="error">{error}</span>
              ) : loading ? (
                <span className="muted">Loading…</span>
              ) : done && rows.length === 0 ? (
                <span className="muted">No message fits {q.trim() ? <>“{q.trim()}”</> : "these filters"}.</span>
              ) : done ? (
                <span className="muted mono">That's everything.</span>
              ) : null}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
