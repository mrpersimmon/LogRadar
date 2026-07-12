// Top tab strip — ports option B (tree + tabs) from
// `.superpowers/brainstorm/28981-1783828764/content/tabs-comparison.html`,
// restyled with the premium CSS-variable tokens (③a's `src/theme/tokens.css`).
// One tab per open session, labelled by filename basename; the active session
// gets a teal underline (`box-shadow: inset 0 -2px 0 var(--scan)`); the ×
// button calls `onClose(id)` and stops propagation so it does not also select.
// The caller wires `onSelect` → `useSessions.setActive` and `onClose` →
// `useSessions.close` (→ `closeSession` IPC).

import type { SessionMeta } from "../hooks/useSessions";
import "./TabStrip.css";

export type TabStripProps = {
  sessions: Map<string, SessionMeta>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function TabStrip({ sessions, activeId, onSelect, onClose }: TabStripProps) {
  const tabs = [...sessions.entries()];

  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {tabs.map(([id, meta]) => {
        const name = basename(meta.path);
        const on = id === activeId;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={on}
            aria-label={name}
            tabIndex={0}
            className={`tab${on ? " on" : ""}`}
            onClick={() => onSelect(id)}
          >
            <span className="tab-label">{name}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
