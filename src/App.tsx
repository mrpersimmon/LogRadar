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
// "export" → ExportDialog (T10, now receives the lifted activeQuery);
// "workspace" → WorkspaceManager (T10, now saves the lifted activeQuery);
// otherwise the full WelcomePage (T10).

import { useState } from "react";
import { AppShell } from "./components/AppShell";
import { WelcomePage } from "./pages/WelcomePage";
import { MainWindow } from "./pages/MainWindow";
import { ExportDialog } from "./pages/ExportDialog";
import { WorkspaceManager } from "./pages/WorkspaceManager";
import { useView } from "./router";
import { useSessions } from "./hooks/useSessions";
import { useSearch } from "./lib/ipc";
import {
  EMPTY_QUERY,
  extractHighlightTerm,
  type SearchRequest,
} from "./components/SearchPanel";

/** The match cap forwarded to the Rust `search` command. Matches SearchPanel's
 *  own default; kept here so App (which owns the lift) controls it. */
const SEARCH_CAP = 1000;

export function App() {
  const { view, setView } = useView();
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
  // The first text-predicate's keyword, surfaced to VirtualLogView so matched
  // lines wrap the term in `<mark class="hit">`. "" for level/time-only queries.
  const highlightTerm = extractHighlightTerm(activeQuery);
  return (
    <AppShell>
      {view === "main" ? (
        <MainWindow
          sessions={sessions}
          search={search}
          setActiveQuery={setActiveQuery}
          highlightTerm={highlightTerm}
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
          onClose={() => setView("main")}
        />
      ) : (
        <WelcomePage sessions={sessions} setView={setView} />
      )}
    </AppShell>
  );
}
