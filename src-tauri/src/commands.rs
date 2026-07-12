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
    // Brief's `serde_json::from_value::<Query>(query)` can't compile (core `Query`
    // is serde-free); deserialize into the Tauri-owned `SearchRequest` DTO, then
    // convert into a validated `logradar_core::Query`.
    let req: SearchRequest = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let query: logradar_core::Query = req.into_query()?;
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    let token = Arc::new(logradar_core::CancellationToken::new());
    // Resolution 1: starting a new search auto-cancels the in-flight one (spec §8)
    // BEFORE registering the new token — the old task's cloned token gets cancelled.
    state.cancel_search(&session_id);
    state.set_search_token(&session_id, token.clone());
    let search_id = uuid::Uuid::new_v4().to_string();
    let on_event = std::sync::Mutex::new(on_event);
    let entry = entry.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_search_streaming(&entry, &query, &fmt, token, cap, |ev| {
            // Resolution 4: Tauri 2.x Channel API is `send`, not `emit`.
            let _ = on_event.lock().unwrap().send(ev);
        });
    });
    Ok(search_id)
}

#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.cancel_search(&session_id))
}

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
    let cols: Vec<&str> = columns.iter().map(|s| s.as_str()).collect();
    // Resolution: the brief's closure called `session.get_lines(n, 1)` inside the
    // `search_stream` callback, but `search_stream` already holds `&mut *session`
    // for the duration of the scan (E0499 — cannot borrow `session` as mutable
    // more than once). The callback only receives the line number (`FnMut(u64)`),
    // so we cannot fetch the decoded line mid-scan. Collect matching line numbers
    // during the single-pass scan (callback borrows only the Vec, not `session`),
    // then fetch+format+write each match AFTER the scan's `&mut` borrow ends.
    let mut matches: Vec<u64> = Vec::new();
    let res = logradar_core::QueryEngine::search_stream(&mut *session, query, fmt, &token, usize::MAX, |n| {
        matches.push(n);
    });
    let _ = res;
    let mut count: u64 = 0;
    for n in matches {
        let line = session.get_lines(n, 1).into_iter().next().unwrap_or_default();
        let row = format_row(&cols, n, &line);
        let _ = writeln!(out, "{row}");
        count += 1;
    }
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
    // Brief's `serde_json::from_value::<Query>(query)` can't compile (core `Query`
    // is serde-free); reuse Task 6's `SearchRequest` DTO + `into_query()` — same
    // bridge the `search` command uses. Do NOT duplicate the DTO here.
    let req: SearchRequest = serde_json::from_value(query).map_err(|e| e.to_string())?;
    let query: logradar_core::Query = req.into_query()?;
    let fmt = { let s = entry.session.lock().map_err(|e| e.to_string())?; s.format().clone() };
    export_impl(&entry, &query, &fmt, &columns, &target)
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
