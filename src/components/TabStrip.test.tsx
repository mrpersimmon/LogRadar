import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TabStrip } from "./TabStrip";
import type { SessionMeta } from "../hooks/useSessions";

function session(id: string, path: string, lineCount = 5): [string, SessionMeta] {
  return [id, { sessionId: id, path, lineCount, encoding: "Utf8", isJson: false, timestampFmt: "iso" }];
}
const map = (...e: [string, SessionMeta][]) => new Map(e);

describe("TabStrip", () => {
  it("renders one tab per open session, labelled by filename", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/api/c.log", 4),
    );
    render(
      <TabStrip sessions={sessions} activeId="s1" onSelect={() => {}} onClose={() => {}} />,
    );

    expect(screen.getByRole("tab", { name: "a.log" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "c.log" })).toBeTruthy();
  });

  it("marks the active tab as selected and the rest as not", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/api/c.log", 4),
    );
    render(
      <TabStrip sessions={sessions} activeId="s2" onSelect={() => {}} onClose={() => {}} />,
    );

    expect(screen.getByRole("tab", { name: "c.log", selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "a.log", selected: false })).toBeTruthy();
  });

  it("calls onSelect(sessionId) when a tab is clicked", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/api/c.log", 4),
    );
    const onSelect = vi.fn();
    render(<TabStrip sessions={sessions} activeId="s1" onSelect={onSelect} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("tab", { name: "c.log" }));
    expect(onSelect).toHaveBeenCalledWith("s2");
  });

  it("calls onClose (and not onSelect) when the × button is clicked", () => {
    const sessions = map(
      session("s1", "/logs/auth/a.log", 8),
      session("s2", "/logs/api/c.log", 4),
    );
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<TabStrip sessions={sessions} activeId="s1" onSelect={onSelect} onClose={onClose} />);

    const tab = screen.getByRole("tab", { name: "c.log" });
    const closeBtn = within(tab).getByRole("button", { name: /close/i }) as HTMLElement;
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledWith("s2");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders no tabs when no sessions are open", () => {
    render(<TabStrip sessions={new Map()} activeId={null} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });
});
