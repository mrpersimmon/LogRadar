// MainWindow (Task 7 ③b) — the assembled main screen. Ports the full main
// layout from `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html`
// (and its token-adapted twin `premium-redesign.html`): a top tab strip, a left
// sidebar tree, a center column (log view + right signal-trace minimap on top,
// bottom search panel), and a status bar. Assembles the five sub-components from
// Tasks 3–6 and wires the active session (from `useSessions`, owned by `App`
// and passed in as `sessions`) into `VirtualLogView` and `SearchPanel`.
//
// Layout (flex): top tabs (full width) → body row [FileTree | mw-main] → status
// bar (full width). `mw-main` is a column: mw-view (log-view + Minimap, flex:1)
// then the SearchPanel. The Minimap's viewport marker is driven by
// VirtualLogView's `onViewportChange` (the ACTUAL visible window, no overscan),
// so the teal sweep tracks the real scroll position — the signature
// log-view↔minimap link.
//
// Premium tokens throughout (③a's `src/theme/tokens.css`); no hardcoded colors.

import { useState, useCallback, useMemo } from "react";
import type { SessionsApi } from "../hooks/useSessions";
import type { View, SplitSelection } from "../router";
import { TabStrip } from "../components/TabStrip";
import { FileTree } from "../components/FileTree";
import { VirtualLogView } from "../components/VirtualLogView";
import { Minimap } from "../components/Minimap";
import { SearchPanel } from "../components/SearchPanel";
import type { SearchControllerView, SearchRequest } from "../components/SearchPanel";
import "./MainWindow.css";

export type MainWindowProps = {
  /** The single `useSessions()` instance, owned by `App` and shared with the
   *  WelcomePage so files opened there are visible here. Passed in (not called
   *  here) so the open-files registry is a single source of truth. */
  sessions: SessionsApi;
  /** Lifted search controller from App (Task 1 ④a). When provided, the SAME
   *  controller's matches flow to VirtualLogView (hit highlight) + SearchPanel
   *  (results) — closing the ③b-deferred I3/I4 search→view loop. */
  search?: SearchControllerView;
  /** Lifted query setter from App. Forwarded to SearchPanel so its Search
   *  click builds the query → App's `useSearch` keys on it. */
  setActiveQuery?: (q: SearchRequest | null) => void;
  /** The keyword to highlight inside matched lines (derived by App from the
   *  active query via `extractHighlightTerm`). Forwarded to VirtualLogView. */
  highlightTerm?: string;
  /** View router setter (Task 6 ④a). The Compare picker calls
   *  `setView("split", { left, right })` so App routes to SplitView with both
   *  chosen sessions side-by-side. */
  setView?: (v: View, split?: SplitSelection) => void;
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function MainWindow({
  sessions,
  search,
  setActiveQuery,
  highlightTerm,
  setView,
}: MainWindowProps) {
  // Destructure the registry; `map` is the sessions Map (prop field `sessions`).
  const { sessions: map, activeId, setActive, close } = sessions;
  const active = activeId ? map.get(activeId) ?? null : null;

  // Visible viewport reported by VirtualLogView → drives the Minimap sweep +
  // the status bar's position readout. Defaults to [0,0) until the first layout
  // measure fires onViewportChange.
  const [viewport, setViewport] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const onViewportChange = useCallback((start: number, end: number) => {
    setViewport((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  // The jump target: a VirtualLogView row click (or a SearchPanel result-row
  // click) calls onJumpToLine(n) → we set this → VirtualLogView marks line n
  // with the jump style. The search→view loop's jump half.
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);

  // Task 6 (④a): the Compare picker. Visible only when 2+ sessions are open.
  // `leftId`/`rightId` default to the first two distinct sessions when the
  // picker opens; the user can swap either via the selects, and confirming
  // routes to SplitView with both ids (`setView("split", { left, right })`).
  const sessionIds = useMemo(() => [...map.keys()], [map]);
  const canCompare = sessionIds.length >= 2;
  const [comparing, setComparing] = useState(false);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const toggleCompare = useCallback(() => {
    setComparing((open) => {
      if (open) return false;
      // opening: default to the first two distinct open sessions
      setLeftId(sessionIds[0] ?? "");
      setRightId(sessionIds[1] ?? sessionIds[0] ?? "");
      return true;
    });
  }, [sessionIds]);
  const startCompare = useCallback(() => {
    if (!setView || !leftId || !rightId || leftId === rightId) return;
    setView("split", { left: leftId, right: rightId });
  }, [setView, leftId, rightId]);

  return (
    <div className="mw">
      <TabStrip
        sessions={map}
        activeId={activeId}
        onSelect={setActive}
        onClose={close}
      />

      <div className="mw-body">
        <FileTree sessions={map} activeId={activeId} onSelect={setActive} />

        <div className="mw-main">
          {active ? (
            <>
              <div className="mw-view">
                <VirtualLogView
                  sessionId={active.sessionId}
                  totalLines={active.lineCount}
                  hits={search?.matches}
                  highlightTerm={highlightTerm}
                  jumpToLine={jumpTarget}
                  onJumpToLine={(n: number) => setJumpTarget(n)}
                  onViewportChange={onViewportChange}
                />
                <Minimap
                  levelDistribution={[]}
                  viewportStart={viewport.start}
                  viewportEnd={viewport.end}
                  totalLines={active.lineCount}
                />
              </div>

              <SearchPanel
                sessionId={active.sessionId}
                filePath={active.path}
                sessionIds={[...map.keys()]}
                filePathFor={(sid: string) => map.get(sid)?.path}
                search={search}
                setActiveQuery={setActiveQuery}
                onJumpToLine={(n: number) => setJumpTarget(n)}
              />
            </>
          ) : (
            <div className="mw-empty" data-testid="mw-empty">
              <span className="mw-empty-glyph" aria-hidden>
                ◳
              </span>
              <span className="mw-empty-title">No file open</span>
              <span className="mw-empty-hint">
                Open a log from the welcome screen to start tracing.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Task 6 (④a): the Compare picker. Two labeled selects (Left / Right)
          over the open sessions + a Start-compare confirm. Defaults to the
          first two distinct sessions; the confirm routes to SplitView. */}
      {comparing && canCompare && (
        <div className="mw-compare" data-testid="mw-compare-panel">
          <label className="mw-compare-field">
            <span className="mw-compare-lbl">Left</span>
            <select
              aria-label="Left session for compare"
              value={leftId}
              onChange={(e) => setLeftId(e.target.value)}
            >
              {sessionIds.map((id) => (
                <option key={id} value={id}>
                  {basename(map.get(id)?.path ?? id)}
                </option>
              ))}
            </select>
          </label>
          <span className="mw-compare-vs" aria-hidden>
            ⇄
          </span>
          <label className="mw-compare-field">
            <span className="mw-compare-lbl">Right</span>
            <select
              aria-label="Right session for compare"
              value={rightId}
              onChange={(e) => setRightId(e.target.value)}
            >
              {sessionIds.map((id) => (
                <option key={id} value={id}>
                  {basename(map.get(id)?.path ?? id)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="mw-compare-go"
            aria-label="Start split compare"
            onClick={startCompare}
            disabled={!leftId || !rightId || leftId === rightId}
          >
            Compare
          </button>
        </div>
      )}

      <footer className="mw-status">
        <span className="mw-status-files">
          {map.size} file{map.size === 1 ? "" : "s"}
        </span>
        {active && (
          <>
            <span className="mw-status-sep" aria-hidden>
              ·
            </span>
            <span className="mw-status-enc">{active.encoding}</span>
            <span className="mw-status-sep" aria-hidden>
              ·
            </span>
            <span className="mw-status-jump">
              view → {basename(active.path)}:
              {String(viewport.start).padStart(6, "0")}
            </span>
          </>
        )}
        {canCompare && (
          <button
            className="mw-compare-btn"
            data-testid="mw-compare-btn"
            aria-label="Compare sessions"
            aria-expanded={comparing}
            onClick={toggleCompare}
          >
            Compare
          </button>
        )}
      </footer>
    </div>
  );
}
