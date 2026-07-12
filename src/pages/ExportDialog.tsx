// ExportDialog (Task 10 ③b) — modal over a dimmed backdrop. Lets the user pick
// an export range (segmented: current-query / current-file / selection / all
// open files), a format (raw / CSV / JSON Lines / custom template), which
// columns to include (checkboxes), and a target (file path + choose, or copy
// to clipboard). A live preview re-renders to reflect the chosen columns, and
// the footer shows a row + size estimate. Export → `exportFile` IPC.
//
// Visual structure ported from
// `.superpowers/brainstorm/28981-1783828764/content/export.html` (modal /
// mhead / mbody / field / seg / checks / chk / target / opt / pathrow / preview
// / prog / mfoot / btn), restyled with ③a's premium CSS-variable tokens.

import { useState } from "react";
import { exportFile } from "../lib/ipc";
import type { SearchRequest } from "../components/SearchPanel";
import "./ExportDialog.css";

export type ExportRange = "current-query" | "current-file" | "selection" | "all";
export type ExportFormat = "raw" | "csv" | "jsonl" | "template";
export type ExportColumn =
  | "lineNumber"
  | "timestamp"
  | "filePath"
  | "level"
  | "message";
export type ExportTarget = "file" | "clipboard";

export type ExportDialogProps = {
  /** Active log session the export applies to. */
  sessionId: string;
  /** The lifted active query from App (Task 1 ④a). The "current-query" range
   *  forwards this — a valid SearchRequest the Rust `export` command
   *  deserializes — instead of the match-all sentinel. null/undefined until
   *  SearchPanel commits a query; then the range falls back to match-all. */
  activeQuery?: SearchRequest | null;
  /** Close affordance (✕ / Cancel). */
  onClose?: () => void;
};

// Task 2 (④a): the lift (T1) put `activeQuery` at App → ExportDialog receives
// it as a prop, so the "current-query" range is now ENABLED (was disabled in
// ③b-fix because the active query wasn't reachable here). Selecting it sends
// the lifted `activeQuery` (a valid SearchRequest) — see `onExport` below.
type RangeOption = {
  value: ExportRange;
  label: string;
  disabled?: boolean;
  title?: string;
};

const RANGES: RangeOption[] = [
  { value: "current-query", label: "Current query" },
  { value: "current-file", label: "Current file" },
  { value: "selection", label: "Selection" },
  { value: "all", label: "All open files" },
];

// I2: `exportFile`'s 2nd arg is the `query` the Rust `export` command
// deserializes into `SearchRequest` (requires `{root: QueryNodeDto}` — see
// src-tauri/src/commands.rs). Pre-fix the dialog sent `{range, format}` which
// has no `root` → serde_json::from_value fails → export always errored. For
// the ranges that don't need the active query (current-file / selection /
// all) send a match-all SearchRequest — empty text matches every line via
// `line.contains("")`. The "current-query" range sends the lifted `activeQuery`
// (Task 2 ④a); match-all is also the fallback when no query is committed yet.
const MATCH_ALL_QUERY: SearchRequest = {
  root: { kind: "leaf", predicate: { kind: "text", text: "" } },
};

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "raw", label: "Raw" },
  { value: "csv", label: "CSV" },
  { value: "jsonl", label: "JSON Lines" },
  { value: "template", label: "Template…" },
];

const COLUMNS: { value: ExportColumn; label: string }[] = [
  { value: "lineNumber", label: "Line no." },
  { value: "timestamp", label: "Timestamp" },
  { value: "filePath", label: "File path" },
  { value: "level", label: "Level" },
  { value: "message", label: "Message" },
];

// Sample preview rows (mirroring the mockup's three ERROR lines) so the preview
// reflects column toggles even before any real data is fetched.
const PREVIEW_ROWS = [
  {
    no: "000124",
    ts: "14:22:01.003",
    path: "logs/auth/a.log",
    level: "ERROR",
    msg: "DB connection refused",
  },
  {
    no: "000231",
    ts: "14:25:40.118",
    path: "logs/auth/a.log",
    level: "ERROR",
    msg: "conn pool refused",
  },
  {
    no: "000411",
    ts: "14:22:01.020",
    path: "logs/api/c.log",
    level: "ERROR",
    msg: "gateway upstream refused",
  },
];

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ExportDialog({ sessionId, activeQuery, onClose }: ExportDialogProps) {
  // Default range is "current-file"; "current-query" is now selectable (re-enabled
  // in Task 2 ④a) and sends the lifted `activeQuery` when chosen.
  const [range, setRange] = useState<ExportRange>("current-file");
  const [format, setFormat] = useState<ExportFormat>("raw");
  const [cols, setCols] = useState<Record<ExportColumn, boolean>>({
    lineNumber: true,
    timestamp: true,
    filePath: true,
    level: true,
    message: true,
  });
  const [target, setTarget] = useState<ExportTarget>("file");
  const [path, setPath] = useState(
    `~/Downloads/logradar-export-${todayStamp()}.log`,
  );
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Static demo estimate (real per-range row count + bytes arrive from the
  // core's export preview in ④; here it tracks the selected range so the UI
  // is honest about magnitude).
  const estRows = range === "all" ? 4812 : range === "selection" ? 18 : 1204;
  const estKb = Math.max(1, Math.round((estRows * 32) / 1024));

  function toggleColumn(c: ExportColumn) {
    setCols((prev) => ({ ...prev, [c]: !prev[c] }));
  }

  const selectedColumns: ExportColumn[] = COLUMNS.filter(
    (c) => cols[c.value],
  ).map((c) => c.value);

  async function onExport() {
    setErr(null);
    const targetStr = target === "file" ? path : "clipboard";
    setExporting(true);
    try {
      // Task 2 (④a): send a VALID SearchRequest ({root:{...}}) the Rust `export`
      // command can deserialize. The "current-query" range forwards the lifted
      // `activeQuery` (the exact SearchRequest SearchPanel committed — keywords
      // + level + time + excludes as the QueryNodeDto tree); the other ranges
      // (current-file / selection / all) send the match-all sentinel (empty text
      // matches every line via line.contains("")). When no query is committed
      // yet (activeQuery null), current-query also falls back to match-all —
      // an empty query matches all lines, so never an invalid payload.
      const query =
        range === "current-query" && activeQuery ? activeQuery : MATCH_ALL_QUERY;
      const written = await exportFile(
        sessionId,
        query,
        selectedColumns,
        targetStr,
      );
      setDone(written);
    } catch (e) {
      setErr(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="ed-scrim" onClick={onClose}>
      <div
        className="ed-modal"
        role="dialog"
        aria-label="Export"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ed-mhead">
          <span className="ed-eyebrow">Export</span>
          <button
            className="ed-x"
            aria-label="Close export dialog"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="ed-mbody">
          {/* range */}
          <div className="ed-field">
            <span className="ed-lbl">Range</span>
            <div className="ed-seg" role="group" aria-label="Export range">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  className={`ed-seg-btn${range === r.value ? " on" : ""}`}
                  aria-pressed={range === r.value}
                  disabled={r.disabled}
                  title={r.title}
                  onClick={() => setRange(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* format */}
          <div className="ed-field">
            <span className="ed-lbl">Format</span>
            <div className="ed-seg" role="group" aria-label="Export format">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  className={`ed-seg-btn${format === f.value ? " on" : ""}`}
                  aria-pressed={format === f.value}
                  onClick={() => setFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* columns */}
          <div className="ed-field">
            <span className="ed-lbl">Columns</span>
            <div className="ed-checks">
              {COLUMNS.map((c) => (
                <button
                  key={c.value}
                  className={`ed-chk${cols[c.value] ? " on" : ""}`}
                  role="checkbox"
                  aria-checked={cols[c.value]}
                  aria-label={c.label}
                  onClick={() => toggleColumn(c.value)}
                >
                  <span className="ed-box" aria-hidden>
                    {cols[c.value] ? "✓" : ""}
                  </span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* target */}
          <div className="ed-field">
            <span className="ed-lbl">Target</span>
            <div className="ed-target">
              <button
                className={`ed-opt${target === "file" ? " on" : ""}`}
                role="radio"
                aria-checked={target === "file"}
                aria-label="Save to file"
                onClick={() => setTarget("file")}
              >
                <span className="ed-radio" aria-hidden />
                Save to file
              </button>
              <div className="ed-pathrow">
                <input
                  className="ed-path"
                  role="textbox"
                  aria-label="Export path"
                  value={path}
                  disabled={target !== "file"}
                  onChange={(e) => setPath(e.target.value)}
                />
                <span className="ed-pick">Choose…</span>
              </div>
              <button
                className={`ed-opt${target === "clipboard" ? " on" : ""}`}
                role="radio"
                aria-checked={target === "clipboard"}
                aria-label="Copy to clipboard"
                onClick={() => setTarget("clipboard")}
              >
                <span className="ed-radio" aria-hidden />
                Copy to clipboard
              </button>
            </div>
          </div>

          {/* preview */}
          <div className="ed-field">
            <span className="ed-lbl">Preview</span>
            <div className="ed-preview" data-testid="export-preview">
              {PREVIEW_ROWS.map((row, i) => (
                <div className="ed-pln" key={i}>
                  {cols.lineNumber && (
                    <span className="ed-no">{row.no}</span>
                  )}
                  {cols.timestamp && <span className="ed-ts">{row.ts}</span>}
                  {cols.filePath && (
                    <span className="ed-p">{row.path}</span>
                  )}
                  {cols.level && (
                    <span className="ed-lv">{row.level}</span>
                  )}
                  {cols.message && <span className="ed-msg">{row.msg}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* progress slot (visible while exporting large results) */}
        <div
          className={`ed-prog${exporting ? " show" : ""}`}
          aria-hidden={!exporting}
        >
          <div className="ed-progbar">
            <i style={{ width: exporting ? "60%" : "0%" }} />
          </div>
          <div className="ed-progmeta">
            <span>
              exporting <b>{estRows.toLocaleString()}</b> / {estRows.toLocaleString()} rows
            </span>
            <span>est. 0s</span>
          </div>
        </div>

        <div className="ed-mfoot" data-testid="export-footer">
          <span className="ed-est">
            est. <b>{estRows.toLocaleString()}</b> rows · <b>~{estKb} KB</b>
          </span>
          <span className="ed-hint">
            large results show a progress bar and can be cancelled
          </span>
          <span className="ed-sp" />
          {err && <span className="ed-err">{err}</span>}
          {done != null && (
            <span className="ed-done">wrote {done.toLocaleString()} rows</span>
          )}
          <button className="ed-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ed-btn ed-primary"
            onClick={onExport}
            disabled={exporting || selectedColumns.length === 0}
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
