import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  openFile,
  getSearchController,
  useSearch,
  useCrossFileSearch,
  extractArchive,
  scanDir,
  type SearchEvent,
} from "./ipc";

// `vi.hoisted` makes the mock fn + Channel stub available to the `vi.mock`
// factory (the factory runs during import resolution, before the module body).
//
// @tauri-apps/api v2 note: the real `Channel` is Tauri-runtime-bound — its
// constructor touches `window.__TAURI_INTERNALS__`, which jsdom does not
// provide, so `new Channel()` throws. Unit tests therefore stub `Channel`
// with a constructible that records every instance (so a test can drive
// `channel.onmessage` for several sessions at once), letting the test prove
// the batch-accumulation logic. The real streaming path (Rust `on_event.send`
// -> JS `channel.onmessage`) is proven end-to-end in ③b/④.
const { invokeMock, MockChannel, allChannels, lastChannel } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const all: { onmessage?: (msg: SearchEvent) => void }[] = [];
  class MockChannel<T = unknown> {
    onmessage?: (msg: T) => void;
    constructor(onmessage?: (msg: T) => void) {
      if (onmessage) this.onmessage = onmessage;
      all.push(this as unknown as { onmessage?: (msg: SearchEvent) => void });
    }
  }
  const allChannels = () => all;
  const lastChannel = () => all[all.length - 1];
  return { invokeMock, MockChannel, allChannels, lastChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  Channel: MockChannel,
}));

beforeEach(() => {
  invokeMock.mockReset();
  allChannels().length = 0; // reset captured channels between cases
});

describe("openFile", () => {
  it("invokes open_file and returns the OpenResponse", async () => {
    invokeMock.mockResolvedValue({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
    const res = await openFile("/path/a.log");
    expect(invokeMock).toHaveBeenCalledWith("open_file", { path: "/path/a.log" });
    expect(res).toEqual({ sessionId: "s1", lineCount: 3, encoding: "Utf8", isJson: false, timestampFmt: "iso" });
  });
});

describe("search controller accumulates batches", () => {
  it("collects matches from batch events and marks done", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = getSearchController("s1", { root: {} }, 100);
    await ctrl.run(); // invokes `search` (mocked no-op); channel.onmessage is wired
    expect(ctrl.status).toBe("running");
    expect(ctrl.matches).toEqual([]);

    // Simulate the Rust side emitting events through the wired Channel.
    const ch = lastChannel();
    expect(ch?.onmessage).toBeDefined();

    ch!.onmessage!({ kind: "batch", matches: [10, 20, 30] });
    expect(ctrl.matches).toEqual([10, 20, 30]);

    ch!.onmessage!({ kind: "batch", matches: [40] });
    expect(ctrl.matches).toEqual([10, 20, 30, 40]);

    ch!.onmessage!({ kind: "done", matched: 4, cancelled: false, truncated: false });
    expect(ctrl.status).toBe("done");
  });

  it("marks status cancelled when the done event carries cancelled=true", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = getSearchController("s2", { root: {} }, 50);
    await ctrl.run();
    const ch = lastChannel();
    ch!.onmessage!({ kind: "done", matched: 0, cancelled: true, truncated: false });
    expect(ctrl.status).toBe("cancelled");
  });

  // useSyncExternalStore requires the snapshot to be referentially stable
  // across reads when nothing changed, AND to change reference whenever the
  // data changes. In-place `push` would mutate the same array and break
  // reactivity (React would never see a new snapshot). This test pins the
  // contract: each batch yields a NEW array reference + accumulates correctly.
  it("returns a NEW matches snapshot reference per batch (referential stability)", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = getSearchController("s3", { root: {} }, 100);
    const listener = vi.fn();
    const unsub = ctrl.subscribe(listener);

    await ctrl.run(); // status -> running, notify()
    expect(ctrl.status).toBe("running");
    expect(listener).toHaveBeenCalled();

    const snap0 = ctrl.matches; // initial snapshot ref
    expect(snap0).toEqual([]);

    const callsAfterRun = listener.mock.calls.length;

    const ch = lastChannel();
    ch!.onmessage!({ kind: "batch", matches: [10, 20] });
    const snap1 = ctrl.matches;
    expect(snap1).not.toBe(snap0); // NEW reference (not in-place push)
    expect(snap1).toEqual([10, 20]);
    expect(listener.mock.calls.length).toBe(callsAfterRun + 1); // notified once

    ch!.onmessage!({ kind: "batch", matches: [30] });
    const snap2 = ctrl.matches;
    expect(snap2).not.toBe(snap1); // NEW reference again
    expect(snap2).not.toBe(snap0);
    expect(snap2).toEqual([10, 20, 30]);
    expect(listener.mock.calls.length).toBe(callsAfterRun + 2);

    unsub();
  });

  it("sets status='error' when invoke('search') rejects", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const ctrl = getSearchController("s4", { root: {} }, 100);
    const listener = vi.fn();
    ctrl.subscribe(listener);

    await ctrl.run(); // run() must catch the rejection -> status="error"
    expect(ctrl.status).toBe("error");
    expect(ctrl.matches).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  // I1: the controller is a singleton keyed on (sessionId, query, cap), so
  // re-running the SAME query (via SearchPanel history ◀▶▾ or re-clicking
  // Search with an unchanged form) reuses the controller whose `matches`
  // still hold the prior run. Without a reset at the top of run(), new batches
  // append onto the old → duplicate, ever-growing results + inflated "N 命中".
  // run() must reset `matches = []` (a fresh array — referentially stable for
  // useSyncExternalStore) BEFORE the second run's batches arrive.
  it("resets matches on re-run (no duplicate accumulation across runs)", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = getSearchController("s-rerun", { root: {} }, 100);

    // First run → one batch → done.
    await ctrl.run();
    const ch1 = lastChannel();
    ch1!.onmessage!({ kind: "batch", matches: [1] });
    expect(ctrl.matches).toEqual([1]);
    ch1!.onmessage!({ kind: "done", matched: 1, cancelled: false, truncated: false });
    expect(ctrl.status).toBe("done");

    // Second run of the SAME query reuses the controller (same registry key).
    // matches MUST be reset to [] before the second run's batches arrive.
    await ctrl.run();
    expect(ctrl.matches).toEqual([]); // RESET on re-run (fails pre-fix: still [1])
    expect(ctrl.status).toBe("running");

    // A fresh channel is created each run; the second run's batch must append
    // onto the EMPTY array, not onto the prior run's [1].
    const ch2 = lastChannel();
    expect(ch2).not.toBe(ch1);
    ch2!.onmessage!({ kind: "batch", matches: [2, 3] });
    expect(ctrl.matches).toEqual([2, 3]); // NOT [1, 2, 3] (pre-fix accumulation)
  });
});

// Prove the React hook wiring (useSyncExternalStore) actually re-renders the
// component when a batch arrives. The controller-level tests above pin the
// snapshot contract; this pins that the hook subscribes to it correctly.
describe("useSearch (React hook) re-renders on batch", () => {
  it("exposes matches/status that update as batches stream in", async () => {
    invokeMock.mockImplementation(async () => {});
    const { result } = renderHook(() => useSearch("s-react", { root: {} }, 100));

    expect(result.current.matches).toEqual([]);
    expect(result.current.status).toBe("idle");

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.status).toBe("running");

    const ch = lastChannel();
    await act(async () => {
      ch!.onmessage!({ kind: "batch", matches: [7, 8] });
    });
    expect(result.current.matches).toEqual([7, 8]);

    await act(async () => {
      ch!.onmessage!({ kind: "done", matched: 2, cancelled: false, truncated: false });
    });
    expect(result.current.status).toBe("done");
    expect(result.current.matches).toEqual([7, 8]);
  });
});

// ---------------------------------------------------------------------------
// useCrossFileSearch: aggregates per-session useSearch results into a flat
// {sessionId, matches, status}[] list (B4 — cross-file Find-in-Files). Reuses
// `useSearch` verbatim (the controller registry dedupes by (sessionId, query,
// cap), so the active session's controller here is the SAME singleton App's
// lifted useSearch owns). This drives three sessions' channels and proves the
// hook aggregates each session's matches into one entry per session.
// ---------------------------------------------------------------------------
describe("useCrossFileSearch aggregates per-session matches", () => {
  it("returns one {sessionId,matches,status} per session, each reactive to its own channel", async () => {
    invokeMock.mockImplementation(async () => {});
    const query = { root: { kind: "leaf", predicate: { kind: "text", text: "refused" } } };
    const { result } = renderHook(() =>
      useCrossFileSearch(["s1", "s2", "s3"], query, 100),
    );

    // Three entries, one per session, idle + empty before any run.
    expect(result.current.results).toHaveLength(3);
    expect(result.current.results.map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(result.current.results.every((r) => r.matches.length === 0)).toBe(true);

    // run() fans out to ALL sessions — each creates its own channel.
    await act(async () => {
      await result.current.run();
    });
    const chans = allChannels();
    expect(chans).toHaveLength(3);

    // Stream a different match-count into each session's channel.
    await act(async () => {
      chans[0].onmessage!({ kind: "batch", matches: [1, 2, 3, 4, 5, 6, 7, 8] }); // a.log · 8
      chans[1].onmessage!({ kind: "batch", matches: [10, 11, 12, 13] }); // b.log · 4
      chans[2].onmessage!({ kind: "batch", matches: [20, 21, 22, 23, 24] }); // c.log · 5
    });
    expect(result.current.results.map((r) => [r.sessionId, r.matches.length])).toEqual([
      ["s1", 8],
      ["s2", 4],
      ["s3", 5],
    ]);

    // A second batch into s1 appends (s1's matches grow 8 → 9) without
    // disturbing s2/s3 — proves per-session reactivity, not a shared array.
    await act(async () => {
      chans[0].onmessage!({ kind: "batch", matches: [99] });
    });
    expect(result.current.results[0].matches).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 99]);
    expect(result.current.results[1].matches).toEqual([10, 11, 12, 13]);
    expect(result.current.results[2].matches).toEqual([20, 21, 22, 23, 24]);
  });

  it("shares the active session's controller with useSearch (registry dedup — no duplicate scan)", async () => {
    invokeMock.mockImplementation(async () => {});
    const query = { root: { kind: "leaf", predicate: { kind: "text", text: "x" } } };
    // The active session's controller, obtained directly via getSearchController
    // (the SAME singleton useSearch subscribes to).
    const activeCtrl = getSearchController("s1", query, 100);

    const { result } = renderHook(() =>
      useCrossFileSearch(["s1", "s2"], query, 100),
    );
    await act(async () => {
      await result.current.run();
    });
    const chans = allChannels();
    // Drive s1's channel. Because the cross-file slot for s1 resolved to the
    // SAME controller as `activeCtrl`, activeCtrl.matches must reflect the
    // batch too — proving no duplicate controller/scan was created.
    await act(async () => {
      chans[0].onmessage!({ kind: "batch", matches: [5, 6, 7] });
    });
    expect(activeCtrl.matches).toEqual([5, 6, 7]);
    expect(result.current.results[0].matches).toBe(activeCtrl.matches); // same ref
  });

  it("cancel() fans out to every session's controller", async () => {
    invokeMock.mockImplementation(async () => {});
    const query = { root: { kind: "leaf", predicate: { kind: "text", text: "x" } } };
    const { result } = renderHook(() =>
      useCrossFileSearch(["s1", "s2"], query, 100),
    );
    await act(async () => {
      await result.current.run();
    });
    // invoke('cancel_search', {sessionId}) is fired once per session.
    invokeMock.mockClear();
    result.current.cancel();
    const cancels = invokeMock.mock.calls.filter((c) => c[0] === "cancel_search");
    expect(cancels).toHaveLength(2);
    expect(cancels.map((c) => (c[1] as { sessionId: string }).sessionId).sort()).toEqual(["s1", "s2"]);
  });

  // I1: useCrossFileSearch maps `sessionIds` over a fixed 8-element `slots`
  // array (the unrolled `useSearch` calls — rules-of-hooks forbid a variable
  // loop count). With 9+ sessions, `slots[i]` (i>=8) was `undefined` →
  // `slots[i].matches` threw a TypeError DURING render → the tree unmounted.
  // The intent was graceful degradation ("search only the first 8"). Assert:
  // no crash, results clamped to 8, and only the first 8 sessions are
  // actually scanned (s9/s10 get no channel — never invoke('search')).
  it("clamps to MAX_CROSS_SESSIONS (8) — no crash with >8 sessions, only the first 8 searched", async () => {
    invokeMock.mockImplementation(async () => {});
    const query = { root: { kind: "leaf", predicate: { kind: "text", text: "x" } } };
    // 10 sessions — pre-fix this threw during render (slots[8] undefined).
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"];

    // renderHook itself must NOT throw (pre-fix: TypeError reading
    // slots[8].matches). results clamped to the 8-slot cap; s9, s10 dropped.
    const { result } = renderHook(() => useCrossFileSearch(ids, query, 100));
    expect(result.current.results).toHaveLength(8);
    expect(result.current.results.map((r) => r.sessionId)).toEqual(ids.slice(0, 8));

    // run() fans out to the first 8 ONLY — exactly 8 channels created (s9,
    // s10 never scanned). Pre-fix run() also sliced past slots.length.
    await act(async () => {
      await result.current.run();
    });
    expect(allChannels()).toHaveLength(8);
    const searchedSids = invokeMock.mock.calls
      .filter((c) => c[0] === "search")
      .map((c) => (c[1] as { sessionId: string }).sessionId);
    expect(searchedSids).toEqual(ids.slice(0, 8));
  });
});

// ---------------------------------------------------------------------------
// ipc archive: scanDir typed wrapper over the `scan_dir` command (Task 7).
// The brief's test sketches its own `vi.mock("@tauri-apps/api/core", ...)` with
// `vi.importActual` (real `Channel`) + a fresh `invoke: vi.fn()`. Appended
// verbatim, that second `vi.mock` would OVERRIDE this file's module-level mock
// (above, which stubs `Channel` with `MockChannel`) — the real `Channel`
// constructor touches `window.__TAURI_INTERNALS__` (absent in jsdom) and throws,
// breaking every search-controller test above. So this case reuses the existing
// `invokeMock` (the established handle throughout this file) instead of a
// competing mock. The load-bearing assertions are the brief's verbatim:
// `scan_dir` invoked with `{ path }`, and the response's `logFiles` pass-through.
// `extractArchive` is imported above so its missing export turns the file red
// pre-implementation; its streaming shape is verified in Task 8's e2e.
// ---------------------------------------------------------------------------
describe("ipc archive", () => {
  it("scanDir invokes scan_dir with the path", async () => {
    invokeMock.mockResolvedValue({ logFiles: ["a.log"], archiveHint: [] });
    const res = await scanDir("/some/dir");
    expect(invokeMock).toHaveBeenCalledWith("scan_dir", { path: "/some/dir" });
    expect(res.logFiles).toEqual(["a.log"]);
  });
});
