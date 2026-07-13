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

/** Drop every search controller registered for `sessionId`. Called on session
 *  close so the registry doesn't grow unbounded across open/close cycles: a
 *  closed session's controllers (one per distinct query/cap combo — the
 *  cross-file search pads up to MAX_CROSS_SESSIONS slots, and history re-runs
 *  accumulate distinct query keys) are stale (their Channel is dead, the
 *  session is gone from the backend) and must not linger. Keys are
 *  `${sessionId}:${cap}:${json}`, so the `${sessionId}:` prefix matches every
 *  controller for that session and ONLY that session — the colon delimiter
 *  means one id can't be a prefix of another, and real session ids (Rust
 *  UUIDs, no colons) can't collide with the sentinel (`""`). */
export function evictSearchControllers(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of [...controllerRegistry.keys()]) {
    if (key.startsWith(prefix)) controllerRegistry.delete(key);
  }
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
  // I1: clamp to MAX_CROSS_SESSIONS. The 8 `useSearch` calls below are
  // unrolled (rules-of-hooks forbid a variable loop count), so `slots` has a
  // fixed length of 8. Without clamping, 9+ sessions made `sessionIds.map`
  // read `slots[i]` (i>=8) → `undefined` → TypeError during render → tree
  // unmounts. The intent was graceful degradation ("search only the first 8"),
  // so clamp once at the top and map/run/cancel over `capped` only — `slots[i]`
  // stays in bounds and tabs beyond the cap are simply not searched.
  const capped = sessionIds.slice(0, MAX_CROSS_SESSIONS);

  // Fixed-slot padding (unrolled to satisfy rules-of-hooks): real sessions use
  // the real query; empty slots use the sentinel (idle forever). The registry
  // dedupes the sentinel to one entry, so the unused slots cost nothing.
  const s0 = useSearch(capped[0] ?? SENTINEL_SID, capped[0] ? query : SENTINEL_QUERY, cap);
  const s1 = useSearch(capped[1] ?? SENTINEL_SID, capped[1] ? query : SENTINEL_QUERY, cap);
  const s2 = useSearch(capped[2] ?? SENTINEL_SID, capped[2] ? query : SENTINEL_QUERY, cap);
  const s3 = useSearch(capped[3] ?? SENTINEL_SID, capped[3] ? query : SENTINEL_QUERY, cap);
  const s4 = useSearch(capped[4] ?? SENTINEL_SID, capped[4] ? query : SENTINEL_QUERY, cap);
  const s5 = useSearch(capped[5] ?? SENTINEL_SID, capped[5] ? query : SENTINEL_QUERY, cap);
  const s6 = useSearch(capped[6] ?? SENTINEL_SID, capped[6] ? query : SENTINEL_QUERY, cap);
  const s7 = useSearch(capped[7] ?? SENTINEL_SID, capped[7] ? query : SENTINEL_QUERY, cap);
  const slots = [s0, s1, s2, s3, s4, s5, s6, s7];

  const results: CrossFileResult[] = capped.map((sid, i) => ({
    sessionId: sid,
    matches: slots[i].matches,
    status: slots[i].status,
  }));

  const run = async () => {
    // Fan out to every real session's controller (sentinel slots excluded).
    // `slots[i].run` is each controller's stable singleton `run`, so even
    // though `slots` is re-derived per render, the methods resolve to the same
    // controllers the registry owns. `capped.length` (not sessionIds.length)
    // keeps the slice in bounds when sessionIds exceeds the 8-slot cap.
    await Promise.all(slots.slice(0, capped.length).map((s) => s.run()));
  };
  const cancel = () => {
    slots.slice(0, capped.length).forEach((s) => s.cancel());
  };
  return { results, run, cancel };
}

// ---------------------------------------------------------------------------
// Archive extract + scan_dir client wrappers (Task 7). `extractArchive`
// streams `ExtractProgress` over a Tauri 2.x `Channel` — the same pattern as
// `useSearch` above: construct `Channel`, set `onmessage`, pass it as the
// `onEvent` arg (Tauri maps JS `onEvent` → Rust `on_event: Channel<...>` and
// routes `on_event.send(ev)` into `channel.onmessage` here).
//
// Wire shape mirrors the Rust DTOs in src-tauri/src/commands.rs (verified):
//   ExtractProgress  #[serde(tag = "type", rename_all = "camelCase")]
//     File { done, total, current_file } → { type: "file", done, total, currentFile }
//   ExtractResponse { extracted_dir, log_files } → { extractedDir, logFiles }
//   ScanDirResponse { log_files, archive_hint }   → { logFiles, archiveHint }
//
// M3: the Rust enum previously had a `Done { extracted_dir, log_count }`
// variant, but the frontend's `onOpenArchive` callback only handles `type ===
// "file"` (it uses the command's return value `logFiles` for the final list),
// so `Done` was dead wire — emitted then ignored. It's dropped from the Rust
// enum + its emission; the TS union reflects just the `file` shape, and the
// terminal state travels in the `ExtractResponse` return value instead.
// ---------------------------------------------------------------------------

export type ExtractProgress = {
  type: "file";
  done: number;
  total: number;
  currentFile: string;
};

export type ExtractResponse = { extractedDir: string; logFiles: string[] };
export type ScanDirResponse = { logFiles: string[]; archiveHint: string[] };

export async function extractArchive(
  path: string,
  onProgress: (p: ExtractProgress) => void,
): Promise<ExtractResponse> {
  const ch = new Channel<ExtractProgress>();
  ch.onmessage = onProgress;
  return invoke<ExtractResponse>("extract_archive", { path, onEvent: ch });
}

export async function scanDir(path: string): Promise<ScanDirResponse> {
  return invoke<ScanDirResponse>("scan_dir", { path });
}
