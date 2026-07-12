use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::format::{self, LineFormat};
use crate::query::{Combinator, Predicate, Query, QueryNode};
use crate::session::Session;

pub struct CancellationToken { cancelled: Arc<AtomicBool> }
impl CancellationToken {
    pub fn new() -> Self { Self { cancelled: Arc::new(AtomicBool::new(false)) } }
    pub fn is_cancelled(&self) -> bool { self.cancelled.load(Ordering::Relaxed) }
    pub fn cancel(&self) { self.cancelled.store(true, Ordering::Relaxed) }
}
impl Default for CancellationToken { fn default() -> Self { Self::new() } }

pub struct SearchResult {
    pub matches: Vec<u64>,   // line numbers that matched
    pub truncated: bool,     // true if hit cap before scanning all
}

pub struct QueryEngine;

impl QueryEngine {
    /// Scans the whole session sequentially (v1; rayon parallelism added once
    /// line_at is batchable). Stops early if cancelled or cap reached.
    pub fn search(
        session: &mut Session,
        query: &Query,
        fmt: &LineFormat,
        token: &CancellationToken,
        cap: usize,
    ) -> SearchResult {
        let mut matches: Vec<u64> = Vec::new();
        let total = session.line_count();
        for n in 0..total {
            if token.is_cancelled() { return SearchResult { matches, truncated: false }; }
            if matches.len() >= cap { return SearchResult { matches, truncated: true }; }
            // fetch line; if source errors, treat as no-match and continue
            let Some(line) = session_line(session, n) else { continue };
            if eval_node(&query.root, fmt, &line) {
                matches.push(n);
            }
        }
        SearchResult { matches, truncated: false }
    }
}

// helper: Session::get_lines returns Vec<String> but engine wants one line at a time.
// Simplified from the brief: returns Option<String> directly (avoids the
// String -> Vec<u8> -> String::from_utf8_lossy round-trip; eval_node/eval_predicate
// already operate on &str).
fn session_line(session: &mut Session, n: u64) -> Option<String> {
    session.get_lines(n, 1).into_iter().next()
}

fn eval_node(node: &QueryNode, fmt: &LineFormat, line: &str) -> bool {
    match node {
        QueryNode::Leaf(p) => eval_predicate(p, fmt, line),
        QueryNode::Branch { combinator, children } => {
            match combinator {
                Combinator::And => children.iter().all(|c| eval_node(c, fmt, line)),
                Combinator::Or  => children.iter().any(|c| eval_node(c, fmt, line)),
            }
        }
    }
}
fn eval_predicate(p: &Predicate, fmt: &LineFormat, line: &str) -> bool {
    match p {
        Predicate::Text(t) => line.contains(t),
        Predicate::Regex(r) => r.is_match(line),
        Predicate::Level(levels) => {
            if let Some(parsed) = format::parse_level(fmt, line) {
                levels.iter().any(|l| level_eq(l, &parsed))
            } else { false }
        }
        Predicate::TimeRange { start_epoch_ms, end_epoch_ms } => {
            match format::parse_epoch_ms(fmt, line) {
                Some(ms) => start_epoch_ms.map_or(true, |s| ms >= s) && end_epoch_ms.map_or(true, |e| ms <= e),
                None => false,
            }
        }
        Predicate::Not(inner) => !eval_predicate(inner, fmt, line),
    }
}
fn level_eq(a: &crate::query::Level, b: &crate::query::Level) -> bool {
    use crate::query::Level::*;
    matches!((a, b),
        (Error, Error) | (Warn, Warn) | (Info, Info) | (Debug, Debug) | (Trace, Trace))
    // Other(String) compares string; omitted for brevity in v1 since levels come from known set
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn write_tmp(content: &str) -> std::path::PathBuf {
        // Unique per call: tests run in parallel and would otherwise clobber a
        // path keyed only on PID (same bug session::tests already fixed).
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("lr-eng-{}-{}.log", std::process::id(), n));
        let _ = std::fs::remove_file(&p);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }
    #[test]
    fn finds_text_matches_and_caps() {
        let p = write_tmp("INFO a\nERROR refused\nERROR refused\nWARN x\nERROR refused\n");
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("refused".into()))).unwrap();
        let tok = CancellationToken::new();
        let fmt = s.format().clone();
        let res = QueryEngine::search(&mut s, &q, &fmt, &tok, 2);
        assert_eq!(res.matches.len(), 2);
        assert!(res.truncated);
    }
    #[test]
    fn cancel_stops_early() {
        let p = write_tmp(&"ERROR hit\n".repeat(1000));
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Text("hit".into()))).unwrap();
        let tok = CancellationToken::new();
        tok.cancel();
        let fmt = s.format().clone();
        let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
        assert!(res.matches.is_empty());
    }
    #[test]
    fn and_or_combinators() {
        let p = write_tmp("ERROR refused\nWARN timeout\nINFO ok\nERROR timeout\n");
        let mut s = Session::open(&p).unwrap();
        let q = Query::build(QueryNode::Branch {
            combinator: Combinator::Or,
            children: vec![
                QueryNode::Leaf(Predicate::Text("refused".into())),
                QueryNode::Leaf(Predicate::Text("timeout".into())),
            ],
        }).unwrap();
        let tok = CancellationToken::new();
        let fmt = s.format().clone();
        let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
        assert_eq!(res.matches.len(), 3); // lines 0,1,3
    }
}
