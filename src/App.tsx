// App — the router. Owns the single `useView()` (T1's view state machine) and
// `useSessions()` (T1's open-files registry) instances so the registry is a
// single source of truth shared with the WelcomePage (which opens files).
// Renders the active page inside AppShell (③a's topbar + theme toggle).
// view === "main" → MainWindow (T7's assembled main screen); otherwise the ③a
// WelcomePage placeholder (a full WelcomePage lands in T10).

import { AppShell } from "./components/AppShell";
import { WelcomePage } from "./pages/WelcomePage";
import { MainWindow } from "./pages/MainWindow";
import { useView } from "./router";
import { useSessions } from "./hooks/useSessions";

export function App() {
  const { view } = useView();
  const sessions = useSessions();
  return (
    <AppShell>
      {view === "main" ? (
        <MainWindow sessions={sessions} />
      ) : (
        <WelcomePage />
      )}
    </AppShell>
  );
}
