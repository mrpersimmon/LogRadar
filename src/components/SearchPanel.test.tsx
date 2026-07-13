import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import {
  SearchPanel,
  buildQuery,
  describeQuery,
  parseEpochMs,
  type QueryForm,
} from "./SearchPanel";

// Mock `../lib/ipc` so the SearchPanel is tested in isolation from Tauri: we
// control `useSearch`'s {matches,status,run,cancel} (single-session fallback),
// `useCrossFileSearch`'s {results,run,cancel} (cross-file mode), and `getLines`'s
// resolved lines. `vi.hoisted` makes the fns available to the `vi.mock` factory
// (which runs during import resolution, before the module body).
const { useSearchMock, useCrossFileSearchMock, getLinesMock } = vi.hoisted(() => ({
  useSearchMock: vi.fn(),
  useCrossFileSearchMock: vi.fn(),
  getLinesMock: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  useSearch: useSearchMock,
  useCrossFileSearch: useCrossFileSearchMock,
  getLines: getLinesMock,
}));

function fakeCtrl(
  opts?: {
    matches?: number[];
    status?: "idle" | "running" | "done" | "cancelled" | "error";
    run?: ReturnType<typeof vi.fn>;
    cancel?: ReturnType<typeof vi.fn>;
  },
) {
  return {
    matches: opts?.matches ?? [],
    status: opts?.status ?? "idle",
    run: opts?.run ?? vi.fn(),
    cancel: opts?.cancel ?? vi.fn(),
  };
}

/** A cross-file aggregate view: one {sessionId,matches,status} per open session.
 *  Mirrors the shape `useCrossFileSearch` returns. */
function fakeCross(
  results: { sessionId: string; matches: number[]; status?: "idle" | "running" | "done" | "cancelled" | "error" }[],
  opts?: { run?: ReturnType<typeof vi.fn>; cancel?: ReturnType<typeof vi.fn> },
) {
  return {
    results: results.map((r) => ({
      sessionId: r.sessionId,
      matches: r.matches,
      status: r.status ?? "done",
    })),
    run: opts?.run ?? vi.fn(),
    cancel: opts?.cancel ?? vi.fn(),
  };
}

const emptyForm: QueryForm = {
  keywords: [],
  combinator: "AND",
  levels: [],
  timeRange: { start: "", end: "" },
};

beforeEach(() => {
  useSearchMock.mockReset();
  useCrossFileSearchMock.mockReset();
  getLinesMock.mockReset();
  useSearchMock.mockReturnValue(fakeCtrl());
  // Default cross-file mock: no sessions → empty results (single-session tests
  // that don't pass `sessionIds` never read this, but it must be a valid shape
  // so the unconditional `useCrossFileSearch` call inside SearchPanel doesn't
  // blow up).
  useCrossFileSearchMock.mockReturnValue(fakeCross([]));
  getLinesMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// pure logic: parseEpochMs
// ---------------------------------------------------------------------------
describe("parseEpochMs", () => {
  it("parses 'YYYY-MM-DD HH:MM:SS' to the same epoch ms as the T-form", () => {
    expect(parseEpochMs("2026-07-11 14:22:00")).toBe(
      Date.parse("2026-07-11T14:22:00"),
    );
  });
  it("returns null for an empty string", () => {
    expect(parseEpochMs("")).toBeNull();
  });
  it("returns null for a whitespace-only string", () => {
    expect(parseEpochMs("   ")).toBeNull();
  });
  it("returns null for unparseable text", () => {
    expect(parseEpochMs("not-a-date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pure logic: buildQuery (asserts against ②'s SearchRequest DTO shape)
// ---------------------------------------------------------------------------
describe("buildQuery", () => {
  it("returns null for an empty form (no keywords)", () => {
    expect(buildQuery(emptyForm)).toBeNull();
  });
  it("returns null when keywords are all whitespace", () => {
    expect(
      buildQuery({ ...emptyForm, keywords: ["  ", ""] }),
    ).toBeNull();
  });
  it("builds a single leaf text root for one keyword (no level/time)", () => {
    expect(buildQuery({ ...emptyForm, keywords: ["refused"] })).toEqual({
      root: { kind: "leaf", predicate: { kind: "text", text: "refused" } },
    });
  });
  it("builds a branch with lowercase 'and' combinator for two AND keywords", () => {
    expect(
      buildQuery({ ...emptyForm, keywords: ["refused", "timeout"], combinator: "AND" }),
    ).toEqual({
      root: {
        kind: "branch",
        combinator: "and",
        children: [
          { kind: "leaf", predicate: { kind: "text", text: "refused" } },
          { kind: "leaf", predicate: { kind: "text", text: "timeout" } },
        ],
      },
    });
  });
  it("builds a branch with lowercase 'or' when combinator is OR", () => {
    const q = buildQuery({ ...emptyForm, keywords: ["a", "b"], combinator: "OR" });
    expect(q?.root).toMatchObject({ kind: "branch", combinator: "or" });
  });
  it("nests keywords under a keyword-branch AND-ed with a level filter", () => {
    const q = buildQuery({
      ...emptyForm,
      keywords: ["refused", "timeout"],
      combinator: "AND",
      levels: ["ERROR", "WARN"],
    });
    const root = q?.root as { kind: string; combinator: string; children: unknown[] };
    expect(root.kind).toBe("branch");
    expect(root.combinator).toBe("and"); // outer is AND (keywords AND level)
    expect(root.children).toHaveLength(2);
    const kw = root.children[0] as { kind: string; combinator: string };
    expect(kw).toMatchObject({ kind: "branch", combinator: "and" });
    expect(root.children[1]).toEqual({
      kind: "leaf",
      predicate: { kind: "level", levels: ["ERROR", "WARN"] },
    });
  });
  it("AND-s a single keyword with a level filter", () => {
    const q = buildQuery({ ...emptyForm, keywords: ["refused"], levels: ["ERROR"] });
    expect(q?.root).toEqual({
      kind: "branch",
      combinator: "and",
      children: [
        { kind: "leaf", predicate: { kind: "text", text: "refused" } },
        { kind: "leaf", predicate: { kind: "level", levels: ["ERROR"] } },
      ],
    });
  });
  it("emits a timeRange leaf with epoch ms for start+end", () => {
    const q = buildQuery({
      ...emptyForm,
      keywords: ["refused"],
      timeRange: { start: "2026-07-11 14:22:00", end: "2026-07-11 14:23:00" },
    });
    const root = q?.root as { children: { predicate: { kind: string; startEpochMs: number | null; endEpochMs: number | null } }[] };
    const tr = root.children.find((c) => c.predicate.kind === "timeRange")!;
    expect(tr.predicate).toEqual({
      kind: "timeRange",
      startEpochMs: Date.parse("2026-07-11T14:22:00"),
      endEpochMs: Date.parse("2026-07-11T14:23:00"),
    });
  });
  it("emits a timeRange leaf with null endEpochMs when only start is set", () => {
    const q = buildQuery({
      ...emptyForm,
      keywords: ["refused"],
      timeRange: { start: "2026-07-11 14:22:00", end: "" },
    });
    const root = q?.root as {
      children: {
        predicate: {
          kind: string;
          startEpochMs: number | null;
          endEpochMs: number | null;
        };
      }[];
    };
    const tr = root.children.find((c) => c.predicate.kind === "timeRange")!;
    expect(tr.predicate.endEpochMs).toBeNull();
    expect(tr.predicate.startEpochMs).toBe(
      Date.parse("2026-07-11T14:22:00"),
    );
  });
  it("filters out empty/whitespace keywords before building", () => {
    const q = buildQuery({
      ...emptyForm,
      keywords: ["refused", "  ", ""],
      combinator: "AND",
    });
    // only 1 real keyword → single leaf root (not a branch)
    expect(q).toEqual({
      root: { kind: "leaf", predicate: { kind: "text", text: "refused" } },
    });
  });
  // THE FLAGSHIP: 2 keywords + AND + level ERROR,WARN + time range → full DTO shape.
  it("builds the full query shape for 2 keywords AND + level + time (asserts against the DTO)", () => {
    const form: QueryForm = {
      keywords: ["refused", "timeout"],
      combinator: "AND",
      levels: ["ERROR", "WARN"],
      timeRange: { start: "2026-07-11 14:22:00", end: "2026-07-11 14:23:00" },
    };
    expect(buildQuery(form)).toEqual({
      root: {
        kind: "branch",
        combinator: "and",
        children: [
          {
            kind: "branch",
            combinator: "and",
            children: [
              { kind: "leaf", predicate: { kind: "text", text: "refused" } },
              { kind: "leaf", predicate: { kind: "text", text: "timeout" } },
            ],
          },
          { kind: "leaf", predicate: { kind: "level", levels: ["ERROR", "WARN"] } },
          {
            kind: "leaf",
            predicate: {
              kind: "timeRange",
              startEpochMs: Date.parse("2026-07-11T14:22:00"),
              endEpochMs: Date.parse("2026-07-11T14:23:00"),
            },
          },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// pure logic: describeQuery (the history entry title = full query)
// ---------------------------------------------------------------------------
describe("describeQuery", () => {
  it("joins keywords with the combinator", () => {
    expect(
      describeQuery({ ...emptyForm, keywords: ["refused", "timeout"], combinator: "AND" }),
    ).toContain("refused AND timeout");
  });
  it("appends a level clause", () => {
    expect(
      describeQuery({ ...emptyForm, keywords: ["refused"], levels: ["ERROR", "WARN"] }),
    ).toContain("ERROR,WARN");
  });
  it("appends a time clause with both endpoints", () => {
    const t = describeQuery({
      ...emptyForm,
      keywords: ["refused"],
      timeRange: { start: "2026-07-11 14:22:00", end: "2026-07-11 14:23:00" },
    });
    expect(t).toContain("14:22");
    expect(t).toContain("14:23");
  });
  it("omits level and time clauses when absent", () => {
    expect(describeQuery({ ...emptyForm, keywords: ["refused"] })).toBe("refused");
  });
  it("records the FULL query title (keywords + level + time)", () => {
    const t = describeQuery({
      keywords: ["refused", "timeout"],
      combinator: "AND",
      levels: ["ERROR", "WARN"],
      timeRange: { start: "2026-07-11 14:22:00", end: "2026-07-11 14:23:00" },
    });
    expect(t).toContain("refused AND timeout");
    expect(t).toContain("ERROR,WARN");
    expect(t).toContain("14:22");
    expect(t).toContain("14:23");
  });
});

// ---------------------------------------------------------------------------
// component: form → useSearch query wiring + validation
// ---------------------------------------------------------------------------
function addKeyword(label: string) {
  fireEvent.change(screen.getByLabelText(/keyword input/i), {
    target: { value: label },
  });
  fireEvent.click(screen.getByRole("button", { name: /add keyword/i }));
}

describe("SearchPanel form validation", () => {
  it("disables the Search button until at least one keyword is entered", () => {
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    expect(
      (screen.getByRole("button", { name: /^search$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("enables the Search button once a keyword is added", () => {
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    expect(
      (screen.getByRole("button", { name: /^search$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("SearchPanel form → useSearch query arg", () => {
  it("passes the built SearchRequest to useSearch (asserts DTO shape after fill)", () => {
    let captured: unknown = null;
    useSearchMock.mockImplementation((_sid: string, q: unknown) => {
      captured = q;
      return fakeCtrl();
    });
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    addKeyword("timeout");
    // combinator defaults to AND
    fireEvent.click(screen.getByRole("button", { name: /level error/i }));
    fireEvent.click(screen.getByRole("button", { name: /level warn/i }));
    fireEvent.change(screen.getByLabelText(/start time/i), {
      target: { value: "2026-07-11 14:22:00" },
    });
    fireEvent.change(screen.getByLabelText(/end time/i), {
      target: { value: "2026-07-11 14:23:00" },
    });
    expect(captured).toEqual({
      root: {
        kind: "branch",
        combinator: "and",
        children: [
          {
            kind: "branch",
            combinator: "and",
            children: [
              { kind: "leaf", predicate: { kind: "text", text: "refused" } },
              { kind: "leaf", predicate: { kind: "text", text: "timeout" } },
            ],
          },
          { kind: "leaf", predicate: { kind: "level", levels: ["ERROR", "WARN"] } },
          {
            kind: "leaf",
            predicate: {
              kind: "timeRange",
              startEpochMs: Date.parse("2026-07-11T14:22:00"),
              endEpochMs: Date.parse("2026-07-11T14:23:00"),
            },
          },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// component: history (records full query; click re-fills + re-runs)
// ---------------------------------------------------------------------------
describe("SearchPanel history", () => {
  it("records the full query to history on Search", () => {
    const run = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ run }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    addKeyword("timeout");
    fireEvent.click(screen.getByRole("button", { name: /level error/i }));
    fireEvent.click(screen.getByRole("button", { name: /level warn/i }));
    fireEvent.change(screen.getByLabelText(/start time/i), {
      target: { value: "2026-07-11 14:22:00" },
    });
    fireEvent.change(screen.getByLabelText(/end time/i), {
      target: { value: "2026-07-11 14:23:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    // open the history dropdown
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    const dd = screen.getByRole("listbox", { name: /search history/i });
    // the entry's title is the FULL query (keywords + level + time)
    expect(within(dd).getByText(/refused AND timeout/)).toBeTruthy();
    expect(within(dd).getByText(/ERROR,WARN/)).toBeTruthy();
    expect(within(dd).getByText(/14:22/)).toBeTruthy();
    expect(within(dd).getByText(/14:23/)).toBeTruthy();
  });

  it("re-fills the form and re-runs when a history entry is clicked", () => {
    const run = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ run, status: "idle" }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    // Run query A (one keyword: refused)
    addKeyword("refused");
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(run).toHaveBeenCalledTimes(1);
    // Move form to query B (add a second keyword: timeout)
    addKeyword("timeout");
    const form = screen.getByTestId("search-form");
    // sanity: both chips present now
    expect(within(form).getByText("refused")).toBeTruthy();
    expect(within(form).getByText("timeout")).toBeTruthy();
    // Open history + click the entry whose title is query A
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    const dd = screen.getByRole("listbox", { name: /search history/i });
    fireEvent.click(within(dd).getByRole("option", { name: /refused/ }));
    // re-fill: the timeout chip is gone (form restored to query A)
    expect(within(form).queryByText("timeout")).toBeNull();
    expect(within(form).getByText("refused")).toBeTruthy();
    // re-run: run() was called a second time
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("navigates history with back/forward arrows (re-fills + re-runs)", () => {
    const run = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ run, status: "idle" }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("alpha");
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    addKeyword("beta"); // form now has alpha+beta; run query B
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(run).toHaveBeenCalledTimes(2);
    // Back arrow → restore query A (single keyword alpha)
    fireEvent.click(screen.getByRole("button", { name: /history back/i }));
    const form = screen.getByTestId("search-form");
    expect(within(form).queryByText("beta")).toBeNull();
    expect(within(form).getByText("alpha")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(3);
    // Forward arrow → restore query B
    fireEvent.click(screen.getByRole("button", { name: /history forward/i }));
    expect(within(form).getByText("beta")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("clears the history via the clear button", () => {
    const run = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ run }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    const dd = screen.getByRole("listbox", { name: /search history/i });
    expect(within(dd).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /clear history/i }));
    // dropdown closes / no entries
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    const dd2 = screen.getByRole("listbox", { name: /search history/i });
    expect(within(dd2).queryAllByRole("option")).toHaveLength(0);
  });

  it("resets history when sessionId changes (session-scoped)", () => {
    const run = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ run }));
    const { rerender } = render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    expect(
      within(screen.getByRole("listbox", { name: /search history/i })).getAllByRole("option"),
    ).toHaveLength(1);
    // switch session → history resets
    rerender(<SearchPanel sessionId="s2" filePath="b.log" />);
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    expect(
      within(screen.getByRole("listbox", { name: /search history/i })).queryAllByRole("option"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// component: flat results (one row per matched file + hit count, expandable)
// ---------------------------------------------------------------------------
describe("SearchPanel results", () => {
  it("renders a flat file row with the path and hit count", () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [124, 231, 400], status: "done" }));
    render(<SearchPanel sessionId="s1" filePath="logs/auth/a.log" />);
    expect(screen.getByText("logs/auth/a.log")).toBeTruthy();
    // hit-count text appears both in the file row and the nav-meta aggregate
    expect(screen.getAllByText(/3\s*命中/).length).toBeGreaterThan(0);
  });
  it("shows an empty state when the search is done with no matches", () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [], status: "done" }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    expect(screen.getByText(/no results|无结果/i)).toBeTruthy();
  });
  it("shows a searching state while running with no matches yet", () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [], status: "running" }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    expect(screen.getByText(/searching|搜索中/i)).toBeTruthy();
  });
  it("updates the hit count reactively when matches stream in", () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [], status: "running" }));
    const { rerender } = render(<SearchPanel sessionId="s1" filePath="a.log" />);
    expect(screen.queryAllByText(/1\s*命中/)).toHaveLength(0);
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [10], status: "running" }));
    rerender(<SearchPanel sessionId="s1" filePath="a.log" />);
    expect(screen.getAllByText(/1\s*命中/).length).toBeGreaterThan(0);
  });
  it("fetches matching line content via getLines when a file row is expanded", async () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [124, 231], status: "done" }));
    getLinesMock.mockResolvedValue(["2026-07-11 14:22:01 ERROR DB connection refused"]);
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    fireEvent.click(screen.getByRole("button", { name: /a\.log/i }));
    expect(getLinesMock).toHaveBeenCalledWith("s1", 124, expect.any(Number));
    // Issue 1: content is fetched for EVERY match (2 here), so each renders.
    expect((await screen.findAllByText(/refused/)).length).toBe(2);
  });
  // Issue 1 fix: the expanded row must render EVERY matching line (line number
  // + content), not just matches[0] + a "还有 N 行" truncation. Asserts all 5
  // matches render AND each row is jump-clickable (onJumpToLine with its line).
  it("renders ALL matching lines (not just the first) when a row is expanded (Issue 1)", async () => {
    useSearchMock.mockReturnValue(
      fakeCtrl({ matches: [124, 231, 400, 512, 700], status: "done" }),
    );
    getLinesMock.mockResolvedValue(["matched line content"]);
    render(<SearchPanel sessionId="s1" filePath="a.log" onJumpToLine={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /a\.log/i }));
    // ALL 5 match line numbers render (previously only 124 + "还有 4 行")
    expect(await screen.findByText("124")).toBeTruthy();
    expect(screen.getByText("231")).toBeTruthy();
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByText("512")).toBeTruthy();
    expect(screen.getByText("700")).toBeTruthy();
    // the "还有 N 行" truncation is gone
    expect(screen.queryByText(/还有/)).toBeNull();
  });

  it("makes each rendered match row jump-clickable (calls onJumpToLine with its line number)", async () => {
    const onJumpToLine = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [124, 231], status: "done" }));
    getLinesMock.mockResolvedValue(["content"]);
    render(
      <SearchPanel sessionId="s1" filePath="a.log" onJumpToLine={onJumpToLine} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /a\.log/i }));
    await screen.findByText("124");
    fireEvent.click(screen.getByRole("button", { name: /jump to line 124/i }));
    expect(onJumpToLine).toHaveBeenCalledWith(124);
    fireEvent.click(screen.getByRole("button", { name: /jump to line 231/i }));
    expect(onJumpToLine).toHaveBeenCalledWith(231);
  });
  it("collapses the expanded rows on a second click", async () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [124], status: "done" }));
    getLinesMock.mockResolvedValue(["2026-07-11 14:22:01 ERROR refused"]);
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    const row = screen.getByRole("button", { name: /a\.log/i });
    fireEvent.click(row);
    await screen.findByText(/refused/);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// component: keyword/level combinator edits
// ---------------------------------------------------------------------------
describe("SearchPanel form edits", () => {
  it("removes a keyword chip via its × button", () => {
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    addKeyword("timeout");
    fireEvent.click(screen.getByRole("button", { name: /remove keyword refused/i }));
    const form = screen.getByTestId("search-form");
    expect(within(form).queryByText("refused")).toBeNull();
    expect(within(form).getByText("timeout")).toBeTruthy();
  });
  it("toggles the combinator between AND and OR", () => {
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    const comb = screen.getByRole("button", { name: /combinator/i });
    expect(comb.textContent).toMatch(/AND/);
    fireEvent.click(comb);
    expect(comb.textContent).toMatch(/OR/);
    fireEvent.click(comb);
    expect(comb.textContent).toMatch(/AND/);
  });
  it("toggles a level button on then off", () => {
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    const err = screen.getByRole("button", { name: /level error/i });
    expect(err.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(err);
    expect(err.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(err);
    expect(err.getAttribute("aria-pressed")).toBe("false");
  });
  it("calls cancel() when the cancel button is clicked during a running search", () => {
    const cancel = vi.fn();
    useSearchMock.mockReturnValue(fakeCtrl({ status: "running", run: vi.fn(), cancel }));
    render(<SearchPanel sessionId="s1" filePath="a.log" />);
    addKeyword("refused");
    fireEvent.click(screen.getByRole("button", { name: /cancel|取消/i }));
    expect(cancel).toHaveBeenCalled();
  });
  it("shows the result/file count meta from the active search", () => {
    useSearchMock.mockReturnValue(fakeCtrl({ matches: [1, 2, 3, 4], status: "done" }));
    render(<SearchPanel sessionId="s1" filePath="logs/x.log" />);
    expect(screen.getAllByText(/4\s*命中/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1\s*文件/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// component: cross-file results (B4 — one flat row per matched file across ALL
// open sessions, Notepad++ Find-in-Files style). SearchPanel switches to
// `useCrossFileSearch` when `sessionIds` is provided.
// ---------------------------------------------------------------------------
describe("SearchPanel cross-file results", () => {
  it("renders one flat row per session with hits across all open sessions (a.log · 8, b.log · 4, c.log · 5)", () => {
    useCrossFileSearchMock.mockReturnValue(
      fakeCross([
        { sessionId: "s1", matches: [1, 2, 3, 4, 5, 6, 7, 8], status: "done" },
        { sessionId: "s2", matches: [10, 11, 12, 13], status: "done" },
        { sessionId: "s3", matches: [20, 21, 22, 23, 24], status: "done" },
      ]),
    );
    const filePathFor = (sid: string) =>
      ({ s1: "logs/auth/a.log", s2: "logs/b.log", s3: "logs/c.log" })[sid] ?? sid;
    render(
      <SearchPanel
        sessionId="s1"
        sessionIds={["s1", "s2", "s3"]}
        filePathFor={filePathFor}
      />,
    );
    // three flat rows — one per matched file, each labeled by its full path
    expect(screen.getByText("logs/auth/a.log")).toBeTruthy();
    expect(screen.getByText("logs/b.log")).toBeTruthy();
    expect(screen.getByText("logs/c.log")).toBeTruthy();
    // hit counts per file (B4: "一个命中文件全路径一行")
    expect(screen.getAllByText(/8\s*命中/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4\s*命中/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5\s*命中/).length).toBeGreaterThan(0);
  });

  it("omits sessions with zero matches from the flat rows", () => {
    useCrossFileSearchMock.mockReturnValue(
      fakeCross([
        { sessionId: "s1", matches: [1, 2], status: "done" },
        { sessionId: "s2", matches: [], status: "done" }, // no hits → no row
        { sessionId: "s3", matches: [3], status: "done" },
      ]),
    );
    const filePathFor = (sid: string) =>
      ({ s1: "a.log", s2: "b.log", s3: "c.log" })[sid] ?? sid;
    render(
      <SearchPanel
        sessionId="s1"
        sessionIds={["s1", "s2", "s3"]}
        filePathFor={filePathFor}
      />,
    );
    expect(screen.getByText("a.log")).toBeTruthy();
    expect(screen.queryByText("b.log")).toBeNull(); // zero-hit file not shown
    expect(screen.getByText("c.log")).toBeTruthy();
  });

  it("shows the aggregate hit + file count meta across all sessions", () => {
    useCrossFileSearchMock.mockReturnValue(
      fakeCross([
        { sessionId: "s1", matches: [1, 2, 3, 4, 5, 6, 7, 8], status: "done" },
        { sessionId: "s2", matches: [10, 11, 12, 13], status: "done" },
        { sessionId: "s3", matches: [20, 21, 22, 23, 24], status: "done" },
      ]),
    );
    render(
      <SearchPanel
        sessionId="s1"
        sessionIds={["s1", "s2", "s3"]}
        filePathFor={() => "x.log"}
      />,
    );
    // 8 + 4 + 5 = 17 total hits across 3 files
    expect(screen.getAllByText(/17\s*命中/).length).toBeGreaterThan(0);
    expect(screen.getByText(/3\s*文件/i)).toBeTruthy();
  });

  it("runs useCrossFileSearch.run() (all sessions) on Search click — not the single-session useSearch.run", () => {
    const crossRun = vi.fn();
    const localRun = vi.fn();
    // SearchPanel still calls `useSearch` once for the active session (hooks
    // rule — the single-session fallback path), but in cross-file mode its run
    // must NOT be the one invoked: the cross-file run fans out to all sessions.
    useSearchMock.mockReturnValue(fakeCtrl({ run: localRun }));
    useCrossFileSearchMock.mockReturnValue(
      fakeCross(
        [
          { sessionId: "s1", matches: [], status: "idle" },
          { sessionId: "s2", matches: [], status: "idle" },
        ],
        { run: crossRun },
      ),
    );
    render(
      <SearchPanel
        sessionId="s1"
        sessionIds={["s1", "s2"]}
        filePathFor={() => "x.log"}
      />,
    );
    addKeyword("refused");
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(crossRun).toHaveBeenCalledTimes(1);
    expect(localRun).not.toHaveBeenCalled();
  });
});
