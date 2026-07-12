# LogRadar Frontend Pages Implementation Plan (③b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Build the full LogRadar UI pages on top of ③a's foundation (Vite/React/TS + IPC client + theme + AppShell, on `main` commit `465c506`): MainWindow (sidebar tree + tabs + virtualized log view + minimap + bottom search panel), SplitView, JsonInspector, ExportDialog, WorkspaceManager, full WelcomePage — ported from the confirmed mockups in `.superpowers/brainstorm/`.

**Architecture:** React components in `src/components/` + `src/pages/`, calling ③a's `src/lib/ipc.ts` (typed `invoke` wrappers + `useSearch`). Routing = a simple `view` state machine (welcome/main/split) — no react-router (YAGNI for a single-window app). `useSearch` is wrapped reactive (`useSyncExternalStore`). The premium visual code (JSX structure + CSS) is PORTED from the confirmed mockups (each task names its source `.html` in `.superpowers/brainstorm/<session>/content/`); the plan specifies the React structure + IPC wiring + tests, not full CSS re-spec.

**Tech Stack:** React 18 + TS 5 (on `main`), `@tauri-apps/api` v2, `@tauri-apps/plugin-dialog`, Vitest + @testing-library/react. Mockups: `.superpowers/brainstorm/28981-1783828764/content/*.html` (premium-redesign, welcome-v3/v4, main-window-v4/v5/v6/v7, split-view-v3, json-inspector, export, workspace, tabs-comparison).

## Global Constraints

- React 18, TS 5, Tauri 2 (`@tauri-apps/api` v2). Reuse ③a's `ipc.ts` (typed wrappers) + `theme/` (tokens, `useTheme`, `ThemeToggle`) + `AppShell`.
- **Port visuals from the mockups** — each task names its source `.html`; copy the structure + CSS (adapted to React + the CSS-variable tokens from ③a). Don't redesign; the mockups are confirmed.
- **IPC**: pages call `ipc.ts` functions (openFile/getLines/useSearch/cancelSearch/closeSession/exportFile/workspace*), never raw `invoke`.
- **Premium tokens** (③a's `tokens.css`): use `var(--scan)`, `var(--surface)`, etc. — no hardcoded colors.
- **TDD**: failing test → see fail → minimal impl → see pass → commit. Frequent commits.
- **`useSearch` reactive rework** (③a final-review M1/M2): wrap in `useSyncExternalStore` (referentially-stable snapshot — NEW array per batch, not in-place mutation) + add `"error"` status. This is Task 1 (foundation for SearchPanel).
- **Real Tauri window** (③a had `windows:[]` headless): Task 2 adds a window + capabilities to `tauri.conf.json` so the IPC actually runs (openFile/useSearch need a runtime window).
- Out of scope: packaging/CI (④).

---

## File Structure

```
src/
  lib/ipc.ts                  # (③a) — Task 1 reworks useSearch reactive
  router.ts                   # view state machine (welcome/main/split/export/workspace)
  hooks/
    useSessions.ts            # open-files registry (sessionId → meta) + active tab
  components/
    FileTree.tsx (+.css)      # sidebar directory tree (port from main-window-v4)
    TabStrip.tsx (+.css)      # top tabs (port from tabs-comparison B / main-window-v7)
    VirtualLogView.tsx        # virtualized log view, windowed get_lines
    Minimap.tsx (+.css)       # signal-trace minimap (port from main-window-v4/premium-redesign)
    SyntaxHighlighter.tsx     # level/timestamp/JSON coloring (port line rendering from mockups)
    SearchPanel.tsx (+.css)   # bottom panel: form + history + flat results (port main-window-v7)
    JsonInspector.tsx          # inline JSON tree expand (port from json-inspector)
  pages/
    MainWindow.tsx (+.css)    # assembles FileTree+TabStrip+VirtualLogView+SearchPanel+Minimap (port main-window-v7)
    WelcomePage.tsx (+.css)   # FULL: radar sweep + recents + workspaces (port welcome-v3)
    SplitView.tsx (+.css)     # two panes + time-sync gutter + tolerance (port split-view-v3)
    ExportDialog.tsx (+.css)  # export modal (port export)
    WorkspaceManager.tsx (+.css) # workspace modal (port workspace)
  App.tsx                     # router: renders the active page in AppShell
src-tauri/tauri.conf.json     # Task 2: add a window + capabilities
```

---

## Task 1: Reactive `useSearch` + router

**Files:**
- Modify: `src/lib/ipc.ts` (`useSearch` → `useSyncExternalStore`-ready: expose `subscribe` + referentially-stable snapshot; add `"error"` status + try/catch in `run`)
- Create: `src/router.ts` (view state machine), `src/hooks/useSessions.ts` (open-files registry)
- Test: `src/lib/ipc.test.ts` (extend), `src/router.test.ts`, `src/hooks/useSessions.test.ts`

**Interfaces:**
- Produces: `useSearch` returning `{ matches: number[], status: SearchStatus, run, cancel, subscribe }` (reactive via `useSyncExternalStore`); `SearchStatus = "idle"|"running"|"done"|"cancelled"|"error"`; `router.ts` exporting `useView()` → `{view, setView}` (view: "welcome"|"main"|"split"|"export"|"workspace"); `useSessions()` → `{sessions, activeId, open(path), close(id), setActive(id)}`.

- [ ] **Step 1: Write failing tests**

`src/lib/ipc.test.ts` (extend): a test that subscribes + drives `channel.onmessage` with 2 batches, asserts the snapshot reference CHANGES between batches (referential stability — `useSyncExternalStore` requirement) + `matches` accumulates correctly; + a test that `invoke("search")` rejecting sets `status="error"`.

`src/router.test.ts`: `useView()` defaults to `"welcome"`, `setView("main")` updates.

`src/hooks/useSessions.test.ts`: `open("/a.log")` adds a session (mocked `openFile`) + sets active; `close(id)` removes + cancels (mocked `closeSession`).

- [ ] **Step 2: Run → FAIL** (`npm test`).

- [ ] **Step 3: Implement** — rework `useSearch`:
```ts
import { useSyncExternalStore } from "react";
export type SearchStatus = "idle"|"running"|"done"|"cancelled"|"error";
// Controller holds: matches (new array per batch), status, subscribers, channel.
// subscribe(cb) registers; notify() calls all + bumps a version so getSnapshot returns a new ref.
// run(): try { invoke("search", {onEvent: channel}) } catch { status="error"; notify() }
// channel.onmessage: batch → matches = [...matches, ...batch.matches] (NEW array); notify(). done → status; notify().
// React binding:
export function useSearch(sessionId: string, query: unknown, cap: number) {
  const ctrl = getController(sessionId, query, cap); // singleton-per-(sessionId,query,cap)
  const matches = useSyncExternalStore(ctrl.subscribe, () => ctrl.matchesSnapshot);
  const status = useSyncExternalStore(ctrl.subscribe, () => ctrl.status);
  return { matches, status, run: ctrl.run, cancel: ctrl.cancel };
}
```
`src/router.ts`:
```ts
import { useState, useCallback } from "react";
export type View = "welcome"|"main"|"split"|"export"|"workspace";
export function useView() {
  const [view, setView] = useState<View>("welcome");
  const go = useCallback((v: View) => setView(v), []);
  return { view, setView: go };
}
```
`src/hooks/useSessions.ts`: holds `sessions: Map<sessionId, {meta, lines cache?}>` + `activeId`; `open(path)` → `openFile` → add + setActive; `close(id)` → `closeSession` → remove + reassign active.

- [ ] **Step 4: Run → PASS**. - [ ] **Step 5: Commit** `feat(fe): reactive useSearch (useSyncExternalStore) + error status + router + useSessions`.

---

## Task 2: Tauri window + capabilities (runtime IPC enabler)

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`app.windows` → one window), `src-tauri/capabilities/default.json` (NEW — allow core/dialog/fs perms)

**Interfaces:**
- Produces: a real Tauri window so `cargo tauri dev` shows the app + IPC (openFile/useSearch/dialog) runs at runtime.

- [ ] **Step 1**: Write the config (no unit test — verified by `cargo tauri dev` building a window; the test is "the app launches"):
`src-tauri/tauri.conf.json` `app.windows`:
```json
"windows": [{ "title": "LogRadar", "width": 1280, "height": 800, "resizable": true }]
```
`src-tauri/capabilities/default.json` (Tauri 2 capability — web-verify the v2 schema):
```json
{ "$schema": "../.schema.ts", "identifier": "default", "description": "LogRadar default cap",
  "windows": ["main"], "permissions": ["core:default", "dialog:default", "core:window:allow-set-title"] }
```
(The exact Tauri 2 capability/permission names — web-verify against the resolved tauri 2.x; `core:default` + `dialog:default` are the common v2 defaults.)

- [ ] **Step 2**: `cargo build -p logradar-tauri` (compiles with the window + capability). 
- [ ] **Step 3**: (manual/optional) `cargo tauri dev` → a window opens showing WelcomePage (③a). 
- [ ] **Step 4**: `npm test` still green. - [ ] **Step 5**: Commit `feat(fe): Tauri window + capabilities (runtime IPC)`.

---

## Task 3: FileTree + TabStrip

**Files:** `src/components/FileTree.tsx`(+.css), `src/components/TabStrip.tsx`(+.css), tests.
**Visual source:** `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html` (sidebar tree) + `tabs-comparison.html` (tab strip, option B).
**Interfaces:** Consumes `useSessions` (Task 1). Produces `FileTree({sessions, activeId, onSelect})` (tree by path), `TabStrip({sessions, activeId, onSelect, onClose})`.

- [ ] **Step 1**: Tests — `FileTree` renders open files grouped by dir + highlights active; `TabStrip` renders tabs + active underline + close (×) calls `onClose` (which calls `closeSession`).
- [ ] **Step 2**: Run → FAIL. - [ ] **Step 3**: Port the sidebar + tab-strip HTML/CSS from the mockups (adapt to React + tokens). Wire `onSelect` → `useSessions.setActive`; `onClose` → `useSessions.close` (→ `closeSession` IPC). - [ ] **Step 4**: Run → PASS. - [ ] **Step 5**: Commit.

---

## Task 4: VirtualLogView

**Files:** `src/components/VirtualLogView.tsx`, test.
**Visual source:** `main-window-v7.html` (the log view: line numbers + timestamp + level pip + message + hit highlight + jump-target).
**Interfaces:** Consumes `useSessions` (active session) + `getLines`. Produces `VirtualLogView({sessionId, start, count})` — on scroll, requests only the visible window via `getLines` (assert in test: only visible range requested).

- [ ] **Step 1**: Test — mock `getLines`; render with a 1M-line session; simulate scroll to line 500k; assert `getLines` called with `{start: ~499990, count: viewport}` (NOT the whole file). + hit highlight + jump-target styling.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: Implement a virtualized list (windowed rendering: compute visible [start..end] from scrollTop + row height; request `getLines(start, end-start+1)`; render only visible rows + a spacer div for total height). Port the line rendering (line number / timestamp / level pip / message / hit mark) from the mockup. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 5: SearchPanel (form + full-query history + flat results)

**Files:** `src/components/SearchPanel.tsx`(+.css), `src/components/SearchHistory.tsx`, tests.
**Visual source:** `main-window-v7.html` (the bottom panel: form row + history nav + flat results) — the Notepad++ Find-in-Files style.
**Interfaces:** Consumes `useSearch` (Task 1, reactive) + a session-scoped history store. Produces `SearchPanel({sessionId})` — form (keywords AND/OR + level + time) + `◀▶▾` history (full query per entry, click reruns) + flat file-path results.

- [ ] **Step 1**: Tests — building a query (2 keywords + AND) + level + time → the `search` `query` arg shape; history records the FULL query (keywords+level+time) + a click reruns; results render flat file-rows.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port the SearchPanel structure from the mockup. The form builds a `SearchRequest` JSON (matching ②'s DTO: `{root: {leaf: {text: "..."}} | {branch: {combinator: "AND", children: [...]}}}`). History = session-scoped in-memory array of full Query objects (click → re-fill form + `useSearch.run`). Results = flat `logs/auth/a.log · 8 hits` rows (from `useSearch.matches` → render via `getLines` for visible result rows). - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 6: Minimap + SyntaxHighlighter

**Files:** `src/components/Minimap.tsx`(+.css), `src/components/SyntaxHighlighter.tsx`, test.
**Visual source:** `main-window-v7.html` / `premium-redesign.html` (the signal-trace minimap) + line coloring.
**Interfaces:** `Minimap({levelDistribution, viewport})` (signal trace: baseline + level blips + scan window), `SyntaxHighlighter` (a function/component coloring a line's tokens: level pip + timestamp dim + hit mark).

- [ ] **Step 1**: Test — `Minimap` renders blips colored by level + a viewport marker; `SyntaxHighlighter` colors a line `"14:22:01 ERROR db refused"` with the `refused` hit highlighted.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port the trace (concentric-free: vertical baseline + colored blips + scan window) + the line coloring from mockups. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 7: MainWindow (assemble)

**Files:** `src/pages/MainWindow.tsx`(+.css), test.
**Visual source:** `main-window-v7.html` (the full main screen layout: tabs + sidebar tree + log view + minimap + bottom search panel).
**Interfaces:** Consumes Tasks 3–6. Produces `MainWindow` — assembles `TabStrip` + `FileTree` + `VirtualLogView` + `Minimap` + `SearchPanel` in the layout.

- [ ] **Step 1**: Test — `MainWindow` renders all sub-components + the active session's lines via `VirtualLogView`. - [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port the layout from the mockup (flex: top tabs, left sidebar, center log-view+minimap, bottom search panel). Wire `useSessions` active → `VirtualLogView`/`SearchPanel`. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 8: SplitView

**Files:** `src/pages/SplitView.tsx`(+.css), test.
**Visual source:** `split-view-v3.html` (two panes + time-sync gutter + tolerance control).
**Interfaces:** `SplitView({leftSessionId, rightSessionId})` — two `VirtualLogView`s + a center time-sync gutter + `同滚` toggle + `容差` input + `对齐` mode.

- [ ] **Step 1**: Test — `同滚` on + `容差 10ms` + a cancel scenario renders both panes + the gutter marker (Δ + 超差 styling). (Time-sync logic is the frontend's: scroll left → request right at nearest time — but the actual time-matching uses the timestamps in the lines, which the frontend parses; for v1, a simpler "scroll-spy" — left scroll offset → right scroll to the line with the closest timestamp. Test the UI state, not the exact matching.)
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port from the mockup. The time-sync: parse timestamps from visible lines (via the line content) + scroll-spy. Tolerance UI (input + presets). - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 9: JsonInspector

**Files:** `src/components/JsonInspector.tsx`, test.
**Visual source:** `json-inspector.html` (inline JSON tree expand).
**Interfaces:** `JsonInspector({line})` — parses a JSON log line, renders an inline expandable field tree (key/string/number coloring + ▾/▸ fold + hit highlight within JSON).

- [ ] **Step 1**: Test — given a JSON line `{"event":"db_error","code":"ECONNREFUSED","user":{"id":42}}`, renders the tree; expanding `user` shows `id: 42`; `ECONNREFUSED` (containing the search term) is highlighted. - [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port from the mockup. Parse JSON (a small recursive renderer; ▾/▸ state per node). - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 10: ExportDialog + WorkspaceManager + full WelcomePage

**Files:** `src/pages/ExportDialog.tsx`(+.css), `src/pages/WorkspaceManager.tsx`(+.css), `src/pages/WelcomePage.tsx` (FULL rewrite), tests.
**Visual source:** `export.html`, `workspace.html`, `welcome-v3.html`.
**Interfaces:** `ExportDialog({sessionId})` (range/format/columns/target + preview + progress → `exportFile`), `WorkspaceManager` (save current + list + open → `workspaceSave/Load/List`), full `WelcomePage` (radar sweep + recents + workspaces).

- [ ] **Step 1**: Tests — `ExportDialog` builds the args + preview reflects columns; `WorkspaceManager` lists + opens; `WelcomePage` shows drop zone + recents + workspace cards. - [ ] **Step 2**: FAIL. - [ ] **Step 3**: Port all three from mockups. ExportDialog → `exportFile`; WorkspaceManager → `workspace*`; WelcomePage radar sweep (CSS animation, reduced-motion respected — port from welcome-v3). - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Self-Review

**Spec coverage (③b = the pages):** MainWindow(T7) + FileTree/TabStrip(T3) + VirtualLogView(T4) + SearchPanel+history(T5) + Minimap(T6) + SplitView(T8) + JsonInspector(T9) + ExportDialog(T10) + WorkspaceManager(T10) + full WelcomePage(T10) + SyntaxHighlighter(T6) + reactive useSearch(T1) + routing(T1) + Tauri window(T2). All 6 confirmed pages + the components. ✓
**Placeholder scan:** Tasks reference mockups for the full visual code (the plan specifies React structure + IPC + tests, not full CSS — the mockups ARE the complete visual source, on disk). No "TBD." Task 1's `useSearch` rework code is sketched (the controller singleton pattern) — implementer fleshes out the `useSyncExternalStore` binding; the test (referential stability + error status) is the spec.
**Type consistency:** `useSessions` (sessions/activeId/open/close) consistent T1(def) ↔ T3(FileTree/TabStrip) ↔ T4/T5/T7. `useSearch` (matches/status/run/cancel/subscribe) consistent T1(def) ↔ T5(SearchPanel). `View` type consistent T1 ↔ App router. ✓
**Gaps (deferred to ④):** the time-sync matching in SplitView (T8) is a v1 scroll-spy approximation (proper time-normalized matching via the core's FormatDetector is a ④ refinement); packaging/CI (④).

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-13-logradar-frontend-pages.md`. Execute via superpowers:subagent-driven-development (per the user's loop directive).
