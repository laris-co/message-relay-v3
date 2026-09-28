import type { ReactNode } from "react";
import { openDashboard, pb } from "./pb.ts";

/** Inside Home Assistant's sidebar panel (ingress iframe): HA already shows the title, the navigation and
 * the account, so the app keeps one compact row and no side panel of its own. */
export const EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent: embedded all the same
  }
})();

export type Page = "timeline" | "endpoints";

/** One drawn icon set: 16 px, 1.75 stroke, currentColor. */
const paths = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  filter: <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.5V8.5z" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  external: <><path d="M9 3h4v4" /><path d="M13 3 7.5 8.5" /><path d="M11 9.5V13H3V5h3.5" /></>,
  panel: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6.5 3v10" /></>,
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

export function Tabs({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  if (!pb.authStore.isSuperuser) return null; // Endpoints is an admin page
  return (
    <div className="tabs" role="tablist" aria-label="Pages">
      {(["timeline", "endpoints"] as const).map((p) => (
        <button key={p} role="tab" aria-selected={page === p} className={page === p ? "on" : ""} onClick={() => setPage(p)}>
          {p === "timeline" ? "Timeline" : "Endpoints"}
        </button>
      ))}
    </div>
  );
}

/** The one header row: brand (standalone only) · pages · page tools · status · actions. */
export function Header({ nav, tools, status }: { nav: ReactNode; tools?: ReactNode; status?: ReactNode }) {
  return (
    <header className="topbar">
      {!EMBEDDED && (
        <span className="brand">
          message-relay <span>v3</span>
        </span>
      )}
      {nav}
      <div className="tools">{tools}</div>
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
