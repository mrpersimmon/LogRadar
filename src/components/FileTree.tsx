// Sidebar directory tree — ports the sidebar from
// `.superpowers/brainstorm/28981-1783828764/content/main-window-v7.html`
// (and its token-adapted form in `premium-redesign.html`), restyled with the
// premium CSS-variable tokens (③a's `src/theme/tokens.css`). Open files are
// grouped by the directory path derived from each session's `path`; the active
// session is highlighted; file rows carry a line-count badge. `onSelect(id)`
// is wired by the caller to `useSessions.setActive`.

import { useState } from "react";
import type { SessionMeta } from "../hooks/useSessions";
import "./FileTree.css";

export type FileTreeProps = {
  sessions: Map<string, SessionMeta>;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Optional inline style override applied to the root `<aside className=
  *  "file-tree">`. MainWindow uses this to drive the sidebar width from its
  *  drag-to-resize handle (Issue 3), overriding the CSS `width:208px`. */
  style?: React.CSSProperties;
};

type FileNode = {
  kind: "file";
  name: string;
  sessionId: string;
  lineCount: number;
};
type DirNode = {
  kind: "dir";
  name: string;
  /** Full slash-joined path from the tree root, e.g. `logs/auth`. */
  key: string;
  children: TreeNode[];
  /** Recursive count of file descendants. */
  fileCount: number;
};
type TreeNode = DirNode | FileNode;

/**
 * Build a directory tree from the open sessions' absolute paths. Each path is
 * split on `/` (empty segments from leading/trailing slashes are dropped); the
 * last segment is the file, the rest are nested dirs. Directories are sorted
 * alpha with dirs-first; files are alpha within their dir.
 */
function buildTree(sessions: Map<string, SessionMeta>): DirNode {
  const root: DirNode = { kind: "dir", name: "", key: "", children: [], fileCount: 0 };
  for (const [id, meta] of sessions) {
    const parts = meta.path.split("/").filter(Boolean);
    const filename = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);
    let cur = root;
    let acc = "";
    for (const p of dirParts) {
      acc = acc ? `${acc}/${p}` : p;
      let child = cur.children.find(
        (c): c is DirNode => c.kind === "dir" && c.name === p,
      );
      if (!child) {
        child = { kind: "dir", name: p, key: acc, children: [], fileCount: 0 };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.children.push({
      kind: "file",
      name: filename,
      sessionId: id,
      lineCount: meta.lineCount,
    });
  }
  finalize(root);
  return root;
}

/** Recursively sort children (dirs before files, alpha within) and tally files. */
function finalize(node: DirNode): void {
  for (const c of node.children) if (c.kind === "dir") finalize(c);
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.fileCount = node.children.reduce(
    (n, c) => n + (c.kind === "file" ? 1 : c.fileCount),
    0,
  );
}

export function FileTree({ sessions, activeId, onSelect, style }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const root = buildTree(sessions);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) =>
      n.kind === "dir" ? (
        <DirRow
          key={`d-${n.key}`}
          node={n}
          depth={depth}
          collapsed={collapsed.has(n.key)}
          onToggle={toggle}
          renderChildren={renderNodes}
        />
      ) : (
        <FileRow
          key={`f-${n.sessionId}`}
          node={n}
          depth={depth}
          active={activeId === n.sessionId}
          onSelect={onSelect}
        />
      ),
    );

  const label = `${root.fileCount} file${root.fileCount === 1 ? "" : "s"}`;

  return (
    <aside className="file-tree" aria-label="File tree" style={style}>
      <div className="ft-head">
        <span className="ft-eyebrow">File tree</span>
        <span className="ft-count">{label}</span>
      </div>
      <div className="ft-tree" role="tree">
        {root.children.length === 0 ? (
          <div className="ft-empty">No files open</div>
        ) : (
          renderNodes(root.children, 0)
        )}
      </div>
    </aside>
  );
}

type DirRowProps = {
  node: DirNode;
  depth: number;
  collapsed: boolean;
  onToggle: (key: string) => void;
  renderChildren: (nodes: TreeNode[], depth: number) => React.ReactNode;
};

function DirRow({ node, depth, collapsed, onToggle, renderChildren }: DirRowProps) {
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        tabIndex={0}
        className="ft-row ft-dir"
        style={{ paddingLeft: 8 + depth * 18 }}
        onClick={() => onToggle(node.key)}
      >
        <span className="ft-caret" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="ft-ico" aria-hidden>
          📁
        </span>
        <span className="ft-name">{node.name}</span>
        <span className="ft-badge" aria-hidden>
          {node.fileCount}
        </span>
      </div>
      {!collapsed && (
        <div role="group">{renderChildren(node.children, depth + 1)}</div>
      )}
    </>
  );
}

type FileRowProps = {
  node: FileNode;
  depth: number;
  active: boolean;
  onSelect: (id: string) => void;
};

function FileRow({ node, depth, active, onSelect }: FileRowProps) {
  return (
    <div
      role="treeitem"
      aria-selected={active}
      tabIndex={0}
      className={`ft-row ft-file${active ? " active" : ""}`}
      style={{ paddingLeft: 8 + depth * 18 }}
      onClick={() => onSelect(node.sessionId)}
    >
      <span className="ft-ico" aria-hidden>
        📄
      </span>
      <span className="ft-name">{node.name}</span>
      <span className="ft-badge" aria-hidden>
        {node.lineCount}
      </span>
    </div>
  );
}
