// WelcomePage (Task 10 ③b, FULL rewrite; Task 3 ④a recents wiring; Task 9
// Open archive / Open folder / Open file filter) — the landing screen. A drop
// zone with the signature radar-sweep animation (CSS conic-gradient beam,
// rotating under `prefers-reduced-motion: reduce` → static), format badges,
// and THREE open entry points: Open file (filtered to .log/.txt →
// `sessions.open`), Open archive (.zip/.gz → `sessions.openArchive` streaming
// progress into the ExtractProgress widget), and Open folder (`directory:
// true` → `sessions.openFolder`, surfacing an archive-hint notice if archives
// were found inside); a recents list loaded from the `logradar-recents`
// localStorage store on mount (each recent shows its path + an "open"
// affordance, click to re-open); and workspace cards. Opening a file — via the
// dialog OR by clicking a recent — wires the full chain: openDialog/row-click
// → `sessions.open` (→ `openFile`) → `addRecent` (bump to most-recent-first)
// → `setView("main")` — closing the gap noted in T7 (the router flips to
// MainWindow on open).
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
import { ExtractProgress } from "../components/ExtractProgress";
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
  // Task 9: extract progress (null when not extracting). Set when Open archive
  // begins, updated per `file` event from `sessions.openArchive`, cleared on
  // completion / error. Drives the ExtractProgress widget below.
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    currentFile: string;
  } | null>(null);
  // Task 9: archive hint surfaced after Open folder when `scan_dir` found
  // archives inside the picked directory. Null = no hint to show; non-empty =
  // the notice nudges the user toward Open archive instead.
  const [archiveHint, setArchiveHint] = useState<string[] | null>(null);
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

  // Task 9: Open file — single pick, filtered to .log/.txt (the formats a plain
  // log file uses; archives + folders have their own entry points below).
  const onOpenFile = () =>
    openPicked(() =>
      openDialog({
        multiple: false,
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      }),
    );

  // Task 9: Open folder — `directory: true` pick, scanned by `scan_dir`; opens
  // every found log via `sessions.openFolder`. If archives were found inside
  // the dir, surface the archive-hint notice and STAY on the welcome page so
  // the notice is actually visible (App swaps pages via a ternary on `view`,
  // so `setView("main")` would unmount WelcomePage and discard the hint state
  // — the notice could never render). When no archives were found, flip to
  // main as usual so the opened logs are shown.
  const onOpenFolder = async () => {
    setErr(null);
    try {
      const picked = await openDialog({ directory: true });
      if (typeof picked !== "string") return; // cancelled
      const { archiveHint: hint } = await sessions.openFolder(picked);
      if (hint.length > 0) {
        setArchiveHint(hint); // stay on welcome so the notice renders
      } else {
        setView("main");
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  // Task 9: Open archive — single pick filtered to .zip/.gz; `extract_archive`
  // streams `ExtractProgress` `file` events (done/total/currentFile) so the
  // ExtractProgress widget advances bar + label live. The command's return
  // value (`ExtractResponse.logFiles`) carries the terminal list; the callback
  // only needs to track `file` events. On completion each extracted log is
  // opened (by `openArchive` itself) and the view flips to main.
  const onOpenArchive = async () => {
    setErr(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Archive", extensions: ["zip", "gz"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      setProgress({ done: 0, total: 0, currentFile: "" });
      await sessions.openArchive(picked, (p) => {
        if (p.type === "file") {
          setProgress({
            done: p.done,
            total: p.total,
            currentFile: p.currentFile,
          });
        }
      });
      setProgress(null);
      setView("main");
    } catch (e) {
      setErr(String(e));
      setProgress(null);
    }
  };

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
          <button className="wp-btn" onClick={onOpenArchive}>
            Open archive
          </button>
          <button className="wp-btn" onClick={onOpenFolder}>
            Open folder
          </button>
        </div>

        {/* Task 9: live extract progress — shown only while Open archive is
            streaming `file` events; null otherwise. */}
        {progress && (
          <ExtractProgress
            done={progress.done}
            total={progress.total}
            currentFile={progress.currentFile}
          />
        )}

        {/* Task 9: archive-hint notice — after Open folder, if `scan_dir` found
            archives inside the picked dir, nudge the user toward Open archive
            (the folder scan opens logs but skips archives needing extraction). */}
        {archiveHint && archiveHint.length > 0 && (
          <div className="wp-hint" role="status">
            Found {archiveHint.length} archive
            {archiveHint.length === 1 ? "" : "s"} — use Open archive
          </div>
        )}
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
