import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  openFile,
  getSearchController,
  useSearch,
  type SearchEvent,
} from "./ipc";

// `vi.hoisted` makes the mock fn + Channel stub available to the `vi.mock`
// factory (the factory runs during import resolution, before the module body).
//
// @tauri-apps/api v2 note: the real `Channel` is Tauri-runtime-bound — its
// constructor touches `window.__TAURI_INTERNALS__`, which jsdom does not
// provide, so `new Channel()` throws. Unit tests therefore stub `Channel`
// with a constructible that records the latest instance, letting the test
// drive `channel.onmessage` directly to prove the batch-accumulation logic.
// The real streaming path (Rust `on_event.send` -> JS `channel.onmessage`)
// is proven end-to-end in ③b/④.
const { invokeMock, MockChannel, lastChannel } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  let last: { onmessage?: (msg: SearchEvent) => void } | null = null;
  class MockChannel<T = unknown> {
    onmessage?: (msg: T) => void;
    constructor(onmessage?: (msg: T) => void) {
      if (onmessage) this.onmessage = onmessage;
      last = this as unknown as { onmessage?: (msg: SearchEvent) => void };
    }
  }
  (MockChannel as unknown as { __lastChannel: () => typeof last }).__lastChannel = () => last;
  const lastChannel = () =>
    (MockChannel as unknown as { __lastChannel: () => { onmessage?: (e: SearchEvent) => void } }).__lastChannel();
  return { invokeMock, MockChannel, lastChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  Channel: MockChannel,
}));

beforeEach(() => {
  invokeMock.mockReset();
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
