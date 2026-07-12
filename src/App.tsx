// App — the router. Owns the single `useView()` (T1's view state machine) and
// `useSessions()` (T1's open-files registry) instances so the registry is a
// single source of truth shared with the WelcomePage (which opens files).
// Renders the active page inside AppShell (③a's topbar + theme toggle).
// view === "main" → MainWindow (T7); "export" → ExportDialog (T10);
// "workspace" → WorkspaceManager (T10); otherwise the full WelcomePage (T10).
// WelcomePage's open flow wires openDialog → sessions.open → setView("main"),
// closing the T7 gap (router flips to MainWindow on open).

import { AppShell } from "./components/AppShell";
import { WelcomePage } from "./pages/WelcomePage";
import { MainWindow } from "./pages/MainWindow";
import { ExportDialog } from "./pages/ExportDialog";
import { WorkspaceManager } from "./pages/WorkspaceManager";
import { useView } from "./router";
import { useSessions } from "./hooks/useSessions";

export function App() {
  const { view, setView } = useView();
  const sessions = useSessions();
  return (
    <AppShell>
      {view === "main" ? (
        <MainWindow sessions={sessions} />
      ) : view === "export" ? (
        <ExportDialog
          sessionId={sessions.activeId ?? ""}
          onClose={() => setView("main")}
        />
      ) : view === "workspace" ? (
        <WorkspaceManager
          sessions={sessions}
          onClose={() => setView("main")}
        />
      ) : (
        <WelcomePage sessions={sessions} setView={setView} />
      )}
    </AppShell>
  );
}
