import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileTree } from "./FileTree";
import type { SessionMeta } from "../hooks/useSessions";

function session(id: string, path: string, lineCount = 5): [string, SessionMeta] {
  return [id, { sessionId: id, path, lineCount, encoding: "Utf8", isJson: false, timestampFmt: "iso" }];
}
const map = (...e: [string, SessionMeta][]) => new Map(e);

describe("FileTree", () => {
  it("renders open files grouped by their directory path", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/auth/b.log", 4),
    );
    render(<FileTree sessions={sessions} activeId="s1" onSelect={() => {}} />);

    // file rows
    expect(screen.getByRole("treeitem", { name: "a.log" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "b.log" })).toBeTruthy();
    // directory rows that group them
    expect(screen.getByRole("treeitem", { name: "logs" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "auth" })).toBeTruthy();
  });

  it("groups files under separate directory headers when paths differ", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 1),
      session("s2", "/logs/api/c.log", 2),
    );
    render(<FileTree sessions={sessions} activeId="s1" onSelect={() => {}} />);

    expect(screen.getByRole("treeitem", { name: "auth" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "api" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "a.log" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "c.log" })).toBeTruthy();
  });

  it("marks the active file row as selected and others as not", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/auth/b.log", 4),
    );
    render(<FileTree sessions={sessions} activeId="s2" onSelect={() => {}} />);

    const active = screen.getByRole("treeitem", { name: "b.log" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    const inactive = screen.getByRole("treeitem", { name: "a.log" });
    expect(inactive.getAttribute("aria-selected")).toBe("false");
  });

  it("calls onSelect(sessionId) when a file row is clicked", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/auth/b.log", 4),
    );
    const onSelect = vi.fn();
    render(<FileTree sessions={sessions} activeId="s1" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("treeitem", { name: "b.log" }));
    expect(onSelect).toHaveBeenCalledWith("s2");
  });

  it("shows a line-count badge per file row", () => {
    const sessions = map(session("s1", "/logs/auth/a.log", 8));
    render(<FileTree sessions={sessions} activeId="s1" onSelect={() => {}} />);

    const row = screen.getByRole("treeitem", { name: "a.log" });
    expect(row.textContent).toMatch(/8/);
  });

  it("toggles a directory's expanded state on click", () => {
    const sessions = map(session("s1", "/logs/auth/a.log", 8));
    render(<FileTree sessions={sessions} activeId="s1" onSelect={() => {}} />);

    const dir = screen.getByRole("treeitem", { name: "auth" });
    expect(dir.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(dir);
    expect(dir.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders an empty state when no sessions are open", () => {
    render(<FileTree sessions={new Map()} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText(/0 files/i)).toBeTruthy();
  });

  it("groups Windows backslash paths into a tree (archive-extract regression)", () => {
    // Regression: buildTree split on "/" only, so a Windows path
    // (C:\extracted\foo\a.log) was treated as a single segment → the file
    // rendered as a flat top-level row with the whole path as its name,
    // not grouped under a `foo` directory node. Must split on both / and \.
    const sessions = map(
      session("s1", "C:\\extracted\\foo\\a.log", 8),
      session("s2", "C:\\extracted\\foo\\b.log", 4),
    );
    render(<FileTree sessions={sessions} activeId="s1" onSelect={() => {}} />);

    expect(screen.getByRole("treeitem", { name: "foo" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "a.log" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "b.log" })).toBeTruthy();
  });
});
