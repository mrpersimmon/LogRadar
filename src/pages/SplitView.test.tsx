// SplitView (Task 8 ③b) — two-pane time-synced compare. The CRITICAL behaviors
// under test (per the brief: test the UI STATE, not the exact time-matching —
// deterministic timestamp matching is a ④ refinement):
//   (1) BOTH panes render (a left + right `VirtualLogView`), each wired to its
//       own sessionId — `getLines` is called for BOTH the left and right ids;
//   (2) the center time-sync gutter renders (`.sv-gutter`) with the sync marker
//       showing a signed Δ (`Δ+17ms` from the mock data's .003 vs .020);
//   (3) the `同滚` toggle defaults ON and flips to OFF when clicked (sync
//       cancelled) — the toggle's `on` class tracks the state;
//   (4) the `容差` input updates tolerance, and that state crosses the Δ: with
//       the default 1s tolerance the marker is WITHIN (teal); setting `10` (ms)
//       — Δ17ms exceeds it → the marker turns OVER (amber).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { SessionsApi, SessionMeta } from "../hooks/useSessions";

// Mock the IPC module so VirtualLogView's `getLines` (windowed line fetch) AND
// SplitView's scroll-spy `getLines` (top-line timestamp fetch) never touch
// Tauri in jsdom. `vi.hoisted` makes the spy available to the factory.
const { getLinesMock } = vi.hoisted(() => ({ getLinesMock: vi.fn() }));
vi.mock("../lib/ipc", () => ({ getLines: getLinesMock }));
import { getLines } from "../lib/ipc";
const mockedGetLines = vi.mocked(getLines);

import { SplitView } from "./SplitView";

const LEFT = "s-left";
const RIGHT = "s-right";

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

/** Build a SessionsApi with two sessions. Mutators are vi.fn()s — we only test
 *  rendering + state, not routing. */
function api(sessions: Map<string, SessionMeta>): SessionsApi {
  return {
    sessions,
    activeId: null,
    open: vi.fn(),
    close: vi.fn(),
    setActive: vi.fn(),
    openArchive: vi.fn(),
    openFolder: vi.fn(),
  };
}

beforeEach(() => {
  mockedGetLines.mockReset();
  // Constant-timestamp lines per session so the Δ is deterministic:
  //   left  → 14:22:01.003  (3ms within the second)
  //   right → 14:22:01.020  (20ms within the second)  → Δ = +17ms
  mockedGetLines.mockImplementation(
    (sid: string, _start: number, count: number) => {
      const isLeft = sid === LEFT;
      const ts = isLeft ? "14:22:01.003" : "14:22:01.020";
      const lvl = isLeft ? "ERROR" : "ERROR";
      return Promise.resolve(
        Array.from({ length: count }, () => `${ts} ${lvl} sync compare line`),
      );
    },
  );
});

describe("SplitView", () => {
  it("renders BOTH panes (left+right VirtualLogView) + the time-sync gutter + 同滚/容差/对齐 controls, and calls getLines for BOTH session ids", async () => {
    const sessions = new Map([
      [LEFT, meta(LEFT, "/logs/auth/a.log", 1000)],
      [RIGHT, meta(RIGHT, "/logs/api/c.log", 800)],
    ]);
    const { container } = render(
      <SplitView
        sessions={api(sessions)}
        leftSessionId={LEFT}
        rightSessionId={RIGHT}
      />,
    );

    // Flush the async chunk-load + scroll-spy top-line fetches inside act.
    await waitFor(() => expect(mockedGetLines).toHaveBeenCalled());

    // (1) TWO panes — a left + right VirtualLogView.
    const panes = container.querySelectorAll(".log-view");
    expect(panes.length).toBe(2);

    // getLines was called for BOTH session ids (each pane is wired to its own).
    const calledIds = new Set(
      mockedGetLines.mock.calls.map((c) => c[0] as string),
    );
    expect(calledIds.has(LEFT)).toBe(true);
    expect(calledIds.has(RIGHT)).toBe(true);

    // (2) the center time-sync gutter.
    expect(container.querySelector(".sv-gutter")).not.toBeNull();

    // (3) the controls exist; 同滚 defaults ON.
    const toggle = container.querySelector(".sv-sync-toggle") as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.classList.contains("on")).toBe(true);
    expect(container.querySelector(".sv-tol-input")).not.toBeNull();
    expect(container.querySelector(".sv-align")).not.toBeNull();
  });

  it("toggling 同滚 flips it OFF then ON (sync cancelled / resumed)", async () => {
    const sessions = new Map([
      [LEFT, meta(LEFT, "/logs/auth/a.log", 1000)],
      [RIGHT, meta(RIGHT, "/logs/api/c.log", 800)],
    ]);
    const { container } = render(
      <SplitView
        sessions={api(sessions)}
        leftSessionId={LEFT}
        rightSessionId={RIGHT}
      />,
    );
    await waitFor(() => expect(mockedGetLines).toHaveBeenCalled());

    const toggle = container.querySelector(".sv-sync-toggle") as HTMLElement;
    expect(toggle.classList.contains("on")).toBe(true); // default on

    fireEvent.click(toggle);
    expect(toggle.classList.contains("on")).toBe(false); // toggled OFF

    fireEvent.click(toggle);
    expect(toggle.classList.contains("on")).toBe(true); // back ON
  });

  it("shows the Δ marker from the two panes' top-line timestamps and recolors it from WITHIN→OVER when 容差 drops below Δ", async () => {
    const sessions = new Map([
      [LEFT, meta(LEFT, "/logs/auth/a.log", 1000)],
      [RIGHT, meta(RIGHT, "/logs/api/c.log", 800)],
    ]);
    const { container } = render(
      <SplitView
        sessions={api(sessions)}
        leftSessionId={LEFT}
        rightSessionId={RIGHT}
      />,
    );

    // Both panes report viewport(0) on mount → SplitView fetches each top line
    // → left.ts=.003, right.ts=.020 → Δ=+17ms. The marker lands after the async
    // top-line fetch resolves.
    const delta = await waitFor(async () => {
      const d = container.querySelector(".sv-delta") as HTMLElement;
      expect(d).not.toBeNull();
      return d;
    });
    // signed Δ: right(20ms) - left(3ms) = +17ms
    expect(delta.textContent).toMatch(/\+17ms/);

    // Default 容差 = 1s (1000ms) → 17ms ≤ 1000ms → WITHIN (teal), not OVER.
    expect(delta.classList.contains("within")).toBe(true);
    expect(delta.classList.contains("over")).toBe(false);

    // Drop 容差 to 10ms → Δ17ms EXCEEDS 10ms → OVER (amber).
    const tol = container.querySelector(".sv-tol-input") as HTMLInputElement;
    fireEvent.change(tol, { target: { value: "10" } });
    await waitFor(() => {
      const d = container.querySelector(".sv-delta") as HTMLElement;
      expect(d.classList.contains("over")).toBe(true);
      expect(d.classList.contains("within")).toBe(false);
    });

    // Restore 1000ms → back to WITHIN (state is reversible, not a one-shot).
    fireEvent.change(tol, { target: { value: "1000" } });
    await waitFor(() => {
      const d = container.querySelector(".sv-delta") as HTMLElement;
      expect(d.classList.contains("within")).toBe(true);
    });
  });
});
