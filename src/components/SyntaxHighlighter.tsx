// SyntaxHighlighter — colors a single log line's tokens. Given a raw line like
// `14:22:01 ERROR db connection refused`, it parses out the timestamp (dim),
// the level (a colored pip + level text, colored by ERROR/WARN/INFO/…), and
// the message remainder, and wraps each occurrence of a hit term in
// `<mark class="hit">`. Line rendering is ported from the `.ln` section of
// `.superpowers/brainstorm/28981-1783828764/content/premium-redesign.html`
// (`.ts` / `.lv.err` + `.pip` / `.msg` / `mark.hit`), restyled with ③a's
// premium CSS-variable tokens (no hardcoded colors).
//
// This is the reusable token-colorer; the line number + jump-target chrome
// live in the consumer (VirtualLogView). When a line has no parseable
// timestamp/level, the whole text is the message and no pip is rendered.

import { type ReactNode } from "react";
import "./SyntaxHighlighter.css";

export type SyntaxLevel =
  | "ERROR"
  | "WARN"
  | "INFO"
  | "DEBUG"
  | "FATAL"
  | "TRACE";

export type SyntaxHighlighterProps = {
  /** Raw log line, e.g. `14:22:01 ERROR db connection refused`. */
  line: string;
  /** Substrings to highlight inside the message (the active query terms).
   * Matched case-insensitively; each occurrence becomes a `mark.hit`. */
  hits?: string[];
};

// `14:22:01.003` or `2026-07-11 14:22:01` (ISO-ish). Leading run only.
const TS_RE =
  /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
// First whole-word level token in the remainder.
const LVL_RE = /\b(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/;

function parseLine(raw: string): {
  ts: string | null;
  level: SyntaxLevel | null;
  message: string;
} {
  let rest = raw;
  let ts: string | null = null;
  const tsM = TS_RE.exec(rest);
  if (tsM) {
    ts = tsM[1];
    rest = rest.slice(tsM[0].length).replace(/^\s+/, "");
  }
  let level: SyntaxLevel | null = null;
  let message = rest;
  const lvlM = LVL_RE.exec(rest);
  if (lvlM) {
    level = lvlM[1] as SyntaxLevel;
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

/** Split `text` on any (case-insensitive) term in `terms` and wrap each match
 * in `<mark class="hit">`. Non-matching fragments become inert `<span>`s so
 * React keys are stable. Empty fragments (split artifacts) render as nothing. */
function HighlightedMessage({
  text,
  terms,
}: {
  text: string;
  terms: string[];
}): ReactNode {
  const nonEmpty = terms.filter((t) => t.length > 0);
  if (nonEmpty.length === 0) return <>{text}</>;
  const re = new RegExp(`(${nonEmpty.map(escapeRegex).join("|")})`, "i");
  const parts = text.split(re);
  const lower = new Set(nonEmpty.map((t) => t.toLowerCase()));
  return (
    <>
      {parts.map((p, i) =>
        p && lower.has(p.toLowerCase()) ? (
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

export function SyntaxHighlighter({ line, hits }: SyntaxHighlighterProps) {
  const { ts, level, message } = parseLine(line);
  const terms = hits ?? [];
  return (
    <span className="sh-line">
      {ts != null && <span className="ts">{ts}</span>}
      {level != null && (
        <span className={`lv ${level.toLowerCase()}`}>
          <span className="pip" />
          {level}
        </span>
      )}
      <span className="msg">
        {terms.length > 0 ? (
          <HighlightedMessage text={message} terms={terms} />
        ) : (
          message
        )}
      </span>
    </span>
  );
}
