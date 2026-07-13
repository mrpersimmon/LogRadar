// VirtualLogView — virtualized log view. A 1M-line session scrolls smoothly
// because we render ONLY the visible window: on scroll, compute the visible
// `[start..end]` from `scrollTop` + `rowHeight`, request
// `getLines(sessionId, start, end-start+1)`, and render just those rows over a
// tall spacer whose height = `totalLines * rowHeight` (so the scrollbar is
// correct). We never request the whole file.
//
// Line rendering (line number / timestamp / level pip / message / hit mark /
// jump-target) is ported from the log-view section of
// `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html` and
// its token-adapted form in `premium-redesign.html`, restyled with ③a's
// premium CSS-variable tokens (no hardcoded colors).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getLines } from "../lib/ipc";
import { JsonInspector } from "./JsonInspector";
import { SyntaxHighlighter } from "./SyntaxHighlighter";
import "./VirtualLogView.css";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "FATAL" | "TRACE";

export type VirtualLogViewProps = {
  sessionId: string;
  totalLines: number;
  /** Fixed height per row in px. The CSS sets each row's height to this same
   * value, so the visible-window math stays exact. Defaults to the mockup's
   * 12px / 1.65 line-height ≈ 20px. */
  rowHeight?: number;
  /** Line numbers that match the active search — rendered with the hit style. */
  hits?: number[];
  /** Line currently marked as the jump target — rendered with the jump style. */
  jumpToLine?: number | null;
  /** Substring to highlight inside each hit line's message (the query term). */
  highlightTerm?: string;
  /** Called with the absolute line number when a row is clicked. */
  onJumpToLine?: (line: number) => void;
  /** Reports the ACTUAL visible viewport (no overscan) as the user scrolls, so
   *  a parent (e.g. MainWindow) can drive a Minimap's viewport marker. Fires
   *  only when the visible window changes (deduped), never on sub-row scrolls.
   *  `[start, end)` is 0-based, end exclusive, clamped to `[0, totalLines]`. */
  onViewportChange?: (start: number, end: number) => void;
};

const OVERSCAN = 5; // extra rows above/below the viewport so fast scrolls don't flash blank
const DEFAULT_ROW_HEIGHT = 20;
const FALLBACK_VIEWPORT = 600; // used before layout measures (or in headless jsdom)

// Line-token parsing (timestamp / level pip / message + hit-term highlight) is
// shared with SearchPanel/ExportDialog via `SyntaxHighlighter` — VirtualLogView
// renders that component per row instead of reimplementing the parser, so the
// token-coloring rules live in ONE place (SyntaxHighlighter.tsx/.css).

/** Best-effort detect+extract of a JSON object/array in a raw log line, for the
 *  ▸展开JSON affordance (spec C5). Tries the whole line first (pure-JSON
 *  structured logs like `{"event":"x"}`); if that fails, tries the substring
 *  from the first `{`/`[` onward (for prefixed lines like
 *  `14:22:01 ERROR {"event":"x"}`). Returns the parseable substring if the
 *  parsed value is a non-null object (object/array — excludes bare
 *  primitives, which aren't "structured logs"); else null. The returned string
 *  is what JsonInspector re-parses + renders as a tree. */
function extractJson(raw: string): string | null {
  const candidates: string[] = [raw];
  const braceIdx = raw.search(/[{[]/);
  if (braceIdx > 0) candidates.push(raw.slice(braceIdx));
  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      if (data !== null && typeof data === "object") return c;
    } catch {
      /* not JSON — try next candidate */
    }
  }
  return null;
}

export function VirtualLogView({
  sessionId,
  totalLines,
  rowHeight = DEFAULT_ROW_HEIGHT,
  hits,
  jumpToLine,
  highlightTerm,
  onJumpToLine,
  onViewportChange,
}: VirtualLogViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The visible window we are asking `getLines` for. `count` is 0 until the
  // first layout measure, which suppresses the initial request until we know
  // a real viewport height.
  const [win, setWin] = useState<{ start: number; count: number }>({
    start: 0,
    count: 0,
  });
  // The most recently loaded chunk. Lines render from chunk.start upward.
  const [chunk, setChunk] = useState<{ start: number; lines: string[] } | null>(
    null,
  );
  // Monotonic request id: a late-resolving getLines from an older scroll is
  // ignored so stale chunks never overwrite the current view.
  const reqId = useRef(0);
  // Last visible viewport reported to the parent via `onViewportChange`, so a
  // sub-row scroll (same visible window) doesn't re-fire the callback.
  const lastVp = useRef<{ s: number; e: number }>({ s: -1, e: -1 });
  // Set of absolute line numbers whose ▸展开JSON affordance is currently
  // expanded (showing an inline JsonInspector beneath the line). Keyed by
  // absolute line number so an expansion survives scroll re-renders: a row
  // unmounts when it leaves the viewport, but `expanded.has(n)` stays true, so
  // scrolling back re-renders the JsonInspector without losing fold state.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggleJson = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const hitSet = hits ? new Set(hits) : null;
  const pad = Math.max(6, String(Math.max(0, totalLines - 1)).length);

  const recompute = (scrollTop: number, vh: number) => {
    const rawStart = Math.floor(scrollTop / rowHeight);
    const start = Math.max(0, rawStart - OVERSCAN);
    const end = Math.min(
      totalLines,
      rawStart + Math.ceil(vh / rowHeight) + OVERSCAN,
    );
    const count = Math.max(0, end - start);
    setWin((prev) =>
      prev.start === start && prev.count === count ? prev : { start, count },
    );
    // Report the ACTUAL visible viewport (no overscan) so the Minimap's sweep
    // reflects what the user sees, not the overscanned fetch window. Deduped.
    const vpStart = Math.max(0, rawStart);
    const vpEnd = Math.min(totalLines, rawStart + Math.ceil(vh / rowHeight));
    if (lastVp.current.s !== vpStart || lastVp.current.e !== vpEnd) {
      lastVp.current = { s: vpStart, e: vpEnd };
      onViewportChange?.(vpStart, vpEnd);
    }
  };

  // Measure on mount + when totalLines/rowHeight change; recompute on scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recompute(el.scrollTop, el.clientHeight || FALLBACK_VIEWPORT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLines, rowHeight]);

  useEffect(() => {
    if (win.count <= 0) return;
    const id = ++reqId.current;
    getLines(sessionId, win.start, win.count).then((lines) => {
      if (id !== reqId.current) return; // a newer scroll superseded this request
      setChunk({ start: win.start, lines });
    });
  }, [sessionId, win.start, win.count]);

  const totalH = totalLines * rowHeight;
  const rowsTop = (chunk?.start ?? 0) * rowHeight;

  const rows: ReactNode[] = [];
  if (chunk) {
    for (let i = 0; i < chunk.lines.length; i++) {
      const n = chunk.start + i;
      const raw = chunk.lines[i];
      const isHit = hitSet?.has(n) ?? false;
      const isJump = jumpToLine != null && jumpToLine === n;
      // ▸展开JSON affordance: only on lines whose JSON parses to an object/array.
      const jsonSrc = extractJson(raw);
      const isJson = jsonSrc !== null;
      const isOpen = expanded.has(n);
      const cls = [
        "ln",
        isHit ? "hit" : "",
        isJump ? "jump" : "",
        isJson ? "has-json" : "",
        isOpen ? "ln-expanded" : "",
      ]
        .filter(Boolean)
        .join(" ");
      rows.push(
        <div
          key={n}
          data-line={n}
          className={cls}
          style={{ height: rowHeight }}
          onClick={onJumpToLine ? () => onJumpToLine(n) : undefined}
        >
          <span className="no">
            {isJump ? "▸" : ""}
            {String(n).padStart(pad, "0")}
          </span>
          <SyntaxHighlighter
            line={raw}
            hits={isHit && highlightTerm ? [highlightTerm] : []}
          />
          {isJump && <span className="tag">← jump target</span>}
          {isJson && (
            <span
              className="json-toggle"
              data-testid="json-toggle"
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "收起" : "展开"}JSON line ${n}`}
              onClick={(e) => {
                // stopPropagation: the row's onClick jumps to the line; the
                // affordance toggles the inline tree and must not also jump.
                e.stopPropagation();
                toggleJson(n);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleJson(n);
                }
              }}
            >
              {isOpen ? "▾收起JSON" : "▸展开JSON"}
            </span>
          )}
          {isOpen && jsonSrc != null && (
            <div
              className="ln-json"
              data-line-json={n}
              // stopPropagation: clicks inside the tree (e.g. on a nested
              // ▾/▸ twist) must not bubble up to the row's onClick (jump to
              // line). The tree manages its own fold state independently.
              onClick={(e) => e.stopPropagation()}
            >
              <JsonInspector
                line={jsonSrc}
                hits={highlightTerm ? [highlightTerm] : []}
              />
            </div>
          )}
        </div>,
      );
    }
  }

  return (
    <section className="log-view" aria-label="Log view">
      <div
        ref={scrollRef}
        data-testid="log-viewport"
        className="log-viewport"
        onScroll={(e) => {
          const el = e.currentTarget;
          recompute(el.scrollTop, el.clientHeight || FALLBACK_VIEWPORT);
        }}
      >
        <div data-testid="log-spacer" className="log-spacer" style={{ height: totalH }}>
          <div className="log-rows" style={{ top: rowsTop }}>
            {rows}
          </div>
        </div>
      </div>
    </section>
  );
}
