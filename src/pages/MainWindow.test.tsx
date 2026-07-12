// MainWindow (Task 7) — the integration page. It assembles TabStrip (T3) +
// FileTree (T3) + VirtualLogView (T4) + Minimap (T6) + SearchPanel (T5) in the
// main-window-v7 layout (top tabs / left sidebar / center log-view + right
// minimap / bottom search panel) and wires the active session (from
// `useSessions`, owned by App and passed in as `sessions`) into VirtualLogView
// and SearchPanel. The CRITICAL behaviors under test:
//   (1) ALL five sub-components are present for an active session;
//   (2) the ACTIVE session's id is what VirtualLogView requests lines for —
//       `getLines` is called with the active session's id, never a sibling's;
//   (3) no active session → a stable empty placeholder (no crash, no getLines);
//   (4) scrolling the log view drives the Minimap's viewport marker (the sweep)
//       to the matching relative position — the signature log-view↔minimap link.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { SessionsApi, SessionMeta } from "../hooks/useSessions";

// Mock the IPC module so VirtualLogView's `getLines` and SearchPanel's
// `useSearch` never touch Tauri in jsdom. `vi.hoisted` makes the spies available
// to the factory (which runs during import resolution, before the module body).
const { getLinesMock, useSearchMock } = vi.hoisted(() => ({
  getLinesMock: vi.fn(),
  useSearchMock: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  getLines: getLinesMock,
  useSearch: useSearchMock,
}));

import { MainWindow } from "./MainWindow";

function meta(id: string, path: string, lineCount = 1000): SessionMeta {
  return {
    sessionId: id,
    path,
    lineCount,
    encoding: "Utf8",
    isJson: false,
    timestampFmt: "iso",
  };
}

/** Build a SessionsApi with the given sessions + activeId. The mutators are
 *  vi.fn()s so a test can assert routing without caring about IPC. */
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
  };
}

/** A stable idle controller for the mocked `useSearch`. */
function fakeCtrl() {
  return {
    matches: [],
    status: "idle" as const,
    run: vi.fn(),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  getLinesMock.mockReset();
  useSearchMock.mockReset();
  getLinesMock.mockImplementation(
    (_sid: string, _start: number, count: number) =>
      Promise.resolve(
        Array.from({ length: count }, (_, i) => `14:22:01.003 ERROR line ${i}`),
      ),
  );
  useSearchMock.mockReturnValue(fakeCtrl());
});

/** jsdom reports 0 for all layout metrics (no layout engine). Force
 *  `clientHeight` / `scrollTop` on the log viewport so the visible-window math
 *  is deterministic — same trick VirtualLogView's own test uses. */
function forceMetrics(el: HTMLElement, scrollTop: number, vh = 400) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: vh });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop });
}

describe("MainWindow", () => {
  it("renders all sub-components (TabStrip, FileTree, VirtualLogView, SearchPanel, Minimap)", async () => {
    const sessions = new Map([["s1", meta("s1", "/logs/auth/a.log", 1000)]]);
    const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);

    // Flush the async chunk-load (VirtualLogView's getLines().then) inside act
    // so its setState doesn't leak past the test boundary.
    await waitFor(() => expect(getLinesMock).toHaveBeenCalled());

    expect(container.querySelector(".tab-strip")).not.toBeNull(); // TabStrip (T3)
    expect(container.querySelector(".file-tree")).not.toBeNull(); // FileTree (T3)
    expect(container.querySelector(".log-view")).not.toBeNull(); // VirtualLogView (T4)
    expect(container.querySelector(".sp")).not.toBeNull(); // SearchPanel (T5)
    expect(container.querySelector(".trace")).not.toBeNull(); // Minimap (T6)
  });

  it("flows the ACTIVE session's lines to VirtualLogView (getLines called with the active id, never a sibling's)", async () => {
    const sessions = new Map([
      ["s1", meta("s1", "/logs/auth/a.log", 1000)],
      ["s2", meta("s2", "/logs/api/c.log", 500)],
    ]);
    render(<MainWindow sessions={api(sessions, "s2")} />);

    await waitFor(() => expect(getLinesMock).toHaveBeenCalled());

    // Every getLines call is for the ACTIVE session s2 — never s1.
    expect(getLinesMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of getLinesMock.mock.calls) {
      expect(call[0]).toBe("s2");
    }
    // The active session's lineCount (500) reached VirtualLogView as totalLines
    // (spacer height = totalLines * rowHeight; rowHeight default = 20).
    const spacer = document.querySelector('[data-testid="log-spacer"]') as HTMLElement;
    expect(spacer).not.toBeNull();
    expect(spacer.style.height).toBe(`${500 * 20}px`);
  });

  it("renders an empty placeholder (no VirtualLogView) when no session is active", () => {
    const sessions = new Map([["s1", meta("s1", "/logs/auth/a.log", 1000)]]);
    const { container } = render(<MainWindow sessions={api(sessions, null)} />);

    // No log view / minimap when there's nothing to show.
    expect(container.querySelector(".log-view")).toBeNull();
    expect(container.querySelector(".trace")).toBeNull();
    // Stable empty-state node so the user sees the chrome is alive.
    expect(container.querySelector('[data-testid="mw-empty"]')).not.toBeNull();
  });

  it("drives the Minimap sweep to the scrolled viewport position (log-view↔minimap link)", async () => {
    const sessions = new Map([["s1", meta("s1", "/logs/auth/a.log", 1000)]]);
    const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);

    const scroll = container.querySelector(
      '[data-testid="log-viewport"]',
    ) as HTMLElement;
    // totalLines=1000, rowHeight=20 → scroll so the first visible line ≈ 400.
    forceMetrics(scroll, 400 * 20);
    fireEvent.scroll(scroll);

    await waitFor(() => {
      const sweep = container.querySelector(".sweep") as HTMLElement;
      expect(sweep).not.toBeNull();
      // 400/1000 = 40% — the sweep tracks the real scroll position.
      expect(parseFloat(sweep.style.top)).toBeCloseTo(40, 5);
    });
  });
});
