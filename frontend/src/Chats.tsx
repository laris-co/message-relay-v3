// Chats: the conversation list and one conversation — v2's Explorer ("Conversations") in v1's Chat
// layout. Left: search ("/" jumps to it), the filter chips (source, then each source's channels,
// with counts) and the list, newest activity first (↑↓ walk it). Right: the open chat — its name,
// id, counts and channels, then its messages newest first, in runs per sender, with day separators;
// new ones arrive live. Filters and the open chat live in the URL. On a narrow screen the list and
// the chat take turns, and the chips fold behind "Filters".
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FIELDS, PAGE, chatKey, pb, sameChat, type Chat, type ChatRef } from "./pb.ts";
import { insertByTime, olderThan, type MessageRecord } from "./filter.ts";
import {
  channelRows, channelsOf, chatName, counted, dayKey, dayLabel, eventText, filterChats, isFiltered, lastSeen, noFilters, previewOf,
  shortId, sourceChips, sourceLabel, spanOf, timeOf, TYPE_WORD, type Filters,
} from "./chats.ts";
import { param, senderOf, setParams, useChats, useLive, useMedia, useNames, useSlashFocus, type Names } from "./hooks.ts";
import { Avatar, CopyButton, FilterChip, FilterRow, FirstRun, Header, Icon, LiveStatus, Media, SourceBadge, senderColor } from "./ui.tsx";

const NARROW = "(max-width: 900px)";

const readFilters = (): Filters => ({ source: param("source"), channel: param("ch"), q: param("q") });
const readOpen = (): ChatRef | null => (param("g") ? { provider: param("p"), group_id: param("g") } : null);

/** The source row and a channel row per source: the same chips on Chats and Stream. */
export function Facets({ chats, f, set }: { chats: readonly Chat[]; f: Pick<Filters, "source" | "channel">; set: (next: { source: string; channel: string }) => void }) {
  const sources = useMemo(() => sourceChips(chats), [chats]);
  const rows = useMemo(() => channelRows(chats, f.source, f.channel), [chats, f.source, f.channel]);
  return (
    <div className="facets">
      {sources.length > 1 && (
        <FilterRow name="Source">
          <FilterChip on={!f.source} onClick={() => set({ source: "", channel: "" })}>All</FilterChip>
          {sources.map((s) => (
            <FilterChip key={s.value} on={f.source === s.value} count={s.n} title={`Only ${sourceLabel(s.value)}`}
              onClick={() => set({ source: f.source === s.value ? "" : s.value, channel: "" })}>
              {sourceLabel(s.value)}
            </FilterChip>
          ))}
        </FilterRow>
      )}
      {rows.map((r) => (
        <FilterRow key={r.source} name={sourceLabel(r.source)}>
          {r.chips.map((c) => (
            <FilterChip key={c.value} mono on={f.channel === c.value} count={c.n} title={`Came in on ${c.value}`}
              onClick={() => set({ source: f.source, channel: f.channel === c.value ? "" : c.value })}>
              {c.value}
            </FilterChip>
          ))}
        </FilterRow>
      ))}
    </div>
  );
}

export function Chats({ nav, onAddEndpoint }: { nav: ReactNode; onAddEndpoint: () => void }) {
  const { chats, error, refresh, refreshSoon } = useChats();
  const names = useNames();
  const live = useLive(refreshSoon, refreshSoon);
  const narrow = useMedia(NARROW);

  const [f, setF] = useState<Filters>(readFilters);
  const setFilters = (next: Filters) => {
    setParams({ source: next.source, ch: next.channel, q: next.q });
    setF(next);
  };
  const [open, setOpen] = useState<ChatRef | null>(readOpen);
  const openChat = useCallback((c: ChatRef | null) => {
    setParams({ p: c?.provider, g: c?.group_id });
    setOpen(c && { provider: c.provider, group_id: c.group_id });
  }, []);

  const shown = useMemo(() => (chats ? filterChats(chats, f) : []), [chats, f]);
  const filtered = isFiltered(f);
  // a wide screen always has a chat open: the newest one the filters let through (as v1 and v2 do)
  useEffect(() => {
    if (!open && !narrow && shown[0]) openChat(shown[0]);
  }, [open, narrow, shown, openChat]);
  const current = (open && chats?.find((c) => sameChat(c, open))) || null;
  const outside = !!open && !!chats && filtered && !shown.some((c) => sameChat(c, open));

  const search = useRef<HTMLInputElement>(null);
  useSlashFocus(search);
  const list = useRef<HTMLUListElement>(null);
  const focusRow = (step: 1 | -1 | 0) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.conv") ?? [])];
    const i = step === 0 ? -1 : items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[Math.min(items.length - 1, Math.max(0, i + (step || 1)))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    focusRow(e.key === "ArrowDown" ? 1 : -1);
  };

  const [facetsOpen, setFacetsOpen] = useState(false);
  const on = [f.source, f.channel].filter(Boolean).length;

  if (chats && chats.length === 0 && !error) {
    return (
      <div className="app">
        <Header nav={nav} status={<LiveStatus live={live} />} />
        <FirstRun canAdd={pb.authStore.isSuperuser} onAdd={onAddEndpoint} />
      </div>
    );
  }

  const total = shown.reduce((n, c) => n + c.n, 0);
  return (
    <div className="app">
      <Header nav={nav} status={<LiveStatus live={live} />} />
      <div className={`chats${narrow ? (open ? " show-pane" : " show-list") : ""}`}>
        <aside className="card side" aria-label="Chats">
          <div className="side-head">
            <label className="search">
              <Icon name="search" />
              <input ref={search} type="search" value={f.q} placeholder="Search name, id or channel" aria-label="Search chats by name, id or channel"
                aria-keyshortcuts="/" onChange={(e) => setFilters({ ...f, q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && f.q) { e.preventDefault(); setFilters({ ...f, q: "" }); }
                  if (e.key === "ArrowDown") { e.preventDefault(); focusRow(0); }
                }} />
              <kbd aria-hidden="true">/</kbd>
            </label>
            {narrow && (
              <button type="button" className="btn small" aria-expanded={facetsOpen} onClick={() => setFacetsOpen((o) => !o)}>
                {facetsOpen ? "Hide filters" : "Filters"}{on ? ` (${on} on)` : ""}
              </button>
            )}
            {chats && (!narrow || facetsOpen) && <Facets chats={chats} f={f} set={(s) => setFilters({ ...f, ...s })} />}
          </div>
          <div className="side-list">
            {!chats ? (
              error ? <p className="error pad">{error} <button className="btn small" onClick={() => void refresh()}>Retry</button></p> : <p className="muted pad">Loading chats…</p>
            ) : shown.length === 0 ? (
              <p className="muted pad">No chat matches.</p>
            ) : (
              <ul ref={list} onKeyDown={onListKey} aria-label="Chats, newest activity first">
                {shown.map((c) => (
                  <li key={chatKey(c)}>
                    <ChatRow c={c} on={!!open && sameChat(c, open)} onOpen={() => openChat(c)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          {chats && (
            <div className="side-foot" role="status">
              <span>{counted(shown.length, "chat")}</span>
              <span>· {counted(total, "message")}</span>
              {filtered && <button className="btn small" onClick={() => setFilters(noFilters())}>Clear filters</button>}
            </div>
          )}
        </aside>

        <section className="pane" aria-label="Conversation">
          {narrow && open && (
            <button type="button" className="btn small back" onClick={() => openChat(null)}>
              <Icon name="chevron" className="flip" /> All chats
            </button>
          )}
          {outside && (
            <div className="card note" role="status">
              <span>This chat is not in the current filter.</span>
              <button className="btn small" onClick={() => setFilters(noFilters())}>Clear filters</button>
            </div>
          )}
          {open ? (
            <Conversation key={chatKey(open)} at={open} chat={current} names={names} onRenamed={() => void refresh()} />
          ) : chats && !narrow && shown.length === 0 ? (
            <div className="card pad muted">Nothing to open — change the filters.</div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ChatRow({ c, on, onOpen }: { c: Chat; on: boolean; onOpen: () => void }) {
  const name = chatName(c);
  const span = spanOf(c.first_ts, c.last_ts);
  const preview = previewOf(c.last_text);
  return (
    <button type="button" className="conv" aria-current={on || undefined} onClick={onOpen} title={c.group_id}>
      <span className="conv-top">
        <span className={name ? "conv-name" : "conv-name mono"}>{name || shortId(c.group_id)}</span>
        <time className="conv-time" dateTime={c.last_ts}>{lastSeen(c.last_ts)}</time>
      </span>
      <span className="conv-last">
        {c.last_sender && <span className="conv-who">{shortId(c.last_sender)}: </span>}
        {preview.word ? <i>{preview.text}</i> : preview.text}
      </span>
      <span className="conv-foot">
        <SourceBadge provider={c.provider} />
        {channelsOf(c).map((ch) => <span key={ch} className="tag">{ch}</span>)}
        <span className="conv-n">{c.n.toLocaleString("en")}{span ? ` · ${span}` : ""}</span>
      </span>
    </button>
  );
}

/** The open chat: header card, then its messages newest first (more load as you scroll), live. */
function Conversation({ at, chat, names, onRenamed }: { at: ChatRef; chat: Chat | null; names: Names; onRenamed: () => void }) {
  const [rows, setRows] = useState<MessageRecord[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const doneRef = useRef(done);
  doneRef.current = done;
  const busy = useRef(false);
  const where = useMemo(() => pb.filter("provider = {:p} && group_id = {:g}", { p: at.provider, g: at.group_id }), [at.provider, at.group_id]);

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const last = rowsRef.current[rowsRef.current.length - 1];
      const k = last && olderThan(last);
      const res = await pb.collection("messages").getList<MessageRecord>(1, PAGE, {
        sort: "-ts,-id",
        filter: k ? `${where} && ${pb.filter(k.expr, k.params)}` : where,
        fields: FIELDS,
        expand: "attachments_via_message",
        skipTotal: true,
      });
      setRows((prev) => {
        const have = new Set(prev.map((r) => r.id));
        return [...prev, ...res.items.filter((r) => !have.has(r.id))];
      });
      setDone(res.items.length < PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [where]);
  useEffect(() => void loadMore(), [loadMore]);

  // more as the end of the list comes into view
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || loading || !rows.length) return;
    const io = new IntersectionObserver((es) => void (es[0]?.isIntersecting && loadMore()), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [done, loading, rows.length, loadMore]);

  const catchUp = useCallback(async () => {
    const newest = rowsRef.current[0];
    if (!newest) return;
    const res = await pb.collection("messages").getList<MessageRecord>(1, 200, {
      sort: "-ts,-id",
      filter: `${where} && ${pb.filter("ts > {:t}", { t: newest.ts })}`,
      fields: FIELDS,
      expand: "attachments_via_message",
      skipTotal: true,
    });
    if (!res.items.length) return;
    setRows((prev) => res.items.reduce((acc, r) => insertByTime(acc, r, doneRef.current), prev));
    setFresh((s) => new Set([...s, ...res.items.map((r) => r.id)]));
  }, [where]);
  useLive(
    (r) => {
      if (!sameChat(r, at)) return;
      setRows((prev) => insertByTime(prev, r, doneRef.current));
      setFresh((s) => new Set(s).add(r.id));
    },
    () => void catchUp().catch(() => {}),
  );

  const name = chat ? chatName(chat) : "";
  const channels = chat ? channelsOf(chat) : [];
  const span = chat ? spanOf(chat.first_ts, chat.last_ts) : "";
  const renameGroup = async () => {
    if (await names.rename("group", at.provider, at.group_id, name)) onRenamed();
  };

  return (
    <>
      <header className="card pane-head">
        <div className="pane-title">
          <h1 title={at.group_id}>{name || <span className="mono">{shortId(at.group_id)}</span>}</h1>
          <SourceBadge provider={at.provider} />
          <button type="button" className="btn small push" onClick={() => void renameGroup()}>Rename</button>
        </div>
        <div className="pane-meta">
          <code className="id">{at.group_id}</code>
          <CopyButton text={at.group_id} label="Copy id" />
          {chat && (
            <span className="mono">
              {counted(chat.n, "message")}{span ? ` · ${span}` : ""} · last <span title={chat.last_ts}>{lastSeen(chat.last_ts)}</span>
            </span>
          )}
        </div>
        {channels.length > 0 && (
          <div className="pane-path" aria-label="Where it came in">
            <span className="frow-name">Path</span>
            <span className="mono muted">{at.provider}</span>
            <span className="muted" aria-hidden="true">/</span>
            {channels.map((ch) => <span key={ch} className="tag accent">{ch}</span>)}
          </div>
        )}
      </header>

      <div className="card msgs">
        {rows.length === 0 ? (
          <p className={error ? "error pad" : "muted pad"}>
            {error ? <>{error} <button className="btn small" onClick={() => void loadMore()}>Retry</button></> : loading || !done ? "Loading messages…" : "No messages in this chat."}
          </p>
        ) : (
          <MessageList rows={rows} names={names} fresh={fresh} moved={channels.length > 1} />
        )}
        <div ref={sentinel} className="msgs-foot">
          <span className="mono">{rows.length.toLocaleString("en")}{chat ? ` of ${chat.n.toLocaleString("en")}` : ""} shown</span>
          {error && rows.length > 0 && <span className="error">{error}</span>}
          <span className="push mono">{loading && rows.length ? "Loading older…" : done && rows.length ? "Beginning of this chat" : ""}</span>
        </div>
      </div>
    </>
  );
}

/** Newest first, like v2: a day separator per day, one avatar and name per run of the same sender,
 * the time at the right; an event (a join, an unsend) is a centred line. */
function MessageList({ rows, names, fresh, moved }: { rows: MessageRecord[]; names: Names; fresh: Set<string>; moved: boolean }) {
  return (
    <ol className="mlist" aria-label="Messages, newest first">
      {rows.map((r, i) => {
        const newer = rows[i - 1];
        const older = rows[i + 1];
        const newDay = !newer || dayKey(newer.ts) !== dayKey(r.ts);
        const who = senderOf(names, r);
        const event = eventText(r.type, who.name);
        const first = newDay || !!event || !!(newer && eventText(newer.type, "")) || newer!.sender !== r.sender;
        // a chat that moved between channels: mark where it came in on another one than the message before
        const handoff = moved && older && older.channel !== r.channel;
        const cls = `m${first ? " first" : ""}${fresh.has(r.id) ? " fresh" : ""}`;
        return (
          <Fragment key={r.id}>
            {newDay && <li className="sep" role="separator"><span>{dayLabel(r.ts)}</span></li>}
            {event ? (
              <li className={`${cls} event`}>
                <span>{event} · <time dateTime={r.ts} title={r.ts}>{timeOf(r.ts)}</time></span>
              </li>
            ) : (
              <li className={cls}>
                {first ? <Avatar src={who.picture} name={who.name} color={senderColor(r.sender || who.name)} /> : <span className="gutter" aria-hidden="true" />}
                <div className="m-main">
                  {first && (
                    <button type="button" className="name who" style={{ color: senderColor(r.sender || who.name) }} title={`${r.sender} · click to rename`}
                      onClick={() => void names.rename("sender", r.provider, r.sender, who.name)}>
                      {who.name}
                    </button>
                  )}
                  <div className="content">
                    {r.text ? <p>{r.text}</p> : !r.media_kind && !r.expand?.attachments_via_message?.length && <p className="muted"><i>{TYPE_WORD[r.type] ?? r.type}</i></p>}
                    <Media r={r} />
                  </div>
                </div>
                <span className="m-side">
                  {handoff && <span className="tag accent" title={`Came in on ${r.channel}; the message before it on ${older.channel}`}>↳ {r.channel}</span>}
                  {r.type && r.type !== "text" && <span className="type">{r.type}</span>}
                  <time dateTime={r.ts} title={r.ts}>{timeOf(r.ts)}</time>
                </span>
              </li>
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}
