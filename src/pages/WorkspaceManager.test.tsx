// WorkspaceManager (Task 10 ③b) — CRITICAL behavior under test: on mount it
// lists saved workspaces (workspaceList → names, then workspaceLoad per name →
// full Workspace with files + queries) and renders a card per workspace
// (name / file paths / full-query chips preview); the Open button reloads that
// workspace via workspaceLoad + fires onOpenWorkspace; and Save Current builds
// a Workspace from the open sessions' file paths + a name and calls
// workspaceSave. Visual structure ported from
// `.superpowers/brainstorm/28981-1783828764/content/workspace.html`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WorkspaceManager } from "./WorkspaceManager";
import type { SessionsApi } from "../hooks/useSessions";

const workspaceListMock = vi.fn();
const workspaceLoadMock = vi.fn();
const workspaceSaveMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  workspaceList: () => workspaceListMock(),
  workspaceLoad: (name: string) => workspaceLoadMock(name),
  workspaceSave: (ws: unknown) => workspaceSaveMock(ws),
}));

beforeEach(() => {
  workspaceListMock.mockReset();
  workspaceLoadMock.mockReset();
  workspaceSaveMock.mockReset();
});

function stubSessions(paths: string[]): SessionsApi {
  const sessions = new Map(
    paths.map((p, i) => [
      `s${i + 1}`,
      {
        sessionId: `s${i + 1}`,
        path: p,
        lineCount: 3,
        encoding: "Utf8",
        isJson: false,
        timestampFmt: "iso",
      },
    ]),
  );
  return {
    sessions,
    activeId: paths.length ? "s1" : null,
    open: vi.fn(),
    close: vi.fn(),
    setActive: vi.fn(),
  } as unknown as SessionsApi;
}

describe("WorkspaceManager", () => {
  it("lists saved workspaces (files + query chips) and opens one on click", async () => {
    workspaceListMock.mockResolvedValue(["7/11 DB incident", "API slow queries"]);
    workspaceLoadMock.mockImplementation((name: string) =>
      Promise.resolve(
        name === "7/11 DB incident"
          ? {
              name,
              files: ["logs/auth/a.log", "logs/auth/b.log"],
              queries: [
                { keywords: ["refused", "timeout"], levels: ["ERROR", "WARN"] },
                { keywords: ["ECONNREFUSED"], levels: ["ERROR"] },
              ],
            }
          : {
              name,
              files: ["logs/api/c.log"],
              queries: [{ keywords: ["duration>500"], levels: ["WARN"] }],
            },
      ),
    );
    const onOpenWorkspace = vi.fn();
    render(<WorkspaceManager onOpenWorkspace={onOpenWorkspace} />);

    // both workspaces load + render their names + file paths
    await waitFor(() =>
      expect(workspaceLoadMock).toHaveBeenCalledWith("7/11 DB incident"),
    );
    expect(screen.getByText("7/11 DB incident")).toBeTruthy();
    expect(screen.getByText("logs/auth/a.log")).toBeTruthy();
    // query chip text from the first query renders
    expect(screen.getByText(/refused AND timeout/)).toBeTruthy();

    // click the Open button scoped to the first card
    const card = screen
      .getByText("7/11 DB incident")
      .closest(".wm-card") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /open/i }));

    await waitFor(() => {
      expect(workspaceLoadMock).toHaveBeenLastCalledWith("7/11 DB incident");
      expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
      const ws = onOpenWorkspace.mock.calls[0][0];
      expect(ws.name).toBe("7/11 DB incident");
    });
  });

  it("save current builds a Workspace (name + open file paths) and calls workspaceSave", async () => {
    workspaceListMock.mockResolvedValue([]);
    const sessions = stubSessions(["logs/auth/a.log", "logs/api/c.log"]);
    render(<WorkspaceManager sessions={sessions} />);

    fireEvent.change(screen.getByRole("textbox", { name: /workspace name/i }), {
      target: { value: "My WS" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save current/i }));

    await waitFor(() => {
      expect(workspaceSaveMock).toHaveBeenCalledTimes(1);
      const ws = workspaceSaveMock.mock.calls[0][0] as {
        name: string;
        files: string[];
        queries: unknown[];
      };
      expect(ws.name).toBe("My WS");
      expect(ws.files).toEqual(["logs/auth/a.log", "logs/api/c.log"]);
      expect(ws.queries).toEqual([]);
    });
  });

  it("renders empty-state hint when no saved workspaces exist", async () => {
    workspaceListMock.mockResolvedValue([]);
    render(<WorkspaceManager />);
    await waitFor(() => expect(workspaceListMock).toHaveBeenCalled());
    expect(screen.getByTestId("wm-empty")).toBeTruthy();
  });
});
