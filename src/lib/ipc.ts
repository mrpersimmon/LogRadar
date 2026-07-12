// IPC client: typed `invoke` wrappers around sub-project ②'s Tauri commands
// (src-tauri/src/commands.rs), plus a reactive `useSearch` that streams
// `SearchEvent` batches over a Tauri 2.x `Channel<T>`.
//
// JSON contract is camelCase throughout, matching the Rust side's
// `#[serde(rename_all = "camelCase")]`.

import { useSyncExternalStore } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

export type OpenResponse = {
  sessionId: string;
  lineCount: number;
  encoding: string;
  isJson: boolean;
  timestampFmt: string;
};

export type SearchEvent =
  | { kind: "batch"; matches: number[] }
  | { kind: "done"; matched: number; cancelled: boolean; truncated: boolean };

export type Workspace = { name: string; files: string[]; queries: unknown[] };

export function openFile(path: string) {
  return invoke<OpenResponse>("open_file", { path });
}

export function getLines(sessionId: string, start: number, count: number) {
  return invoke<string[]>("get_lines", { sessionId, start, count });
}

export function cancelSearch(sessionId: string) {
  return invoke<boolean>("cancel_search", { sessionId });
}

export function closeSession(sessionId: string) {
  return invoke<boolean>("close_session", { sessionId });
}

export function exportFile(sessionId: string, query: unknown, columns: string[], target: string) {
  return invoke<number>("export", { sessionId, query, columns, target });
}

export function workspaceSave(ws: Workspace) {
  return invoke<void>("workspace_save", { ws });
}

export function workspaceLoad(name: string) {
  return invoke<Workspace>("workspace_load", { name });
}

export function workspaceList() {
  return invoke<string[]>("workspace_list");
}

// Streaming search via a Tauri 2.x `Channel`. The Rust `search` command takes
// `on_event: Channel<SearchEvent>`; Tauri maps the JS-side `onEvent` arg to it
// and routes `on_event.send(ev)` into `channel.onmessage` here.
//
// The controller is `useSyncExternalStore`-ready: it exposes `subscribe` plus a
// `getSnapshot` that returns a referentially-stable array reference — stable
// across reads while nothing changed, and a NEW reference whenever a batch
// arrives (`matches = [...matches, ...batch.matches]`, never in-place `push`).
// The React hook `useSearch` below wires that store into React. The unit test
// drives `channel.onmessage` directly to prove both the snapshot contract and
// the batch-accumulation logic; the real Channel streaming is proven
// end-to-end in ③b/④.
export type SearchStatus = "idle" | "running" | "done" | "cancelled" | "error";

export interface SearchController {
  /** Current matches snapshot (referentially stable until a new batch arrives). */
  readonly matches: number[];
  readonly status: SearchStatus;
  /** Register a listener; returns an unsubscribe function. */
  subscribe: (cb: () => void) => () => void;
  /** Snapshot getter for `useSyncExternalStore` — returns the live matches ref. */
  getSnapshot: () => number[];
  /** Snapshot getter for `useSyncExternalStore` — returns the status primitive. */
  getStatus: () => SearchStatus;
  run: () => Promise<void>;
  cancel: () => void;
}

// Singleton-per-(sessionId, query, cap): re-renders call `useSearch` again but
// must NOT restart the search — the same controller (and its in-flight channel)
// is reused. Keyed on the JSON-serialized query so shape-equal queries hit the
// same controller even across distinct object identities.
const controllerRegistry = new Map<string, SearchController>();

function controllerKey(sessionId: string, query: unknown, cap: number): string {
  return `${sessionId}:${cap}:${JSON.stringify(query)}`;
}

/**
 * Returns the singleton search controller for (sessionId, query, cap).
 * Exposed so unit tests can drive `channel.onmessage` and assert snapshot
 * referential stability without spinning up a React renderer.
 */
export function getSearchController(
  sessionId: string,
  query: unknown,
  cap: number,
): SearchController {
  const key = controllerKey(sessionId, query, cap);
  const cached = controllerRegistry.get(key);
  if (cached) return cached;
  const created = createSearchController(sessionId, query, cap);
  controllerRegistry.set(key, created);
  return created;
}

/** Test-only escape hatch: clears the singleton registry between cases. */
export function __resetSearchControllers(): void {
  controllerRegistry.clear();
}

function createSearchController(
  sessionId: string,
  query: unknown,
  cap: number,
): SearchController {
  let matches: number[] = [];
  let status: SearchStatus = "idle";
  let channel: Channel<SearchEvent> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };

  const ctrl: SearchController = {
    get matches() {
      return matches;
    },
    get status() {
      return status;
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => matches,
    getStatus: () => status,
    async run() {
      // I1: reset matches on (re)run. The controller is a singleton keyed on
      // (sessionId, query, cap), so re-running the SAME query (via SearchPanel
      // history ◀▶▾ or re-clicking Search with an unchanged form) reuses this
      // controller whose `matches` still hold the prior run. Without this
      // reset, new batches would append onto the old → duplicate, ever-growing
      // results + inflated "N 命中". A fresh empty array (not in-place
      // `matches.length = 0`) gives a NEW reference so `useSyncExternalStore`
      // sees a changed snapshot and re-renders. Notify so subscribers see the
      // reset before status flips to "running".
      matches = [];
      notify();
      status = "running";
      notify();
      channel = new Channel<SearchEvent>();
      channel.onmessage = (msg) => {
        if (msg.kind === "batch") {
          // NEW array reference each batch — never mutate in place, so
          // `useSyncExternalStore` sees a changed snapshot and re-renders.
          matches = [...matches, ...msg.matches];
          notify();
        } else {
          status = msg.cancelled ? "cancelled" : "done";
          notify();
        }
      };
      try {
        await invoke("search", { sessionId, query, cap, onEvent: channel });
      } catch {
        status = "error";
        notify();
      }
    },
    cancel() {
      if (sessionId) cancelSearch(sessionId);
    },
  };
  return ctrl;
}

/**
 * Reactive React binding over the singleton search controller. `matches` and
 * `status` are read through `useSyncExternalStore`, so the component re-renders
 * whenever a batch arrives (new array ref) or the status changes. Re-renders
 * reuse the same controller — they do not restart the search.
 */
export function useSearch(sessionId: string, query: unknown, cap: number): {
  matches: number[];
  status: SearchStatus;
  run: () => Promise<void>;
  cancel: () => void;
} {
  const ctrl = getSearchController(sessionId, query, cap);
  const matches = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);
  const status = useSyncExternalStore(ctrl.subscribe, ctrl.getStatus);
  return { matches, status, run: ctrl.run, cancel: ctrl.cancel };
}

// ---------------------------------------------------------------------------
// Cross-file search aggregation (spec B4 — "一个命中文件全路径一行" flat
// results). Runs `useSearch` per session and aggregates each session's matches
// into a flat per-session result list so SearchPanel can render one row per
// matched file (path · N hits) across ALL open sessions — not just the active
// one. Reuses `useSearch` verbatim: the controller registry dedupes by
// (sessionId, query, cap), so the active session's slot here resolves to the
// SAME singleton controller App's lifted `useSearch` owns — no duplicate scan,
// and the active session's matches stay shared with VirtualLogView's hits.
//
// React's rules-of-hooks forbid calling `useSearch` a variable number of times
// (the count must be stable across renders), so this hook pads `sessionIds`
// up to a fixed slot count with a stable sentinel (sessionId="" + sentinel
// query) whose controller stays idle forever — never run, never scans. The
// sentinel key is constant, so the registry collapses every unused slot to a
// SINGLE idle controller regardless of how many slots are empty.
// ---------------------------------------------------------------------------

/** The maximum number of open sessions cross-file search aggregates across.
 *  Tabs beyond this count are simply not searched (v1 cap; SplitView uses 2,
 *  TabStrip realistically < this). Unrolled `useSearch` calls keep the hook
 *  rules-of-hooks compliant (a loop would trip the linter). */
const MAX_CROSS_SESSIONS = 8;

/** Sentinel session id for empty slots — real session ids are Rust UUIDs, so
 *  "" never collides with a real session. */
const SENTINEL_SID = "";

/** A stable idle query for sentinel slots. Identical shape to SearchPanel's
 *  EMPTY_QUERY (a leaf text predicate on ""), but defined locally to avoid a
 *  circular import (SearchPanel imports from this module). Its controller is
 *  never run → never scans → stays idle forever. */
const SENTINEL_QUERY: { root: { kind: "leaf"; predicate: { kind: "text"; text: string } } } = {
  root: { kind: "leaf", predicate: { kind: "text", text: "" } },
};

export type CrossFileResult = {
  sessionId: string;
  matches: number[];
  status: SearchStatus;
};

/**
 * Reactive cross-file search: one `{sessionId, matches, status}` per entry in
 * `sessionIds`, plus `run`/`cancel` that fan out to every session's controller.
 * `results` is a fresh array each render but each entry's `matches` is the
 * referentially-stable snapshot array from that session's controller (so React
 * sees a changed reference only when a batch actually arrived).
 */
export function useCrossFileSearch(
  sessionIds: string[],
  query: unknown,
  cap: number,
): {
  results: CrossFileResult[];
  run: () => Promise<void>;
  cancel: () => void;
} {
  // Fixed-slot padding (unrolled to satisfy rules-of-hooks): real sessions use
  // the real query; empty slots use the sentinel (idle forever). The registry
  // dedupes the sentinel to one entry, so the unused slots cost nothing.
  const s0 = useSearch(sessionIds[0] ?? SENTINEL_SID, sessionIds[0] ? query : SENTINEL_QUERY, cap);
  const s1 = useSearch(sessionIds[1] ?? SENTINEL_SID, sessionIds[1] ? query : SENTINEL_QUERY, cap);
  const s2 = useSearch(sessionIds[2] ?? SENTINEL_SID, sessionIds[2] ? query : SENTINEL_QUERY, cap);
  const s3 = useSearch(sessionIds[3] ?? SENTINEL_SID, sessionIds[3] ? query : SENTINEL_QUERY, cap);
  const s4 = useSearch(sessionIds[4] ?? SENTINEL_SID, sessionIds[4] ? query : SENTINEL_QUERY, cap);
  const s5 = useSearch(sessionIds[5] ?? SENTINEL_SID, sessionIds[5] ? query : SENTINEL_QUERY, cap);
  const s6 = useSearch(sessionIds[6] ?? SENTINEL_SID, sessionIds[6] ? query : SENTINEL_QUERY, cap);
  const s7 = useSearch(sessionIds[7] ?? SENTINEL_SID, sessionIds[7] ? query : SENTINEL_QUERY, cap);
  const slots = [s0, s1, s2, s3, s4, s5, s6, s7];

  const results: CrossFileResult[] = sessionIds.map((sid, i) => ({
    sessionId: sid,
    matches: slots[i].matches,
    status: slots[i].status,
  }));

  const run = async () => {
    // Fan out to every real session's controller (sentinel slots excluded).
    // `slots[i].run` is each controller's stable singleton `run`, so even
    // though `slots` is re-derived per render, the methods resolve to the same
    // controllers the registry owns.
    await Promise.all(slots.slice(0, sessionIds.length).map((s) => s.run()));
  };
  const cancel = () => {
    slots.slice(0, sessionIds.length).forEach((s) => s.cancel());
  };
  return { results, run, cancel };
}
