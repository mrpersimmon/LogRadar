import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SessionMeta } from "./hooks/useSessions";

// --- Mock `useSessions` (controlled, plain object) so App's open-files registry
// is deterministic per test. App calls `useSessions()` once and reads
// `.activeId` / `.open` off it; returning a fixed object lets each test seed
// the registry (split route) or assert `open` calls (workspace-open flow)
// without spinning up the real hook's openFile chain (covered by useSessions'
// own tests + WelcomePage's integration test).
const { sessionsMock, routerMock } = vi.hoisted(() => {
  const sessionsMock = {
    sessions: new Map<string, SessionMeta>(),
    activeId: null as string | null,
    open: vi.fn(),
    close: vi.fn(),
    setActive: vi.fn(),
  };
  const routerMock = {
    view: "welcome" as string,
    split: null as { left: string; right: string } | null,
    setView: vi.fn(),
  };
  return { sessionsMock, routerMock };
});

vi.mock("./hooks/useSessions", () => ({ useSessions: () => sessionsMock }));
// Mock the router so App renders the page we want to test (default "welcome"
// keeps the existing wordmark / lifted-useSearch tests green) + a `setView`
// spy we can assert on for the workspace-open → "main" transition.
vi.mock("./router", () => ({ useView: () => routerMock }));

// Mock `./lib/ipc` so App's lifted `useSearch` is a spy (proving App owns it)
// and no Tauri invoke runs in jsdom. `vi.hoisted` makes the spy available to
// the factory (which runs during import resolution, before the module body).
const { useSearchMock } = vi.hoisted(() => ({
  useSearchMock: vi.fn(),
}));
vi.mock("./lib/ipc", () => ({
  openFile: vi.fn(),
  getLines: vi.fn(),
  cancelSearch: vi.fn(),
  closeSession: vi.fn(),
  exportFile: vi.fn(),
  workspaceSave: vi.fn(),
  workspaceLoad: vi.fn(),
  workspaceList: vi.fn(),
  useSearch: useSearchMock,
  useCrossFileSearch: vi.fn(() => ({ results: [], run: vi.fn(), cancel: vi.fn() })),
  getSearchController: vi.fn(),
  __resetSearchControllers: vi.fn(),
}));

import { App } from "./App";
import { openFile, getLines, workspaceLoad, workspaceList } from "./lib/ipc";
import type { Workspace } from "./lib/ipc";

const openFileMock = vi.mocked(openFile);
const getLinesMock = vi.mocked(getLines);
const workspaceLoadMock = vi.mocked(workspaceLoad);
const workspaceListMock = vi.mocked(workspaceList);

function meta(id: string, path: string, lineCount = 100): SessionMeta {
  return {
    sessionId: id,
    path,
    lineCount,
    encoding: "Utf8",
    isJson: false,
    timestampFmt: "iso",
  };
}

describe("App", () => {
  beforeEach(() => {
    sessionsMock.sessions = new Map();
    sessionsMock.activeId = null;
    sessionsMock.open = vi.fn();
    sessionsMock.close = vi.fn();
    sessionsMock.setActive = vi.fn();
    routerMock.view = "welcome";
    routerMock.split = null;
    routerMock.setView = vi.fn();
    useSearchMock.mockReset();
    useSearchMock.mockReturnValue({
      matches: [],
      status: "idle",
      run: vi.fn(),
      cancel: vi.fn(),
    });
    openFileMock.mockReset();
    getLinesMock.mockReset();
    workspaceLoadMock.mockReset();
    workspaceListMock.mockReset();
  });

  it("renders the LogRadar wordmark", () => {
    render(<App />);
    expect(screen.getByText("LogRadar")).toBeTruthy();
  });

  // Task 1 (④a): App owns the lifted `useSearch` (active query + matches), so
  // the SAME controller's matches can flow to SearchPanel (results) AND
  // VirtualLogView (hit highlight). Asserting App calls useSearch on mount
  // proves the lift — the call site moved here from SearchPanel.
  it("owns the lifted useSearch (calls it on mount with the active session + cap)", () => {
    render(<App />);
    expect(useSearchMock).toHaveBeenCalled();
    const first = useSearchMock.mock.calls[0];
    // No session open yet → App still calls useSearch unconditionally (hooks
    // rule) with an empty id + a stable sentinel query + the search cap.
    expect(first[0]).toBe(""); // sessionId (no session open)
    expect(first[2]).toBe(1000); // SEARCH_CAP
  });

  // Task 6 (④a): App supplies `onOpenWorkspace` to WorkspaceManager. Opening a
  // saved workspace loads each of its files into the open-files registry
  // (useSessions.open per file) + bumps recents, restores the workspace's
  // first saved query as the active query (so the lifted useSearch re-keys
  // onto it), then flips the view to "main" — landing the user on MainWindow
  // with the loaded files + query armed.
  it("onOpenWorkspace: opens each file via sessions.open + restores the first query + setView('main')", async () => {
    routerMock.view = "workspace";
    const pathA = "logs/auth/a.log";
    const pathB = "logs/api/c.log";
    const restoredQuery = {
      root: { kind: "leaf", predicate: { kind: "text", text: "refused" } },
    };
    const ws: Workspace = {
      name: "7/11 incident",
      files: [pathA, pathB],
      queries: [restoredQuery],
    };
    workspaceListMock.mockResolvedValue(["7/11 incident"]);
    workspaceLoadMock.mockResolvedValue(ws);

    render(<App />);

    // wait for the workspace card to render (mount: workspaceList → load)
    await waitFor(() =>
      expect(screen.getByText("7/11 incident")).toBeTruthy(),
    );

    // click the card's Open button → WorkspaceManager reloads the workspace
    // (workspaceLoad) then fires App's onOpenWorkspace with the loaded ws.
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    await waitFor(() => {
      // App opened each file into useSessions (one open call per ws.files entry)
      expect(sessionsMock.open).toHaveBeenCalledTimes(2);
      // App flipped the router to "main"
      expect(routerMock.setView).toHaveBeenCalledWith("main");
    });
    expect(sessionsMock.open).toHaveBeenCalledWith(pathA);
    expect(sessionsMock.open).toHaveBeenCalledWith(pathB);
    // App restored the workspace's first saved query as the active query →
    // the lifted useSearch is re-keyed onto it (its 2nd arg is the query).
    expect(
      useSearchMock.mock.calls.some((c) => c[1] === restoredQuery),
    ).toBe(true);
  });

  // I2: onOpenWorkspace restored an inert query. setActiveQuery(firstQuery)
  // re-keyed App's lifted useSearch, but (a) SearchPanel's QueryForm is private
  // state — NOT synced to the restored activeQuery (form stays empty, Search
  // button disabled) — and (b) no search.run() followed (the run trigger lived
  // in SearchPanel). The restored query was armed but could never produce
  // matches → the user landed on MainWindow with an invisible inert query.
  // Assert: the restore path fires search.run() (the restored query actually
  // scans + produces matches), NOT just keying useSearch.
  it("onOpenWorkspace: the restored query actually runs (search.run fired), not just keying", async () => {
    routerMock.view = "workspace";
    const runSpy = vi.fn();
    useSearchMock.mockReturnValue({
      matches: [],
      status: "idle",
      run: runSpy,
      cancel: vi.fn(),
    });
    const restoredQuery = {
      root: { kind: "leaf", predicate: { kind: "text", text: "refused" } },
    };
    const ws: Workspace = {
      name: "7/11 incident",
      files: ["logs/auth/a.log"],
      queries: [restoredQuery],
    };
    workspaceListMock.mockResolvedValue(["7/11 incident"]);
    workspaceLoadMock.mockResolvedValue(ws);

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("7/11 incident")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    // The restored query must produce matches — i.e. search.run() fires on
    // the restore path (after the re-key render commits). Pre-fix: only
    // keying happened (useSearch called with restoredQuery); run never fired.
    await waitFor(() => expect(runSpy).toHaveBeenCalled());
    // Keying happened too — the controller re-keyed onto restoredQuery.
    expect(
      useSearchMock.mock.calls.some((c) => c[1] === restoredQuery),
    ).toBe(true);
  });

  // Task 6 (④a): the split route. When the router's view is "split" with a
  // {left, right} selection (set by MainWindow's Compare picker), App renders
  // SplitView wired to BOTH session ids — getLines is called for each, proving
  // App passed split.left / split.right through (not just one pane).
  it("view 'split' + split selection renders SplitView wired to both session ids", async () => {
    sessionsMock.sessions = new Map([
      ["s1", meta("s1", "/logs/a.log", 100)],
      ["s2", meta("s2", "/logs/b.log", 80)],
    ]);
    sessionsMock.activeId = "s1";
    routerMock.view = "split";
    routerMock.split = { left: "s1", right: "s2" };
    getLinesMock.mockResolvedValue(["14:22:01.003 ERROR compare line"]);

    const { container } = render(<App />);

    await waitFor(() => expect(getLinesMock).toHaveBeenCalled());

    // SplitView root rendered (.sv)
    expect(container.querySelector(".sv")).not.toBeNull();
    // both panes wired: getLines called for BOTH the left and right session ids
    const calledIds = new Set(
      getLinesMock.mock.calls.map((c) => c[0] as string),
    );
    expect(calledIds.has("s1")).toBe(true);
    expect(calledIds.has("s2")).toBe(true);
  });
});
