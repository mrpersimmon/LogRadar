// ExtractProgress (Task 9) — small status widget shown while `openArchive`
// streams `ExtractProgress` events from the Rust `extract_archive` command.
// Renders a determinate progress bar (done/total) plus the current file name
// being extracted, so the user sees the extract advancing rather than a blank
// hang. The `ep-` class prefix scopes the styles (defined inline here so the
// widget is self-contained; no shared CSS file dependency).
//
// State contract: `total === 0` means the backend hasn't reported a total yet
// (the first `file` event usually carries the real total) → bar renders at 0%
// rather than div-by-zero. `currentFile` may be empty before the first file
// event lands; we still show `done/total` so the bar is informative.
//
// role="status" + aria-label makes the progress announceable to assistive
// tech; the bar is decorative (aria-hidden via the visible-only fill) since
// the text span already conveys the same numbers.

export function ExtractProgress({
  done,
  total,
  currentFile,
}: {
  done: number;
  total: number;
  currentFile: string;
}) {
  const pct = total ? (done / total) * 100 : 0;
  return (
    <div className="ep" role="status" aria-label="extract progress">
      <div className="ep-bar" aria-hidden>
        <div className="ep-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ep-text">
        {done}/{total}
        {currentFile ? ` · ${currentFile}` : ""}
      </span>
      <style>{`
.ep {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--border-soft, #2a2a2a);
  border-radius: 10px;
  background: var(--surface, #141414);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-dim, #999);
}
.ep-bar {
  position: relative;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-2, #1e1e1e);
  overflow: hidden;
}
.ep-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--scan, #3b82f6);
  transition: width 0.15s ease-out;
}
.ep-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`}</style>
    </div>
  );
}
