import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WelcomePage } from "./WelcomePage";

const openFileMock = vi.fn();
vi.mock("../lib/ipc", () => ({ openFile: (path: string) => openFileMock(path) }));
const dialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => dialogMock() }));

beforeEach(() => { openFileMock.mockReset(); dialogMock.mockReset(); });

describe("WelcomePage", () => {
  it("opens a file via IPC and shows metadata", async () => {
    dialogMock.mockResolvedValue("/path/a.log");
    openFileMock.mockResolvedValue({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
    render(<WelcomePage />);
    fireEvent.click(screen.getByText("Open file"));
    await waitFor(() => {
      expect(openFileMock).toHaveBeenCalledWith("/path/a.log");
      expect(screen.getByText(/sessionId: s1/)).toBeTruthy();
      expect(screen.getByText(/lineCount: 3/)).toBeTruthy();
    });
  });
});
