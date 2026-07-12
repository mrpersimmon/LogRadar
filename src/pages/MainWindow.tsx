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

import { useState, useCallback } from "react";
import type { SessionsApi } from "../hooks/useSessions";
import { TabStrip } from "../components/TabStrip";
import { FileTree } from "../components/FileTree";
import { VirtualLogView } from "../components/VirtualLogView";
import { Minimap } from "../components/Minimap";
import { SearchPanel } from "../components/SearchPanel";
import "./MainWindow.css";

export type MainWindowProps = {
  /** The single `useSessions()` instance, owned by `App` and shared with the
   *  WelcomePage so files opened there are visible here. Passed in (not called
   *  here) so the open-files registry is a single source of truth. */
  sessions: SessionsApi;
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function MainWindow({ sessions }: MainWindowProps) {
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
      </footer>
    </div>
  );
}
