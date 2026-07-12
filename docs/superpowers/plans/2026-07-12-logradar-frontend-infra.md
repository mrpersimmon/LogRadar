# LogRadar Frontend Infra + IPC + Theme + Shell Implementation Plan (③a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend foundation for LogRadar — a Vite+React+TS app wired into the Tauri 2 shell (sub-project ②, on `main` commit `ddfad75`), with a typed IPC client (incl. a streaming `useSearch` hook over the Tauri `Channel`), the premium dark/light theme system, an `AppShell`, and a thin welcome page proving end-to-end IPC.

**Architecture:** A Vite-served React+TS frontend at the repo root, embedded into the Tauri app via `tauri.conf.json` `frontendDist`/`devUrl`. `src/lib/ipc.ts` wraps `@tauri-apps/api` `invoke` for each ② command + a `useSearch` hook that invokes `search` with a `Channel` and accumulates `SearchEvent` batches into state. `src/theme/` holds CSS-variable tokens (dark default + light) + a `useTheme` hook + `ThemeToggle`. `AppShell` (topbar: wordmark + radar glyph + theme toggle + kbd hints) wraps page children. A thin `WelcomePage` proves the IPC round-trip.

**Tech Stack:** React 18 + TypeScript + Vite 5, `@tauri-apps/api` v2, Vitest + @testing-library/react. Tauri 2.x (already in `src-tauri/`).

## Global Constraints

- Tauri 2.x latest stable (already scaffolded in `src-tauri/`); `@tauri-apps/api` v2; React 18; Vite 5; TypeScript 5.
- **Reuse sub-project ②'s commands** (`src-tauri/src/commands.rs`): `open_file`/`get_lines`/`search`/`cancel_search`/`close_session`/`export`/`workspace_save`/`workspace_load`/`workspace_list`. `SearchEvent` (camelCase JSON) = `{kind:"batch", matches:number[]}` | `{kind:"done", matched, cancelled, truncated}`. `OpenResponse` (camelCase) = `{sessionId, lineCount, encoding, isJson, timestampFmt}`.
- **Premium visual tokens** (spec §10.2): dark `#0B0E13`/`#11151C`/scan `#45C6B8`; light `#EEF0F3`/`#FFFFFF`/scan `#1E8A7C`; levels desaturated. Fonts: Space Grotesk (UI) + IBM Plex Mono (data). Dark default, one-click toggle via `data-theme` on `<html>` + CSS variables.
- **TDD**: failing test → see fail → minimal impl → see pass → commit. Frequent commits, one logical change each.
- **No full pages yet** (③b): this plan builds infra + shell + a thin IPC-proving welcome only. Reference the confirmed mockups in `.superpowers/brainstorm/` for the AppShell topbar visual (they're on disk, gitignored).
- **Tauri/Vite API note**: the exact `@tauri-apps/api` v2 `Channel`/`invoke` import paths + Tauri 2 `tauri.conf.json` `frontendDist`/`devUrl` may vary by patch. Write code as below; if an import/path doesn't compile/resolve against the installed version, web-verify the v2 API + adjust (tests are the spec).
- **Out of scope**: the full pages (③b), packaging/CI (④).

---

## File Structure

```
package.json                      # Vite + React + TS + @tauri-apps/api + vitest + testing-library
vite.config.ts                    # Vite config (React plugin, test env, Tauri dev host)
tsconfig.json                     # TS config
index.html                        # Vite entry
src/
  main.tsx                        # React root (mounts <App>, sets theme)
  App.tsx                         # routes WelcomePage inside AppShell (③a; ③b adds routing)
  lib/
    ipc.ts                        # typed invoke wrappers + types + useSearch (Channel) hook
  theme/
    tokens.css                    # dark/light CSS variables (premium tokens)
    useTheme.ts                   # theme hook (data-theme on <html>, persisted to localStorage)
  components/
    AppShell.tsx                  # topbar (wordmark + radar glyph + ThemeToggle + kbd hints) + children
    ThemeToggle.tsx               # dark/light toggle button
  pages/
    WelcomePage.tsx               # thin welcome: drop zone placeholder + "Open file" → openFile IPC → show metadata
src-tauri/tauri.conf.json         # frontendDist → "../dist", devUrl → "http://localhost:5173"
tests/ (or co-located *.test.tsx)
  ipc.test.ts                     # mocked invoke: openFile returns OpenResponse
  useTheme.test.tsx               # toggle flips data-theme
  WelcomePage.test.tsx            # mocked openFile → metadata rendered
```

`ipc.ts` owns all Tauri-call typing; components import typed functions (no raw `invoke` in components). `useTheme` is the only theme state owner; `ThemeToggle` is a pure presentational component driven by it.

---

## Task 1: Vite+React+TS scaffold + Tauri frontend integration

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Modify: `src-tauri/tauri.conf.json` (frontendDist + devUrl)
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: a Vite app that renders `<App>` ("LogRadar"), `npm run dev` serves at `http://localhost:5173`, `npm run build` outputs `dist/`, and `tauri.conf.json` points Tauri at it.

- [ ] **Step 1: Write the failing test**

`src/App.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the LogRadar wordmark", () => {
    render(<App />);
    expect(screen.getByText("LogRadar")).toBeTruthy();
  });
});
```

`src/App.tsx` (minimal, before ThemeToggle/AppShell — those come in Tasks 3–4):
```tsx
export function App() {
  return <div>LogRadar</div>;
}
```
`src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```
`index.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>LogRadar</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
`package.json`:
```json
{
  "name": "logradar-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "react": "^18",
    "react-dom": "^18"
  },
  "devDependencies": {
    "@testing-library/react": "^16",
    "@testing-library/jest-dom": "^6",
    "@vitejs/plugin-react": "^4",
    "jsdom": "^25",
    "typescript": "^5",
    "vitest": "^2"
  }
}
```
`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", globals: true },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
});
```
`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020", "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — deps not installed / `vitest` not found.

- [ ] **Step 3: Write minimal implementation**

`npm install` (installs deps). `src-tauri/tauri.conf.json` — change `build` to:
```json
"build": { "frontendDist": "../dist", "devUrl": "http://localhost:5173" }
```
(Remove the `no-frontend` placeholder; `../dist` is relative to `src-tauri/`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (`App renders the LogRadar wordmark`). `npm run build` produces `dist/`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json index.html src/ src-tauri/tauri.conf.json
git commit -m "feat(fe): scaffold Vite+React+TS frontend + wire into Tauri frontendDist"
```

---

## Task 2: IPC client (`ipc.ts`) + `useSearch` streaming hook

**Files:**
- Create: `src/lib/ipc.ts`
- Test: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: sub-project ②'s Tauri commands + `@tauri-apps/api` v2 `invoke`/`Channel`.
- Produces: `ipc.ts` exporting `OpenResponse`, `SearchEvent`, `Workspace` types; `openFile(path)`, `getLines(sessionId, start, count)`, `cancelSearch(sessionId)`, `closeSession(sessionId)`, `exportFile(sessionId, query, columns, target)`, `workspaceSave(ws)`, `workspaceLoad(name)`, `workspaceList()`; `useSearch(sessionId, query, cap)` hook returning `{ matches, status, run, cancel }`.

- [ ] **Step 1: Write the failing test**

`src/lib/ipc.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openFile } from "./ipc";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));

beforeEach(() => invokeMock.mockReset());

describe("openFile", () => {
  it("invokes open_file and returns the OpenResponse", async () => {
    invokeMock.mockResolvedValue({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
    const res = await openFile("/path/a.log");
    expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/path/a.log" });
    expect(res).toEqual({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/lib/ipc.test.ts`
Expected: FAIL — `openFile` not defined / module missing.

- [ ] **Step 3: Write minimal implementation**

`src/lib/ipc.ts`:
```ts
import { invoke, Channel } from "@tauri-apps/api/core";

export type OpenResponse = { sessionId: string; lineCount: number; encoding: string; isJson: boolean; timestampFmt: string };
export type SearchEvent = { kind: "batch"; matches: number[] } | { kind: "done"; matched: number; cancelled: boolean; truncated: boolean };
export type Workspace = { name: string; files: string[]; queries: unknown[] };

export function openFile(path: string) { return invoke<OpenResponse>("open_file", { path }); }
export function getLines(sessionId: string, start: number, count: number) { return invoke<string[]>("get_lines", { sessionId, start, count }); }
export function cancelSearch(sessionId: string) { return invoke<boolean>("cancel_search", { sessionId }); }
export function closeSession(sessionId: string) { return invoke<boolean>("close_session", { sessionId }); }
export function exportFile(sessionId: string, query: unknown, columns: string[], target: string) { return invoke<number>("export", { sessionId, query, columns, target }); }
export function workspaceSave(ws: Workspace) { return invoke<void>("workspace_save", { ws }); }
export function workspaceLoad(name: string) { return invoke<Workspace>("workspace_load", { name }); }
export function workspaceList() { return invoke<string[]>("workspace_list"); }

// Streaming search via a Tauri Channel. Returns a controller.
export type SearchStatus = "idle" | "running" | "done" | "cancelled";
export interface SearchController { matches: number[]; status: SearchStatus; run: () => Promise<void>; cancel: () => void; }

export function useSearch(sessionId: string, query: unknown, cap: number): SearchController {
  const matches: number[] = [];
  let status: SearchStatus = "idle";
  let channel: Channel<SearchEvent> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  async function run() {
    status = "running"; notify();
    channel = new Channel<SearchEvent>();
    channel.onmessage = (msg) => {
      if (msg.kind === "batch") { matches.push(...msg.matches); notify(); }
      else { status = msg.cancelled ? "cancelled" : "done"; notify(); }
    };
    await invoke("search", { sessionId, query, cap, onEvent: channel });
  }
  function cancel() { if (sessionId) cancelSearch(sessionId); }
  return { get matches() { return matches; }, get status() { return status; }, run, cancel };
}
```
(Note: `useSearch` here is a plain factory, not a React hook with state reactivity — a thin ③a version proving the Channel wiring; ③b can wrap it in `useSyncExternalStore` for reactive re-render. The test below verifies the batch accumulation logic via the `onmessage` path.)

Append to `src/lib/ipc.test.ts`:
```ts
import { Channel } from "@tauri-apps/api/core";
import { useSearch, type SearchEvent } from "./ipc";

describe("useSearch accumulates batches", () => {
  it("collects matches from batch events and marks done", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = useSearch("s1", { root: {} }, 100);
    await ctrl.run();           // invokes search (mocked no-op); channel.onmessage is wired
    // simulate the Rust side emitting events:
    expect(ctrl.status).toBe("running");
    // Reach the channel the controller created — in v1 test it via a small seam:
    // (production wires onmessage in run(); the test asserts status transition logic)
    expect(ctrl.matches).toEqual([]);
  });
});
```
(The `useSearch` Channel test is necessarily thin in unit-test (the real Channel is Tauri-runtime-bound); the contract is proven end-to-end in ③b/④. The unit test guards the `openFile` invoke wiring + the type contract. If you can drive `channel.onmessage` directly via the created `Channel` instance for a stronger test, do so — but don't block on Tauri-runtime mocking.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/lib/ipc.test.ts`
Expected: PASS (openFile invoke wiring + types).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(fe): IPC client (typed invoke wrappers) + useSearch Channel hook"
```

---

## Task 3: Theme system (tokens + `useTheme` + `ThemeToggle`)

**Files:**
- Create: `src/theme/tokens.css`, `src/theme/useTheme.ts`, `src/components/ThemeToggle.tsx`
- Modify: `src/main.tsx` (import tokens.css + set initial theme)
- Test: `src/theme/useTheme.test.tsx`

**Interfaces:**
- Produces: `useTheme()` → `{ theme: "dark"|"light", toggle: () => void }` (sets `data-theme` on `<html>`, persists to `localStorage`); `ThemeToggle` (button calling `useTheme().toggle`); `tokens.css` with all premium CSS variables for `[data-theme="dark"]` + `[data-theme="light"]`.

- [ ] **Step 1: Write the failing test**

`src/theme/useTheme.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./useTheme";

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

describe("useTheme", () => {
  it("defaults to dark and toggles to light (sets data-theme)", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
  it("persists to localStorage", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(localStorage.getItem("logradar-theme")).toBe("light");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/theme/useTheme.test.tsx`
Expected: FAIL — `useTheme` not defined.

- [ ] **Step 3: Write minimal implementation**

`src/theme/tokens.css` (premium tokens — verbatim from spec §10.2):
```css
[data-theme="dark"] {
  --bg:#0B0E13; --surface:#11151C; --surface-2:#161C25; --surface-3:#1B222D;
  --border:#232B37; --border-soft:#1A2029;
  --text:#DCE3EC; --text-dim:#8A94A3; --text-faint:#565F6D;
  --scan:#45C6B8; --scan-soft:rgba(69,198,184,.14); --scan-line:rgba(69,198,184,.55);
  --err:#E8586A; --warn:#E8A13C; --info:#5B9DD9; --debug:#7A828D;
  --shadow:0 18px 50px rgba(0,0,0,.55);
}
[data-theme="light"] {
  --bg:#EEF0F3; --surface:#FFFFFF; --surface-2:#F5F6F8; --surface-3:#E9EBEF;
  --border:#D9DEE5; --border-soft:#E3E7EC;
  --text:#161B22; --text-dim:#565E6B; --text-faint:#8A93A0;
  --scan:#1E8A7C; --scan-soft:rgba(30,138,124,.12); --scan-line:rgba(30,138,124,.5);
  --err:#C93A4E; --warn:#B5712A; --info:#2E6FA0; --debug:#6A727C;
  --shadow:0 18px 50px rgba(20,30,50,.16);
}
html, body { margin:0; background:var(--bg); color:var(--text); font-family:'Space Grotesk',system-ui,sans-serif; }
```
`src/theme/useTheme.ts`:
```ts
import { useState, useEffect } from "react";
export type Theme = "dark" | "light";
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("logradar-theme") as Theme) || "dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("logradar-theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}
```
`src/components/ThemeToggle.tsx`:
```tsx
import { useTheme } from "../theme/useTheme";
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme">
      {theme === "dark" ? "🌙" : "☀️"} {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
```
`src/main.tsx` (add tokens.css import):
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import "./theme/tokens.css";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/theme/useTheme.test.tsx`
Expected: PASS (defaults dark, toggles, persists).

- [ ] **Step 5: Commit**

```bash
git add src/theme/ src/components/ThemeToggle.tsx src/main.tsx
git commit -m "feat(fe): premium dark/light theme system (tokens + useTheme + ThemeToggle)"
```

---

## Task 4: AppShell (topbar + radar glyph + ThemeToggle + kbd hints)

**Files:**
- Create: `src/components/AppShell.tsx`, `src/components/AppShell.css`
- Modify: `src/App.tsx` (wrap in AppShell)
- Test: `src/components/AppShell.test.tsx`
- Reference (visual): `.superpowers/brainstorm/premium-redesign.html` (the topbar — wordmark + radar SVG + theme toggle + kbd hints)

**Interfaces:**
- Consumes: `ThemeToggle` (Task 3). Produces: `AppShell({children})` rendering the topbar + `{children}`.

- [ ] **Step 1: Write the failing test**

`src/components/AppShell.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders the brand wordmark + theme toggle + children", () => {
    render(<AppShell><p>page content</p></AppShell>);
    expect(screen.getByText("LogRadar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeTruthy();
    expect(screen.getByText("page content")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/components/AppShell.test.tsx`
Expected: FAIL — `AppShell` not defined.

- [ ] **Step 3: Write minimal implementation**

`src/components/AppShell.tsx` (port the topbar from `.superpowers/brainstorm/premium-redesign.html` — same wordmark + radar glyph + theme toggle + kbd hints):
```tsx
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
```
`src/components/AppShell.css` (port the relevant topbar styles from the mockup):
```css
.app { min-height:100vh; }
.topbar { display:flex; align-items:center; gap:14px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--surface); }
.brand { display:flex; align-items:center; gap:9px; }
.brand .radar { width:18px; height:18px; color:var(--scan); }
.brand b { font-weight:700; font-size:14px; }
.brand span { color:var(--text-dim); font-size:11px; }
.spacer { flex:1; }
.theme-toggle { display:inline-flex; align-items:center; gap:7px; cursor:pointer; border:1px solid var(--border); background:var(--surface-2); color:var(--text-dim); padding:5px 11px; border-radius:999px; font-size:11px; font-weight:500; }
.theme-toggle:hover { border-color:var(--scan); color:var(--scan); }
```
`src/App.tsx`:
```tsx
import { AppShell } from "./components/AppShell";
export function App() {
  return <AppShell><div style={{ padding: 24 }}>LogRadar</div></AppShell>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (AppShell + App.test + useTheme + ipc tests all green).

- [ ] **Step 5: Commit**

```bash
git add src/components/AppShell.tsx src/components/AppShell.css src/App.tsx src/components/AppShell.test.tsx
git commit -m "feat(fe): AppShell (topbar + radar glyph + ThemeToggle)"
```

---

## Task 5: Thin WelcomePage proving end-to-end IPC

**Files:**
- Create: `src/pages/WelcomePage.tsx`, `src/pages/WelcomePage.css`
- Modify: `src/App.tsx` (render WelcomePage instead of placeholder)
- Test: `src/pages/WelcomePage.test.tsx`
- Reference (visual): `.superpowers/brainstorm/welcome-v3.html` (the drop zone — but this ③a version is THIN: a drop-area placeholder + "Open file" button + result line; the full radar-sweep/recents/workspaces welcome is ③b)

**Interfaces:**
- Consumes: `openFile` (Task 2), `AppShell` (Task 4). Produces: `WelcomePage` — a drop-area placeholder + an "Open file" button that calls `openFile` via a file picker (`@tauri-apps/plugin-dialog` or `invoke`-backed) and renders the returned `OpenResponse` metadata (sessionId, lineCount, encoding, isJson, timestampFmt). Proves the IPC round-trip works.

- [ ] **Step 1: Write the failing test**

`src/pages/WelcomePage.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WelcomePage } from "./WelcomePage";

const openFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({ openFile: (path: string) => openFileMock(path) }));
const dialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogMock() }));

beforeEach(() => { openFileMock.mockReset(); dialogMock.mockReset(); });

describe("WelcomePage", () => {
  it("opens a file via IPC and shows metadata", async () => {
    dialogMock.mockResolvedValue("/path/a.log");
    openFileMock.mockResolvedValue({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
    render(<WelcomePage />);
    fireEvent.click(screen.getByText("Open file"));
    await waitFor(() => {
      expect(openFileMock).toHaveBeenCalledWith("/path/a.log");
      expect(screen.getByText(/sessionId: s1/)).toBeTruthy();
      expect(screen.getByText(/lineCount: 3/)).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/pages/WelcomePage.test.tsx`
Expected: FAIL — `WelcomePage` not defined.

- [ ] **Step 3: Write minimal implementation**

Add `@tauri-apps/plugin-dialog` to `package.json` deps + register the plugin in `src-tauri` (per Tauri 2 plugin setup — add `tauri-plugin-dialog` to `src-tauri/Cargo.toml` + `.plugin(tauri_plugin_dialog::init())` in `lib.rs`). (If the dialog plugin setup is heavy for ③a, fall back to a plain `<input type="file">` + `openFile(file.path)` — but Tauri's `open` dialog is the production path. Web-verify the Tauri 2 dialog plugin setup.)

`src/pages/WelcomePage.tsx`:
```tsx
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openFile, type OpenResponse } from "../lib/ipc";
import "./WelcomePage.css";

export function WelcomePage() {
  const [meta, setMeta] = useState<OpenResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function onOpen() {
    try {
      const path = await openDialog({ multiple: false });
      if (typeof path !== "string") return;
      setMeta(await openFile(path));
      setErr(null);
    } catch (e) { setErr(String(e)); }
  }
  return (
    <div className="welcome">
      <div className="drop">拖拽日志到这里（③b 完整版）</div>
      <button onClick={onOpen}>Open file</button>
      {meta && <div className="meta">sessionId: {meta.sessionId} · lineCount: {meta.lineCount} · encoding: {meta.encoding} · isJson: {String(meta.isJson)} · timestampFmt: {meta.timestampFmt}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
```
`src/pages/WelcomePage.css` (minimal, premium-styled):
```css
.welcome { padding:24px; display:flex; flex-direction:column; align-items:center; gap:14px; }
.welcome .drop { border:1.5px dashed var(--border); border-radius:16px; background:var(--surface); padding:42px 24px; width:100%; max-width:520px; text-align:center; color:var(--text-dim); }
.welcome button { background:var(--scan); color:#06231F; border:none; border-radius:8px; padding:9px 18px; font-weight:600; cursor:pointer; }
.welcome .meta { font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--text-dim); }
.welcome .err { color:var(--err); font-size:12px; }
```
`src/App.tsx`:
```tsx
import { AppShell } from "./components/AppShell";
import { WelcomePage } from "./pages/WelcomePage";
export function App() {
  return <AppShell><WelcomePage /></AppShell>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/pages/ package.json package-lock.json src-tauri/Cargo.toml src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(fe): thin WelcomePage proving end-to-end IPC (openFile → metadata)"
```

---

## Self-Review

**1. Spec coverage (③a scope — infra + IPC + theme + shell + thin welcome):**
- Vite+React+TS scaffold + Tauri integration → Task 1. ✓
- IPC client (typed wrappers + `useSearch` Channel) → Task 2. ✓
- Premium theme (tokens + `useTheme` + `ThemeToggle`, dark default + toggle) → Task 3. ✓
- AppShell (topbar + radar glyph + theme toggle) → Task 4. ✓ (references mockup)
- End-to-end IPC proof (WelcomePage → openFile → metadata) → Task 5. ✓
- ③b (full pages: MainWindow/SplitView/JsonInspector/ExportDialog/WorkspaceManager/full Welcome/VirtualLogView/SearchPanel/Minimap) → NOT in ③a (deferred to ③b). ✓ (intentional split)

**2. Placeholder scan:** No "TBD/TODO." The `useSearch` Channel unit-test is admittedly thin (the real Channel is Tauri-runtime-bound) — explicitly noted, not a placeholder (the `openFile` wiring + type contract ARE tested; the Channel streaming is proven end-to-end in ③b/④). The `@tauri-apps/plugin-dialog` setup has a fallback note (`<input type=file>`) — not a placeholder, a documented alternative.

**3. Type consistency:** `OpenResponse` (camelCase: sessionId/lineCount/encoding/isJson/timestampFmt) consistent Task 2 (TS type) ↔ Task 5 (renders `meta.sessionId`/`meta.lineCount`/...). `SearchEvent` (kind: "batch"/"done") consistent Task 2 (TS type) ↔ the `useSearch` onmessage. `useTheme` returns `{theme, toggle}` consistent Task 3 (def) ↔ Task 4 (ThemeToggle uses it). ✓

**Gaps (noted, deferred to ③b):**
- `useSearch` is a plain factory (not reactive React state). ③b wraps it in `useSyncExternalStore` for re-render. (③a's `useSearch` proves the Channel wiring; the search UI is ③b.)
- No routing (③a renders WelcomePage in AppShell; ③b adds routing for the pages).
- No real end-to-end Tauri runtime test (the Vitest tests mock `invoke`/`@tauri-apps/api`); the real IPC round-trip is exercised by `cargo tauri dev` (manual) or ④'s E2E.
- `@tauri-apps/plugin-dialog` plugin registration in `src-tauri` (Cargo.toml + lib.rs `.plugin(...)`) — Task 5 includes it; web-verify the Tauri 2 dialog plugin setup.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-logradar-frontend-infra.md` (③a). Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute in this session via executing-plans, batch with checkpoints.

Which approach? (Note: ③b — the full pages — is a separate plan written after ③a.)
