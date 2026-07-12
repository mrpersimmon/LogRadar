// SplitView (Task 8 ③b) — two-pane time-synced compare. Ports the layout from
// `.superpowers/brainstorm/28981-1783828764/content/split-view-v3.html`: two
// `VirtualLogView` panes flanking a center time-sync gutter, a `同滚` (sync)
// toggle, a `容差` (tolerance) input + presets, a `对齐` mode (最近 nearest /
// 向前 forward), and a Δ indicator that is teal when the panes' top-line
// timestamp delta is within tolerance and amber (超差) when it exceeds it.
//
// SCROLL-SPY TIME-SYNC (v1 — frontend scroll-spy; the core's FormatDetector
// time-normalized matching is a ④ refinement). Sync is one-directional:
// scrolling the LEFT pane drives the RIGHT pane. On the left's
// `onViewportChange(start)`, SplitView fetches the left's top visible line via
// `getLines` and parses its timestamp (a simple regex for common log TS
// formats — `HH:MM:SS.mmm` and ISO `YYYY-MM-DD HH:MM:SS.mmm`). It then
// estimates a proportional line in the right pane
// (`rEst = start / leftTotal * rightTotal`), fetches a bounded ±50-line window
// around it, parses each window line's timestamp, and picks the nearest (or
// earliest-later, per `对齐`) to the left's timestamp — NOT a full-file index,
// so even a 1M-line pane stays bounded to one windowed `getLines` per left
// scroll. It then sets the right pane's viewport `scrollTop` to that line
// (driving VirtualLogView's own scroll → it fetches + renders the new window).
// Δ is always `rightTop.ms − leftTop.ms` (signed); tolerance compares |Δ|.
//
// The right pane's `onViewportChange` only updates the right top-line readout
// (it never drives the left), so there is no feedback loop.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionsApi } from "../hooks/useSessions";
import { getLines } from "../lib/ipc";
import { VirtualLogView } from "../components/VirtualLogView";
import "./SplitView.css";

export type SplitViewProps = {
  /** The single `useSessions()` instance (shared with MainWindow) — resolves
   *  each sessionId → its `SessionMeta` (lineCount + path), which
   *  `VirtualLogView` needs. */
  sessions: SessionsApi;
  leftSessionId: string;
  rightSessionId: string;
  /** Fixed row height in px (must match VirtualLogView's row rendering).
   *  Defaults to 20 — the mockup's 12px/1.65 line-height ≈ 20px. */
  rowHeight?: number;
};

type TopLine = { line: number; ms: number; ts: string } | null;
type AlignMode = "nearest" | "forward";
type TimeMode = "day" | "iso";

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_TOL_MS = 1000; // 1s
const TOL_PRESETS = [
  { label: "1ms", ms: 1 },
  { label: "10ms", ms: 10 },
  { label: "100ms", ms: 100 },
  { label: "1s", ms: 1000 },
  { label: "5s", ms: 5000 },
];
const HALF_WINDOW = 50; // ±50 lines scanned around the proportional estimate
const TICK_COUNT = 5;

// Common log timestamp formats: `14:22:01.003` and ISO `2026-07-13T14:22:01.003`
// (the leading run of the line). Same regex family as VirtualLogView's parser.
const TS_RE =
  /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

function tsToMs(ts: string): number | null {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(ts);
  if (iso) {
    const str = `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}${
      iso[7] ? "." + iso[7] : ""
    }`;
    const t = Date.parse(str);
    return Number.isNaN(t) ? null : t;
  }
  const day = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(ts);
  if (!day) return null;
  let ms =
    Number(day[1]) * 3600000 + Number(day[2]) * 60000 + Number(day[3]) * 1000;
  if (day[4]) ms += Number(day[4].slice(0, 3).padEnd(3, "0")); // .3→300, .03→30, .003→3
  return ms;
}

/** Parse a raw log line's leading timestamp → {ms, ts}. `ts` is the verbatim
 *  matched string (for the marker's L/R chips); `ms` is for Δ + matching. */
function parseLineTs(line: string): { ms: number; ts: string } | null {
  const m = TS_RE.exec(line);
  if (!m) return null;
  const ms = tsToMs(m[1]);
  if (ms == null || Number.isNaN(ms)) return null;
  return { ms, ts: m[1] };
}

function isIsoTs(ts: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(ts);
}

/** Format day-relative ms (within one day) back to `HH:MM:SS.mmm`. */
function msToDayTs(ms: number): string {
  const h = Math.floor(ms / 3600000) % 24;
  const mi = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const mmm = Math.floor(ms % 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(mi)}:${p(s)}.${p(mmm, 3)}`;
}

function msToTs(ms: number, mode: TimeMode): string {
  if (mode === "iso") return new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  return msToDayTs(ms);
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dirName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

export function SplitView({
  sessions,
  leftSessionId,
  rightSessionId,
  rowHeight = DEFAULT_ROW_HEIGHT,
}: SplitViewProps) {
  const { sessions: map } = sessions;
  const leftMeta = map.get(leftSessionId) ?? null;
  const rightMeta = map.get(rightSessionId) ?? null;

  const [syncOn, setSyncOn] = useState(true);
  const [tolMs, setTolMs] = useState(DEFAULT_TOL_MS);
  const [alignMode, setAlignMode] = useState<AlignMode>("nearest");
  const [leftTop, setLeftTop] = useState<TopLine>(null);
  const [rightTop, setRightTop] = useState<TopLine>(null);
  // The left pane's [first..last] timestamp span — drives the gutter's tick
  // labels. Fetched once (2 getLines calls) on mount / when the left session
  // changes. Null until it resolves → ticks render unlabeled.
  const [span, setSpan] = useState<{
    firstMs: number;
    lastMs: number;
    mode: TimeMode;
  } | null>(null);

  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  // Monotonic request ids so a slow left-scroll fetch (and its window-scan
  // continuation) is abandoned when a newer scroll supersedes it — stale data
  // never overwrites the current Δ / drives the right pane to an old line.
  const spyReqId = useRef(0);
  const spanReqId = useRef(0);

  // Resolve left + right top lines when the left pane's visible window moves.
  // Driving the right pane only happens when syncOn is on.
  const onLeftViewport = useCallback(
    (start: number, _end: number) => {
      const id = ++spyReqId.current;
      void (async () => {
        if (!leftMeta) return;
        const llines = await getLines(leftSessionId, start, 1);
        if (id !== spyReqId.current) return; // superseded
        const lp = parseLineTs(llines[0]);
        setLeftTop(
          lp
            ? { line: start, ms: lp.ms, ts: lp.ts }
            : { line: start, ms: NaN, ts: "—" },
        );
        if (!syncOn || !rightMeta) return; // sync cancelled / no right pane
        // Proportional estimate → bounded ±HALF_WINDOW scan of the right pane.
        const rEst = Math.round(
          (start / Math.max(1, leftMeta.lineCount)) * rightMeta.lineCount,
        );
        const rStart = Math.max(0, rEst - HALF_WINDOW);
        const rCount = Math.min(
          rightMeta.lineCount - rStart,
          HALF_WINDOW * 2 + 1,
        );
        if (rCount <= 0) return;
        const rlines = await getLines(rightSessionId, rStart, rCount);
        if (id !== spyReqId.current) return; // superseded
        const tL = lp?.ms;
        if (tL == null) return;
        let nearest: { line: number; ms: number } | null = null;
        let fwd: { line: number; ms: number } | null = null;
        for (let i = 0; i < rlines.length; i++) {
          const rp = parseLineTs(rlines[i]);
          if (!rp) continue;
          const line = rStart + i;
          if (!nearest || Math.abs(rp.ms - tL) < Math.abs(nearest.ms - tL))
            nearest = { line, ms: rp.ms };
          if (rp.ms >= tL && (!fwd || rp.ms < fwd.ms)) fwd = { line, ms: rp.ms };
        }
        const pick = alignMode === "forward" ? fwd ?? nearest : nearest;
        if (!pick) return;
        // Drive the right pane: set its viewport scrollTop; in a real browser
        // VirtualLogView's onScroll fires → it fetches + renders the new window
        // and onViewportChange updates rightTop. (jsdom fires no scroll event
        // from programmatic scrollTop, so rightTop is updated by the right
        // pane's own mount viewport report — the drive is proven end-to-end in
        // ③b/④, not unit-tested here per the brief.)
        const vp = rightPaneRef.current?.querySelector(
          '[data-testid="log-viewport"]',
        ) as HTMLElement | null;
        if (vp) vp.scrollTop = pick.line * rowHeight;
      })();
    },
    [leftMeta, rightMeta, leftSessionId, rightSessionId, syncOn, alignMode, rowHeight],
  );

  // The right pane NEVER drives the left — it only reports its top-line
  // timestamp so the marker's R chip + Δ reflect what the right is showing.
  const onRightViewport = useCallback(
    (start: number, _end: number) => {
      void (async () => {
        if (!rightMeta) return;
        const lines = await getLines(rightSessionId, start, 1);
        const rp = parseLineTs(lines[0]);
        setRightTop(
          rp
            ? { line: start, ms: rp.ms, ts: rp.ts }
            : { line: start, ms: NaN, ts: "—" },
        );
      })();
    },
    [rightMeta, rightSessionId],
  );

  // Fetch the left pane's first + last line timestamps to label the gutter's
  // time axis. Bounded to 2 getLines calls; skipped entirely if the line
  // content has no parseable timestamp.
  useEffect(() => {
    if (!leftMeta) {
      setSpan(null);
      return;
    }
    const id = ++spanReqId.current;
    let cancelled = false;
    void (async () => {
      const first = await getLines(leftSessionId, 0, 1);
      const lastIdx = Math.max(0, leftMeta.lineCount - 1);
      const last = await getLines(leftSessionId, lastIdx, 1);
      if (cancelled || id !== spanReqId.current) return;
      const fp = parseLineTs(first[0]);
      const lp = parseLineTs(last[0]);
      if (!fp || !lp) {
        setSpan(null);
        return;
      }
      setSpan({
        firstMs: fp.ms,
        lastMs: lp.ms,
        mode: isIsoTs(fp.ts) ? "iso" : "day",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [leftMeta, leftSessionId]);

  // Δ (signed): rightTop − leftTop. Tolerance compares the absolute delta.
  const deltaMs =
    leftTop && rightTop && !Number.isNaN(leftTop.ms) && !Number.isNaN(rightTop.ms)
      ? rightTop.ms - leftTop.ms
      : null;
  const over = deltaMs != null && Math.abs(deltaMs) > tolMs;
  const markerTopPct =
    leftTop && leftMeta
      ? Math.max(
          0,
          Math.min(100, (leftTop.line / Math.max(1, leftMeta.lineCount)) * 100),
        )
      : 50;

  const ticks: { pct: number; label: string | null }[] = [];
  if (span) {
    for (let i = 0; i < TICK_COUNT; i++) {
      const f = i / (TICK_COUNT - 1);
      ticks.push({
        pct: 10 + f * 80, // spread ticks across the 10%–90% band
        label: msToTs(span.firstMs + f * (span.lastMs - span.firstMs), span.mode),
      });
    }
  } else {
    for (let i = 0; i < TICK_COUNT; i++)
      ticks.push({ pct: 10 + (i / (TICK_COUNT - 1)) * 80, label: null });
  }

  return (
    <div className="sv" aria-label="Split compare">
      <div className="sv-tool">
        <span
          className={`sv-sync-toggle${syncOn ? " on" : ""}`}
          role="switch"
          aria-checked={syncOn}
          tabIndex={0}
          onClick={() => setSyncOn((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              setSyncOn((v) => !v);
            }
          }}
        >
          <span className="sv-sw" />
          同滚
        </span>

        <label className="sv-align">
          对齐
          <select
            value={alignMode}
            onChange={(e) => setAlignMode(e.target.value as AlignMode)}
          >
            <option value="nearest">最近</option>
            <option value="forward">向前</option>
          </select>
        </label>

        <span className={`sv-tol${over ? " over" : ""}`}>
          容差
          <input
            className="sv-tol-input"
            type="number"
            min={1}
            step={1}
            value={tolMs}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1) setTolMs(Math.floor(v));
            }}
          />
          <span className="sv-tol-unit">ms</span>
        </span>

        <span className="sv-presets">
          {TOL_PRESETS.map((p) => (
            <button
              key={p.label}
              className={`sv-preset${tolMs === p.ms ? " active" : ""}`}
              onClick={() => setTolMs(p.ms)}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </span>
      </div>

      <div className="sv-panes">
        <div className="sv-pane" ref={leftPaneRef}>
          <PaneHead meta={leftMeta} side="L" />
          {leftMeta ? (
            <VirtualLogView
              sessionId={leftMeta.sessionId}
              totalLines={leftMeta.lineCount}
              rowHeight={rowHeight}
              onViewportChange={onLeftViewport}
            />
          ) : (
            <div className="sv-pane-empty">left session not open</div>
          )}
        </div>

        <div className="sv-gutter" aria-hidden>
          <div className="sv-gutter-axis" />
          {ticks.map((t, i) => (
            <div
              key={i}
              className="sv-gtick"
              style={{ top: `${t.pct}%` }}
            >
              {t.label ?? ""}
            </div>
          ))}
          <div
            className="sv-marker"
            style={{ top: `${markerTopPct}%` }}
          >
            <div className={`sv-dot${over ? " over" : " within"}`} />
            <div className="sv-times">
              <div className="sv-t">
                <span className="sv-lbl">L</span>
                {leftTop?.ts ?? "—"}
              </div>
              <div className="sv-t">
                <span className="sv-lbl">R</span>
                {rightTop?.ts ?? "—"}
              </div>
            </div>
            <div
              className={`sv-delta${over ? " over" : " within"}`}
            >
              {deltaMs != null
                ? `Δ${deltaMs >= 0 ? "+" : ""}${deltaMs}ms`
                : "Δ—"}
            </div>
          </div>
        </div>

        <div className="sv-pane" ref={rightPaneRef}>
          <PaneHead meta={rightMeta} side="R" />
          {rightMeta ? (
            <VirtualLogView
              sessionId={rightMeta.sessionId}
              totalLines={rightMeta.lineCount}
              rowHeight={rowHeight}
              onViewportChange={onRightViewport}
            />
          ) : (
            <div className="sv-pane-empty">right session not open</div>
          )}
        </div>
      </div>

      <footer className="sv-status">
        <span>2 文件 · 分屏对比</span>
        {leftTop && rightMeta && (
          <span className={`sv-status-delta${over ? " over" : " within"}`}>
            同滚 · {over ? "超出容差" : "容差内"}{" "}
            {deltaMs != null
              ? `Δ${deltaMs >= 0 ? "+" : ""}${deltaMs}ms`
              : ""}
            {over ? ` > ${tolMs}ms` : ""}
          </span>
        )}
      </footer>
    </div>
  );
}

function PaneHead({
  meta,
  side,
}: {
  meta: { path: string; lineCount: number; encoding: string } | null;
  side: "L" | "R";
}) {
  if (!meta) return <div className="sv-pane-head" />;
  const d = dirName(meta.path);
  return (
    <div className="sv-pane-head">
      <span className="sv-side">{side}</span>
      <span className="sv-path">
        {d && <span className="sv-dim">{d}/</span>}
        {basename(meta.path)}
      </span>
      <span className="sv-cnt">{meta.lineCount.toLocaleString()} 行</span>
      <span className="sv-enc">{meta.encoding}</span>
    </div>
  );
}
