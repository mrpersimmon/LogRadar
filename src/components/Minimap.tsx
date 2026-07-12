// Minimap — LogRadar's signature "signal trace". A thin vertical strip with a
// centered baseline and one level-colored blip per `levelDistribution` entry,
// positioned at its relative line (`line/totalLines`), plus a teal viewport
// marker (`.sweep`) showing the current `[viewportStart, viewportEnd)` range.
// Ported from the `.trace` element of
// `.superpowers/brainstorm/28981-1783828764/content/premium-redesign.html`
// (vertical baseline + colored level blips + scan-window viewport marker),
// restyled with ③a's premium CSS-variable tokens (no hardcoded colors).
//
// Radar-evocative by design: the blips read as a level signal along the file,
// and the teal sweep is the scan window moving as the user scrolls. When the
// viewport is a tiny fraction of a huge file, the sweep's CSS `min-height`
// keeps it visible (its `top` still tracks the real scroll position).

import "./Minimap.css";

/** Levels mirrored to the theme's level tokens (`--err`/`--warn`/`--info`/
 * `--debug`). `fatal` colors like `err`, `trace` like `debug`. */
export type MinimapLevel =
  | "err"
  | "warn"
  | "info"
  | "debug"
  | "fatal"
  | "trace";

export type MinimapBlip = {
  /** Absolute line number (0-based). Mapped to a vertical % via `line/totalLines`. */
  line: number;
  level: MinimapLevel;
  /** Blip width in px — proportional to the level's density/severity at that
   *  position. Defaults to 8 (the mockup's mid-range width). */
  intensity?: number;
};

export type MinimapProps = {
  /** Per-line level samples; one blip each, colored by `level`. */
  levelDistribution: MinimapBlip[];
  /** First visible line (0-based) of the current viewport. */
  viewportStart: number;
  /** One past the last visible line (0-based, exclusive) of the current viewport. */
  viewportEnd: number;
  /** Total lines in the file. Used to map lines → vertical %. */
  totalLines: number;
};

const DEFAULT_BLIP_WIDTH = 8;

export function Minimap({
  levelDistribution,
  viewportStart,
  viewportEnd,
  totalLines,
}: MinimapProps) {
  const safeTotal = Math.max(1, totalLines);
  // Map an absolute line to a clamped 0..100% vertical position on the strip.
  const pct = (n: number) =>
    `${Math.min(100, Math.max(0, (n / safeTotal) * 100))}%`;

  const sweepTop = pct(viewportStart);
  const sweepHeight = `${Math.max(
    0,
    ((viewportEnd - viewportStart) / safeTotal) * 100,
  )}%`;

  return (
    <div className="trace" aria-label="signal trace minimap" role="img">
      {levelDistribution.map((b, i) => (
        <div
          key={i}
          className={`blip ${b.level}`}
          style={{
            top: pct(b.line),
            width: `${b.intensity ?? DEFAULT_BLIP_WIDTH}px`,
          }}
        />
      ))}
      <div className="sweep" style={{ top: sweepTop, height: sweepHeight }} />
      <div className="trace-label">TRACE</div>
    </div>
  );
}
