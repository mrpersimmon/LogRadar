// IPC contract tests for LogRadar's Tauri shell (Task 9).
//
// Drives the commands/logic end-to-end via the crate's public API:
//   - open → search (collect batches via a fake on_event) → assert batches + Done
//   - open → search → cancel mid-way → assert stopped + cancelled
//   - close session while a search token is registered → assert in-flight cancelled
//
// The brief's 3 contract tests (below) build a core `Query` directly, bypassing
// the JSON→Query conversion that the real `search` Tauri command performs. Two
// extra tests cover that conversion path: a happy-path test (JSON → SearchRequest
// → into_query() → run_search_streaming → matches) and an invalid-regex test
// (into_query() surfaces an Err, never a panic — `Predicate::regex_or_text`
// compiles the pattern and returns `QueryError::InvalidRegex` on failure).

use logradar_core::{Query, QueryNode, Predicate, CancellationToken};
use logradar_tauri::commands::{open_file_impl, run_search_streaming, SearchEvent, SearchRequest};
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

// ---------------------------------------------------------------------------
// JSON → Query conversion tests (gap from Task 6: the brief's 3 contract tests
// above pass a core `Query` straight to `run_search_streaming`, so the
// `SearchRequest` DTO + `into_query()` bridge — which the real `search` and
// `export` Tauri commands use — is otherwise untested. These two tests close
// that gap.
//
// Task 6's DTO API (src-tauri/src/commands.rs):
//   pub struct SearchRequest { pub root: QueryNodeDto }
//   pub enum QueryNodeDto { Leaf { predicate: PredicateDto },
//                           Branch { combinator: CombinatorDto, children: Vec<QueryNodeDto> } }
//   pub enum PredicateDto { Text { text }, Regex { pattern }, Level { levels },
//                            TimeRange { start_epoch_ms, end_epoch_ms }, Not { inner } }
//   pub enum CombinatorDto { And, Or }
//   impl SearchRequest { pub fn into_query(self) -> Result<Query, String> }
// Wire format: camelCase + `tag = "kind"` (e.g. `{ "kind": "leaf", "predicate": ... }`).
// `Regex` predicates route through `Predicate::regex_or_text(&pattern)`, which
// compiles the pattern and returns `Err(QueryError::InvalidRegex)` on failure —
// so `into_query()` surfaces a `Result::Err` for bad regex, never panics.
// ---------------------------------------------------------------------------

#[test]
fn search_request_json_converts_to_query_and_matches() {
    // Happy path: serde_json::Value → SearchRequest → Query → run_search_streaming.
    // Uses a `regex` predicate so the `Predicate::regex_or_text` compile path is
    // exercised (the 3 brief tests above only use `Predicate::Text`).
    let state = AppState::default();
    let id = open(&state, &"ERROR hit\n".repeat(150));
    let entry = state.get(&id).unwrap();
    let fmt = entry.session.lock().unwrap().format().clone();

    let json = serde_json::json!({
        "root": {
            "kind": "leaf",
            "predicate": { "kind": "regex", "pattern": "hit" }
        }
    });
    let req: SearchRequest = serde_json::from_value(json).expect("valid SearchRequest JSON");
    let q: Query = req.into_query().expect("valid regex → Query");

    let tok = Arc::new(CancellationToken::new());
    let events: Arc<Mutex<Vec<SearchEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let res = run_search_streaming(&entry, &q, &fmt, tok, usize::MAX, move |ev| ev2.lock().unwrap().push(ev));
    assert_eq!(res.matched, 150);
    let evs = events.lock().unwrap();
    assert!(evs.iter().any(|e| matches!(e, SearchEvent::Batch{..})));
    assert!(evs.iter().any(|e| matches!(e, SearchEvent::Done{matched:150, ..})));
    let total: u64 = evs.iter().filter_map(|e| match e { SearchEvent::Batch{matches} => Some(matches.len() as u64), _ => None }).sum();
    assert_eq!(total, 150);
}

#[test]
fn invalid_regex_search_request_yields_error_not_panic() {
    // Error path: an invalid-regex `SearchRequest` must surface an `Err` from
    // `into_query()` (via `Predicate::regex_or_text` → `QueryError::InvalidRegex`),
    // NOT a panic — so the Tauri command can return a user-visible error string.
    let json = serde_json::json!({
        "root": {
            "kind": "leaf",
            "predicate": { "kind": "regex", "pattern": "(unclosed" }
        }
    });
    let req: SearchRequest = serde_json::from_value(json).expect("SearchRequest deserializes fine");
    let err = req.into_query();
    assert!(err.is_err(), "invalid regex must surface as Err, not panic");
}

// --- M2: genuine MID-search cancel (not pre-cancel) ---
//
// The brief's `cancel_stops_search_midway` test (above) PRE-cancels the token
// before run_search_streaming starts — it proves the engine honors a cancel
// set at t=0, but NOT that a cancel set WHILE the scan is running stops it
// mid-flight with partial matches. This test spawns the scan on its own
// thread, waits until the search thread has emitted at least one Batch (real
// mid-scan progress: ≥64 matches found, but 200_000 total exist so the scan is
// still running), THEN cancels, and asserts: cancelled==true, partial matches
// collected (0 < matched < total). RED if cancel-while-running were a no-op
// (the I1 bug: a 2nd search couldn't cancel the 1st because of lock ordering
// — same class of "cancel doesn't land" failure this guards against).
#[test]
fn mid_search_cancel_yields_partial_matches_and_cancelled() {
    let state = AppState::default();
    let id = open(&state, &"ERROR hit\n".repeat(200_000));
    let entry = state.get(&id).unwrap();
    let fmt = entry.session.lock().unwrap().format().clone();
    let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
    let tok = Arc::new(CancellationToken::new());
    let events: Arc<Mutex<Vec<SearchEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev_for_thread = events.clone();
    let tok_for_thread = tok.clone();
    let handle = std::thread::spawn(move || {
        run_search_streaming(&entry, &q, &fmt, tok_for_thread, usize::MAX, move |ev| {
            ev_for_thread.lock().unwrap().push(ev);
        })
    });
    // Wait until the scan has emitted real partial progress (a Batch ≥64
    // matches), then cancel mid-scan.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let partial: usize = events.lock().unwrap().iter()
            .filter_map(|e| match e { SearchEvent::Batch { matches } => Some(matches.len()), _ => None })
            .sum();
        if partial > 0 { break; }
        if std::time::Instant::now() > deadline { panic!("scan never emitted a batch (too fast?)"); }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    tok.cancel(); // mid-search cancel
    let res = handle.join().expect("search thread must not panic");
    assert!(res.cancelled, "a mid-scan cancel must surface as cancelled=true");
    assert!(res.matched > 0, "some partial matches must have been collected before cancel");
    assert!(res.matched < 200_000, "the scan must not have completed before the cancel landed");
}
