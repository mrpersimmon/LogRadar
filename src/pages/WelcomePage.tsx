// WelcomePage (Task 10 ③b, FULL rewrite; Task 3 ④a recents wiring) — the landing
// screen. A drop zone with the signature radar-sweep animation (CSS conic-
// gradient beam, rotating under `prefers-reduced-motion: reduce` → static),
// format badges, and an Open file button; a recents list loaded
// from the `logradar-recents` localStorage store on mount (each recent shows its
// path + an "open" affordance, click to re-open); and workspace cards. Opening a
// file — via the dialog OR by clicking a recent — wires the full chain:
// openDialog/row-click → `sessions.open` (→ `openFile`) → `addRecent` (bump to
// most-recent-first) → `setView("main")` — closing the gap noted in T7 (the
// router flips to MainWindow on open).
//
// Visual structure ported from
// `.superpowers/brainstorm/28981-1783785226/content/welcome-v3.html` (drop /
// sweep / fmts / actions / recents / ritem / lq / ws-head / wlist / wcard),
// restyled with ③a's premium CSS-variable tokens.

import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { SessionsApi } from "../hooks/useSessions";
import type { View } from "../router";
import { getRecents, addRecent } from "../lib/recents";
import "./WelcomePage.css";

export type RecentKind = "file" | "archive" | "folder";

export type RecentEntry = {
  path: string;
  /** Display string e.g. "32 MB". */
  size?: string;
  /** Relative time label e.g. "just now". */
  openedLabel?: string;
  /** Last query run against this file; rendered as a chip. */
  lastQuery?: string;
  kind?: RecentKind;
};

export type WorkspaceCard = {
  name: string;
  fileCount: number;
  queryCount: number;
  lastOpened?: string;
};

export type WelcomePageProps = {
  /** The single `useSessions()` instance (owned by `App`) — opening a file
   *  registers it here, then `setView("main")` flips to MainWindow. */
  sessions: SessionsApi;
  /** View router setter; called with "main" after a file opens. */
  setView: (v: View) => void;
  /** Recents list. If omitted, derived from the open sessions. */
  recents?: RecentEntry[];
  /** Workspace cards. If omitted, none render (loaded via WorkspaceManager). */
  workspaces?: WorkspaceCard[];
};

const FORMAT_BADGES = [".log", ".txt", ".gz", ".zip"];

function recentIcon(kind: RecentKind = "file"): string {
  if (kind === "archive") return "📦";
  if (kind === "folder") return "📁";
  return "📄";
}

export function WelcomePage({
  sessions,
  setView,
  recents,
  workspaces = [],
}: WelcomePageProps) {
  const [err, setErr] = useState<string | null>(null);
  // Recents loaded from localStorage on mount. Only used when no explicit
  // `recents` prop is supplied (presentational override, e.g. tests / a
  // future IPC-derived list). `recents` prop wins when present.
  const [loadedRecents, setLoadedRecents] = useState<string[]>([]);
  useEffect(() => {
    if (recents) return; // presentational mode — prop wins, skip the load
    setLoadedRecents(getRecents());
  }, [recents]);

  // Recents list: explicit prop wins; otherwise the localStorage-loaded paths
  // (paths only — no size/lastQuery, since the store persists just paths).
  const recentList: RecentEntry[] =
    recents ?? loadedRecents.map((p) => ({ path: p, kind: "file" as const }));

  async function openPicked(getter: () => Promise<unknown>) {
    setErr(null);
    try {
      const picked = await getter();
      if (typeof picked !== "string") return; // cancelled / not a file path
      await sessions.open(picked);
      addRecent(picked); // record newly-opened file (most-recent-first)
      setView("main");
    } catch (e) {
      setErr(String(e));
    }
  }

  // Re-open flow: clicking a recent row re-opens that file (openFile via
  // sessions.open), bumps it to the front of recents (addRecent dedupes), then
  // flips to MainWindow.
  async function openRecent(path: string) {
    setErr(null);
    try {
      await sessions.open(path);
      addRecent(path);
      setView("main");
    } catch (e) {
      setErr(String(e));
    }
  }

  const onOpenFile = () => openPicked(() => openDialog({ multiple: false }));

  return (
    <div className="wp">
      <section className="wp-drop" aria-label="Drop zone">
        <div className="wp-drop-glow" aria-hidden />
        {/* radar sweep — signature animation; reduced-motion → static (CSS) */}
        <div className="wp-sweep" data-testid="radar-sweep" aria-hidden>
          <div className="wp-ring" />
          <div className="wp-ring r2" />
          <div className="wp-ring r3" />
          <div className="wp-beam" />
          <div className="wp-blip b1" />
          <div className="wp-blip b2" />
          <div className="wp-core" />
        </div>

        <h1 className="wp-title">Drag a log here</h1>

        <div className="wp-fmts">
          {FORMAT_BADGES.map((f) => (
            <span className="wp-fmt" key={f}>
              {f}
            </span>
          ))}
        </div>

        <div className="wp-actions">
          <button className="wp-btn wp-primary" onClick={onOpenFile}>
            Open file
          </button>
        </div>
      </section>

      {/* recents */}
      {recentList.length > 0 && (
        <div className="wp-section">
          <div className="wp-recents-head">
            <span className="wp-eyebrow">Recent</span>
            <span className="wp-cnt">{recentList.length}</span>
          </div>
          <div className="wp-rlist">
            {recentList.map((r) => (
              <div
                className="wp-ritem"
                key={r.path}
                role="button"
                tabIndex={0}
                aria-label={`open ${r.path}`}
                onClick={() => openRecent(r.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openRecent(r.path);
                  }
                }}
              >
                <span className="wp-ico" aria-hidden>
                  {recentIcon(r.kind)}
                </span>
                <span className="wp-path">{r.path}</span>
                {r.lastQuery && (
                  <span className="wp-lq">
                    last: {r.lastQuery}
                  </span>
                )}
                <span className="wp-meta">
                  {r.size && (
                    <>
                      <span className="wp-sz">{r.size}</span>
                      <br />
                    </>
                  )}
                  <span className="wp-open">open</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* workspace cards */}
      {workspaces.length > 0 && (
        <div className="wp-section">
          <div className="wp-ws-head">
            <span className="wp-eyebrow">Workspaces</span>
          </div>
          <div className="wp-wlist">
            {workspaces.map((w) => (
              <div className="wp-wcard" key={w.name}>
                <div className="wp-wt">{w.name}</div>
                <div className="wp-wm">
                  <span className="wp-n">
                    {w.fileCount} file{w.fileCount === 1 ? "" : "s"}
                  </span>
                  {w.lastOpened && <span>last {w.lastOpened}</span>}
                  <span>
                    {w.queryCount} quer{w.queryCount === 1 ? "y" : "ies"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <div className="wp-err">{err}</div>}
    </div>
  );
}
