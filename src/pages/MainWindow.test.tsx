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
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import type { SessionsApi, SessionMeta } from "../hooks/useSessions";

// Mock the IPC module so VirtualLogView's `getLines`, SearchPanel's
// `useSearch` (single-session fallback) + `useCrossFileSearch` (cross-file
// mode), never touch Tauri in jsdom. `vi.hoisted` makes the spies available
// to the factory (which runs during import resolution, before the module body).
const { getLinesMock, useSearchMock, useCrossFileSearchMock } = vi.hoisted(() => ({
  getLinesMock: vi.fn(),
  useSearchMock: vi.fn(),
  useCrossFileSearchMock: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  getLines: getLinesMock,
  useSearch: useSearchMock,
  useCrossFileSearch: useCrossFileSearchMock,
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
    openArchive: vi.fn(),
    openFolder: vi.fn(),
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
  useCrossFileSearchMock.mockReset();
  getLinesMock.mockImplementation(
    (_sid: string, _start: number, count: number) =>
      Promise.resolve(
        Array.from({ length: count }, (_, i) => `14:22:01.003 ERROR line ${i}`),
      ),
  );
  useSearchMock.mockReturnValue(fakeCtrl());
  // Cross-file mock: empty results (one per session would be more faithful,
  // but MainWindow's tests don't assert SearchPanel's flat rows — they just
  // need the unconditional `useCrossFileSearch` call to not crash).
  useCrossFileSearchMock.mockReturnValue({
    results: [],
    run: vi.fn(),
    cancel: vi.fn(),
  });
});

/** jsdom reports 0 for all layout metrics (no layout engine). Force
 *  `clientHeight` / `scrollTop` on the log viewport so the visible-window math
 *  is deterministic — same trick VirtualLogView's own test uses. scrollTop is
 *  writable so VirtualLogView's jumpToLine auto-scroll effect can assign it
 *  (Issue 2b) without throwing in strict mode. */
function forceMetrics(el: HTMLElement, scrollTop: number, vh = 400) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: vh });
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: scrollTop });
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

  // -------------------------------------------------------------------------
  // Task 1 (④a): the search→view loop. App lifts `useSearch` so the SAME
  // controller's matches flow to VirtualLogView (hit highlight) + the jump
  // loop (a row click → jumpToLine marks the line). These assert MainWindow
  // wires the lifted `search` into VirtualLogView's existing
  // hits/highlightTerm/jumpToLine/onJumpToLine props.
  // -------------------------------------------------------------------------
  /** getLines lines that contain the "refused" term so mark.hit can wrap it.
   *  Returns a Promise (VirtualLogView calls `.then` on the result). */
  function refusedLines(_sid: string, start: number, count: number) {
    return Promise.resolve(
      Array.from(
        { length: count },
        (_, i) =>
          `14:22:0${(start + i) % 10}.${String((start + i) % 1000).padStart(3, "0")} ERROR DB connection refused line${start + i}`,
      ),
    );
  }

  it("passes lifted search.matches + highlightTerm to VirtualLogView (a hit line is highlighted)", async () => {
    const sessions = new Map([["s1", meta("s1", "/logs/auth/a.log", 1_000_000)]]);
    getLinesMock.mockImplementation(refusedLines);
    const search = {
      matches: [500000],
      status: "done" as const,
      run: vi.fn(),
      cancel: vi.fn(),
    };
    const { container } = render(
      <MainWindow
        sessions={api(sessions, "s1")}
        search={search}
        highlightTerm="refused"
      />,
    );

    const scroll = container.querySelector(
      '[data-testid="log-viewport"]',
    ) as HTMLElement;
    forceMetrics(scroll, 500_000 * 20);
    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(container.querySelector('[data-line="500000"]')).not.toBeNull(),
    );
    const row = container.querySelector('[data-line="500000"]') as HTMLElement;
    expect(row.classList.contains("hit")).toBe(true);
    const mark = row.querySelector("mark.hit") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("refused");
  });

  it("wires a VirtualLogView row click → onJumpToLine → jumpToLine (the clicked row is marked jump)", async () => {
    const sessions = new Map([["s1", meta("s1", "/logs/auth/a.log", 1_000_000)]]);
    getLinesMock.mockImplementation(refusedLines);
    const search = {
      matches: [500000],
      status: "done" as const,
      run: vi.fn(),
      cancel: vi.fn(),
    };
    const { container } = render(
      <MainWindow
        sessions={api(sessions, "s1")}
        search={search}
        highlightTerm="refused"
      />,
    );

    const scroll = container.querySelector(
      '[data-testid="log-viewport"]',
    ) as HTMLElement;
    forceMetrics(scroll, 500_000 * 20);
    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(container.querySelector('[data-line="500000"]')).not.toBeNull(),
    );
    const row = container.querySelector('[data-line="500000"]') as HTMLElement;
    expect(row.classList.contains("jump")).toBe(false); // not yet the jump target
    fireEvent.click(row);
    const rowAfter = container.querySelector(
      '[data-line="500000"]',
    ) as HTMLElement;
    expect(rowAfter.classList.contains("jump")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Task 6 (④a): the Compare picker. MainWindow shows a "Compare" affordance
  // only when 2+ sessions are open; opening it reveals a Left/Right session
  // picker (defaulting to the first two distinct sessions); confirming calls
  // `setView("split", { left, right })` so App routes to SplitView with both.
  // -------------------------------------------------------------------------
  describe("Compare picker (Task 6)", () => {
    it("shows the Compare affordance only when 2+ sessions are open", async () => {
      const setView = vi.fn();
      // 1 session → no Compare button
      const one = new Map([["s1", meta("s1", "/a.log", 10)]]);
      const { container, rerender } = render(
        <MainWindow sessions={api(one, "s1")} setView={setView} />,
      );
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      expect(
        container.querySelector('[data-testid="mw-compare-btn"]'),
      ).toBeNull();

      // 2 sessions → Compare button appears
      const two = new Map([
        ["s1", meta("s1", "/a.log", 10)],
        ["s2", meta("s2", "/b.log", 20)],
      ]);
      rerender(<MainWindow sessions={api(two, "s1")} setView={setView} />);
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      expect(
        container.querySelector('[data-testid="mw-compare-btn"]'),
      ).not.toBeNull();
    });

    it("Compare picker picks 2 sessions → setView('split', { left, right })", async () => {
      const sessions = new Map([
        ["s1", meta("s1", "/logs/a.log", 10)],
        ["s2", meta("s2", "/logs/b.log", 20)],
      ]);
      const setView = vi.fn();
      const { container } = render(
        <MainWindow sessions={api(sessions, "s1")} setView={setView} />,
      );
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());

      // open the picker
      fireEvent.click(
        container.querySelector('[data-testid="mw-compare-btn"]')!,
      );
      const panel = container.querySelector(
        '[data-testid="mw-compare-panel"]',
      );
      expect(panel).not.toBeNull();

      // defaults: left=s1, right=s2 (the first two distinct sessions)
      const leftSel = container.querySelector(
        '[aria-label="Left session for compare"]',
      ) as HTMLSelectElement;
      const rightSel = container.querySelector(
        '[aria-label="Right session for compare"]',
      ) as HTMLSelectElement;
      expect(leftSel.value).toBe("s1");
      expect(rightSel.value).toBe("s2");

      // confirm → routes to split with both session ids
      fireEvent.click(
        container.querySelector('[aria-label="Start split compare"]')!,
      );
      expect(setView).toHaveBeenCalledTimes(1);
      expect(setView).toHaveBeenCalledWith("split", {
        left: "s1",
        right: "s2",
      });
    });

    it("reflects a user-picked left/right pair into the setView payload", async () => {
      const sessions = new Map([
        ["s1", meta("s1", "/logs/a.log", 10)],
        ["s2", meta("s2", "/logs/b.log", 20)],
        ["s3", meta("s3", "/logs/c.log", 30)],
      ]);
      const setView = vi.fn();
      const { container } = render(
        <MainWindow sessions={api(sessions, "s1")} setView={setView} />,
      );
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());

      fireEvent.click(
        container.querySelector('[data-testid="mw-compare-btn"]')!,
      );
      // swap the right pane to the third session
      fireEvent.change(
        container.querySelector(
          '[aria-label="Right session for compare"]',
        ) as HTMLSelectElement,
        { target: { value: "s3" } },
      );
      fireEvent.click(
        container.querySelector('[aria-label="Start split compare"]')!,
      );
      expect(setView).toHaveBeenCalledWith("split", {
        left: "s1",
        right: "s3",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Issue 3: drag-to-resize handles. A vertical handle between FileTree and
  // .mw-main resizes the sidebar width; a horizontal handle between .mw-view
  // and SearchPanel resizes the panel height. jsdom can't do a real mouse drag,
  // but the delta-from-mousedown pattern (no getBoundingClientRect) makes the
  // window mousemove dispatch deterministic, so the wiring is unit-tested;
  // visual/feel verification needs `cargo tauri dev`.
  // -------------------------------------------------------------------------
  describe("Resize handles (Issue 3)", () => {
    it("renders drag-resize handles for the sidebar and search panel", async () => {
      const sessions = new Map([["s1", meta("s1", "/logs/a.log", 1000)]]);
      const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      expect(
        container.querySelector('[data-testid="sidebar-resize-handle"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sp-resize-handle"]'),
      ).not.toBeNull();
    });

    it("applies the default sidebar width + search panel height via inline style", async () => {
      const sessions = new Map([["s1", meta("s1", "/logs/a.log", 1000)]]);
      const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      const ft = container.querySelector(".file-tree") as HTMLElement;
      expect(ft.style.width).toBe("208px"); // default sidebar width
      const sp = container.querySelector(".sp") as HTMLElement;
      // default = window.innerHeight * 0.36 (jsdom innerHeight = 768 → 276.48)
      expect(parseFloat(sp.style.height)).toBeCloseTo(
        window.innerHeight * 0.36,
        5,
      );
    });

    it("dragging the sidebar handle resizes the FileTree width", async () => {
      const sessions = new Map([["s1", meta("s1", "/logs/a.log", 1000)]]);
      const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      const handle = container.querySelector(
        '[data-testid="sidebar-resize-handle"]',
      ) as HTMLElement;
      // mousedown at clientX=208 (current width), then drag to clientX=300
      fireEvent.mouseDown(handle, { clientX: 208 });
      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
      });
      const ft = container.querySelector(".file-tree") as HTMLElement;
      expect(ft.style.width).toBe("300px");
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
    });

    it("dragging the search-panel handle resizes the SearchPanel height", async () => {
      const sessions = new Map([["s1", meta("s1", "/logs/a.log", 1000)]]);
      const { container } = render(<MainWindow sessions={api(sessions, "s1")} />);
      await waitFor(() => expect(getLinesMock).toHaveBeenCalled());
      const handle = container.querySelector(
        '[data-testid="sp-resize-handle"]',
      ) as HTMLElement;
      const startH = window.innerHeight * 0.36;
      fireEvent.mouseDown(handle, { clientY: 400 });
      // drag the handle UP (clientY 400 → 300): the bottom panel grows by 100
      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientY: 300 }));
      });
      const sp = container.querySelector(".sp") as HTMLElement;
      const expected = Math.min(
        window.innerHeight * 0.8,
        Math.max(120, startH + 100),
      );
      expect(parseFloat(sp.style.height)).toBeCloseTo(expected, 5);
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
    });
  });
});
