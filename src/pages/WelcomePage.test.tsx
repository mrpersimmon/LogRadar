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
import type { SessionsApi, SessionMeta } from "../hooks/useSessions";
import type { View } from "../router";

const openFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  openFile: (path: string) => openFileMock(path),
}));
const dialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogMock() }));

// Task 3: recents store is mocked so WelcomePage's mount-load + re-open flow can
// be driven without touching real localStorage. Defaults to [] (no recents).
const { getRecentsMock, addRecentMock } = vi.hoisted(() => ({
  getRecentsMock: vi.fn(),
  addRecentMock: vi.fn(),
}));
vi.mock("../lib/recents", () => ({
  getRecents: () => getRecentsMock(),
  addRecent: (path: string) => addRecentMock(path),
}));

beforeEach(() => {
  openFileMock.mockReset();
  dialogMock.mockReset();
  getRecentsMock.mockReset();
  addRecentMock.mockReset();
  getRecentsMock.mockReturnValue([]); // default: no recents on mount
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

/** Build a complete `SessionsApi` stub with every member (incl. `openArchive` /
 *  `openFolder`) backed by `vi.fn()`, mirroring the helper used in
 *  MainWindow/SplitView tests. Replaces the prior `as never` cast that omitted
 *  `openArchive`/`openFolder` — a stubbed-but-complete mock keeps the type
 *  honest and won't crash if a future test triggers those paths. */
function api(
  sessions: Map<string, SessionMeta>,
  activeId: string | null,
): SessionsApi {
  return {
    sessions,
    activeId,
    open: vi.fn(),
    close: vi.fn(),
    setActive: vi.fn(),
    openArchive: vi.fn(),
    openFolder: vi.fn(),
  };
}

describe("WelcomePage", () => {
  it("shows the drop zone, radar-sweep element, format badges, recents + workspace cards", () => {
    render(
      <WelcomePage
        sessions={api(new Map(), null)}
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

  // Task 3: WelcomePage loads recents from localStorage (getRecents) on mount
  // and renders them as clickable rows. Each row shows the path + an "open"
  // affordance; clicking a recent re-opens it through the full chain:
  // openFile (via sessions.open) → addRecent (bump to most-recent-first) →
  // setView("main").
  it("loads and renders recents on mount (localStorage via getRecents)", async () => {
    getRecentsMock.mockReturnValue(["logs/x.log", "logs/y.log"]);
    render(<Harness setView={vi.fn()} />);

    // recents load in a useEffect (after first paint) → wait for them
    await waitFor(() => {
      expect(screen.getByText("logs/x.log")).toBeTruthy();
      expect(screen.getByText("logs/y.log")).toBeTruthy();
    });
    expect(getRecentsMock).toHaveBeenCalled();
  });

  it("re-opens a recent on click: openFile → addRecent → setView('main')", async () => {
    getRecentsMock.mockReturnValue(["/rec/a.log"]);
    openFileMock.mockResolvedValue({
      sessionId: "s1",
      lineCount: 3,
      encoding: "Utf8",
      isJson: false,
      timestampFmt: "iso",
    });
    const setView = vi.fn();
    render(<Harness setView={setView} />);

    // The recent row is a role=button with aria-label "open <path>"
    const row = await screen.findByRole("button", { name: /open \/rec\/a\.log/i });
    fireEvent.click(row);

    await waitFor(() => {
      expect(openFileMock).toHaveBeenCalledWith("/rec/a.log");
      expect(addRecentMock).toHaveBeenCalledWith("/rec/a.log");
      expect(setView).toHaveBeenCalledWith("main");
    });
  });

  it("records a newly dialog-opened file into recents (addRecent on open)", async () => {
    dialogMock.mockResolvedValue("/dialog/picked.log");
    openFileMock.mockResolvedValue({
      sessionId: "s2",
      lineCount: 1,
      encoding: "Utf8",
      isJson: false,
      timestampFmt: "iso",
    });
    const setView = vi.fn();
    render(<Harness setView={setView} />);

    fireEvent.click(screen.getByRole("button", { name: /open file/i }));

    await waitFor(() => {
      expect(openFileMock).toHaveBeenCalledWith("/dialog/picked.log");
      expect(addRecentMock).toHaveBeenCalledWith("/dialog/picked.log");
      expect(setView).toHaveBeenCalledWith("main");
    });
  });

  // Task 9: WelcomePage exposes three entry points — Open file (filtered to
  // .log/.txt), Open archive (.zip/.gz, streaming progress via ExtractProgress),
  // and Open folder (directory scan; shows an archive-hint notice if archives
  // were found inside). This test pins the three affordances' presence so a
  // future refactor can't silently drop one (Open folder was removed in 995fdbc
  // and is now restored).
  it("shows Open archive and Open folder buttons", () => {
    render(
      <WelcomePage
        sessions={api(new Map(), null)}
        setView={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /open archive/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open file/i })).toBeTruthy();
  });
});
