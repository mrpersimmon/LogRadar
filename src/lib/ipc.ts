// IPC client: typed `invoke` wrappers around sub-project ②'s Tauri commands
// (src-tauri/src/commands.rs), plus a `useSearch` factory that streams
// `SearchEvent` batches over a Tauri 2.x `Channel<T>`.
//
// JSON contract is camelCase throughout, matching the Rust side's
// `#[serde(rename_all = "camelCase")]`.

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
// This is a thin ③a factory (plain controller, no React state reactivity);
// ③b can wrap it in `useSyncExternalStore` for reactive re-render. The unit
// test proves the `onmessage` batch-accumulation logic; the real Channel
// streaming is proven end-to-end in ③b/④.
export type SearchStatus = "idle" | "running" | "done" | "cancelled";

export interface SearchController {
  matches: number[];
  status: SearchStatus;
  run: () => Promise<void>;
  cancel: () => void;
}

export function useSearch(sessionId: string, query: unknown, cap: number): SearchController {
  const matches: number[] = [];
  let status: SearchStatus = "idle";
  let channel: Channel<SearchEvent> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  async function run() {
    status = "running";
    notify();
    channel = new Channel<SearchEvent>();
    channel.onmessage = (msg) => {
      if (msg.kind === "batch") {
        matches.push(...msg.matches);
        notify();
      } else {
        status = msg.cancelled ? "cancelled" : "done";
        notify();
      }
    };
    await invoke("search", { sessionId, query, cap, onEvent: channel });
  }

  function cancel() {
    if (sessionId) cancelSearch(sessionId);
  }

  return {
    get matches() {
      return matches;
    },
    get status() {
      return status;
    },
    run,
    cancel,
  };
}
