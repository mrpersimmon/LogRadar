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

const exportFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  exportFile: (sid: string, q: unknown, cols: string[], tgt: string) =>
    exportFileMock(sid, q, cols, tgt),
}));

beforeEach(() => exportFileMock.mockReset());

describe("ExportDialog", () => {
  it("builds export args (range/format/columns/target) and calls exportFile", async () => {
    exportFileMock.mockResolvedValue(1204);
    render(<ExportDialog sessionId="s1" />);

    // defaults: range=current-query, format=raw, all columns on, target=file.
    fireEvent.click(screen.getByRole("button", { name: "All open files" }));
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    // uncheck File path — it must be excluded from the columns array
    fireEvent.click(screen.getByRole("checkbox", { name: "File path" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Export path" }), {
      target: { value: "/out/x.csv" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportFileMock).toHaveBeenCalledTimes(1);
      const [sid, query, columns, target] = exportFileMock.mock.calls[0];
      expect(sid).toBe("s1");
      expect(query).toMatchObject({ range: "all", format: "csv" });
      expect(columns).toEqual([
        "lineNumber",
        "timestamp",
        "level",
        "message",
      ]);
      expect(target).toBe("/out/x.csv");
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
