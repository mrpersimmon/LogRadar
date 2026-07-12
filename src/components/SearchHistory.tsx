// SearchHistory — the history nav row (◀ ▶ + a ▾ dropdown listing past
// searches). Presentational: the parent (SearchPanel) owns the history state
// and passes entries + callbacks. EACH ENTRY'S TITLE = the full query
// (keywords + level + time), so the dropdown reads like the mockup's
// `refused AND timeout · ERROR,WARN · 14:22–14:23`. Clicking an entry →
// onSelect(id); ◀/▶ → onNav(±1); the chip → onToggle; "清空" → onClear.
//
// Ported from main-window-v7.html's navrow + history dropdown (and its
// token-adapted form in premium-redesign.html), restyled with premium tokens.

import type { HistoryEntry } from "./SearchPanel";
import "./SearchPanel.css";

export type { HistoryEntry } from "./SearchPanel";

export type SearchHistoryProps = {
  entries: HistoryEntry[];
  /** Index of the currently-selected entry, or -1 if none. */
  currentIndex: number;
  open: boolean;
  /** Aggregate hit count across all matched files (from the active search). */
  resultCount: number;
  /** Number of matched files in the active search. */
  fileCount: number;
  /** Title shown in the nav chip when no history entry is selected (e.g. the
   *  live form's describeQuery); falls back to entries[currentIndex].title. */
  currentTitle?: string;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNav: (delta: number) => void;
  onClear: () => void;
};

export function SearchHistory({
  entries,
  currentIndex,
  open,
  resultCount,
  fileCount,
  currentTitle,
  onToggle,
  onSelect,
  onNav,
  onClear,
}: SearchHistoryProps): React.ReactElement {
  const cur = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const chipTitle = currentTitle ?? cur?.title ?? "—";

  return (
    <div className="navrow">
      <button
        className="arrow"
        aria-label="History back"
        onClick={() => onNav(-1)}
      >
        ◀
      </button>
      <button
        className="arrow"
        aria-label="History forward"
        onClick={() => onNav(1)}
      >
        ▶
      </button>
      <span className="nav-label">历史</span>
      <button
        className="cur"
        aria-label="History menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="cur-text">{chipTitle}</span>
        <span className="cur-caret"> ▾</span>
      </button>
      <span className="meta">
        {resultCount} 命中 / {fileCount} 文件
      </span>
      <span className="sort">排序: 命中数 ▾</span>

      {open && (
        <div className="hd open" role="listbox" aria-label="Search history">
          <div className="hd-head">
            <span className="eyebrow">搜索历史 · 每条＝完整查询</span>
            <button className="clr" aria-label="Clear history" onClick={onClear}>
              清空
            </button>
          </div>
          {entries.length === 0 ? (
            <div className="hd-empty">无历史</div>
          ) : (
            entries.map((e, i) => (
              <div
                key={e.id}
                role="option"
                aria-selected={i === currentIndex}
                aria-label={e.title}
                className={`hitem${i === currentIndex ? " cur" : ""}`}
                onClick={() => onSelect(e.id)}
              >
                <div className="t">{e.title}</div>
                <div className="s">{e.resultCount} 命中</div>
              </div>
            ))
          )}
          <div className="hd-foot">点击回填全部条件（关键词+级别+时间）并重跑</div>
        </div>
      )}
    </div>
  );
}
