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
};

const OVERSCAN = 5; // extra rows above/below the viewport so fast scrolls don't flash blank
const DEFAULT_ROW_HEIGHT = 20;
const FALLBACK_VIEWPORT = 600; // used before layout measures (or in headless jsdom)

// Best-effort parse of a raw log line into {ts, level, message}. The mockup's
// lines look like `14:22:01.003 ERROR DB connection refused`. If the leading
// run doesn't match a timestamp + level, the whole text is the message and no
// pip is rendered.
const TS_RE =
  /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
const LVL_RE = /\b(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/;

function parseLine(raw: string): {
  ts: string | null;
  level: LogLevel | null;
  message: string;
} {
  let rest = raw;
  let ts: string | null = null;
  const tsM = TS_RE.exec(rest);
  if (tsM) {
    ts = tsM[1];
    rest = rest.slice(tsM[0].length).replace(/^\s+/, "");
  }
  let level: LogLevel | null = null;
  let message = rest;
  const lvlM = LVL_RE.exec(rest);
  if (lvlM) {
    level = lvlM[1] as LogLevel;
    const i = lvlM.index;
    // drop the level token (and any space right after it) from the message
    message = (rest.slice(0, i) + rest.slice(i + lvlM[0].length)).replace(
      /^\s+/,
      "",
    );
  }
  return { ts, level, message };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` on the (case-insensitive) `term` and wrap each match in
 * `<mark class="hit">`. Used only for hit lines. */
function HighlightedMessage({
  text,
  term,
}: {
  text: string;
  term?: string;
}): ReactNode {
  if (!term) return <>{text}</>;
  const re = new RegExp(`(${escapeRegex(term)})`, "i");
  const parts = text.split(re);
  const tl = term.toLowerCase();
  return (
    <>
      {parts.map((p, i) =>
        p && p.toLowerCase() === tl ? (
          <mark className="hit" key={i}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function VirtualLogView({
  sessionId,
  totalLines,
  rowHeight = DEFAULT_ROW_HEIGHT,
  hits,
  jumpToLine,
  highlightTerm,
  onJumpToLine,
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
      const { ts, level, message } = parseLine(chunk.lines[i]);
      const isHit = hitSet?.has(n) ?? false;
      const isJump = jumpToLine != null && jumpToLine === n;
      const cls = ["ln", isHit ? "hit" : "", isJump ? "jump" : ""]
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
          {ts != null && <span className="ts">{ts}</span>}
          {level != null && (
            <span className={`lv ${level.toLowerCase()}`}>
              <span className="pip" />
              {level}
            </span>
          )}
          <span className="msg">
            {isHit && highlightTerm ? (
              <HighlightedMessage text={message} term={highlightTerm} />
            ) : (
              message
            )}
          </span>
          {isJump && <span className="tag">← jump target</span>}
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
