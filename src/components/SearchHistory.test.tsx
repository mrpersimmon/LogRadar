import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SearchHistory, type SearchHistoryProps } from "./SearchHistory";
import type { HistoryEntry, QueryForm } from "./SearchPanel";

const baseForm: QueryForm = {
  keywords: ["refused"],
  combinator: "AND",
  levels: [],
  timeRange: { start: "", end: "" },
};
const entries: HistoryEntry[] = [
  {
    id: "h1",
    form: baseForm,
    title: "refused AND timeout · ERROR,WARN · 14:22–14:23",
    timestamp: Date.now(),
    resultCount: 17,
  },
  {
    id: "h2",
    form: baseForm,
    title: "ECONNREFUSED · ERROR",
    timestamp: Date.now(),
    resultCount: 9,
  },
];

function props(over: Partial<SearchHistoryProps> = {}): SearchHistoryProps {
  return {
    entries,
    currentIndex: 0,
    open: false,
    resultCount: 17,
    fileCount: 3,
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onNav: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
}

describe("SearchHistory nav row", () => {
  it("renders back and forward nav buttons", () => {
    render(<SearchHistory {...props()} />);
    expect(screen.getByRole("button", { name: /history back/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /history forward/i })).toBeTruthy();
  });
  it("renders the current entry's title inside the history-menu chip", () => {
    render(<SearchHistory {...props({ currentIndex: 0 })} />);
    const chip = screen.getByRole("button", { name: /history menu/i });
    expect(chip.textContent).toContain("refused");
  });
  it("renders the result/file count meta", () => {
    render(<SearchHistory {...props({ resultCount: 17, fileCount: 3 })} />);
    expect(screen.getByText(/17\s*命中/)).toBeTruthy();
    expect(screen.getByText(/3\s*文件/)).toBeTruthy();
  });
  it("calls onNav(-1) on back and onNav(1) on forward", () => {
    const onNav = vi.fn();
    render(<SearchHistory {...props({ onNav })} />);
    fireEvent.click(screen.getByRole("button", { name: /history back/i }));
    expect(onNav).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: /history forward/i }));
    expect(onNav).toHaveBeenCalledWith(1);
  });
  it("calls onToggle when the history-menu chip is clicked", () => {
    const onToggle = vi.fn();
    render(<SearchHistory {...props({ onToggle })} />);
    fireEvent.click(screen.getByRole("button", { name: /history menu/i }));
    expect(onToggle).toHaveBeenCalled();
  });
  it("sets aria-expanded on the chip to reflect open state", () => {
    const { rerender } = render(<SearchHistory {...props({ open: false })} />);
    expect(
      screen.getByRole("button", { name: /history menu/i }).getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(<SearchHistory {...props({ open: true })} />);
    expect(
      screen.getByRole("button", { name: /history menu/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("SearchHistory dropdown", () => {
  it("does not render the dropdown listbox when closed", () => {
    render(<SearchHistory {...props({ open: false })} />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("lists all entries as options when open", () => {
    render(<SearchHistory {...props({ open: true })} />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
  it("renders each entry's full-query title", () => {
    render(<SearchHistory {...props({ open: true })} />);
    const lb = screen.getByRole("listbox", { name: /search history/i });
    // scope to the dropdown so the nav chip (which shows the same title) doesn't
    // make getByText ambiguous.
    expect(within(lb).getByText(/refused AND timeout/)).toBeTruthy();
    expect(within(lb).getByText(/ECONNREFUSED/)).toBeTruthy();
  });
  it("marks the current entry as selected", () => {
    render(<SearchHistory {...props({ open: true, currentIndex: 0 })} />);
    const opts = screen.getAllByRole("option");
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    expect(opts[1].getAttribute("aria-selected")).toBe("false");
  });
  it("calls onSelect(id) when an entry is clicked", () => {
    const onSelect = vi.fn();
    render(<SearchHistory {...props({ open: true, onSelect })} />);
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onSelect).toHaveBeenCalledWith("h2");
  });
  it("calls onClear when the clear button is clicked", () => {
    const onClear = vi.fn();
    render(<SearchHistory {...props({ open: true, onClear })} />);
    fireEvent.click(screen.getByRole("button", { name: /clear history/i }));
    expect(onClear).toHaveBeenCalled();
  });
  it("renders an empty-state message when there are no entries", () => {
    render(<SearchHistory {...props({ entries: [], currentIndex: -1, open: true })} />);
    expect(screen.getByText(/no history|无历史/i)).toBeTruthy();
  });
  it("renders the footer hint about click-to-refill", () => {
    render(<SearchHistory {...props({ open: true })} />);
    expect(screen.getByText(/refill|回填|重跑/i)).toBeTruthy();
  });
});
