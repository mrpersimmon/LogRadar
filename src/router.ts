// View state machine for LogRadar's top-level navigation. Each View is a
// distinct full-screen layout the AppShell swaps between. `useView` is a thin
// `useState` wrapper with a stable `setView` identity (useCallback) so child
// components can memo on it without re-binding handlers on every render.

import { useState, useCallback } from "react";

export type View = "welcome" | "main" | "split" | "export" | "workspace";

export function useView(): { view: View; setView: (v: View) => void } {
  const [view, setView] = useState<View>("welcome");
  const go = useCallback((v: View) => setView(v), []);
  return { view, setView: go };
}
