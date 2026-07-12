// ExportDialog (Task 10 ③b) — CRITICAL behavior under test: the dialog builds the
// export args (range / format / columns / target) from its segmented controls +
// checkboxes + path field and calls `exportFile(sessionId, query, columns,
// target)`, and the live preview re-renders to reflect which columns are
// checked (toggling a column off removes that field from every preview line).
// Visual structure ported from
// `.superpowers/brainstorm/28981-1783828764/content/export.html`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportDialog } from "./ExportDialog";
import type { SearchRequest } from "../components/SearchPanel";

const exportFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  exportFile: (sid: string, q: unknown, cols: string[], tgt: string) =>
    exportFileMock(sid, q, cols, tgt),
}));

beforeEach(() => exportFileMock.mockReset());

describe("ExportDialog", () => {
  // I2: `exportFile`'s 2nd arg is the `query` the Rust `export` command
  // deserializes into `SearchRequest` (requires `{root: QueryNodeDto}` — see
  // src-tauri/src/commands.rs). Pre-fix the dialog sent `{range, format}` which
  // has no `root` → serde_json::from_value fails → export always errored.
  // The fix sends a match-all SearchRequest `{root:{leaf:{text:""}}}` (empty
  // text matches every line via line.contains("")) for the ranges that don't
  // need the active query (current-file / selection / all).
  it("calls exportFile with a valid SearchRequest payload ({root:...}) not {range,format}", async () => {
    exportFileMock.mockResolvedValue(1204);
    render(<ExportDialog sessionId="s1" />);

    // defaults: range=current-file (current-query disabled per I2), format=raw,
    // all columns on, target=file.
    fireEvent.click(screen.getByRole("button", { name: "All open files" }));
    // uncheck File path — it must be excluded from the columns array
    fireEvent.click(screen.getByRole("checkbox", { name: "File path" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Export path" }), {
      target: { value: "/out/x.log" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportFileMock).toHaveBeenCalledTimes(1);
      const [sid, query, columns, target] = exportFileMock.mock.calls[0];
      expect(sid).toBe("s1");
      // query MUST be a SearchRequest the Rust side can deserialize, NOT the
      // {range, format} UI state (which has no `root`).
      expect(query).toMatchObject({
        root: {
          kind: "leaf",
          predicate: { kind: "text", text: "" },
        },
      });
      expect(query).not.toHaveProperty("range");
      expect(query).not.toHaveProperty("format");
      expect(columns).toEqual(["lineNumber", "timestamp", "level", "message"]);
      expect(target).toBe("/out/x.log");
    });
  });

  // Task 2 (④a): the lift (T1) put `activeQuery` at App → ExportDialog receives
  // it as a prop. The "current-query" range is now ENABLED (was disabled in
  // ③b-fix because the active query wasn't reachable here). Selecting it sends
  // the lifted `activeQuery` — a valid SearchRequest the Rust `export` command
  // deserializes — instead of the match-all sentinel the other ranges use.
  it("enables the current-query range and sends the lifted activeQuery when selected", async () => {
    exportFileMock.mockResolvedValue(7);
    const activeQuery: SearchRequest = {
      root: { kind: "leaf", predicate: { kind: "text", text: "refused" } },
    };
    render(<ExportDialog sessionId="s1" activeQuery={activeQuery} />);

    const q = screen.getByRole("button", { name: "Current query" }) as HTMLButtonElement;
    // re-enabled: no longer greyed out / non-interactive
    expect(q.disabled).toBe(false);

    // selecting current-query → export sends the lifted activeQuery (not match-all)
    fireEvent.click(q);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportFileMock).toHaveBeenCalledTimes(1);
      const [, query] = exportFileMock.mock.calls[0];
      // the EXACT lifted activeQuery object (referential equality) — proving the
      // dialog forwards the lifted query, not a rebuilt/lossy match-all copy.
      expect(query).toBe(activeQuery);
    });
  });

  // Edge case: no activeQuery committed yet (activeQuery is null/undefined).
  // The current-query range stays enabled, and selecting it falls back to the
  // match-all sentinel — an empty query matches every line via line.contains(""),
  // so "current query" with no query === all lines. Never an invalid payload.
  it("falls back to the match-all SearchRequest for current-query when no activeQuery is set", async () => {
    exportFileMock.mockResolvedValue(1204);
    render(<ExportDialog sessionId="s1" />);

    const q = screen.getByRole("button", { name: "Current query" }) as HTMLButtonElement;
    expect(q.disabled).toBe(false);
    fireEvent.click(q);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportFileMock).toHaveBeenCalledTimes(1);
      const [, query] = exportFileMock.mock.calls[0];
      expect(query).toMatchObject({
        root: { kind: "leaf", predicate: { kind: "text", text: "" } },
      });
    });
  });

  it("preview reflects the selected columns (toggling File path off removes it)", () => {
    render(<ExportDialog sessionId="s1" />);
    const preview = screen.getByTestId("export-preview");
    // default: all columns on → the sample file path appears in the preview
    expect(preview.textContent).toContain("logs/auth/a.log");
    // uncheck File path → the path disappears from every preview line
    fireEvent.click(screen.getByRole("checkbox", { name: "File path" }));
    expect(preview.textContent).not.toContain("logs/auth/a.log");
    // re-check → it comes back
    fireEvent.click(screen.getByRole("checkbox", { name: "File path" }));
    expect(screen.getByTestId("export-preview").textContent).toContain(
      "logs/auth/a.log",
    );
  });

  it("shows a size/line estimate in the footer", () => {
    render(<ExportDialog sessionId="s1" />);
    // footer estimate mentions rows + a size unit
    const footer = screen.getByTestId("export-footer");
    expect(footer.textContent).toMatch(/rows?/i);
    expect(footer.textContent).toMatch(/KB|MB/i);
  });
});
