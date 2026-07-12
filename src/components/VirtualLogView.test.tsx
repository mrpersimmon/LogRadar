// VirtualLogView — virtualized log view. The CRITICAL behavior under test:
// on scroll, the component must request ONLY the visible window of lines via
// `getLines(sessionId, start, count)` — never the whole file. With a 1M-line
// session scrolled to ~line 500k, the last `getLines` call must have
// `start ≈ 499990` and a viewport-sized `count` (tens of rows), NOT 1_000_000.
//
// The mockup's line rendering (line number / timestamp / level pip / message /
// hit mark / jump-target) is ported from
// `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html`
// (log-view section) and its token-adapted form in `premium-redesign.html`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

// Mock the IPC module so `getLines` is a spy and we never touch Tauri in jsdom.
vi.mock("../lib/ipc", () => ({ getLines: vi.fn() }));
import { getLines } from "../lib/ipc";
const mockedGetLines = vi.mocked(getLines);

import { VirtualLogView } from "./VirtualLogView";

const ROW = 20;
const VIEWPORT = 400; // px; 400 / 20 = 20 visible rows

/** Deterministic line text: a timestamp, an ERROR level, and the term
 * "refused" so the hit-highlight + jump-target assertions can locate content. */
function fakeLine(n: number): string {
  return `14:22:0${n % 10}.${String(n % 1000).padStart(3, "0")} ERROR DB connection refused line${n}`;
}

beforeEach(() => {
  mockedGetLines.mockReset();
  mockedGetLines.mockImplementation((_sid: string, start: number, count: number) =>
    Promise.resolve(Array.from({ length: count }, (_, i) => fakeLine(start + i))),
  );
});

/** jsdom reports 0 for all layout metrics (no layout engine). Force
 * `clientHeight` / `scrollTop` on the scroll container so the visible-window
 * math is deterministic. */
function forceMetrics(el: HTMLElement, scrollTop: number, vh = VIEWPORT) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: vh });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop });
}

function viewport(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="log-viewport"]') as HTMLElement;
}

describe("VirtualLogView", () => {
  it("renders a tall spacer so the scrollbar reflects totalLines", async () => {
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1_000_000} rowHeight={ROW} />,
    );
    // flush the async getLines microtask (chunk load) so it lands inside act
    await waitFor(() => expect(mockedGetLines).toHaveBeenCalled());
    const spacer = container.querySelector('[data-testid="log-spacer"]') as HTMLElement;
    expect(spacer.style.height).toBe(`${1_000_000 * ROW}px`);
  });

  it("requests ONLY the visible window via getLines on scroll (NOT the whole file)", async () => {
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1_000_000} rowHeight={ROW} />,
    );
    const scroll = viewport(container);
    // scroll so the top visible line is ~500000 (scrollTop = 500000 * rowHeight)
    forceMetrics(scroll, 500_000 * ROW);
    fireEvent.scroll(scroll);

    await waitFor(() => expect(mockedGetLines).toHaveBeenCalled());

    const calls = mockedGetLines.mock.calls as [string, number, number][];
    const last = calls[calls.length - 1];
    const [, start, count] = last;

    // visible window centered on line 500k — NOT the whole 1M-line file
    expect(start).toBeGreaterThanOrEqual(499_980);
    expect(start).toBeLessThanOrEqual(500_005);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100); // viewport-sized, not 1_000_000
    expect(count).toBeLessThan(1_000_000);

    // Killer assertion: NO call ever asked for the whole file.
    for (const c of mockedGetLines.mock.calls) {
      expect((c as [string, number, number])[2]).toBeLessThan(1_000_000);
    }
  });

  it("renders line numbers for the visible rows and elides far-away rows", async () => {
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1_000_000} rowHeight={ROW} />,
    );
    const scroll = viewport(container);
    forceMetrics(scroll, 500_000 * ROW);
    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(container.querySelector('[data-line="500000"]')).not.toBeNull(),
    );
    // the visible window is around 500k; rows far outside it are NOT rendered
    expect(container.querySelector('[data-line="0"]')).toBeNull();
    expect(container.querySelector('[data-line="999999"]')).toBeNull();
  });

  it("marks hit lines with the hit style and wraps the term in mark.hit", async () => {
    const { container } = render(
      <VirtualLogView
        sessionId="s1"
        totalLines={1_000_000}
        rowHeight={ROW}
        hits={[500000]}
        highlightTerm="refused"
      />,
    );
    const scroll = viewport(container);
    forceMetrics(scroll, 500_000 * ROW);
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

  it("marks the jump-target line with the jump style + tag", async () => {
    const { container } = render(
      <VirtualLogView
        sessionId="s1"
        totalLines={1_000_000}
        rowHeight={ROW}
        jumpToLine={500000}
      />,
    );
    const scroll = viewport(container);
    forceMetrics(scroll, 500_000 * ROW);
    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(container.querySelector('[data-line="500000"]')).not.toBeNull(),
    );
    const row = container.querySelector('[data-line="500000"]') as HTMLElement;
    expect(row.classList.contains("jump")).toBe(true);
    expect(row.querySelector(".tag")?.textContent).toMatch(/jump target/i);
  });

  it("calls onJumpToLine(n) when a row is clicked", async () => {
    const onJumpToLine = vi.fn();
    const { container } = render(
      <VirtualLogView
        sessionId="s1"
        totalLines={1_000_000}
        rowHeight={ROW}
        onJumpToLine={onJumpToLine}
      />,
    );
    const scroll = viewport(container);
    forceMetrics(scroll, 500_000 * ROW);
    fireEvent.scroll(scroll);

    await waitFor(() =>
      expect(container.querySelector('[data-line="500000"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-line="500000"]')!);
    expect(onJumpToLine).toHaveBeenCalledWith(500000);
  });

  it("requests the first window on mount (start=0)", async () => {
    render(<VirtualLogView sessionId="s1" totalLines={1_000_000} rowHeight={ROW} />);
    await waitFor(() => expect(mockedGetLines.mock.calls.length).toBeGreaterThan(0));
    const first = mockedGetLines.mock.calls[0] as [string, number, number];
    expect(first[1]).toBe(0); // start at line 0
    expect(first[2]).toBeLessThan(100); // a window, not the whole file
  });

  // --- Task 5: ▸展开JSON affordance — JsonInspector ↔ VirtualLogView (spec C5) ---
  // A JSON log line shows a ▸展开JSON toggle; clicking expands JsonInspector
  // inline beneath the line (indented); clicking again collapses; non-JSON
  // lines show no affordance.

  it("shows a ▸展开JSON affordance on a JSON line and expands JsonInspector inline on click", async () => {
    const jsonLine = '{"event":"db_error","code":"ECONNREFUSED"}';
    mockedGetLines.mockImplementation(() => Promise.resolve([jsonLine]));
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1} rowHeight={ROW} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-line="0"]')).not.toBeNull(),
    );
    const row = container.querySelector('[data-line="0"]') as HTMLElement;
    // collapsed: the ▸展开JSON affordance is present, no tree yet
    const toggle = row.querySelector(
      '[data-testid="json-toggle"]',
    ) as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain("▸展开JSON");
    expect(container.querySelector(".jtree")).toBeNull();
    // click → JsonInspector tree renders inline beneath the line
    fireEvent.click(toggle);
    const tree = await waitFor(() => container.querySelector(".jtree"));
    expect(tree).not.toBeNull();
    expect(tree!.textContent).toContain("event");
    expect(tree!.textContent).toContain("db_error");
    expect(tree!.textContent).toContain("ECONNREFUSED");
    // expanded toggle now shows ▾ (collapse affordance)
    expect(
      (row.querySelector('[data-testid="json-toggle"]') as HTMLElement)
        .textContent,
    ).toContain("▾");
  });

  it("collapses the JsonInspector on a second toggle click", async () => {
    const jsonLine = '{"event":"x"}';
    mockedGetLines.mockImplementation(() => Promise.resolve([jsonLine]));
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1} rowHeight={ROW} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-line="0"]')).not.toBeNull(),
    );
    const toggle = container.querySelector(
      '[data-testid="json-toggle"]',
    ) as HTMLElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector(".jtree")).not.toBeNull());
    // second click collapses → tree gone, affordance back to ▸
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector(".jtree")).toBeNull());
    expect(
      (container.querySelector('[data-testid="json-toggle"]') as HTMLElement)
        .textContent,
    ).toContain("▸展开JSON");
  });

  it("shows no ▸展开JSON affordance on non-JSON lines", async () => {
    // default beforeEach mock returns fakeLine(): "14:22:01 ERROR DB connection refused"
    const { container } = render(
      <VirtualLogView sessionId="s1" totalLines={1} rowHeight={ROW} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-line="0"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-testid="json-toggle"]')).toBeNull();
    expect(container.textContent).not.toContain("展开JSON");
  });

  it("does not trigger onJumpToLine when clicking inside the expanded JsonInspector tree", async () => {
    // nested object so there's a ▾/▸ twist to click inside the tree
    const jsonLine = '{"user":{"id":42}}';
    mockedGetLines.mockImplementation(() => Promise.resolve([jsonLine]));
    const onJumpToLine = vi.fn();
    const { container } = render(
      <VirtualLogView
        sessionId="s1"
        totalLines={1}
        rowHeight={ROW}
        onJumpToLine={onJumpToLine}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-line="0"]')).not.toBeNull(),
    );
    // expand the inline tree
    fireEvent.click(container.querySelector('[data-testid="json-toggle"]')!);
    await waitFor(() => expect(container.querySelector(".jtree")).not.toBeNull());
    // click a nested twist inside the tree — must NOT bubble up to the row's
    // onJumpToLine (the tree manages its own fold state; jump is a row action)
    const twist = container.querySelector('[data-key="user"]') as HTMLElement;
    expect(twist).not.toBeNull();
    fireEvent.click(twist);
    expect(onJumpToLine).not.toHaveBeenCalled();
  });
});
