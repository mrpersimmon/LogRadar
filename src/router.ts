// View state machine for LogRadar's top-level navigation. Each View is a
// distinct full-screen layout the AppShell swaps between. `useView` is a thin
// `useState` wrapper with a stable `setView` identity (useCallback) so child
// components can memo on it without re-binding handlers on every render.
//
// Task 6 (④a): `setView("split", { left, right })` also stashes the two
// session ids the Compare picker chose, so App's split branch can hand them
// to SplitView. The payload is optional and only meaningful for "split"; other
// transitions ignore it, so existing one-arg `setView(view)` callers (the
// router tests, WelcomePage, ExportDialog/WorkspaceManager onClose) are
// unchanged.

import { useState, useCallback } from "react";

export type View = "welcome" | "main" | "split" | "export" | "workspace";

/** The two open-session ids a Compare compare should render side-by-side.
 *  Set by MainWindow's Compare picker via `setView("split", selection)`. */
export type SplitSelection = { left: string; right: string };

export function useView(): {
  view: View;
  setView: (v: View, split?: SplitSelection) => void;
  split: SplitSelection | null;
} {
  const [view, setView] = useState<View>("welcome");
  const [split, setSplit] = useState<SplitSelection | null>(null);
  const go = useCallback((v: View, sel?: SplitSelection) => {
    setView(v);
    if (sel) setSplit(sel);
  }, []);
  return { view, setView: go, split };
}
