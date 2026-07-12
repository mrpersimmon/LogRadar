#[tauri::command]
pub fn ping() -> String { "pong".to_string() }

use serde::Serialize;
use tauri::State;
use crate::state::AppState;
use logradar_core::format::TimestampFmt;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
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
    // Resolution 3: clean lowercase strings instead of Rust's Option Debug repr
    // (`"Some(Iso)"`/`"None"`). Matches the brief's prose contract + JS convention.
    let timestamp_fmt = match &fmt.timestamp {
        Some(TimestampFmt::Iso) => "iso",
        Some(TimestampFmt::Slashed) => "slashed",
        Some(TimestampFmt::EpochMs) => "epoch_ms",
        Some(TimestampFmt::EpochSec) => "epoch_sec",
        None => "none",
    }.to_string();
    let session_id = state.insert(session);
    Ok(OpenResponse { session_id, line_count, encoding, is_json, timestamp_fmt })
}

#[tauri::command]
pub async fn open_file(state: State<'_, AppState>, path: String) -> Result<OpenResponse, String> {
    open_file_impl(&state, &path)
}

pub fn get_lines_impl(state: &AppState, session_id: &str, start: u64, count: usize) -> Result<Vec<String>, String> {
    let entry = state.get(session_id).ok_or("session not found".to_string())?;
    let mut session = entry.session.lock().map_err(|e| e.to_string())?;
    Ok(session.get_lines(start, count))
}

#[tauri::command]
pub async fn get_lines(state: State<'_, AppState>, session_id: String, start: u64, count: usize) -> Result<Vec<String>, String> {
    get_lines_impl(&state, &session_id, start, count)
}

use tauri::ipc::Channel;
use std::sync::Arc;
use serde::Deserialize;
use logradar_core::{Combinator, Level, Predicate, Query, QueryNode};

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchEvent {
    Batch { matches: Vec<u64> },
    Done { matched: u64, cancelled: bool, truncated: bool },
}

/// IPC wire-format query tree (camelCase JSON). The core's `Query`/`QueryNode`/
/// `Predicate` are intentionally serde-free (core stays IPC-agnostic); the Tauri
/// layer owns the DTO + conversion. The brief's "Files" lists `SearchRequest` but
/// its code block omits the definition — this is that bridge. The brief's
/// `serde_json::from_value::<Query>(query)` cannot compile (`Query` has no
/// `Deserialize`), so `search` deserializes into `SearchRequest` then converts.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub root: QueryNodeDto,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryNodeDto {
    Leaf { predicate: PredicateDto },
    Branch { combinator: CombinatorDto, children: Vec<QueryNodeDto> },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PredicateDto {
    Text { text: String },
    Regex { pattern: String },
    Level { levels: Vec<String> },
    TimeRange { start_epoch_ms: Option<i64>, end_epoch_ms: Option<i64> },
    Not { inner: Box<PredicateDto> },
}

#[derive(Deserialize, Debug, Copy, Clone)]
#[serde(rename_all = "lowercase")]
pub enum CombinatorDto { And, Or }

impl From<CombinatorDto> for Combinator {
    fn from(c: CombinatorDto) -> Self {
        match c { CombinatorDto::And => Combinator::And, CombinatorDto::Or => Combinator::Or }
    }
}

impl SearchRequest {
    /// Convert the wire DTO into a validated `logradar_core::Query`.
    /// Invalid regex patterns surface as `Err` (via `Predicate::regex_or_text`).
    pub fn into_query(self) -> Result<Query, String> {
        let root = convert_node(self.root)?;
        Query::build(root).map_err(|e| format!("{:?}", e))
    }
}

fn convert_node(dto: QueryNodeDto) -> Result<QueryNode, String> {
    match dto {
        QueryNodeDto::Leaf { predicate } => Ok(QueryNode::Leaf(convert_predicate(predicate)?)),
        QueryNodeDto::Branch { combinator, children } => {
            let children = children.into_iter()
                .map(convert_node)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(QueryNode::Branch { combinator: combinator.into(), children })
        }
    }
}

fn convert_predicate(dto: PredicateDto) -> Result<Predicate, String> {
    match dto {
        PredicateDto::Text { text } => Ok(Predicate::Text(text)),
        // Compile pattern → Predicate::Regex; invalid regex → Err (no `regex` dep needed
        // in the Tauri crate — reuse core's public helper).
        PredicateDto::Regex { pattern } => Predicate::regex_or_text(&pattern)
            .map_err(|e| format!("{:?}", e)),
        PredicateDto::Level { levels } => Ok(Predicate::Level(levels.into_iter().map(level_from_str).collect())),
        PredicateDto::TimeRange { start_epoch_ms, end_epoch_ms } =>
            Ok(Predicate::TimeRange { start_epoch_ms, end_epoch_ms }),
        PredicateDto::Not { inner } => Ok(Predicate::Not(Box::new(convert_predicate(*inner)?))),
    }
}

fn level_from_str(s: String) -> Level {
    match s.to_uppercase().as_str() {
        "ERROR" | "ERR" => Level::Error,
        "WARN" | "WARNING" => Level::Warn,
        "INFO" => Level::Info,
        "DEBUG" => Level::Debug,
        "TRACE" => Level::Trace,
        _ => Level::Other(s),
    }
}

const BATCH_SIZE: usize = 64;

/// Runs search_stream, batching matches into `on_event` (Batch), emitting Done at the end.
/// Returns the StreamResult. The Tauri command wraps this with a real Channel.
///
/// search_stream's on_match now passes the decoded line content `(u64, &str)` —
/// but this helper batches line NUMBERS only (the frontend renders lines via a
/// follow-up `get_lines` viewport fetch), so it ignores the `&str` arg (`_line`).
pub fn run_search_streaming(
    entry: &crate::state::SessionEntry,
    query: &logradar_core::Query,
    fmt: &logradar_core::LineFormat,
    token: Arc<logradar_core::CancellationToken>,
    cap: usize,
    mut on_event: impl FnMut(SearchEvent),
) -> logradar_core::StreamResult {
    let mut session = entry.session.lock().unwrap_or_else(|p| p.into_inner());
    let mut buf: Vec<u64> = Vec::with_capacity(BATCH_SIZE);
    let res = logradar_core::QueryEngine::search_stream(&mut session, query, fmt, &token, cap, |n, _line| {
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
    // Brief's `serde_json::from_value::<Query>(query)` can't compile (core `Query`
    // is serde-free); deserialize into the Tauri-owned `SearchRequest` DTO, then
    // convert into a validated `logradar_core::Query`.
    let req: SearchRequest = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let query: logradar_core::Query = req.into_query()?;
    // I1: cancel the in-flight search BEFORE acquiring the session mutex to
    // clone `fmt`. run_search_streaming holds the session mutex for the ENTIRE
    // scan, so locking the session here to read `fmt` would block until the old
    // scan finishes naturally — by then the cancel is a no-op (the headline
    // §8 behavior "切新查询自动取消在飞的搜索" silently wouldn't fire) and a
    // tokio worker stalls. Cancelling first → the old scan checks the token at
    // the next line, breaks, releases the lock → the fmt read proceeds promptly.
    state.cancel_search(&session_id);
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    let token = Arc::new(logradar_core::CancellationToken::new());
    // Register the new token AFTER cancelling the old one (the old token is
    // already invalidated; this is the new in-flight token a later
    // new-search / cancel_search / close will target).
    state.set_search_token(&session_id, token.clone());
    let search_id = uuid::Uuid::new_v4().to_string();
    let entry = entry.clone();
    // M3: capture `on_event` by value (no Mutex). Tauri 2.x `Channel::send` takes
    // `&self`, and the closure is single-threaded within the spawn_blocking task
    // (scan_lines runs on this one worker), so no shared-mutable state needs
    // protecting — drop the unnecessary Mutex.
    tauri::async_runtime::spawn_blocking(move || {
        // I5(b): the spawn_blocking task is detached → if run_search_streaming
        // panics (poisoned mutex recovered into bad state, decode bug, etc.) the
        // frontend would never receive a terminal event. catch_unwind contains
        // the panic and, on failure, emits a fallback Done so the IPC stream
        // always closes. AssertUnwindSafe is sound: the only shared mutable bit
        // (session mutex) is internally synchronized; the rest are shared refs /
        // an Arc token / a Copy cap.
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_search_streaming(&entry, &query, &fmt, token, cap, |ev| {
                let _ = on_event.send(ev);
            })
        }));
        if res.is_err() {
            // run_search_streaming already emits Done on the happy path; this is
            // only the panic-fallback (cancelled:false signals "not user-cancelled").
            let _ = on_event.send(SearchEvent::Done { matched: 0, cancelled: false, truncated: false });
        }
    });
    Ok(search_id)
}

#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.cancel_search(&session_id))
}

// I6: AppState::close exists (cancels the in-flight search + drops the session)
// but wasn't exposed as a Tauri command. The frontend needs it to release a
// session when the user closes a file tab (prevents the search_token + session
// from leaking until app shutdown).
#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.close(&session_id))
}

use std::io::Write;

pub fn export_impl(
    entry: &crate::state::SessionEntry,
    query: &logradar_core::Query,
    fmt: &logradar_core::LineFormat,
    columns: &[String],
    target: &str,
) -> Result<u64, String> {
    // I5(a): recover from a poisoned session mutex rather than panicking forever.
    let mut session = entry.session.lock().unwrap_or_else(|p| p.into_inner());
    let mut out = std::fs::File::create(target).map_err(|e| e.to_string())?;
    let token = logradar_core::CancellationToken::new(); // export isn't user-cancelable in v1
    // A clone shares the inner AtomicBool so the on_match closure can signal
    // cancel to the in-flight search_stream (which owns `&token`) on write error
    // — halting the scan at the next line (no need to change on_match's return
    // type, which the spec keeps as `FnMut(u64, &str)`).
    let cancel_signal = token.clone();
    let cols: Vec<&str> = columns.iter().map(|s| s.as_str()).collect();
    // I2/I4: one-pass. search_stream's on_match now hands us the DECODED line
    // (`&str`), so we write each match directly inside the callback — no
    // `Vec<u64>` accumulation (unbounded memory) and no re-fetch via
    // `session.get_lines(n,1)` (which is O(n²) for gz AND inherits the GzView
    // zran drift → wrong/empty content past ~1MB gz). O(n) time, O(1) extra mem.
    let mut count: u64 = 0;
    let mut write_err: Option<String> = None;
    let res = logradar_core::QueryEngine::search_stream(&mut session, query, fmt, &token, usize::MAX, |n, line| {
        let row = format_row(&cols, n, line);
        // I3: write errors (ENOSPC → 盘满) are NOT discarded. Record the first
        // failure and cancel the scan (halts at the next per-line token check);
        // the outer block then drops the partial file + removes it (cleanup) +
        // returns Err — spec §8 "导出盘满 → 中止 + 清理半成品".
        if let Err(e) = writeln!(out, "{row}") {
            if write_err.is_none() { write_err = Some(e.to_string()); }
            cancel_signal.cancel();
        } else {
            count += 1;
        }
    });
    let _ = res;
    if let Some(msg) = write_err {
        // Cleanup the half-built file so a failed export doesn't leave a
        // truncated artifact the user would mistake for a complete result.
        drop(out);
        let _ = std::fs::remove_file(target);
        Err(msg)
    } else {
        Ok(count)
    }
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
    // Brief's `serde_json::from_value::<Query>(query)` can't compile (core `Query`
    // is serde-free); reuse Task 6's `SearchRequest` DTO + `into_query()` — same
    // bridge the `search` command uses. Do NOT duplicate the DTO here.
    let req: SearchRequest = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let query: logradar_core::Query = req.into_query()?;
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    // I2: export_impl is synchronous blocking I/O (file create + scan + write).
    // Running it on the async runtime's poll thread blocks the executor; hand it
    // to spawn_blocking so the IPC async task returns promptly and the actual
    // work runs on a blocking-capable worker.
    tauri::async_runtime::spawn_blocking(move || {
        export_impl(&entry, &query, &fmt, &columns, &target)
    })
    .await
    .map_err(|e| format!("{e}"))?
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

#[cfg(test)]
mod search_tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;
    use logradar_core::{CancellationToken, Query, QueryNode, Predicate};
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

use crate::workspace::Workspace;

// The `state` DI param is required by the Tauri command convention (so the
// handler signature matches the managed `AppState`), but the workspace
// commands read/write the config dir directly and don't consult `state`.
// Underscore-prefix silences `unused_variables` while keeping the param.
#[tauri::command]
pub async fn workspace_save(_state: State<'_, AppState>, ws: Workspace) -> Result<(), String> {
    crate::workspace::save(&ws)
}
#[tauri::command]
pub async fn workspace_load(_state: State<'_, AppState>, name: String) -> Result<Workspace, String> {
    crate::workspace::load(&name)
}
#[tauri::command]
pub async fn workspace_list(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    crate::workspace::list()
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use crate::state::AppState;
    use logradar_core::{Query, QueryNode, Predicate};
    fn open_tmp(state: &AppState, content: &str) -> String {
        let p = std::env::temp_dir().join(format!("lr-exp-src-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        open_file_impl(state, p.to_str().unwrap()).unwrap().session_id
    }
    #[test]
    fn export_writes_matching_lines_to_file() {
        let state = AppState::default();
        let id = open_tmp(&state, "INFO a\nERROR hit one\nERROR hit two\nWARN x\n");
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let target = std::env::temp_dir().join(format!("lr-exp-out-{}.log", uuid::Uuid::new_v4()));
        let n = export_impl(&entry, &q, &fmt, &["no".to_string(), "msg".to_string()], target.to_str().unwrap()).unwrap();
        assert_eq!(n, 2);
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("hit one") && written.contains("hit two"));
        let _ = std::fs::remove_file(&target);
    }
    // --- I2/I4 RED→GREEN: one-pass export bypasses the buggy gz re-fetch path ---
    //
    // Pre-fix export_impl collected match line NUMBERS, then re-fetched each via
    // `session.get_lines(n, 1)` → `GzView::line_at(n)`. For a gz file >1MB
    // decompressed, GzView's zran drift makes `line_at` return None for lines
    // past the first ~1MB checkpoint, so the exported row's `msg` column is
    // EMPTY (unwrap_or_default) for those matches — silently wrong content.
    // This test builds a ~1.5MB gz with a distinct needle every 100 lines (the
    // last at line 2400, well past 1MB) and asserts the exported file CONTAINS
    // the decoded needle text for line 2400. RED before the one-pass rewrite
    // (empty msg column → no "line-002400"), GREEN after (writes the decoded
    // `&str` straight from search_stream's callback).
    #[test]
    fn export_gz_large_file_writes_correct_content_past_1mb() {
        let lines: Vec<String> = (0..2500)
            .map(|i| {
                let tag = if i % 100 == 0 { "NEEDLE" } else { "filler" };
                format!("{tag} line-{i:06} {}", "a".repeat(590))
            })
            .collect();
        // ~2500 × 611 B ≈ 1.5MB > 1MB gz checkpoint boundary.
        let src = std::env::temp_dir().join(format!("lr-exp-gz-src-{}.gz", uuid::Uuid::new_v4()));
        let f = std::fs::File::create(&src).unwrap();
        let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        for l in &lines { writeln!(enc, "{l}").unwrap(); }
        enc.finish().unwrap();

        let state = AppState::default();
        let id = open_file_impl(&state, src.to_str().unwrap()).unwrap().session_id;
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        // Match every NEEDLE line (25 of them: 0,100,…,2400).
        let q = Query::build(QueryNode::Leaf(Predicate::Text("NEEDLE".into()))).unwrap();
        let target = std::env::temp_dir().join(format!("lr-exp-gz-out-{}.log", uuid::Uuid::new_v4()));
        let n = export_impl(&entry, &q, &fmt, &["no".to_string(), "msg".to_string()], target.to_str().unwrap()).unwrap();
        assert_eq!(n, 25, "all 25 needles must be exported");
        let written = std::fs::read_to_string(&target).unwrap();
        // Line 2400 is past the ~1MB zran checkpoint. The pre-fix re-fetch path
        // returns None for it → empty msg → this assertion FAILS (RED). The
        // one-pass rewrite writes the decoded `&str` directly → passes (GREEN).
        assert!(written.contains("line-002400"),
            "exported content for the >1MB gz needle (line 2400) must be the real decoded text, not empty");
        assert!(written.contains("NEEDLE line-002400"),
            "exported row for line 2400 must carry the decoded message, not just the line number");
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(&src);
    }
    // --- I3: write errors surface as Err (not silently-dropped Ok(count)) + cleanup ---
    //
    // Pre-fix `let _ = writeln!(out, "{row}");` discarded write errors → a
    // disk-full (ENOSPC) export returned Ok(count) with a silently-truncated
    // file (spec §8 violation). The rewrite checks every writeln! and, on Err,
    // records it + cancels the scan + removes the partial file + returns Err.
    //
    // (a) Creation-failure path (cross-platform): target inside a directory
    //     that doesn't exist → File::create Err → export returns Err and leaves
    //     no artifact at `target`.
    #[test]
    fn export_creation_failure_returns_err_and_leaves_no_file() {
        let state = AppState::default();
        let id = open_tmp(&state, "ERROR hit\nERROR hit\n");
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let target = std::env::temp_dir().join(format!("lr-no-such-dir-{}/out.log", uuid::Uuid::new_v4()));
        let res = export_impl(&entry, &q, &fmt, &["msg".to_string()], target.to_str().unwrap());
        assert!(res.is_err(), "unwritable target must surface as Err, not Ok");
        assert!(!target.exists(), "no partial file must be left at the failed target");
    }
    // (b) Mid-write ENOSPC path (Linux only): /dev/full always fails writes
    //     with ENOSPC after File::create succeeds — the genuine "盘满" scenario.
    //     Gated to Linux because /dev/full doesn't exist on macOS/Windows.
    #[cfg(target_os = "linux")]
    #[test]
    fn export_disk_full_surfaces_err_not_silently_dropped() {
        let state = AppState::default();
        let id = open_tmp(&state, "ERROR hit\nERROR hit\n");
        let entry = state.get(&id).unwrap();
        let fmt = entry.session.lock().unwrap().format().clone();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        // /dev/full: create succeeds, first write returns ENOSPC.
        let res = export_impl(&entry, &q, &fmt, &["msg".to_string()], "/dev/full");
        assert!(res.is_err(),
            "ENOSPC mid-write must surface as Err (pre-fix `let _ = writeln!` dropped it → Ok)");
    }
}
