import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { openDashboard, pb } from "./pb.ts";
import { sourceLabel } from "./chats.ts";
import type { MessageRecord } from "./filter.ts";

/** Inside Home Assistant's sidebar panel (ingress iframe): HA already shows the title and the
 * account, so the app drops its brand and its Sign out. */
export const EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent: embedded all the same
  }
})();

export type Page = "chats" | "stream" | "endpoints";

/** One drawn icon set: 16 px, 1.75 stroke, currentColor. */
const paths = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  external: <><path d="M9 3h4v4" /><path d="M13 3 7.5 8.5" /><path d="M11 9.5V13H3V5h3.5" /></>,
  play: <path d="M5.5 3.5v9l7-4.5z" fill="currentColor" />,
  plus: <path d="M8 3v10M3 8h10" />,
  logout: <><path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6" /><path d="M10.5 11 13.5 8l-3-3" /><path d="M13.5 8H6" /></>,
};
export function Icon({ name, className }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** The pages, as v1 and v2 show them: one line of words, the current one in the accent. */
export function Nav({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  const pages: [Page, string][] = [["chats", "Chats"], ["stream", "Stream"]];
  if (pb.authStore.isSuperuser) pages.push(["endpoints", "Endpoints"]); // an admin page
  return (
    <nav className="nav" aria-label="Pages">
      {pages.map(([p, label]) => (
        <a key={p} href={`?view=${p}`} aria-current={page === p ? "page" : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab stays the browser's
            e.preventDefault();
            setPage(p);
          }}>
          {label}
        </a>
      ))}
    </nav>
  );
}

/** The one header row: brand (standalone only) · pages · status · actions. Its height is --head-h. */
export function Header({ nav, status }: { nav: ReactNode; status?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--head-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <header className="topbar" ref={ref}>
      {!EMBEDDED && (
        <span className="brand">
          Message Relay <span>v3</span>
        </span>
      )}
      {nav}
      <span className="spacer" />
      {status}
      <div className="actions">
        {pb.authStore.isSuperuser && (
          <button className="btn quiet" onClick={openDashboard} title="PocketBase dashboard: collections, logs, backups, settings" aria-label="Open the PocketBase dashboard">
            <span className="label">PocketBase</span> <Icon name="external" />
          </button>
        )}
        {/* inside HA the HA session is the login: signing out here would only sign straight back in */}
        {!EMBEDDED && (
          <button className="btn quiet" onClick={() => pb.authStore.clear()} title="Sign out" aria-label="Sign out">
            <Icon name="logout" /> <span className="label">Sign out</span>
          </button>
        )}
      </div>
    </header>
  );
}

export function LiveStatus({ live }: { live: boolean }) {
  return (
    <span className={live ? "live on" : "live"} role="status" title={live ? "New messages show up as they arrive" : "Connection lost, reconnecting"}>
      <span className="dot" aria-hidden="true" />
      <span className="label">{live ? "live" : "reconnecting…"}</span>
    </span>
  );
}

// ── sources ─────────────────────────────────────────────────────────────────
/** Known sources keep their colour; any other gets one of these, the same one every time. */
const OTHER_TONES = ["red", "purple", "pink", "yellow", "blue"];
export function toneOf(provider: string): string {
  if (["line", "github", "messenger", "generic", "discord"].includes(provider)) return provider;
  let h = 0;
  for (const ch of provider) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return OTHER_TONES[Math.abs(h) % OTHER_TONES.length]!;
}

/** A source as a small label (v1's platform badge): a word, never colour alone. */
export function SourceBadge({ provider }: { provider: string }) {
  return <span className={`badge t-${toneOf(provider)}`} title={`source: ${provider}`}>{sourceLabel(provider)}</span>;
}

// ── filter chips (v2) ───────────────────────────────────────────────────────
export function FilterRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="frow" role="group" aria-label={name}>
      <span className="frow-name">{name}</span>
      <div className="frow-chips">{children}</div>
    </div>
  );
}

export function FilterChip({ on, onClick, count, title, mono, children }: {
  on: boolean; onClick: () => void; count?: number; title?: string; mono?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" className={mono ? "fchip mono" : "fchip"} aria-pressed={on} onClick={onClick} title={title}>
      <span className="fchip-text">{children}</span>
      {count !== undefined && <span className="fchip-n">{count.toLocaleString("en")}</span>}
    </button>
  );
}

// ── people ──────────────────────────────────────────────────────────────────
/** A sender's colour, the same one every time (12 tones, v1's Chat). */
export function senderColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = key.charCodeAt(i) + ((h << 5) - h);
  return `var(--sender-${(Math.abs(h) % 12) + 1})`;
}

/** Their picture, or their initial on their colour. */
export function Avatar({ src, name, color, size = 32 }: { src?: string; name: string; color: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { "--sc": color, width: size, height: size } as CSSProperties;
  if (src && !broken) return <img className="avatar" style={style} src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return (
    <span className="avatar initial" style={{ ...style, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {(Array.from(name.trim())[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** Copy to the clipboard; says "Copied" for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? "Copied" : label}
    </button>
  );
}

// ── messages ────────────────────────────────────────────────────────────────
/** A message's pictures: from its `attachments` (our copy first, else the source link); before the
 * attachment exists, the links on the message itself. */
export function Media({ r }: { r: MessageRecord }) {
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

/** A fresh install: nothing has arrived yet. Say how messages get here, and where to start. */
export function FirstRun({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
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
