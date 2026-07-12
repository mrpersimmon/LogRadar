// JsonInspector — inline JSON tree expand. When a JSON log line is expanded
// (in VirtualLogView, via a ▾展开JSON affordance), JsonInspector parses the
// line's JSON and renders an inline expandable field tree: keys
// (blue/`--info`), string values (teal/`--scan`), numbers (amber/`--warn`),
// booleans/null (debug), type tags (faint), and collapsible object/array nodes
// (▾ expanded / ▸ collapsed). Search-hit terms are highlighted as substrings
// inside the JSON string values.
//
// The tree structure (`.jtree` / `.br` / `.k` / `.col` / `.s` / `.n` / `.b` /
// `.typ` / `.twist` / `.collapsed` / `mark.jhit`) is ported from
// `.superpowers/brainstorm/28981-1783828764/content/json-inspector.html`,
// restyled with ③a's premium CSS-variable tokens (no hardcoded colors). The
// per-node fold state lives in React: the root container is always expanded
// (no twist); every nested object/array starts collapsed (▸) and toggles on
// click — so deep JSON doesn't flood the log view until you drill in.

import { useState, type ReactNode } from "react";
import "./JsonInspector.css";

export type JsonInspectorProps = {
  /** A raw log line. If it parses as JSON, the tree is rendered; otherwise the
   *  raw text is shown verbatim (no crash). */
  line: string;
  /** Search-hit terms. Each occurrence (case-insensitive) inside a JSON
   *  STRING value is wrapped in `<mark class="jhit">`. Keys are never
   *  highlighted — only values. */
  hits?: string[];
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `text` on any (case-insensitive) term in `terms` and wrap each match
 * in `<mark class="jhit">`. Non-matching fragments become inert `<span>`s so
 * React keys are stable. Mirrors SyntaxHighlighter's HighlightedMessage, but
 * uses the in-JSON `jhit` class. */
function HighlightedValue({
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
          <mark className="jhit" key={i}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

type Entry = [string | number, unknown];

function toEntries(value: object): Entry[] {
  if (Array.isArray(value)) {
    return value.map((v, i): Entry => [i, v]);
  }
  return Object.entries(value as Record<string, unknown>);
}

/** A primitive value node: string (teal, quoted, hit-highlighted), number
 * (amber), boolean/null (debug). Never holds state. */
function LeafValue({
  value,
  terms,
}: {
  value: unknown;
  terms: string[];
}): ReactNode {
  if (typeof value === "string") {
    return (
      <span className="s">
        "<HighlightedValue text={value} terms={terms} />"
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="n">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="b">{String(value)}</span>;
  }
  // null (JSON.parse never produces undefined)
  return <span className="b">null</span>;
}

function leafType(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "null";
}

/** One node (a single `.node` line in the tree). Dispatches to ContainerNode
 * for objects/arrays, else renders a leaf. `nodeKey` is null only for the
 * root, which carries no key/colon. For array items `nodeKey` is the index
 * (number) and renders as `[0]` in the number color; for object members it is
 * the key string in the info color. */
function ValueNode({
  value,
  nodeKey,
  depth,
  terms,
}: {
  value: unknown;
  nodeKey: string | number | null;
  depth: number;
  terms: string[];
}): ReactNode {
  if (value !== null && typeof value === "object") {
    return (
      <ContainerNode
        value={value as object}
        nodeKey={nodeKey}
        depth={depth}
        terms={terms}
      />
    );
  }
  const isArrIdx = typeof nodeKey === "number";
  return (
    <div className="node" style={{ paddingLeft: depth * 18 }}>
      <span className="twist"> </span>
      {nodeKey != null && (
        <span className={isArrIdx ? "n" : "k"}>
          {isArrIdx ? `[${nodeKey}]` : String(nodeKey)}
        </span>
      )}
      {nodeKey != null && <span className="col">{isArrIdx ? " " : ":"}</span>}
      <LeafValue value={value} terms={terms} />
      <span className="typ">{leafType(value)}</span>
    </div>
  );
}

/** An object/array node: opening brace line (with a ▾/▸ twist for nested
 * nodes), children when expanded, closing brace line. The root (`nodeKey`
 * null) renders just the braces with no twist and no type tag — it is always
 * expanded, mirroring the mockup. Nested containers start collapsed. */
function ContainerNode({
  value,
  nodeKey,
  depth,
  terms,
}: {
  value: object;
  nodeKey: string | number | null;
  depth: number;
  terms: string[];
}): ReactNode {
  const isRoot = nodeKey === null;
  const isArrIdx = typeof nodeKey === "number";
  const arr = Array.isArray(value);
  const entries = toEntries(value);
  const openBrace = arr ? "[" : "{";
  const closeBrace = arr ? "]" : "}";
  const tag = `${arr ? "array" : "object"} · ${entries.length}`;
  // Root is always expanded (no twist to toggle it); nested starts collapsed.
  const [open, setOpen] = useState(isRoot);

  return (
    <>
      {/* opening line */}
      <div className="node" style={{ paddingLeft: depth * 18 }}>
        {isRoot ? (
          <span className="br">{openBrace}</span>
        ) : (
          <>
            <span
              className="twist"
              data-key={isArrIdx ? `[${nodeKey}]` : String(nodeKey)}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              aria-label={`${open ? "collapse" : "expand"} ${nodeKey}`}
              onClick={() => setOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              }}
            >
              {open ? "▾" : "▸"}
            </span>
            <span className={isArrIdx ? "n" : "k"}>
              {isArrIdx ? `[${nodeKey}]` : String(nodeKey)}
            </span>
            <span className="col">{isArrIdx ? " " : ":"}</span>
            <span className="br">{openBrace}</span>
            {open ? null : (
              <>
                {" "}
                <span className="collapsed">…</span>
                <span className="br">{closeBrace}</span>
              </>
            )}
            {" "}
            <span className="typ">{tag}</span>
          </>
        )}
      </div>
      {/* children (only when expanded) */}
      {open &&
        entries.map(([k, v]) => (
          <ValueNode
            key={String(k)}
            value={v}
            nodeKey={k}
            depth={depth + 1}
            terms={terms}
          />
        ))}
      {/* closing brace line (only when expanded) */}
      {open && (
        <div className="node" style={{ paddingLeft: depth * 18 }}>
          <span className="br">{closeBrace}</span>
        </div>
      )}
    </>
  );
}

export function JsonInspector({ line, hits }: JsonInspectorProps) {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    // Not JSON — render the raw line verbatim. No crash, no tree.
    return <span className="jtree-plain">{line}</span>;
  }
  const terms = hits ?? [];
  return (
    <div className="jtree" data-testid="jtree">
      <ValueNode value={data} nodeKey={null} depth={0} terms={terms} />
    </div>
  );
}
