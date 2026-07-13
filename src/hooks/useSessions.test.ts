import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessions, type SessionMeta } from "./useSessions";

// Mock the IPC wrappers `useSessions` depends on (openFile / closeSession /
// evictSearchControllers — close triggers controller eviction on the way out;
// extractArchive / scanDir — Task 8's archive + folder flows). Re-using ③a's
// wrappers — no need to re-add `invoke` here. Mocks are exposed as the vi.fn
// instances directly so tests can drive `.mockImplementation` /
// `.mockResolvedValue` / `expect(...).toHaveBeenCalledWith` on the imported
// wrapper name (the brief's openArchive test does this via dynamic import).
const {
  openFileMock,
  closeSessionMock,
  evictSearchControllersMock,
  extractArchiveMock,
  scanDirMock,
} = vi.hoisted(() => ({
  openFileMock: vi.fn(),
  closeSessionMock: vi.fn(),
  evictSearchControllersMock: vi.fn(),
  extractArchiveMock: vi.fn(),
  scanDirMock: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  openFile: openFileMock,
  closeSession: closeSessionMock,
  evictSearchControllers: evictSearchControllersMock,
  extractArchive: extractArchiveMock,
  scanDir: scanDirMock,
}));

function meta(id: string, path: string): SessionMeta {
  return {
    sessionId: id,
    path,
    lineCount: 5,
    encoding: "Utf8",
    isJson: false,
    timestampFmt: "iso",
  };
}

beforeEach(() => {
  openFileMock.mockReset();
  closeSessionMock.mockReset();
  evictSearchControllersMock.mockReset();
  extractArchiveMock.mockReset();
  scanDirMock.mockReset();
});

describe("useSessions open", () => {
  it("open(path) calls openFile, adds a session, and sets it active", async () => {
    openFileMock.mockResolvedValue(meta("sess-1", "/a.log"));
    const { result } = renderHook(() => useSessions());

    expect(result.current.sessions.size).toBe(0);
    expect(result.current.activeId).toBeNull();

    await act(async () => {
      await result.current.open("/a.log");
    });

    expect(openFileMock).toHaveBeenCalledWith("/a.log");
    expect(result.current.sessions.size).toBe(1);
    expect(result.current.activeId).toBe("sess-1");
    expect(result.current.sessions.get("sess-1")?.path).toBe("/a.log");
    expect(result.current.sessions.get("sess-1")?.lineCount).toBe(5);
  });

  it("opening a second session keeps both and switches active to the new one", async () => {
    openFileMock.mockResolvedValueOnce(meta("sess-1", "/a.log"));
    openFileMock.mockResolvedValueOnce(meta("sess-2", "/b.log"));
    const { result } = renderHook(() => useSessions());

    await act(async () => { await result.current.open("/a.log"); });
    await act(async () => { await result.current.open("/b.log"); });

    expect(result.current.sessions.size).toBe(2);
    expect(result.current.activeId).toBe("sess-2");
    expect(result.current.sessions.get("sess-1")?.path).toBe("/a.log");
    expect(result.current.sessions.get("sess-2")?.path).toBe("/b.log");
  });
});

describe("useSessions setActive", () => {
  it("setActive(id) switches activeId without touching the set", async () => {
    openFileMock.mockResolvedValueOnce(meta("sess-1", "/a.log"));
    openFileMock.mockResolvedValueOnce(meta("sess-2", "/b.log"));
    const { result } = renderHook(() => useSessions());

    await act(async () => { await result.current.open("/a.log"); });
    await act(async () => { await result.current.open("/b.log"); });
    expect(result.current.activeId).toBe("sess-2");

    act(() => result.current.setActive("sess-1"));
    expect(result.current.activeId).toBe("sess-1");
    expect(result.current.sessions.size).toBe(2);
  });
});

describe("useSessions close", () => {
  it("close(id) calls closeSession, removes the session, and reassigns active", async () => {
    openFileMock.mockResolvedValueOnce(meta("sess-1", "/a.log"));
    openFileMock.mockResolvedValueOnce(meta("sess-2", "/b.log"));
    const { result } = renderHook(() => useSessions());

    await act(async () => { await result.current.open("/a.log"); });
    await act(async () => { await result.current.open("/b.log"); });
    expect(result.current.activeId).toBe("sess-2");

    await act(async () => {
      await result.current.close("sess-2");
    });

    expect(closeSessionMock).toHaveBeenCalledWith("sess-2");
    // Task 7: close evicts the closed session's search controllers so the
    // singleton registry doesn't leak across open/close cycles.
    expect(evictSearchControllersMock).toHaveBeenCalledWith("sess-2");
    expect(result.current.sessions.size).toBe(1);
    expect(result.current.sessions.has("sess-2")).toBe(false);
    // active reassigned to the remaining session
    expect(result.current.activeId).toBe("sess-1");
  });

  it("close(id) clears activeId when no sessions remain", async () => {
    openFileMock.mockResolvedValue(meta("sess-1", "/a.log"));
    const { result } = renderHook(() => useSessions());

    await act(async () => { await result.current.open("/a.log"); });
    const id = result.current.activeId!;
    expect(id).toBe("sess-1");

    await act(async () => {
      await result.current.close(id);
    });

    expect(closeSessionMock).toHaveBeenCalledWith("sess-1");
    expect(result.current.sessions.size).toBe(0);
    expect(result.current.activeId).toBeNull();
  });

  it("closing a non-active session leaves activeId untouched", async () => {
    openFileMock.mockResolvedValueOnce(meta("sess-1", "/a.log"));
    openFileMock.mockResolvedValueOnce(meta("sess-2", "/b.log"));
    const { result } = renderHook(() => useSessions());

    await act(async () => { await result.current.open("/a.log"); });
    await act(async () => { await result.current.open("/b.log"); });
    expect(result.current.activeId).toBe("sess-2");

    await act(async () => {
      await result.current.close("sess-1");
    });

    expect(closeSessionMock).toHaveBeenCalledWith("sess-1");
    expect(result.current.sessions.size).toBe(1);
    expect(result.current.activeId).toBe("sess-2");
  });
});

describe("useSessions openArchive", () => {
  it("openArchive extracts then opens each returned log", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useSessions } = await import("./useSessions");
    const { openFile } = await import("../lib/ipc");
    (openFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => ({
      sessionId: "s-" + path, lineCount: 1, encoding: "Utf8", isJson: false, timestampFmt: "iso",
    }));
    const { extractArchive } = await import("../lib/ipc");
    (extractArchive as ReturnType<typeof vi.fn>).mockResolvedValue({
      extractedDir: "/x", logFiles: ["/x/a.log", "/x/b.log"],
    });
    const { result } = renderHook(() => useSessions());
    await act(async () => { await result.current.openArchive("/foo.zip", () => {}); });
    expect(openFile).toHaveBeenCalledWith("/x/a.log");
    expect(openFile).toHaveBeenCalledWith("/x/b.log");
    expect(result.current.sessions.size).toBe(2);
  });
});
