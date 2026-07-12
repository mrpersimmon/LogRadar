// WorkspaceManager (Task 10 ③b) — modal over a dimmed backdrop. Save the
// current open-files state as a named workspace (name input → `workspaceSave`
// with the open file paths + empty queries list), list saved workspaces as
// cards (each card previews its file paths + full-query chips, loaded via
// `workspaceList` → `workspaceLoad` per name), and Open a workspace (reloads it
// via `workspaceLoad` + fires `onOpenWorkspace`). Import/export affordances sit
// in the footer.
//
// Visual structure ported from
// `.superpowers/brainstorm/28981-1783828764/content/workspace.html` (modal /
// save / wlist / wcard / wtop / wname / wmeta / wact / wprev / wfiles / wqs /
// wq / mfoot / btn), restyled with ③a's premium CSS-variable tokens.

import { useEffect, useState } from "react";
import {
  workspaceSave,
  workspaceLoad,
  workspaceList,
  type Workspace,
} from "../lib/ipc";
import type { SessionsApi } from "../hooks/useSessions";
import type { SearchRequest } from "../components/SearchPanel";
import "./WorkspaceManager.css";

export type WorkspaceManagerProps = {
  /** The open-files registry (so Save Current can read the open file paths).
   *  Optional — if omitted, Save Current saves an empty file list. */
  sessions?: SessionsApi;
  /** The lifted active query from App (Task 1 ④a). Save Current includes it as
   *  the workspace's single query (was `queries: []` in ③b because the query
   *  wasn't reachable here). null/undefined until SearchPanel commits a query. */
  activeQuery?: SearchRequest | null;
  /** Fired after a workspace is (re)loaded via the Open button. */
  onOpenWorkspace?: (ws: Workspace) => void;
  /** Close affordance. */
  onClose?: () => void;
};

/** Render a query object as a compact chip string: keywords joined by AND,
 *  levels comma-joined, optional time range + excludes. Mirrors the mockup's
 *  `refused AND timeout · ERROR,WARN · 14:22–14:23` chip format. */
function formatQuery(q: unknown): string {
  if (q == null || typeof q !== "object") return String(q ?? "");
  const o = q as Record<string, unknown>;
  const parts: string[] = [];
  const kw = o.keywords;
  if (Array.isArray(kw) && kw.length) parts.push(kw.join(" AND "));
  const lv = o.levels;
  if (Array.isArray(lv) && lv.length) parts.push(lv.join(","));
  if (typeof o.timeRange === "string" && o.timeRange) parts.push(o.timeRange);
  const ex = o.excludes;
  if (Array.isArray(ex) && ex.length) parts.push(`exclude:${ex.join(",")}`);
  return parts.join(" · ");
}

const MAX_QUERY_CHIPS = 2;

export function WorkspaceManager({
  sessions,
  activeQuery,
  onOpenWorkspace,
  onClose,
}: WorkspaceManagerProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // On mount, fetch the saved-workspace names and load each one to render its
  // card preview (files + query chips).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const names = await workspaceList();
        if (cancelled) return;
        const loaded = await Promise.all(
          names.map((n) => workspaceLoad(n)),
        );
        if (cancelled) return;
        setWorkspaces(loaded);
      } catch (e) {
        setErr(String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    try {
      const names = await workspaceList();
      const loaded = await Promise.all(names.map((n) => workspaceLoad(n)));
      setWorkspaces(loaded);
    } catch {
      /* keep last list */
    }
  }

  async function onSave() {
    setErr(null);
    const files = sessions
      ? [...sessions.sessions.values()].map((s) => s.path)
      : [];
    // Task 2 (④a): include the lifted `activeQuery` as the workspace's single
    // query (was `queries: []` in ③b — the active query wasn't reachable here).
    // The query is a full SearchRequest (keywords + level + time + excludes as
    // the QueryNodeDto tree), so the saved workspace round-trips the exact query
    // the user ran. null (no query committed yet) → empty queries list.
    const queries = activeQuery ? [activeQuery] : [];
    setSaving(true);
    try {
      await workspaceSave({ name, files, queries });
      setName("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onOpen(wsName: string) {
    try {
      const ws = await workspaceLoad(wsName);
      onOpenWorkspace?.(ws);
    } catch (e) {
      setErr(String(e));
    }
  }

  const openPaths = sessions ? [...sessions.sessions.values()].map((s) => s.path) : [];
  // Task 2 (④a): the lifted activeQuery counts as the one query Save Current
  // will persist (was always 0 in ③b — queries wasn't reachable here).
  const openQueryCount = activeQuery ? 1 : 0;

  return (
    <div className="wm-scrim" onClick={onClose}>
      <div
        className="wm-modal"
        role="dialog"
        aria-label="Workspaces"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wm-mhead">
          <span className="wm-eyebrow">Workspaces</span>
          <button
            className="wm-x"
            aria-label="Close workspace manager"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="wm-mbody">
          {/* save current */}
          <div className="wm-save">
            <div className="wm-row1">
              <input
                className="wm-name"
                aria-label="Workspace name"
                placeholder="Name this snapshot…"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                className="wm-go"
                aria-label="Save current"
                disabled={saving || name.trim().length === 0}
                onClick={onSave}
              >
                Save current
              </button>
            </div>
            <div className="wm-will">
              will save <b>{openPaths.length}</b> file
              {openPaths.length === 1 ? "" : "s"} + <b>{openQueryCount}</b>{" "}
              queries (with full conditions: keywords · levels · time · excludes)
            </div>
          </div>

          {/* saved workspaces */}
          {loaded && workspaces.length === 0 ? (
            <div className="wm-empty" data-testid="wm-empty">
              <span className="wm-empty-glyph" aria-hidden>
                ◳
              </span>
              <span className="wm-empty-title">No saved workspaces</span>
              <span className="wm-empty-hint">
                Save the current open-files + queries to return to them later.
              </span>
            </div>
          ) : (
            <div className="wm-wlist">
              {workspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.name}
                  ws={ws}
                  onOpen={() => onOpen(ws.name)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="wm-mfoot">
          <button className="wm-link">Import…</button>
          <button className="wm-link">Export…</button>
          {err && <span className="wm-err">{err}</span>}
          <span className="wm-sp" />
          <button className="wm-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceCard({
  ws,
  onOpen,
}: {
  ws: Workspace;
  onOpen: () => void;
}) {
  const queries = Array.isArray(ws.queries) ? (ws.queries as unknown[]) : [];
  const shown = queries.slice(0, MAX_QUERY_CHIPS);
  const extra = queries.length - shown.length;
  return (
    <div className="wm-card">
      <div className="wm-wtop">
        <span className="wm-wname">{ws.name}</span>
        <span className="wm-wmeta">
          <span className="wm-n">
            {ws.files.length} file{ws.files.length === 1 ? "" : "s"}
          </span>
          <span>{queries.length} queries</span>
        </span>
        <span className="wm-wact">
          <button className="wm-open" onClick={onOpen}>
            Open
          </button>
          <span className="wm-menu" aria-hidden>
            ⋯
          </span>
        </span>
      </div>
      <div className="wm-wprev">
        <div className="wm-wfiles">
          {ws.files.map((f, i) => (
            <span className="wm-file" key={i}>
              {f}
            </span>
          ))}
        </div>
        {queries.length > 0 && (
          <div className="wm-wqs">
            {shown.map((q, i) => (
              <span className="wm-wq" key={i}>
                {formatQuery(q)}
              </span>
            ))}
            {extra > 0 && <span className="wm-wq more">+{extra}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
