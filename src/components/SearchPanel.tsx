// SearchPanel — the bottom panel (form + full-query history + flat results),
// Notepad++ Find-in-Files style. Ports the bottom-panel structure/CSS from
// `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html` (and
// its token-adapted form in `premium-redesign.html`), restyled with ③a's
// premium tokens.
//
// Three stacked layers (per spec):
//   (1) form — keywords with AND/OR connectors + level multi-select + time range
//       (YYYY-MM-DD HH:MM:SS);
//   (2) history nav — ◀ ▶ + a ▾ dropdown listing past searches; EACH ENTRY'S
//       TITLE = the full query (keywords + level + time + exclusion); click →
//       re-fill the form + re-run. History is session-scoped (in-memory, reset
//       when sessionId changes);
//   (3) flat results — one row per matched file (path + hit count), expandable
//       to show matching line content fetched via `getLines`.
//
// The form builds a `SearchRequest` JSON whose shape matches ②'s DTO in
// `src-tauri/src/commands.rs` (`SearchRequest`/`QueryNodeDto`/`PredicateDto`/
// `CombinatorDto`): the wire format is camelCase, `QueryNodeDto`/`PredicateDto`
// are `{kind:"leaf"|"branch",...}`/`{kind:"text"|"level"|"timeRange",...}` tags,
// and `CombinatorDto` serializes lowercase (`"and"`/`"or"`). The frontend owns
// this exact JSON (Task 1's `useSearch(sessionId, query, cap)` forwards it to
// `invoke("search", {sessionId, query, cap, onEvent})`).
//
// Semantics: keywords combine under the user-chosen combinator (AND/OR); level
// and time are CONJUNCTIVE filters AND-ed with the keyword expression. So
// {kw1,kw2 AND, level=[ERROR,WARN], time} becomes
//   branch(and, [ branch(and, [text kw1, text kw2]), leaf(level), leaf(timeRange) ])
// — the inner branch uses the user's combinator; the outer is always AND.

import { useEffect, useRef, useState } from "react";
import { useSearch, getLines, type SearchStatus } from "../lib/ipc";
import { SearchHistory } from "./SearchHistory";
import "./SearchPanel.css";

// ---------- shared types (the DTO ② expects, mirrored on the frontend) ----------

export type Combinator = "AND" | "OR";

/** The form state — the single source of truth. The query JSON is DERIVED from
 *  this via `buildQuery`; the history title via `describeQuery`. Storing the
 *  form (not the JSON) lets a history click re-fill the form directly, with no
 *  round-trip deserialization. */
export type QueryForm = {
  keywords: string[];
  combinator: Combinator;
  levels: string[];
  timeRange: { start: string; end: string };
};

export type HistoryEntry = {
  id: string;
  form: QueryForm;
  title: string;
  timestamp: number;
  resultCount: number;
};

export type PredicateDto =
  | { kind: "text"; text: string }
  | { kind: "regex"; pattern: string }
  | { kind: "level"; levels: string[] }
  | {
      kind: "timeRange";
      startEpochMs: number | null;
      endEpochMs: number | null;
    }
  | { kind: "not"; inner: PredicateDto };

export type QueryNodeDto =
  | { kind: "leaf"; predicate: PredicateDto }
  | {
      kind: "branch";
      combinator: "and" | "or";
      children: QueryNodeDto[];
    };

export type SearchRequest = { root: QueryNodeDto };

/** The lifted search controller's reactive view (the slice SearchPanel consumes).
 *  When App owns `useSearch` (Task 1 ④a), it passes this down; SearchPanel reads
 *  matches/status/run/cancel from it instead of instantiating its own — so the
 *  SAME controller's matches also flow to VirtualLogView (the search→view loop)
 *  and, in later tasks, to ExportDialog's current-query export. */
export type SearchControllerView = {
  matches: number[];
  status: SearchStatus;
  run: () => Promise<void>;
  cancel: () => void;
};

export type SearchPanelProps = {
  sessionId: string;
  /** Path label for the active session's file (resolved by the caller from
   *  `useSessions`); falls back to sessionId when absent. */
  filePath?: string;
  cap?: number;
  /** Lifted controller from App (controlled mode). When provided, SearchPanel
   *  consumes its matches/status/run/cancel instead of a local useSearch. When
   *  absent, SearchPanel falls back to a local useSearch (standalone/test mode).
   *  The controller registry dedupes by (sessionId, query, cap), so the two
   *  paths never trigger duplicate scans — they resolve to the SAME controller. */
  search?: SearchControllerView;
  /** Lifted query setter from App. SearchPanel calls this with the built query
   *  when the user runs a search (Search click / history ◀▶▾), so App's
   *  `useSearch` keys on the active query. */
  setActiveQuery?: (q: SearchRequest | null) => void;
  /** Called with a matched line number when a result row is clicked, so
   *  MainWindow can mark + scroll VirtualLogView to it (the jump half of the
   *  search→view loop). */
  onJumpToLine?: (line: number) => void;
};

// ---------- pure logic (exported for direct unit testing) ----------

/** Parse "YYYY-MM-DD HH:MM:SS" → epoch ms (local time, matching the Rust side's
 *  `i64` epoch ms). Empty/whitespace/unparseable → null (DTO `Option<i64>`). */
export function parseEpochMs(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // T separator is the ECMAScript date-time form; the space form is non-standard.
  const ms = Date.parse(trimmed.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

/** Build the SearchRequest JSON from the form. Returns null when the form has
 *  no keywords (search requires ≥1 keyword per spec; `useSearch` is then given
 *  a stable sentinel and `run` is never invoked). */
export function buildQuery(form: QueryForm): SearchRequest | null {
  const keywords = form.keywords.map((k) => k.trim()).filter(Boolean);
  if (keywords.length === 0) return null;

  // keyword expression node: single leaf for one keyword, else a branch under
  // the user's combinator.
  const kwLeaves: QueryNodeDto[] = keywords.map((text) => ({
    kind: "leaf",
    predicate: { kind: "text", text },
  }));
  const keywordNode: QueryNodeDto =
    kwLeaves.length === 1
      ? kwLeaves[0]
      : {
          kind: "branch",
          combinator: form.combinator.toLowerCase() as "and" | "or",
          children: kwLeaves,
        };

  // conjunctive filters (level, timeRange) — AND-ed with the keyword expression
  const filters: QueryNodeDto[] = [];
  if (form.levels.length > 0) {
    filters.push({
      kind: "leaf",
      predicate: { kind: "level", levels: [...form.levels] },
    });
  }
  const startMs = parseEpochMs(form.timeRange.start);
  const endMs = parseEpochMs(form.timeRange.end);
  if (startMs !== null || endMs !== null) {
    filters.push({
      kind: "leaf",
      predicate: {
        kind: "timeRange",
        startEpochMs: startMs,
        endEpochMs: endMs,
      },
    });
  }

  const all = [keywordNode, ...filters];
  const root: QueryNodeDto =
    all.length === 1
      ? all[0]
      : { kind: "branch", combinator: "and", children: all };
  return { root };
}

/** The history entry title = the full query (keywords + level + time). Mirrors
 *  the mockup's `refused AND timeout · ERROR,WARN · 14:22–14:23`. */
export function describeQuery(form: QueryForm): string {
  const keywords = form.keywords.map((k) => k.trim()).filter(Boolean);
  const parts: string[] = [];
  if (keywords.length > 0) {
    parts.push(keywords.join(` ${form.combinator} `));
  }
  if (form.levels.length > 0) {
    parts.push(form.levels.join(","));
  }
  const startMs = parseEpochMs(form.timeRange.start);
  const endMs = parseEpochMs(form.timeRange.end);
  if (startMs !== null || endMs !== null) {
    parts.push(`${fmtTime(form.timeRange.start)}–${fmtTime(form.timeRange.end)}`);
  }
  return parts.join(" · ");
}

/** Render a time string down to HH:MM for the compact history title; falls back
 *  to the raw value when it doesn't carry a time portion. */
function fmtTime(s: string): string {
  const t = s.trim();
  // "YYYY-MM-DD HH:MM:SS" → take HH:MM (chars 11..16)
  if (t.length >= 16 && t[10] === " ") return t.slice(11, 16);
  return t || "—";
}

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE", "FATAL"] as const;
const EMPTY_FORM: QueryForm = {
  keywords: [],
  combinator: "AND",
  levels: [],
  timeRange: { start: "", end: "" },
};
/** Stable sentinel for `useSearch` when the form is invalid (no keywords): the
 *  controller stays idle forever (Search disabled → `run` never invoked), so
 *  this is never sent across the wire. Exported so App can pass it as the
 *  `activeQuery` sentinel when no query is active yet (the hooks rule requires
 *  `useSearch` be called unconditionally). */
export const EMPTY_QUERY: SearchRequest = {
  root: { kind: "leaf", predicate: { kind: "text", text: "" } },
};

/** Walk the query tree; return the first `text` predicate's term. Used by App
 *  to derive VirtualLogView's `highlightTerm` (the keyword wrapped in
 *  `<mark class="hit">` inside matched lines) from the active SearchRequest.
 *  "" when there is no text predicate (e.g. a level-only query). */
export function extractHighlightTerm(q: SearchRequest | null): string {
  if (!q) return "";
  return firstText(q.root) ?? "";
}

function firstText(node: QueryNodeDto): string | null {
  if (node.kind === "leaf") {
    const p = node.predicate;
    if (p.kind === "text") return p.text;
    if (p.kind === "not") {
      return firstText({ kind: "leaf", predicate: p.inner });
    }
    return null;
  }
  for (const c of node.children) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
}

export function SearchPanel({
  sessionId,
  filePath,
  cap = 1000,
  search,
  setActiveQuery,
  onJumpToLine,
}: SearchPanelProps): React.ReactElement {
  const [form, setForm] = useState<QueryForm>(EMPTY_FORM);
  const [kwInput, setKwInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = none selected
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lineContent, setLineContent] = useState<string | null>(null);
  // runTick: an explicit "please run now" signal. The effect below fires ONLY on
  // this tick (not on every query/form change), so editing the form doesn't
  // auto-fire searches. Because the effect runs AFTER the render commit, its
  // closure captures the query+run from the LATEST render — so a history click
  // that does setForm(entry.form)+setRunTick() re-renders with the restored
  // query's controller first, then the effect calls THAT controller's run.
  const [runTick, setRunTick] = useState(0);
  const lastRunSig = useRef<string | null>(null); // guards overlapping same-query scans

  // Reset history when the session changes (history is session-scoped, in-memory).
  useEffect(() => {
    setHistory([]);
    setHistoryIndex(-1);
    setHistoryOpen(false);
    setExpanded(false);
    setLineContent(null);
    setForm(EMPTY_FORM);
    lastRunSig.current = null;
  }, [sessionId]);

  const query = buildQuery(form) ?? EMPTY_QUERY;
  // The controller: App's lifted instance when `search` is provided (controlled
  // — the same matches flow to VirtualLogView), else a local useSearch
  // (standalone/test mode). The registry dedupes by (sessionId, query, cap), so
  // the local call in controlled mode resolves to the SAME controller App owns
  // — the two paths never trigger duplicate scans.
  const local = useSearch(sessionId, query, cap);
  const { matches, status, run, cancel } = search ?? local;

  // Fetch the first matching line's content when a file row is expanded, so the
  // expand shows real decoded text (fetched via ③a's `getLines`). A monotonic
  // request id ignores stale fetches from an older match set.
  const lineReq = useRef(0);
  useEffect(() => {
    if (!expanded || matches.length === 0) {
      setLineContent(null);
      return;
    }
    const id = ++lineReq.current;
    getLines(sessionId, matches[0], 1).then((lines) => {
      if (id !== lineReq.current) return;
      setLineContent(lines[0] ?? "");
    });
  }, [sessionId, expanded, matches]);

  // The run trigger. Fires only on an explicit runTick bump (Search click or a
  // history/nav click). Skips an overlapping scan of the EXACT same query that
  // is already running (real concurrency safety). Note: re-running a *done*
  // identical query is passed through (spec: "click → re-run"); the Task-1
  // controller accumulates matches on re-run of the same query — that's a
  // pre-existing Task-1 limitation, not addressed here (see report concerns).
  useEffect(() => {
    if (runTick === 0) return;
    const sig = JSON.stringify(query);
    if (sig === lastRunSig.current && status === "running") return;
    lastRunSig.current = sig;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runTick]);

  const hasKeyword = form.keywords.some((k) => k.trim());

  function pushHistory(f: QueryForm, resultCount: number) {
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      form: {
        ...f,
        keywords: [...f.keywords],
        levels: [...f.levels],
        timeRange: { ...f.timeRange },
      },
      title: describeQuery(f),
      timestamp: Date.now(),
      resultCount,
    };
    // Compute the new entry's index from the current committed history length
    // (the handler runs with the latest render's `history`), then update both
    // pieces of state without nesting one setter inside the other's updater.
    const nextIndex = history.length;
    setHistory((prev) => [...prev, entry]);
    setHistoryIndex(nextIndex);
  }

  function handleSearch() {
    if (!hasKeyword) return;
    pushHistory(form, matches.length);
    setHistoryOpen(false);
    // Lift the built query to App so its useSearch keys on it (the controller
    // whose matches also flow to VirtualLogView). Batched with setRunTick →
    // App re-renders with the new controller before the run effect fires.
    setActiveQuery?.(buildQuery(form));
    setRunTick((t) => t + 1);
  }

  function applyHistory(entry: HistoryEntry) {
    setForm({
      keywords: [...entry.form.keywords],
      combinator: entry.form.combinator,
      levels: [...entry.form.levels],
      timeRange: { ...entry.form.timeRange },
    });
    setHistoryOpen(false);
    setActiveQuery?.(buildQuery(entry.form));
    setRunTick((t) => t + 1);
  }

  function handleSelect(id: string) {
    const idx = history.findIndex((e) => e.id === id);
    if (idx < 0) return;
    setHistoryIndex(idx);
    applyHistory(history[idx]);
  }

  function handleNav(delta: number) {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(0, historyIndex + delta));
    if (next === historyIndex) return;
    setHistoryIndex(next);
    applyHistory(history[next]);
  }

  function handleClear() {
    setHistory([]);
    setHistoryIndex(-1);
    setHistoryOpen(false);
  }

  // ----- form edit helpers -----
  function addKeyword() {
    const v = kwInput.trim();
    if (!v) return;
    setForm((f) => ({ ...f, keywords: [...f.keywords, v] }));
    setKwInput("");
  }
  function removeKeyword(kw: string) {
    setForm((f) => ({ ...f, keywords: f.keywords.filter((x) => x !== kw) }));
  }
  function toggleLevel(l: string) {
    setForm((f) =>
      f.levels.includes(l)
        ? { ...f, levels: f.levels.filter((x) => x !== l) }
        : { ...f, levels: [...f.levels, l] },
    );
  }
  function toggleCombinator() {
    setForm((f) => ({ ...f, combinator: f.combinator === "AND" ? "OR" : "AND" }));
  }

  const currentTitle =
    historyIndex >= 0 && history[historyIndex]
      ? history[historyIndex].title
      : describeQuery(form) || "—";
  const fileCount = matches.length > 0 ? 1 : 0;

  return (
    <section className="sp" aria-label="Search panel">
      <div className="panel-head">
        <span className="eyebrow">Search · 在所有文件中查找</span>
      </div>

      {/* ---- form row ---- */}
      <div className="form" data-testid="search-form">
        <div className="grp">
          <span className="eyebrow" style={{ color: "var(--text-faint)" }}>Keywords</span>
          {form.keywords.map((kw) => (
            <span className="chip kw" key={kw}>
              <span className="kw-text">{kw}</span>
              <button
                className="x"
                aria-label={`Remove keyword ${kw}`}
                onClick={() => removeKeyword(kw)}
              >
                ×
              </button>
            </span>
          ))}
          <button
            className="op"
            aria-label="Combinator"
            onClick={toggleCombinator}
          >
            {form.combinator} ▾
          </button>
          <input
            aria-label="Keyword input"
            className="kw-input"
            value={kwInput}
            placeholder="keyword"
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addKeyword();
            }}
          />
          <button className="add" aria-label="Add keyword" onClick={addKeyword}>
            ＋
          </button>
        </div>
        <span className="vbar" />
        <div className="grp">
          <span className="eyebrow" style={{ color: "var(--text-faint)" }}>Level</span>
          {LEVELS.map((l) => {
            const on = form.levels.includes(l);
            return (
              <button
                key={l}
                className={`lvl${on ? " on" : ""}`}
                aria-pressed={on}
                aria-label={`Level ${l}`}
                onClick={() => toggleLevel(l)}
              >
                {l}
              </button>
            );
          })}
        </div>
        <span className="vbar" />
        <div className="grp">
          <span className="eyebrow" style={{ color: "var(--text-faint)" }}>Time</span>
          <input
            aria-label="Start time"
            className="time-input"
            value={form.timeRange.start}
            placeholder="YYYY-MM-DD HH:MM:SS"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                timeRange: { ...f.timeRange, start: e.target.value },
              }))
            }
          />
          <span style={{ color: "var(--text-faint)" }}>~</span>
          <input
            aria-label="End time"
            className="time-input"
            value={form.timeRange.end}
            placeholder="YYYY-MM-DD HH:MM:SS"
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                timeRange: { ...f.timeRange, end: e.target.value },
              }))
            }
          />
        </div>
        <button
          className="btn-search"
          disabled={!hasKeyword}
          onClick={handleSearch}
        >
          Search
        </button>
        {status === "running" && (
          <button className="btn-cancel" onClick={() => cancel()}>
            Cancel
          </button>
        )}
      </div>

      {/* ---- history nav (◀▶ + ▾ dropdown) ---- */}
      <SearchHistory
        entries={history}
        currentIndex={historyIndex}
        open={historyOpen}
        resultCount={matches.length}
        fileCount={fileCount}
        currentTitle={currentTitle}
        onToggle={() => setHistoryOpen((o) => !o)}
        onSelect={handleSelect}
        onNav={handleNav}
        onClear={handleClear}
      />

      {/* ---- flat results ---- */}
      <div className="results">
        {matches.length === 0 && status === "running" && (
          <div className="sp-empty">搜索中…</div>
        )}
        {matches.length === 0 && status === "done" && (
          <div className="sp-empty">无结果</div>
        )}
        {matches.length === 0 && (status === "idle" || status === "cancelled" || status === "error") && (
          <div className="sp-empty">—</div>
        )}
        {matches.length > 0 && (
          <div>
            <div
              className={`frow${expanded ? " active" : ""}`}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={filePath ?? sessionId}
              onClick={() => setExpanded((e) => !e)}
            >
              <span className="twist">{expanded ? "▾" : "▸"}</span>
              <span className="path">{filePath ?? sessionId}</span>
              <span className="hc">{matches.length} 命中</span>
            </div>
            {expanded && (
              <div className="fsub">
                {lineContent != null && (
                  <div
                    className="mln hit"
                    role={onJumpToLine ? "button" : undefined}
                    tabIndex={onJumpToLine ? 0 : undefined}
                    aria-label={
                      onJumpToLine ? `Jump to line ${matches[0]}` : undefined
                    }
                    onClick={
                      onJumpToLine
                        ? () => onJumpToLine(matches[0])
                        : undefined
                    }
                  >
                    <span className="no">{matches[0]}</span>
                    <span className="msg">{lineContent}</span>
                  </div>
                )}
                {matches.length > 1 && (
                  <div className="more">还有 {matches.length - 1} 行</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
