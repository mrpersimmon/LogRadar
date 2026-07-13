// Open-files registry: tracks every open log session (Map sessionId -> meta)
// plus the currently-active one. `open` calls ③a's `openFile` (returns the
// session id + line metadata) and registers it; `close` calls ③a's
// `closeSession` then removes the entry and reassigns active to a surviving
// session (or null when the last one closes). sessions + activeId are held in a
// single state object so `close` can delete and reassign atomically.

import { useState, useCallback } from "react";
import { openFile, closeSession, evictSearchControllers, type OpenResponse } from "../lib/ipc";

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

  return {
    sessions: state.sessions,
    activeId: state.activeId,
    open,
    close,
    setActive,
  };
}
