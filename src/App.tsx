// App — the router. Owns the single `useView()` (T1's view state machine),
// `useSessions()` (T1's open-files registry), and — as of Task 1 (④a) — the
// lifted `useSearch(activeSessionId, activeQuery, cap)` instance + the
// `activeQuery` state, so the SAME search controller's matches are shared
// across SearchPanel (results), VirtualLogView (hit highlight + jump), and —
// as of Task 2 (④a) — ExportDialog (current-query export) + WorkspaceManager
// (workspace-save-with-queries). SearchPanel builds the query and calls
// `setActiveQuery` + `search.run()`; App's controller registry dedupes by
// (sessionId, query, cap), so sharing one instance never double-scans.
// Renders the active page inside AppShell (③a's topbar + theme toggle).
// view === "main" → MainWindow (T7, now wired with the lifted search);
// "split" → SplitView (T8; Task 6 ④a routes here from MainWindow's Compare
//   picker, passing the {left, right} session ids stashed in the router);
// "export" → ExportDialog (T10, now receives the lifted activeQuery);
// "workspace" → WorkspaceManager (T10, now saves the lifted activeQuery +
//   fires onOpenWorkspace, which App implements to open each file +
//   restore the first saved query);
// otherwise the full WelcomePage (T10).

import { useState, useCallback, useEffect } from "react";
import { AppShell } from "./components/AppShell";
import { WelcomePage } from "./pages/WelcomePage";
import { MainWindow } from "./pages/MainWindow";
import { SplitView } from "./pages/SplitView";
import { ExportDialog } from "./pages/ExportDialog";
import { WorkspaceManager } from "./pages/WorkspaceManager";
import { useView } from "./router";
import { useSessions } from "./hooks/useSessions";
import { useSearch, type Workspace } from "./lib/ipc";
import { addRecent } from "./lib/recents";
import {
  EMPTY_QUERY,
  extractHighlightTerm,
  type SearchRequest,
} from "./components/SearchPanel";

/** The match cap forwarded to the Rust `search` command. Matches SearchPanel's
 *  own default; kept here so App (which owns the lift) controls it. */
const SEARCH_CAP = 1000;

export function App() {
  const { view, setView, split } = useView();
  const sessions = useSessions();
  // Lifted search state. `activeQuery` is null until SearchPanel commits a
  // query (Search click / history ◀▶▾); `useSearch` is called unconditionally
  // (hooks rule) with the EMPTY_QUERY sentinel when null, so the controller
  // stays idle — `run` is only invoked from SearchPanel's run-tick effect.
  const [activeQuery, setActiveQuery] = useState<SearchRequest | null>(null);
  const search = useSearch(
    sessions.activeId ?? "",
    activeQuery ?? EMPTY_QUERY,
    SEARCH_CAP,
  );
  // I2: a "please run the restored query after the re-key render commits"
  // signal. `onOpenWorkspace` calls setActiveQuery(firstQuery), which re-keys
  // `useSearch` on the NEXT render — so a run fired synchronously in the
  // handler would target the OLD controller. The effect below runs AFTER that
  // re-key render commits (its closure captures the re-keyed `search.run`),
  // so the restored query actually scans + produces matches instead of arming
  // an invisible inert query (SearchPanel's private QueryForm isn't synced to
  // the restored activeQuery, and its run trigger lives behind the Search
  // button — so without this, the restored query could never run).
  const [pendingRestoreRun, setPendingRestoreRun] = useState(false);
  // The first text-predicate's keyword, surfaced to VirtualLogView so matched
  // lines wrap the term in `<mark class="hit">`. "" for level/time-only queries.
  const highlightTerm = extractHighlightTerm(activeQuery);

  // I2: fire search.run() once the lifted controller has re-keyed onto the
  // restored query. `pendingRestoreRun` is armed in onOpenWorkspace; this effect
  // runs after the re-key render commits, so `search.run` is the restored
  // controller's stable singleton run. Mirrors SearchPanel's runTick pattern
  // (guard + effect, not a render-phase side effect).
  useEffect(() => {
    if (!pendingRestoreRun) return;
    setPendingRestoreRun(false);
    void search.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRestoreRun]);

  // Task 6 (④a): open a saved workspace → load each of its files into the
  // open-files registry. `useSessions.open` calls `openFile` (registering the
  // session) and we bump recents for each, mirroring WelcomePage's open chain.
  // Then restore the workspace's first saved query as the active query (so the
  // lifted useSearch re-keys onto it — the user lands with the query armed),
  // and flip to MainWindow. WorkspaceManager already `workspaceLoad`ed the ws
  // before firing this callback, so we only fan out the open + restore here.
  const handleOpenWorkspace = useCallback(
    async (ws: Workspace) => {
      for (const path of ws.files) {
        await sessions.open(path); // → openFile + register in useSessions
        addRecent(path); // bump recents (most-recent-first)
      }
      const firstQuery = Array.isArray(ws.queries) ? ws.queries[0] : undefined;
      if (firstQuery) {
        setActiveQuery(firstQuery as SearchRequest);
        // I2: arm the post-commit run so the restored query actually scans
        // (see the effect above) — not just re-keys useSearch.
        setPendingRestoreRun(true);
      }
      setView("main");
    },
    [sessions, setView],
  );

  return (
    <AppShell>
      {view === "main" ? (
        <MainWindow
          sessions={sessions}
          search={search}
          setActiveQuery={setActiveQuery}
          highlightTerm={highlightTerm}
          setView={setView}
        />
      ) : view === "split" ? (
        <SplitView
          sessions={sessions}
          leftSessionId={split?.left ?? ""}
          rightSessionId={split?.right ?? ""}
        />
      ) : view === "export" ? (
        <ExportDialog
          sessionId={sessions.activeId ?? ""}
          activeQuery={activeQuery}
          onClose={() => setView("main")}
        />
      ) : view === "workspace" ? (
        <WorkspaceManager
          sessions={sessions}
          activeQuery={activeQuery}
          onOpenWorkspace={handleOpenWorkspace}
          onClose={() => setView("main")}
        />
      ) : (
        <WelcomePage sessions={sessions} setView={setView} />
      )}
    </AppShell>
  );
}
