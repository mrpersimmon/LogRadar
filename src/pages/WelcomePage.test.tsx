// WelcomePage (Task 10 ③b, FULL rewrite) — CRITICAL behavior under test: the
// page shows a drop zone (with the radar-sweep animation element), format
// badges, a recents list (each recent shows its path + a last-query chip), and
// workspace cards. Opening a file wires through the full chain:
// openDialog → sessions.open (→ openFile) → setView("main") — closing the gap
// noted in T7 (the router flips to MainWindow on open). Visual structure ported
// from `.superpowers/brainstorm/28981-1783785226/content/welcome-v3.html`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WelcomePage } from "./WelcomePage";
import { useSessions } from "../hooks/useSessions";
import type { View } from "../router";

const openFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  openFile: (path: string) => openFileMock(path),
}));
const dialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogMock() }));

beforeEach(() => {
  openFileMock.mockReset();
  dialogMock.mockReset();
});

/** Harness so the test can hand a REAL `useSessions()` instance (whose `open`
 *  calls the mocked `openFile`) into WelcomePage — proving the open→main chain
 *  end-to-end through the real sessions registry. */
function Harness({
  setView,
  recents,
  workspaces,
}: {
  setView: (v: View) => void;
  recents?: React.ComponentProps<typeof WelcomePage>["recents"];
  workspaces?: React.ComponentProps<typeof WelcomePage>["workspaces"];
}) {
  const sessions = useSessions();
  return (
    <WelcomePage
      sessions={sessions}
      setView={setView}
      recents={recents}
      workspaces={workspaces}
    />
  );
}

describe("WelcomePage", () => {
  it("shows the drop zone, radar-sweep element, format badges, recents + workspace cards", () => {
    render(
      <WelcomePage
        sessions={
          {
            sessions: new Map(),
            activeId: null,
            open: vi.fn(),
            close: vi.fn(),
            setActive: vi.fn(),
          } as never
        }
        setView={vi.fn()}
        recents={[
          {
            path: "logs/auth/a.log",
            size: "32 MB",
            openedLabel: "just now",
            lastQuery: "refused AND timeout",
          },
        ]}
        workspaces={[
          { name: "7/11 DB incident", fileCount: 3, queryCount: 4, lastOpened: "7/11" },
        ]}
      />,
    );

    // drop zone + heading
    expect(screen.getByRole("region", { name: /drop zone/i })).toBeTruthy();
    expect(screen.getByText(/drag.*log/i)).toBeTruthy();
    // radar-sweep animation element (reduced-motion respected in CSS, not here)
    expect(screen.getByTestId("radar-sweep")).toBeTruthy();
    // format badges
    expect(screen.getByText(".log")).toBeTruthy();
    expect(screen.getByText(".gz")).toBeTruthy();
    // recents: path + last-query chip render
    expect(screen.getByText("logs/auth/a.log")).toBeTruthy();
    expect(screen.getByText(/refused AND timeout/)).toBeTruthy();
    // workspace card
    expect(screen.getByText("7/11 DB incident")).toBeTruthy();
  });

  it("calls setView('main') after opening a file via openFile", async () => {
    dialogMock.mockResolvedValue("/path/a.log");
    openFileMock.mockResolvedValue({
      sessionId: "s1",
      lineCount: 3,
      encoding: "Utf8",
      isJson: false,
      timestampFmt: "iso",
    });
    const setView = vi.fn();
    render(<Harness setView={setView} />);

    fireEvent.click(screen.getByRole("button", { name: /open file/i }));

    await waitFor(() => {
      expect(openFileMock).toHaveBeenCalledWith("/path/a.log");
      expect(setView).toHaveBeenCalledWith("main");
    });
  });

  it("does not navigate when the open dialog is cancelled", async () => {
    // dialog returns null (user cancelled) → no open, no setView
    dialogMock.mockResolvedValue(null);
    const setView = vi.fn();
    render(<Harness setView={setView} />);

    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    // give the microtask a tick to settle
    await waitFor(() => expect(openFileMock).not.toHaveBeenCalled());
    expect(setView).not.toHaveBeenCalled();
  });
});
