# LogRadar Frontend Wiring + Cleanup Plan (④a)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Complete LogRadar's frontend by wiring the ③b-deferred integration loops — lift `useSearch` to App-level so the search→view hits/jump loop, export-with-current-query, and workspace-save-with-queries all work — plus recents, cross-file search aggregation, JsonInspector↔VirtualLogView, SplitView routing, onOpenWorkspace, and token/parser/controller cleanup.

**Architecture:** The key change is lifting `useSearch` (active query + matches) from `SearchPanel` to `App`/`MainWindow` (the controller registry dedupes by key, so sharing one instance across SearchPanel/VirtualLogView/ExportDialog/WorkspaceManager is safe — no duplicate scans). This unblocks: VirtualLogView hit-highlight/jump (D1), ExportDialog current-query range, WorkspaceManager save-with-queries (E3). Plus a recents store (localStorage), cross-file search (aggregate multiple sessions' matches), JsonInspector↔VirtualLogView (▸展开JSON), SplitView router (2-session picker), onOpenWorkspace (open files into sessions).

**Tech Stack:** React 18 + TS 5 (on `main`), `@tauri-apps/api` v2, Vitest + @testing-library/react. Reuse ③a/③b components.

## Global Constraints

- React 18, TS 5. Reuse existing components (③a/③b); don't rewrite.
- The ③b final-review I1/I2 fixes are on `main` (run() resets matches; ExportDialog sends valid SearchRequest). Build on them.
- Premium tokens (no hardcoded colors — the ③b review M1 found `#06231f` + `rgba(...)` hardcoded; ④a cleans these up).
- TDD: failing test → see fail → minimal impl → see pass → commit. Frequent commits.
- Out of scope: packaging/CI (④b).

---

## File Structure (modifications to existing ③a/③b files)
```
src/App.tsx                  # owns useSearch (lifted) + active query state
src/components/SearchPanel.tsx  # consumes lifted useSearch (no local instance)
src/components/VirtualLogView.tsx # receives matches/highlightTerm/jumpToLine from lifted search
src/pages/MainWindow.tsx       # passes lifted matches → VirtualLogView; SplitView 2-session picker
src/pages/ExportDialog.tsx     # current-query range enabled (uses lifted query)
src/pages/WorkspaceManager.tsx # save-with-queries (uses lifted queries)
src/pages/WelcomePage.tsx      # loads recents (localStorage) on mount
src/lib/recents.ts             # NEW: recents store (localStorage)
src/lib/ipc.ts                 # cleanup: controller-registry eviction on close; cross-file search helper
src/theme/tokens.css           # +--on-scan token; light-theme radar via color-mix
```

---

## Task 1: Lift `useSearch` to App + search→view hits/jump loop (I3/I4)

**Files:** `src/App.tsx`, `src/components/SearchPanel.tsx`, `src/components/VirtualLogView.tsx`, `src/pages/MainWindow.tsx`
**Test:** `src/App.test.tsx` (extend), `src/pages/MainWindow.test.tsx` (extend)

**Interfaces:**
- Produces: `App` owns `const search = useSearch(activeSessionId, activeQuery, cap)` + `activeQuery` state (a `SearchRequest` JSON); passes `search` + `activeQuery` down to MainWindow → SearchPanel/VirtualLogView/ExportDialog/WorkspaceManager. SearchPanel becomes controlled (consumes the lifted `search.run`/`search.matches`, builds the query → `setActiveQuery` + `search.run()`). VirtualLogView receives `matches` (line numbers) + `highlightTerm` (the keyword) + `jumpToLine` (click a result → scroll).

- [ ] **Step 1**: Tests — `MainWindow` passes `matches`/`highlightTerm` to VirtualLogView (assert a hit line is highlighted); a result-row click calls `jumpToLine` (assert VirtualLogView scrolls). RED (current MainWindow doesn't pass these).
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: Lift `useSearch` to App; SearchPanel consumes it (remove local instance); MainWindow passes `search.matches` + the keyword → VirtualLogView's `hits`/`highlightTerm`/`jumpToLine`. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit `feat(fe): lift useSearch to App + search→view hits/jump loop`.

---

## Task 2: ExportDialog current-query range + WorkspaceManager save-with-queries

**Files:** `src/pages/ExportDialog.tsx`, `src/pages/WorkspaceManager.tsx`, `src/App.tsx`
**Test:** extend both.

- [ ] **Step 1**: Tests — ExportDialog "current-query" range is ENABLED (was disabled in ③b-fix) + sends the lifted `activeQuery` (a valid SearchRequest); WorkspaceManager save includes the lifted `activeQuery` in `queries`. RED.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: ExportDialog current-query uses the lifted `activeQuery`; re-enable the range. WorkspaceManager save → `workspaceSave({name, files, queries: [activeQuery]})`. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 3: Recents store (localStorage)

**Files:** `src/lib/recents.ts` (NEW), `src/pages/WelcomePage.tsx`
**Test:** `src/lib/recents.test.ts`

- [ ] **Step 1**: Tests — `addRecent(path)` adds + dedupes (cap 20); `getRecents()` returns them; WelcomePage renders recents on mount (mocked). RED.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: `recents.ts` — `getRecents(): string[]` (localStorage `logradar-recents`, JSON array, cap 20, dedupe), `addRecent(path)`. WelcomePage loads recents on mount + renders them; clicking a recent → `openFile` → `useSessions.open` → `setView("main")`. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 4: Cross-file search aggregation

**Files:** `src/lib/ipc.ts` (a `useCrossFileSearch` or a helper), `src/components/SearchPanel.tsx`
**Test:** extend.

- [ ] **Step 1**: Tests — given 3 open sessions, a search aggregates matches across all 3 into flat file-path results (`a.log · 8`, `b.log · 4`, `c.log · 5`). RED (current SearchPanel is single-session).
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: A `useCrossFileSearch(sessionIds, query, cap)` that runs `useSearch` per session + aggregates matches into `{ [sessionId]: matches }` → flat results. SearchPanel uses it (renders one row per session with hits). - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 5: JsonInspector ↔ VirtualLogView (▸展开JSON affordance)

**Files:** `src/components/VirtualLogView.tsx`, `src/components/JsonInspector.tsx`
**Test:** extend VirtualLogView.

- [ ] **Step 1**: Tests — a JSON log line shows a `▸展开JSON` affordance; clicking expands the JsonInspector inline beneath the line; collapsing hides it. RED.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: VirtualLogView detects JSON lines (a `try { JSON.parse(line) }` check) + renders a ▾/▸ toggle; expanded → render `<JsonInspector line={line} hits={...} />` indented beneath. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 6: SplitView router (2-session picker) + onOpenWorkspace App-wiring

**Files:** `src/App.tsx`, `src/pages/MainWindow.tsx`, `src/pages/WorkspaceManager.tsx`
**Test:** extend.

- [ ] **Step 1**: Tests — a "Compare" action (pick 2 open sessions) → `setView("split")` → SplitView renders with both; `onOpenWorkspace` opens the workspace's files into `useSessions` + restores the first query. RED.
- [ ] **Step 2**: FAIL. - [ ] **Step 3**: MainWindow adds a "Compare" picker (2 sessions) → `setView("split")` with `{left, right}`. App's `onOpenWorkspace` → `workspaceLoad` → for each file `openFile` + `useSessions.open` → restore the first query via `setActiveQuery`. - [ ] **Step 4**: PASS. - [ ] **Step 5**: Commit.

---

## Task 7: Cleanup (tokens, parser dedupe, controller eviction)

**Files:** `src/theme/tokens.css`, `src/components/VirtualLogView.tsx`, `src/components/SyntaxHighlighter.tsx`, `src/lib/ipc.ts`
**Test:** ensure existing tests stay green.

- [ ] **Step 1**: Add `--on-scan: #06231f` token to both theme blocks; replace hardcoded `#06231f` across SearchPanel/SplitView/WorkspaceManager/ExportDialog/WelcomePage with `var(--on-scan)`. Replace hardcoded `rgba(30,138,124,…)` in WelcomePage light-theme radar with `color-mix(in srgb, var(--scan) N%, transparent)`. Route scrims/shadows via `var(--shadow)`.
- [ ] **Step 2**: Dedupe the parser — VirtualLogView uses `SyntaxHighlighter` (remove VirtualLogView's local `parseLine`/`HighlightedMessage`).
- [ ] **Step 3**: Controller-registry eviction — on `useSessions.close(id)`, drop that sessionId's controllers from the registry (prevent leak).
- [ ] **Step 4**: `npm test` green + `npx tsc --noEmit` clean. - [ ] **Step 5**: Commit `fix(fe): token discipline (--on-scan, color-mix) + parser dedupe + controller eviction`.

---

## Self-Review

**Coverage:** I3/I4 (T1), export/workspace-with-queries (T2), recents (T3), cross-file (T4), JsonInspector↔view (T5), SplitView router + onOpenWorkspace (T6), cleanup (T7). All ③b-deferred wiring + the review's Minors. ✓
**Deferred to ④b:** packaging (tauri build .dmg/.msi), CI (macOS+Win GitHub Actions), `dirs` crate (config dir), ExportDialog real progress (needs a ② progress event — deferred), level-distribution IPC (stats deferred — Minimap uses visible-window approximation for now).
**Type consistency:** `useSearch` lifted to App (shared) — SearchPanel/VirtualLogView/ExportDialog/WorkspaceManager consume it. `SearchRequest` shape consistent. ✓

## Execution Handoff
Saved to `docs/superpowers/plans/2026-07-13-logradar-frontend-wiring.md`. Execute via superpowers:subagent-driven-development (per the user's loop).
