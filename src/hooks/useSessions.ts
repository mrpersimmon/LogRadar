// Open-files registry: tracks every open log session (Map sessionId -> meta)
// plus the currently-active one. `open` calls ③a's `openFile` (returns the
// session id + line metadata) and registers it; `close` calls ③a's
// `closeSession` then removes the entry and reassigns active to a surviving
// session (or null when the last one closes). sessions + activeId are held in a
// single state object so `close` can delete and reassign atomically.

import { useState, useCallback } from "react";
import {
  openFile,
  closeSession,
  evictSearchControllers,
  extractArchive,
  scanDir,
  type OpenResponse,
  type ExtractProgress,
} from "../lib/ipc";

export type SessionMeta = OpenResponse & {
  /** Absolute path the session was opened from. */
  path: string;
};

export type SessionsApi = {
  sessions: Map<string, SessionMeta>;
  activeId: string | null;
  open: (path: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  openArchive: (path: string, onProgress: (p: ExtractProgress) => void) => Promise<void>;
  openFolder: (path: string) => Promise<{ archiveHint: string[] }>;
};

type SessionsState = {
  sessions: Map<string, SessionMeta>;
  activeId: string | null;
};

export function useSessions(): SessionsApi {
  const [state, setState] = useState<SessionsState>({
    sessions: new Map(),
    activeId: null,
  });

  const open = useCallback(async (path: string) => {
    const res = await openFile(path);
    const entry: SessionMeta = { ...res, path };
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.set(res.sessionId, entry);
      return { sessions, activeId: res.sessionId };
    });
  }, []);

  const close = useCallback(async (id: string) => {
    await closeSession(id);
    // Evict this session's search controllers from the singleton registry so
    // it doesn't leak across open/close cycles (their Channels are dead now).
    evictSearchControllers(id);
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.delete(id);
      // Reassign active only if we just closed the active session; otherwise
      // leave it. When no sessions survive, activeId becomes null.
      const activeId =
        prev.activeId === id
          ? [...sessions.keys()][0] ?? null
          : prev.activeId;
      return { sessions, activeId };
    });
  }, []);

  const setActive = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeId: id }));
  }, []);

  // Task 8: openArchive extracts an archive (streaming progress over the
  // ExtractProgress channel) then opens each returned logFile via the hook's
  // own `open` — so each extracted log is registered as a session + set active,
  // exactly as if the user had opened it directly. `open` is a dep because the
  // loop calls it; `extractArchive`/`scanDir` are module-level imports (stable)
  // so they don't need to be listed.
  const openArchive = useCallback(
    async (path: string, onProgress: (p: ExtractProgress) => void) => {
      const resp = await extractArchive(path, onProgress);
      for (const log of resp.logFiles) {
        await open(log);
      }
    },
    [open],
  );

  // Task 8: openFolder scans a directory for logs, opens each found logFile
  // via `open`, and returns the archiveHint (paths of archives found inside
  // the dir that the caller may offer to extract). Mirrors openArchive's shape.
  const openFolder = useCallback(
    async (path: string) => {
      const resp = await scanDir(path);
      for (const log of resp.logFiles) {
        await open(log);
      }
      return { archiveHint: resp.archiveHint };
    },
    [open],
  );

  return {
    sessions: state.sessions,
    activeId: state.activeId,
    open,
    close,
    setActive,
    openArchive,
    openFolder,
  };
}
