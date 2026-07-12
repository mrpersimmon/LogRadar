import { describe, it, expect, vi, beforeEach } from "vitest";
import { openFile, useSearch, type SearchEvent } from "./ipc";

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

describe("useSearch accumulates batches", () => {
  it("collects matches from batch events and marks done", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = useSearch("s1", { root: {} }, 100);
    await ctrl.run(); // invokes `search` (mocked no-op); channel.onmessage is wired
    expect(ctrl.status).toBe("running");
    expect(ctrl.matches).toEqual([]);

    // Simulate the Rust side emitting events through the wired Channel.
    const ch = lastChannel();
    expect(ch.onmessage).toBeDefined();

    ch.onmessage!({ kind: "batch", matches: [10, 20, 30] });
    expect(ctrl.matches).toEqual([10, 20, 30]);

    ch.onmessage!({ kind: "batch", matches: [40] });
    expect(ctrl.matches).toEqual([10, 20, 30, 40]);

    ch.onmessage!({ kind: "done", matched: 4, cancelled: false, truncated: false });
    expect(ctrl.status).toBe("done");
  });

  it("marks status cancelled when the done event carries cancelled=true", async () => {
    invokeMock.mockImplementation(async () => {});
    const ctrl = useSearch("s2", { root: {} }, 50);
    await ctrl.run();
    const ch = lastChannel();
    ch.onmessage!({ kind: "done", matched: 0, cancelled: true, truncated: false });
    expect(ctrl.status).toBe("cancelled");
  });
});
