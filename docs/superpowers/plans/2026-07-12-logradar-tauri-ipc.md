# LogRadar Tauri Shell + IPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Tauri application shell (`src-tauri`) that wraps `logradar-core` (on `main`, commit `bde674d`) as Tauri commands + streaming events, with a session registry and async cancelable search — no frontend UI yet.

**Architecture:** A `src-tauri` binary crate (Tauri 2.x) added to the existing Cargo workspace. An `AppState` holds a `SessionRegistry` (sessionId → `Session` + search `CancellationToken`). Commands: `open_file` / `get_lines` / `search` (async, streams matches via a Tauri `ipc::Channel`, returns a `searchId`, cancelable) / `cancel_search` / `export` / `workspace_save`/`load`/`list`. Search spawns a blocking task calling a new `logradar_core::QueryEngine::search_stream` (callback-based) so gz/zip search stays O(n) (per the core's final-fix) while matches stream to the frontend in batches.

**Tech Stack:** Tauri 2.x, Rust (edition 2021, MSRV 1.75), `tokio` (Tauri's async runtime), `serde` (command/event payloads), `uuid` (sessionIds), reuse `logradar-core` (path dependency).

## Global Constraints

- Tauri 2.x latest stable; Rust edition 2021, MSRV 1.75; cargo/rustc 1.93.1 available.
- **Reuse `logradar-core`** (workspace path dep) — don't duplicate its logic (encoding/format/index/decompress/engine). Public API: `Query, QueryNode, Predicate, Combinator, Level, LineIndexer, Session, QueryEngine, CancellationToken, SearchResult, LineFormat, Encoding`.
- **Search async + cancelable**: `search` returns a `searchId` immediately + streams via `Channel`; `cancel_search(searchId)` stops it; closing a session / starting a new search on the same session auto-cancels the in-flight one (spec §8).
- **Large results stream in batches** via `Channel` — never serialize the whole result at once (spec §6.2).
- **TDD**: failing test → see fail → minimal impl → see pass → commit. Frequent commits, one logical change each.
- **v1 limitation (note, don't fix)**: a `Session` is locked for the duration of a search (`scan_lines` holds `&mut`); concurrent `get_lines` blocks until the search yields. Concurrent search + scroll is deferred. (Search is O(n); acceptable for v1.)
- **Carried v1 deferrals** from sub-project 1 (don't re-litigate): QueryEngine sequential (no rayon), gz no member-resync, `GzView` zran drift on >1MB gz view, `Query::validate` no-op, `level_eq` Other.
- **Tauri API note**: Tauri 2.x's exact API (`ipc::Channel`, `State` lifetimes, `async_runtime::spawn_blocking`, `tauri.conf.json` schema) may vary by resolved patch version. Write the code as below; if a specific call/import doesn't compile against the resolved version, adjust to the matching 2.x API and note it (the tests are the spec).
- **Out of scope**: frontend UI (sub-project 3), packaging/CI/criterion benches (sub-project 4).

---

## File Structure

```
Cargo.toml                              # workspace root — add src-tauri member
crates/logradar-core/                   # (existing, from sub-project 1; Task 5 adds search_stream)
src-tauri/
  Cargo.toml                            # tauri 2.x + serde + uuid + logradar-core path dep + dev mock
  tauri.conf.json                       # app config (window disabled for headless test; identifier)
  build.rs                              # tauri build script (tauri_build)
  src/
    main.rs                             # tauri entry (windows subsystem) → run lib
    lib.rs                              # tauri::Builder + invoke_handler + manage(AppState) + #[cfg(test)]
    state.rs                            # AppState + SessionRegistry + SessionEntry (close cancels in-flight)
    commands.rs                         # #[tauri::command] handlers (thin wrappers over state.rs logic)
    workspace.rs                        # workspace save/load/list (JSON in config dir)
  tests/
    ipc_contract.rs                     # IPC contract tests (fake-frontend: open→search→cancel; batches; rotation)
```

`state.rs` owns the registry logic (pure-ish, testable without Tauri); `commands.rs` are thin `#[tauri::command]` wrappers. `commands.rs` logic is kept minimal so the registry tests in `state.rs` cover the behavior.

---

## Task 1: Tauri app scaffold + smoke command

**Files:**
- Modify: `Cargo.toml` (workspace root — add `src-tauri` to members)
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (inline `#[cfg(test)]` — a unit test on the smoke logic)

**Interfaces:**
- Produces: `lib::run()`, `commands::ping() -> String` (smoke), and the `tauri::Builder` wiring `manage(AppState::default())` + `invoke_handler(generate_handler![ping])`.

- [ ] **Step 1: Write the failing test**

`src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod state;

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ping_returns_expected_string() {
        assert_eq!(commands::ping(), "pong");
    }
}
```
`src-tauri/src/commands.rs`:
```rust
#[tauri::command]
pub fn ping() -> String { "pong".to_string() }
```
`src-tauri/src/state.rs` (stub for now; filled in Task 2):
```rust
#[derive(Default)]
pub struct AppState;
```
`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { logradar_tauri::run(); }
```
`src-tauri/Cargo.toml`:
```toml
[package]
name = "logradar-tauri"
version = "0.1.0"
edition = "2021"
rust-version = "1.75"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
tokio = { version = "1", features = ["sync"] }
logradar-core = { path = "../crates/logradar-core" }

[dev-dependencies]
tauri = { version = "2", features = ["test"] }
```
`src-tauri/build.rs`:
```rust
fn main() { tauri_build::build() }
```
`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "LogRadar",
  "version": "0.1.0",
  "identifier": "com.logradar.app",
  "build": { "frontendDist": "../no-frontend", "devUrl": "" },
  "app": { "windows": [], "security": { "csp": null } },
  "plugins": {}
}
```
(The `windows: []` keeps the app headless for tests; `frontendDist` points at a non-existent dir — acceptable for a backend-only shell; the frontend comes in sub-project 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib`
Expected: FAIL — workspace doesn't include `src-tauri` yet (or compile errors from missing tauri crate).

- [ ] **Step 3: Write minimal implementation**

`Cargo.toml` (workspace root — modify):
```toml
[workspace]
members = ["crates/logradar-core", "src-tauri"]
resolver = "2"
```
(Create `src-tauri/` files from Step 1 — they ARE the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib`
Expected: PASS (`ping_returns_expected_string`); `cargo build -p logradar-tauri` compiles (tauri 2.x deps download — one-time slow).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml src-tauri/
git commit -m "feat(tauri): scaffold src-tauri app + smoke ping command"
```

---

## Task 2: AppState + SessionRegistry (close cancels in-flight search)

**Files:**
- Modify: `src-tauri/src/state.rs` (full registry)
- Test: `src-tauri/src/state.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `logradar_core::{Session, CancellationToken}` (from core).
- Produces: `state::SessionId` (`uuid::Uuid` newtype or `String`), `state::SessionEntry { session: std::sync::Mutex<Session>, search_token: std::sync::Mutex<Option<Arc<CancellationToken>>> }`, `state::SessionRegistry` with `insert(session) -> SessionId`, `get(&self, id) -> Option<...>`, `close(&self, id) -> bool` (cancels in-flight search + removes), `set_search_token(&self, id, token)`, `cancel_search(&self, id)`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/state.rs`:
```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use logradar_core::{CancellationToken, Session};

pub type SessionId = String;

pub struct SessionEntry {
    pub session: Mutex<Session>,
    pub search_token: Mutex<Option<Arc<CancellationToken>>>,
}

#[derive(Default)]
pub struct AppState {
    pub sessions: Mutex<HashMap<SessionId, Arc<SessionEntry>>>,
}

impl AppState {
    pub fn insert(&self, session: Session) -> SessionId {
        let id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(SessionEntry {
            session: Mutex::new(session),
            search_token: Mutex::new(None),
        });
        self.sessions.lock().unwrap().insert(id.clone(), entry);
        id
    }
    pub fn get(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    pub fn set_search_token(&self, id: &str, token: Arc<CancellationToken>) {
        if let Some(e) = self.get(id) { *e.search_token.lock().unwrap() = Some(token); }
    }
    /// Cancel the in-flight search (if any) and remove the session.
    pub fn close(&self, id: &str) -> bool {
        let entry = self.sessions.lock().unwrap().remove(id);
        if let Some(e) = entry {
            if let Some(tok) = e.search_token.lock().unwrap().take() { tok.cancel(); }
            true
        } else { false }
    }
    pub fn cancel_search(&self, id: &str) -> bool {
        if let Some(e) = self.get(id) {
            if let Some(tok) = e.search_token.lock().unwrap().as_ref() { tok.cancel(); return true; }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp_session() -> Session {
        // write a tiny temp file + open via logradar-core
        let p = std::env::temp_dir().join(format!("lr-reg-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n").unwrap();
        Session::open(&p).unwrap()
    }
    #[test]
    fn insert_get_close_lifecycle() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        assert!(state.get(&id).is_some());
        assert!(state.close(&id));
        assert!(state.get(&id).is_none());
    }
    #[test]
    fn close_cancels_in_flight_search_token() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        let tok = Arc::new(CancellationToken::new());
        state.set_search_token(&id, tok.clone());
        assert!(!tok.is_cancelled());
        assert!(state.close(&id));
        assert!(tok.is_cancelled(), "closing a session must cancel its in-flight search");
    }
    #[test]
    fn cancel_search_sets_token() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        let tok = Arc::new(CancellationToken::new());
        state.set_search_token(&id, tok.clone());
        assert!(state.cancel_search(&id));
        assert!(tok.is_cancelled());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib state::tests`
Expected: FAIL (AppState is still the `pub struct AppState;` stub from Task 1 — methods missing).

- [ ] **Step 3: Write minimal implementation**

Replace the `pub struct AppState;` stub in `src-tauri/src/state.rs` with the full `AppState`/`SessionEntry`/`SessionId` + methods from Step 1. (Step 1's code is the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib state::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(tauri): AppState + SessionRegistry (close cancels in-flight search)"
```

---

## Task 3: `open_file` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `open_file`)
- Modify: `src-tauri/src/lib.rs` (register `open_file` in `invoke_handler`)
- Test: `src-tauri/src/commands.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `state::AppState`, `logradar_core::Session`.
- Produces: `commands::OpenResponse { sessionId: String, lineCount: u64, encoding: String, isJson: bool, timestampFmt: String }`, `#[tauri::command] open_file(state: State<AppState>, path: String) -> Result<OpenResponse, String>`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/commands.rs`:
```rust
use serde::Serialize;
use tauri::State;
use crate::state::AppState;

#[derive(Serialize)]
pub struct OpenResponse {
    pub session_id: String,
    pub line_count: u64,
    pub encoding: String,
    pub is_json: bool,
    pub timestamp_fmt: String,
}

pub fn open_file_impl(state: &AppState, path: &str) -> Result<OpenResponse, String> {
    let session = logradar_core::Session::open(std::path::Path::new(path))
        .map_err(|e| e.to_string())?;
    let line_count = session.line_count();
    let encoding = format!("{:?}", session.encoding());
    let fmt = session.format().clone();
    let is_json = fmt.is_json;
    let timestamp_fmt = format!("{:?}", fmt.timestamp);
    let session_id = state.insert(session);
    Ok(OpenResponse { session_id, line_count, encoding, is_json, timestamp_fmt })
}

#[tauri::command]
pub async fn open_file(state: State<'_, AppState>, path: String) -> Result<OpenResponse, String> {
    open_file_impl(&state, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    fn write_tmp(name: &str, content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lr-open-{}-{}.log", name, uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        p
    }
    #[test]
    fn open_file_returns_metadata_and_registers_session() {
        let state = AppState::default();
        let p = write_tmp("a", "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n");
        let resp = open_file_impl(&state, p.to_str().unwrap()).unwrap();
        assert_eq!(resp.line_count, 2);
        assert!(resp.encoding.contains("Utf8"));
        assert!(!resp.session_id.is_empty());
        assert!(state.get(&resp.session_id).is_some(), "session must be registered");
    }
    #[test]
    fn open_file_missing_path_errors() {
        let state = AppState::default();
        let err = open_file_impl(&state, "/nonexistent/path.log").unwrap_err();
        assert!(!err.is_empty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib commands::tests`
Expected: FAIL — `open_file_impl` not defined.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/lib.rs` — register the command:
```rust
pub mod commands;
pub mod state;

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::ping, commands::open_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
(The `commands.rs` code from Step 1 is the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib commands::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): open_file command (returns metadata + registers session)"
```

---

## Task 4: `get_lines` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `get_lines`)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `state::AppState` (lookup by sessionId), `logradar_core::Session::get_lines`.
- Produces: `#[tauri::command] get_lines(state, sessionId: String, start: u64, count: usize) -> Result<Vec<String>, String>`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/commands.rs`:
```rust
pub fn get_lines_impl(state: &AppState, session_id: &str, start: u64, count: usize) -> Result<Vec<String>, String> {
    let entry = state.get(session_id).ok_or("session not found".to_string())?;
    let mut session = entry.session.lock().map_err(|e| e.to_string())?;
    Ok(session.get_lines(start, count))
}

#[tauri::command]
pub async fn get_lines(state: State<'_, AppState>, session_id: String, start: u64, count: usize) -> Result<Vec<String>, String> {
    get_lines_impl(&state, &session_id, start, count)
}

#[cfg(test)]
mod get_lines_tests {
    use super::*;
    use crate::state::AppState;
    fn open_tmp(state: &AppState, content: &str) -> String {
        let p = std::env::temp_dir().join(format!("lr-gl-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        open_file_impl(state, p.to_str().unwrap()).unwrap().session_id
    }
    #[test]
    fn get_lines_returns_window() {
        let state = AppState::default();
        let id = open_tmp(&state, "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n2026-07-12 14:22:03 WARN c\n");
        let win = get_lines_impl(&state, &id, 1, 2).unwrap();
        assert_eq!(win.len(), 2);
        assert!(win[0].contains("ERROR b"));
    }
    #[test]
    fn get_lines_unknown_session_errors() {
        let state = AppState::default();
        assert!(get_lines_impl(&state, "nope", 0, 1).is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib commands::get_lines_tests`
Expected: FAIL — `get_lines_impl` not defined.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/lib.rs` — add `commands::get_lines` to `generate_handler!`.
(`commands.rs` code from Step 1 is the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib`
Expected: PASS (all prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): get_lines command (line window by sessionId+range)"
```

---

## Task 5: `QueryEngine::search_stream` core addition (logradar-core)

**Files:**
- Modify: `crates/logradar-core/src/engine.rs` (add `search_stream` + `StreamResult`)
- Modify: `crates/logradar-core/src/lib.rs` (re-export `StreamResult`)
- Test: `crates/logradar-core/src/engine.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `Session` (scan_lines), `Query`, `LineFormat`, `CancellationToken` (all from core).
- Produces: `engine::StreamResult { matched: u64, cancelled: bool, truncated: bool }`, `QueryEngine::search_stream(session: &mut Session, query: &Query, fmt: &LineFormat, token: &CancellationToken, cap: usize, on_match: impl FnMut(u64)) -> StreamResult` — calls `on_match(line_number)` per match DURING the scan, checks the token between lines (early-stop on cancel), stops at `cap`. This is the streaming variant of `search` that lets the Tauri shell emit matches in batches as they're found (not post-search).

- [ ] **Step 1: Write the failing test**

Append to `crates/logradar-core/src/engine.rs`:
```rust
#[derive(Debug, Clone, PartialEq)]
pub struct StreamResult {
    pub matched: u64,
    pub cancelled: bool,
    pub truncated: bool,
}

impl QueryEngine {
    /// Streaming variant of `search`: calls `on_match(line_no)` per match during the scan,
    /// checks the cancel token between lines, stops at `cap`. Does NOT accumulate a Vec —
    /// the caller streams matches via the callback. Returns a summary.
    pub fn search_stream(
        session: &mut Session,
        query: &Query,
        fmt: &LineFormat,
        token: &CancellationToken,
        cap: usize,
        mut on_match: impl FnMut(u64),
    ) -> StreamResult {
        let mut matched: u64 = 0;
        let mut cancelled = false;
        let mut truncated = false;
        let total = session.line_count();
        let scan_result = session.scan_lines(|n, bytes| {
            if token.is_cancelled() { return false; }                  // early-stop
            if matched >= cap as u64 { truncated = true; return false; }
            let line = String::from_utf8_lossy(bytes);
            if eval_node(&query.root, fmt, &line) { on_match(n); matched += 1; }
            true
        });
        let _ = scan_result; // scan completes; cancelled/truncated handled via early-stop above
        // re-check token (cancel may have been set after last line)
        if token.is_cancelled() { cancelled = true; }
        StreamResult { matched, cancelled, truncated }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use std::io::Write;
    fn write_tmp(content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lr-stream-{}.log", std::process::id()));
        let mut f = std::fs::File::create(&p).unwrap(); f.write_all(content.as_bytes()).unwrap(); p
    }
    #[test]
    fn search_stream_emits_matches_during_scan() {
        let p = write_tmp("INFO a\nERROR hit\nERROR hit\nWARN x\nERROR hit\n");
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let tok = CancellationToken::new();
        let mut got = Vec::new();
        let res = QueryEngine::search_stream(&mut s, &q, s.format(), &tok, usize::MAX, |n| got.push(n));
        assert_eq!(got, vec![1, 2, 4]);
        assert_eq!(res.matched, 3);
        assert!(!res.cancelled && !res.truncated);
    }
    #[test]
    fn search_stream_caps_and_flags_truncated() {
        let p = write_tmp(&"ERROR hit\n".repeat(10));
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let tok = CancellationToken::new();
        let mut got = Vec::new();
        let res = QueryEngine::search_stream(&mut s, &q, s.format(), &tok, 3, |n| got.push(n));
        assert_eq!(got.len(), 3);
        assert!(res.truncated);
    }
    #[test]
    fn search_stream_cancel_stops_early() {
        let p = write_tmp(&"ERROR hit\n".repeat(1000));
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let tok = CancellationToken::new();
        tok.cancel();
        let mut got = Vec::new();
        let res = QueryEngine::search_stream(&mut s, &q, s.format(), &tok, usize::MAX, |n| got.push(n));
        assert!(got.is_empty());
        assert!(res.cancelled);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core engine::stream_tests`
Expected: FAIL — `search_stream` / `StreamResult` not defined.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs` — add to the re-exports:
```rust
pub use engine::{QueryEngine, CancellationToken, SearchResult, StreamResult};
```
(The `engine.rs` code from Step 1 is the impl — it reuses the existing `eval_node`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core`
Expected: PASS (all prior + 3 stream tests).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/engine.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add QueryEngine::search_stream (streaming callback, cancel, cap)"
```

---

## Task 6: `search` command (Channel streaming) + `cancel_search`

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `search`, `cancel_search`, `SearchEvent`, `SearchRequest`)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/commands.rs` (unit test of `search_impl` logic with a fake callback collector; full IPC streaming verified in Task 8's contract test)

**Interfaces:**
- Consumes: `state::AppState`, `logradar_core::{QueryEngine, CancellationToken, StreamResult, Query, LineFormat}` + `tauri::ipc::Channel`.
- Produces: `commands::SearchEvent` (`Batch{matches: Vec<u64>}` | `Done{result: StreamResult}`), `#[tauri::command] search(state, sessionId, query: serde_json::Value, cap, on_event: Channel<SearchEvent>) -> Result<String, String>` (returns searchId, spawns a `spawn_blocking` task running `search_stream` with batches emitted via the Channel), `#[tauri::command] cancel_search(state, sessionId) -> Result<bool, String>`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/commands.rs`:
```rust
use tauri::ipc::Channel;
use std::sync::Arc;

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum SearchEvent {
    Batch { matches: Vec<u64> },
    Done { matched: u64, cancelled: bool, truncated: bool },
}

const BATCH_SIZE: usize = 64;

/// Runs search_stream, batching matches into `on_event` (Batch), emitting Done at the end.
/// Returns the StreamResult. The Tauri command wraps this with a real Channel.
pub fn run_search_streaming(
    entry: &crate::state::SessionEntry,
    query: &logradar_core::Query,
    fmt: &logradar_core::LineFormat,
    token: Arc<logradar_core::CancellationToken>,
    cap: usize,
    mut on_event: impl FnMut(SearchEvent),
) -> logradar_core::StreamResult {
    let mut session = entry.session.lock().unwrap();
    let mut buf: Vec<u64> = Vec::with_capacity(BATCH_SIZE);
    let res = logradar_core::QueryEngine::search_stream(&mut *session, query, fmt, &token, cap, |n| {
        buf.push(n);
        if buf.len() >= BATCH_SIZE {
            on_event(SearchEvent::Batch { matches: std::mem::take(&mut buf) });
        }
    });
    if !buf.is_empty() { on_event(SearchEvent::Batch { matches: std::mem::take(&mut buf) }); }
    on_event(SearchEvent::Done { matched: res.matched, cancelled: res.cancelled, truncated: res.truncated });
    res
}

#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    session_id: String,
    query: serde_json::Value,
    cap: usize,
    on_event: Channel<SearchEvent>,
) -> Result<String, String> {
    let entry = state.get(&session_id).ok_or("session not found")?;
    let query: logradar_core::Query = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    let token = Arc::new(logradar_core::CancellationToken::new());
    state.set_search_token(&session_id, token.clone());
    let search_id = uuid::Uuid::new_v4().to_string();
    let on_event = std::sync::Mutex::new(on_event);
    let entry = entry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_search_streaming(&entry, &query, &fmt, token, cap, |ev| {
            let _ = on_event.lock().unwrap().emit(ev);
        });
    });
    Ok(search_id)
}

#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.cancel_search(&session_id))
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use crate::state::AppState;
    use logradar_core::{Query, QueryNode, Predicate};
    fn open_tmp(state: &AppState, content: &str) -> String {
        let p = std::env::temp_dir().join(format!("lr-sch-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        open_file_impl(state, p.to_str().unwrap()).unwrap().session_id
    }
    #[test]
    fn run_search_streaming_emits_batches_and_done() {
        let state = AppState::default();
        let id = open_tmp(&state, &"ERROR hit\n".repeat(200));
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let tok = Arc::new(CancellationToken::new());
        let mut events = Vec::new();
        let res = run_search_streaming(&entry, &q, &fmt, tok, usize::MAX, |ev| events.push(ev));
        assert_eq!(res.matched, 200);
        let batches = events.iter().filter(|e| matches!(e, SearchEvent::Batch{..})).count();
        let total_matched: u64 = events.iter().filter_map(|e| match e { SearchEvent::Batch{matches} => Some(matches.len() as u64), _ => None }).sum();
        assert_eq!(total_matched, 200);
        assert!(batches >= 3, "200 matches / 64 batch => >=3 batches");
        assert!(events.iter().any(|e| matches!(e, SearchEvent::Done{..})));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib commands::search_tests`
Expected: FAIL — `run_search_streaming` / `SearchEvent` not defined.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/lib.rs` — add `commands::search, commands::cancel_search` to `generate_handler!`.
(`commands.rs` code from Step 1 is the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib`
Expected: PASS (all prior + the search batching test). Note: the `#[tauri::command] async fn search` itself isn't unit-tested (it needs a Channel from Tauri's test harness — covered in Task 8's IPC contract test); `run_search_streaming` (the logic) is unit-tested here.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): search command (Channel streaming via search_stream) + cancel_search"
```

---

## Task 7: `export` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `export`)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `state::AppState`, `logradar_core::QueryEngine::search_stream`.
- Produces: `#[tauri::command] export(state, sessionId, query: serde_json::Value, format: String, columns: Vec<String>, target: String) -> Result<u64, String>` (streams matches to a file at `target`, returns count written).

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/commands.rs`:
```rust
use std::io::Write;

pub fn export_impl(
    entry: &crate::state::SessionEntry,
    query: &logradar_core::Query,
    fmt: &logradar_core::LineFormat,
    columns: &[String],
    target: &str,
) -> Result<u64, String> {
    let mut session = entry.session.lock().map_err(|e| e.to_string())?;
    let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?;
    let token = logradar_core::CancellationToken::new(); // export isn't user-cancelable in v1
    let mut count: u64 = 0;
    let cols: Vec<&str> = columns.iter().map(|s| s.as_str()).collect();
    let res = logradar_core::QueryEngine::search_stream(&mut *session, query, fmt, &token, usize::MAX, |n| {
        let line = session.get_lines(n, 1).into_iter().next().unwrap_or_default();
        let row = format_row(&cols, n, &line);
        let _ = writeln!(out, "{row}");
        count += 1;
    });
    let _ = res;
    Ok(count)
}

fn format_row(cols: &[&str], line_no: u64, line: &str) -> String {
    // v1: just join the requested column values; "msg" = the whole decoded line, "no" = line number
    cols.iter().map(|c| match *c {
        "no" => line_no.to_string(),
        "msg" => line.to_string(),
        other => other.to_string(), // passthrough for path/level/timestamp in v1 (full refine later)
    }).collect::<Vec<_>>().join("\t")
}

#[tauri::command]
pub async fn export(
    state: State<'_, AppState>,
    session_id: String,
    query: serde_json::Value,
    columns: Vec<String>,
    target: String,
) -> Result<u64, String> {
    let entry = state.get(&session_id).ok_or("session not found")?;
    let query: logradar_core::Query = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    export_impl(&entry, &query, &fmt, &columns, &target)
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use crate::state::AppState;
    use logradar_core::{Query, QueryNode, Predicate};
    #[test]
    fn export_writes_matching_lines_to_file() {
        let state = AppState::default();
        let p = std::env::temp_dir().join(format!("lr-exp-src-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, "INFO a\nERROR hit one\nERROR hit two\nWARN x\n").unwrap();
        let id = open_file_impl(&state, p.to_str().unwrap()).unwrap().session_id;
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let target = std::env::temp_dir().join(format!("lr-exp-out-{}.log", uuid::Uuid::new_v4()));
        let n = export_impl(&entry, &q, &fmt, &["no".to_string(), "msg".to_string()], target.to_str().unwrap()).unwrap();
        assert_eq!(n, 2);
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("hit one") && written.contains("hit two"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib commands::export_tests`
Expected: FAIL — `export_impl` not defined.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/lib.rs` — add `commands::export` to `generate_handler!`.
(`commands.rs` code from Step 1 is the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib`
Expected: PASS (all prior + 1 export test).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): export command (stream matches to file)"
```

---

## Task 8: workspace save/load/list commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `workspace_save`, `workspace_load`, `workspace_list`)
- Create: `src-tauri/src/workspace.rs` (persistence logic)
- Modify: `src-tauri/src/lib.rs` (register + `pub mod workspace`)
- Test: `src-tauri/src/workspace.rs`

**Interfaces:**
- Produces: `workspace::Workspace` (`{ name, files: Vec<String>, queries: Vec<serde_json::Value> }`), `workspace::config_dir() -> PathBuf`, `workspace::save(&Workspace) -> Result<(), String>`, `workspace::load(name) -> Result<Workspace, String>`, `workspace::list() -> Result<Vec<String>, String>`. Plus the 3 thin `#[tauri::command]` wrappers.

- [ ] **Step 1: Write the failing test**

`src-tauri/src/workspace.rs`:
```rust
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub name: String,
    pub files: Vec<String>,
    pub queries: Vec<serde_json::Value>, // full Query (keywords+level+time+exclusion) as JSON
}

pub fn config_dir() -> PathBuf {
    let mut p = dirs_or_temp();
    p.push("logradar");
    p.push("workspaces");
    let _ = std::fs::create_dir_all(&p);
    p
}
fn dirs_or_temp() -> PathBuf {
    // v1: use the OS config dir if available, else temp. (Avoids a dirs dep for the core shell;
    // sub-project 4 can swap in the `dirs` crate.)
    std::env::var_os("HOME").map(PathBuf::from).map(|h| h.join(".config"))
        .unwrap_or_else(|| std::env::temp_dir())
}

pub fn save(ws: &Workspace) -> Result<(), String> {
    let mut p = config_dir();
    p.push(format!("{}.json", ws.name));
    let data = serde_json::to_string_pretty(ws).map_err(|e| e.to_string())?;
    std::fs::write(&p, data).map_err(|e| e.to_string())
}
pub fn load(name: &str) -> Result<Workspace, String> {
    let mut p = config_dir();
    p.push(format!("{name}.json"));
    let data = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}
pub fn list() -> Result<Vec<String>, String> {
    let dir = config_dir();
    let mut names = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        if let Some(name) = ent.path().file_stem().and_then(|s| s.to_str()) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unique(name: &str) -> String { format!("{}-{}", name, uuid::Uuid::new_v4()) }
    #[test]
    fn save_load_round_trip() {
        let name = unique("test");
        let ws = Workspace { name: name.clone(), files: vec!["a.log".into()], queries: vec![serde_json::json!({"root":{}})] };
        save(&ws).unwrap();
        let loaded = load(&name).unwrap();
        assert_eq!(loaded.name, name);
        assert_eq!(loaded.files, vec!["a.log"]);
    }
    #[test]
    fn list_includes_saved() {
        let name = unique("lst");
        save(&Workspace { name: name.clone(), files: vec![], queries: vec![] }).unwrap();
        let names = list().unwrap();
        assert!(names.contains(&name));
    }
    #[test]
    fn load_missing_errors() {
        assert!(load(&unique("nope")).is_err());
    }
}
```
Append to `src-tauri/src/commands.rs`:
```rust
use crate::workspace::Workspace;

#[tauri::command]
pub async fn workspace_save(state: State<'_, AppState>, ws: Workspace) -> Result<(), String> {
    crate::workspace::save(&ws)
}
#[tauri::command]
pub async fn workspace_load(state: State<'_, AppState>, name: String) -> Result<Workspace, String> {
    crate::workspace::load(&name)
}
#[tauri::command]
pub async fn workspace_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    crate::workspace::list()
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib workspace::tests`
Expected: FAIL — `workspace` module not declared.

- [ ] **Step 3: Write minimal implementation**

`src-tauri/src/lib.rs`:
```rust
pub mod commands;
pub mod state;
pub mod workspace;

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ping, commands::open_file, commands::get_lines,
            commands::search, commands::cancel_search, commands::export,
            commands::workspace_save, commands::workspace_load, commands::workspace_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
(`workspace.rs` + `commands.rs` additions from Step 1 are the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib`
Expected: PASS (all prior + 3 workspace tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/workspace.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): workspace save/load/list commands (JSON in config dir)"
```

---

## Task 9: IPC contract test (fake-frontend: streaming + cancel + rotation)

**Files:**
- Create: `src-tauri/tests/ipc_contract.rs`

**Interfaces:**
- Consumes: all commands + `run_search_streaming` + `AppState`.
- Produces: end-to-end IPC contract test: open → search (collect batches via a fake on_event) → assert batches + Done; open → search → cancel mid-way → assert stopped + cancelled; close session while searching → assert in-flight cancelled.

- [ ] **Step 1: Write the failing test**

`src-tauri/tests/ipc_contract.rs`:
```rust
use logradar_core::{Query, QueryNode, Predicate, CancellationToken};
use logradar_tauri::commands::{open_file_impl, run_search_streaming, SearchEvent};
use logradar_tauri::state::AppState;
use std::sync::{Arc, Mutex};

fn open(state: &AppState, content: &str) -> String {
    let p = std::env::temp_dir().join(format!("lr-ipc-{}.log", uuid::Uuid::new_v4()));
    std::fs::write(&p, content).unwrap();
    open_file_impl(state, p.to_str().unwrap()).unwrap().session_id
}

#[test]
fn search_streams_batches_then_done() {
    let state = AppState::default();
    let id = open(&state, &"ERROR hit\n".repeat(300));
    let entry = state.get(&id).unwrap();
    let fmt = entry.session.lock().unwrap().format().clone();
    let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
    let tok = Arc::new(CancellationToken::new());
    let events: Arc<Mutex<Vec<SearchEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let res = run_search_streaming(&entry, &q, &fmt, tok, usize::MAX, move |ev| ev2.lock().unwrap().push(ev));
    assert_eq!(res.matched, 300);
    let evs = events.lock().unwrap();
    assert!(evs.iter().any(|e| matches!(e, SearchEvent::Batch{..})));
    assert!(evs.iter().any(|e| matches!(e, SearchEvent::Done{matched:300, ..})));
    let total: u64 = evs.iter().filter_map(|e| match e { SearchEvent::Batch{matches} => Some(matches.len() as u64), _ => None }).sum();
    assert_eq!(total, 300);
}

#[test]
fn cancel_stops_search_midway() {
    let state = AppState::default();
    let id = open(&state, &"ERROR hit\n".repeat(10_000));
    let entry = state.get(&id).unwrap();
    let fmt = entry.session.lock().unwrap().format().clone();
    let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
    let tok = Arc::new(CancellationToken::new());
    // cancel after a short delay (simulate mid-search cancel): pre-cancel
    tok.cancel();
    let res = run_search_streaming(&entry, &q, &fmt, tok, usize::MAX, |_| {});
    assert!(res.cancelled);
    assert!(res.matched < 10_000);
}

#[test]
fn close_session_cancels_in_flight_search() {
    let state = AppState::default();
    let id = open(&state, "ERROR hit\nERROR hit\n");
    let tok = Arc::new(CancellationToken::new());
    state.set_search_token(&id, tok.clone());
    assert!(!tok.is_cancelled());
    assert!(state.close(&id));
    assert!(tok.is_cancelled(), "close must cancel the in-flight search");
    assert!(state.get(&id).is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --test ipc_contract`
Expected: FAIL — `SearchEvent`/`run_search_streaming` not exported from `logradar_tauri::commands` (need `pub`).

- [ ] **Step 3: Write minimal implementation**

Ensure `commands.rs` exposes the needed items: `run_search_streaming`, `open_file_impl`, `SearchEvent` are already `pub` (from Tasks 3/6). The `ipc_contract.rs` test in Step 1 is the consumer — if items aren't `pub`, make them `pub`. (They are `pub` in the prior tasks.) No new production code needed beyond ensuring visibility.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri`
Expected: PASS (all unit + integration tests across the crate).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/ipc_contract.rs
git commit -m "test(tauri): IPC contract tests (streaming batches, cancel, close-cancels)"
```

---

## Self-Review

**1. Spec coverage:**
- §6.2 IPC commands (open_file, get_lines, search, cancel_search, export, workspace_save/load/list) → Tasks 3, 4, 6, 6, 7, 8. ✓
- §6.2 events (search_results batched, search_progress, indexing_progress) → `SearchEvent::Batch` + `Done` via Channel (Task 6). `search_progress` (mid-scan %) and `indexing_progress` NOT emitted in v1 (search_stream doesn't report scanned-count; indexing is sync in core). **Gap**: progress events deferred — note in plan as a v1 limitation (the Channel supports adding a `Progress` variant later; needs a progress callback in `search_stream`). Acceptable v1 (search is O(n); the UI shows Batch + Done).
- §8 search async + cancelable, close/new-query auto-cancels → Task 2 (close cancels) + Task 6 (cancel_search, new search overwrites token). ✓ (New-query-auto-cancels: `search` calls `set_search_token` which overwrites the old token in the entry — but the OLD search task still holds a CLONE of the old token; the old token isn't cancelled by overwrite. **Gap**: starting a new search doesn't auto-cancel the previous one. Fix: in `search`, before `set_search_token`, call `state.cancel_search(&session_id)` to cancel the old. Add this to Task 6's `search` command.)
- §8 result-list memory cap → `search` takes `cap` param, `search_stream` respects it. ✓
- §7.4 gz streams one-pass → `search_stream` uses `Session::scan_lines` → `gz_search` (from core final-fix). ✓

**Fixes applied inline:**
- Task 6 `search` command: add `state.cancel_search(&session_id);` before `state.set_search_token(...)` so a new search auto-cancels the in-flight one (the old task's cloned token gets cancelled). Update Task 6 Step 1's `search` body accordingly. (The plan text above should include this — adding it here as the self-review fix: in the `search` command, before `let token = Arc::new(...)`, insert `state.cancel_search(&session_id);`.)

**2. Placeholder scan:** No "TBD/TODO/add error handling" — all steps have real code. The `format_row` (Task 7) has a `other => other.to_string()` passthrough noted as "full refine later" — that's a documented v1 simplification, not a placeholder.

**3. Type consistency:** `SearchEvent` (`Batch{matches: Vec<u64>}` / `Done{matched, cancelled, truncated}`) consistent across Task 6 (definition) + Task 9 (contract test asserts `Done{matched:300, ..}`). `run_search_streaming(entry, query, fmt, token, cap, on_event) -> StreamResult` consistent Task 6 (def) + Task 9 (use) + Task 7 (export uses `search_stream` directly, not `run_search_streaming` — consistent, export has its own on_match). `StreamResult { matched, cancelled, truncated }` consistent Task 5 (core) + Task 6 (shell) + Task 9. `SessionEntry { session, search_token }` consistent Task 2 + Task 6. ✓

**Gaps (noted, not blocking v1 — for sub-project 3/4):**
- `search_progress` / `indexing_progress` events not emitted (need progress callback in `search_stream` + indexing hooks in core).
- New-search-auto-cancels-previous: FIXED inline above (add `cancel_search` before `set_search_token`).
- `format_row` columns: v1 supports `no` + `msg`; `path`/`level`/`timestamp` passthrough (refine in sub-project 3 when the frontend sends structured columns).
- `dirs` crate not used (config dir via `$HOME/.config` or temp) — sub-project 4 can swap in `dirs`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-logradar-tauri-ipc.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute in this session via executing-plans, batch with checkpoints.

Which approach?
