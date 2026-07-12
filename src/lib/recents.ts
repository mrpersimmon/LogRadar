// Recents store (Task 3 ④a): the most-recently-opened log file paths, persisted
// to localStorage under `logradar-recents` as a JSON string array. The
// WelcomePage reads this list on mount and renders each path as a clickable
// row; clicking a row (or opening via the dialog) re-opens the file and calls
// `addRecent` to bump it to most-recent-first.
//
// Contract: `addRecent(path)` prepends `path` (most-recent-first), removes any
// prior occurrence (dedupe), and caps the list at 20 entries (oldest beyond the
// cap dropped). `getRecents()` reads the list back. Both are defensive against
// a tampered/corrupt store: a missing key, malformed JSON, a non-array payload,
// non-string entries, or a quota-exceeded write all collapse gracefully rather
// than throwing — localStorage is user-writable, so the store must never crash
// the WelcomePage mount that reads it on every app start.

const KEY = "logradar-recents";
const CAP = 20;

/** Read the recents list. Defensive: any corruption → `[]`. */
export function getRecents(): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return []; // localStorage unavailable (private mode / disabled)
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // malformed JSON → treat as empty
  }
  if (!Array.isArray(parsed)) return []; // non-array payload → empty
  return parsed.filter((p): p is string => typeof p === "string");
}

/** Record a freshly-opened path: prepend (most-recent-first), dedupe, cap 20. */
export function addRecent(path: string): void {
  if (typeof path !== "string" || path === "") return;
  const next = [path, ...getRecents().filter((p) => p !== path)].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // quota exceeded / storage unavailable — recents are non-critical; drop.
  }
}
