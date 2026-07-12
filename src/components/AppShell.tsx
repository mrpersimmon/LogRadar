import { ThemeToggle } from "./ThemeToggle";
import "./AppShell.css";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg className="radar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5.5" />
            <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
            <path d="M12 12 L21 6" strokeLinecap="round" />
          </svg>
          <b>LogRadar</b><span>signal trace</span>
        </div>
        <span className="spacer" />
        <ThemeToggle />
      </header>
      {children}
    </div>
  );
}
