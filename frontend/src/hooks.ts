// State shared by the pages: the conversation list, names (aliases), the one realtime connection,
// the URL query, and small browser hooks.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { aliases as loadAliases, chats as loadChats, saveAlias, pb, type Alias, type Chat } from "./pb.ts";
import type { MessageRecord } from "./filter.ts";
import { shortId } from "./chats.ts";

export function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** A media query as state. */
export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

// ── the URL query: filters and the open chat survive a reload and can be shared ──
export const param = (k: string) => new URLSearchParams(window.location.search).get(k) ?? "";

/** Set (or, with "" / undefined, drop) query parameters in place: the path stays, so it works under HA ingress. */
export function setParams(p: Record<string, string | undefined>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(p)) {
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/** "/" puts the cursor in this search box (unless the cursor is already in a field). */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [ref]);
}

// ── realtime: one subscription to new messages, shared by whatever is on screen ──
// The SSE connection drops now and then (idle timeout, sleep, a server restart) and the SDK
// reconnects; events in the gap are not replayed, so every reconnect tells the listeners to catch up.
const creates = new Set<(r: MessageRecord) => void>();
const reconnects = new Set<() => void>();
const states = new Set<(live: boolean) => void>();
let users = 0;
let stop: (() => void) | null = null;
let liveNow = false;
const setLive = (v: boolean) => {
  liveNow = v;
  states.forEach((f) => f(v));
};

function start(): () => void {
  let connectedOnce = false;
  let cancelled = false;
  const unsubs: (() => Promise<void>)[] = [];
  const keep = (u: () => Promise<void>) => (cancelled ? void u() : void unsubs.push(u));
  pb.realtime.onDisconnect = () => setLive(false);
  pb.realtime
    .subscribe("PB_CONNECT", () => {
      setLive(true);
      if (connectedOnce) reconnects.forEach((f) => f());
      connectedOnce = true;
    })
    .then(keep)
    .catch(() => setLive(false));
  pb.collection("messages")
    .subscribe<MessageRecord>("*", (e) => {
      if (e.action === "create") creates.forEach((f) => f(e.record));
    })
    .then((u) => {
      keep(u);
      if (!cancelled) setLive(true);
    })
    .catch(() => setLive(false));
  return () => {
    cancelled = true;
    unsubs.splice(0).forEach((u) => void u().catch(() => {}));
    pb.realtime.onDisconnect = undefined;
    setLive(false);
  };
}

/** Live: new messages (onCreate) and reconnects (onReconnect, to catch up). Returns whether the connection is up. */
export function useLive(onCreate?: (r: MessageRecord) => void, onReconnect?: () => void): boolean {
  const [live, setState] = useState(liveNow);
  const c = useRef(onCreate);
  c.current = onCreate;
  const rc = useRef(onReconnect);
  rc.current = onReconnect;
  useEffect(() => {
    const fc = (r: MessageRecord) => c.current?.(r);
    const fr = () => rc.current?.();
    creates.add(fc);
    reconnects.add(fr);
    states.add(setState);
    if (users++ === 0) stop = start();
    setState(liveNow);
    return () => {
      creates.delete(fc);
      reconnects.delete(fr);
      states.delete(setState);
      if (--users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
  return live;
}

// ── data ────────────────────────────────────────────────────────────────────
/** Every conversation (the `chats` view). refreshSoon(): a burst of new messages reloads it once per 3 s. */
export function useChats() {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setChats(await loadChats());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 3000);
  }, [refresh]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return { chats, error, refresh, refreshSoon };
}

/** Names for ids (aliases: a label, maybe a picture), and renaming one. */
export function useNames() {
  const [names, setNames] = useState<Map<string, Alias>>(new Map());
  const refresh = useCallback(() => loadAliases().then(setNames).catch(() => {}), []);
  useEffect(() => void refresh(), [refresh]);
  const alias = useCallback(
    (kind: "sender" | "group", provider: string, value: string) =>
      names.get(`${kind}\t${provider}\t${value}`) ?? names.get(`${kind}\t\t${value}`),
    [names],
  );
  /** Ask for a name and save it (a hook relabels every message of the id). The new label, or null when nothing changed. */
  const rename = useCallback(
    async (kind: "sender" | "group", provider: string, value: string, current: string): Promise<string | null> => {
      const a = alias(kind, provider, value);
      const label = window.prompt(`Name for ${value}`, a?.label ?? current)?.trim();
      if (!label || label === a?.label) return null;
      await saveAlias(kind, provider, value, label, a);
      await refresh();
      return label;
    },
    [alias, refresh],
  );
  return { alias, rename };
}
export type Names = ReturnType<typeof useNames>;

/** How a sender shows: their alias, else the label the message carries, else the id; and their picture. */
export function senderOf(names: Names, r: Pick<MessageRecord, "provider" | "sender" | "sender_label" | "sender_picture">) {
  const a = names.alias("sender", r.provider, r.sender);
  const picture = (a?.picture && pb.files.getURL(a, a.picture, { thumb: "64x64" })) || r.sender_picture || "";
  const label = r.sender_label && r.sender_label !== r.sender ? r.sender_label : "";
  return { name: a?.label || label || shortId(r.sender) || "—", picture };
}
