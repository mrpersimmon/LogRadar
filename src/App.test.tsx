import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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
  getSearchController: vi.fn(),
  __resetSearchControllers: vi.fn(),
}));

import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    useSearchMock.mockReset();
    useSearchMock.mockReturnValue({
      matches: [],
      status: "idle",
      run: vi.fn(),
      cancel: vi.fn(),
    });
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
});
