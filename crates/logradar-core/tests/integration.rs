use logradar_core::{
    CancellationToken, Combinator, Level, LineIndexer, Predicate, Query, QueryEngine, QueryNode,
    Session,
};
use proptest::prelude::*;

#[test]
fn random_access_100k_lines() {
    let txt: String = (0..100_000)
        .map(|i| format!("line-{i:06}"))
        .collect::<Vec<_>>()
        .join("\n");
    let bytes = txt.into_bytes();
    let idx = LineIndexer::build(&bytes, 256);
    assert_eq!(idx.line_count(), 100_000);
    // Resolution 2: the brief's `Some(b"line-050000".to_vec().as_slice())` and
    // its suggested fix `Some(b"line-050000")` both fail — `Option<&[u8; N]>` does
    // not coerce to `Option<&[u8]>` (Option has no array→slice coercion), so the
    // compiler rejects it with E0308. Use `&str::as_bytes()` (returns `&[u8]`
    // directly), matching the existing line_index unit-test style
    // (`Some("c".as_bytes())`).
    assert_eq!(idx.line_at(&bytes, 50_000), Some("line-050000".as_bytes()));
    // Boundary lines: first and last (no trailing newline on last).
    assert_eq!(idx.line_at(&bytes, 0), Some("line-000000".as_bytes()));
    assert_eq!(idx.line_at(&bytes, 99_999), Some("line-099999".as_bytes()));
    assert_eq!(idx.line_at(&bytes, 100_000), None);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    #[test]
    fn line_at_reconstructs_join(n in 0u64..1_000) {
        // Property: for every generated line number, line_at(n) returns exactly
        // the n-th source line — so the index faithfully reconstructs the input.
        let lines: Vec<String> = (0..1_000).map(|i| format!("l{i}")).collect();
        let txt = lines.join("\n");
        let bytes = txt.into_bytes();
        let idx = LineIndexer::build(&bytes, 16);
        if (n as usize) < lines.len() {
            let got = idx.line_at(&bytes, n).unwrap();
            assert_eq!(std::str::from_utf8(got).unwrap(), lines[n as usize]);
        }
    }
}

// --- shared test helpers ---

/// Unique temp path keyed on PID + counter so parallel tests don't clobber.
fn tmp_path(suffix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("lr-it-{}-{}{suffix}", std::process::id(), n));
    let _ = std::fs::remove_file(&p);
    p
}

fn write_tmp(content: &str) -> std::path::PathBuf {
    let p = tmp_path(".log");
    std::fs::write(&p, content).unwrap();
    p
}

/// Build a gz file from the given lines. Each entry is written with a trailing
/// `\n` (the gz session splits on `\n` exactly like LineIndexer).
fn write_gz(p: &std::path::Path, lines: &[String]) {
    use std::io::Write;
    let f = std::fs::File::create(p).unwrap();
    let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    for l in lines {
        writeln!(enc, "{l}").unwrap();
    }
    enc.finish().unwrap();
}

// --- Finding 4(a): gz Session through the engine (streaming path) ---
//
// Pre-Finding-1, QueryEngine::search fetched each line via Session::get_lines(n,1)
// → GzView::line_at, which re-decompresses from the nearest checkpoint. For a gz
// file >1MB decompressed, the checkpoint's recorded compressed offset (via
// file.stream_position() + BufReader read-ahead drift) is wrong, so line_at for
// lines past the first checkpoint (~1MB) returns None → those needles are missed.
// This test generates a ~1.5MB gz file with a needle every 100 lines, the last
// needle well past the 1MB boundary, so the pre-fix path MISSES needles (RED).
// After Finding 1, search streams one-pass via decompress::gz_search and finds
// every needle (GREEN).
#[test]
fn search_gz_streams_and_finds_every_needle() {
    // 2500 lines × ~611 bytes ≈ 1.5MB > 1MB checkpoint threshold.
    let lines: Vec<String> = (0..2500)
        .map(|i| {
            let tag = if i % 100 == 0 { "NEEDLE" } else { "filler" };
            format!("{tag} line-{i:06} {}", "a".repeat(590))
        })
        .collect();
    let p = tmp_path("-gz-search.gz");
    write_gz(&p, &lines);

    let mut s = Session::open(&p).unwrap();
    assert_eq!(s.line_count(), 2500);
    let q = Query::build(QueryNode::Leaf(Predicate::Text("NEEDLE".into()))).unwrap();
    let tok = CancellationToken::new();
    let fmt = s.format().clone();
    let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);

    let expected: Vec<u64> = (0..2500).step_by(100).collect();
    assert_eq!(res.matches.len(), expected.len(), "got {} matches, want {}", res.matches.len(), expected.len());
    assert_eq!(res.matches, expected);
    // The last needle (2400) is well past the ~1MB checkpoint boundary; the
    // pre-fix per-line path misses it. Assert it explicitly as the load-bearing
    // RED signal (and a regression guard for the streaming path).
    assert!(res.matches.contains(&2400), "last-1MB needle 2400 must be found (streaming path)");
    let _ = std::fs::remove_file(&p);
}

// --- Finding 4(b): TimeRange through the engine over ISO timestamps ---
#[test]
fn search_timerange_filters_iso_timestamps() {
    let content = "\
2026-07-12 14:22:01 INFO before
2026-07-12 14:23:01 ERROR in-window
2026-07-12 14:24:01 WARN after
2026-07-12 14:22:05 INFO also-before
";
    let p = write_tmp(content);
    let mut s = Session::open(&p).unwrap();
    let fmt = s.format().clone();
    // detect_format should classify the timestamp as Iso; the range window
    // covers only 14:23:00–14:23:59 → only line 1 matches.
    let start = epoch_ms("2026-07-12 14:23:00");
    let end = epoch_ms("2026-07-12 14:23:59");
    let q = Query::build(QueryNode::Leaf(Predicate::TimeRange {
        start_epoch_ms: Some(start),
        end_epoch_ms: Some(end),
    }))
    .unwrap();
    let tok = CancellationToken::new();
    let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
    assert_eq!(res.matches, vec![1]);
    let _ = std::fs::remove_file(&p);
}

// --- Finding 4(c): Level predicate through the engine ---
#[test]
fn search_level_predicate_matches_levels() {
    let content = "\
2026-07-12 14:22:01 ERROR refused
2026-07-12 14:22:02 WARN retry
2026-07-12 14:22:03 INFO ok
2026-07-12 14:22:04 DEBUG trace
";
    let p = write_tmp(content);
    let mut s = Session::open(&p).unwrap();
    let fmt = s.format().clone();
    let q = Query::build(QueryNode::Leaf(Predicate::Level(vec![
        Level::Error,
        Level::Warn,
    ])))
    .unwrap();
    let tok = CancellationToken::new();
    let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
    assert_eq!(res.matches, vec![0, 1]);
    let _ = std::fs::remove_file(&p);
}

// --- Finding 4(d): And / Not / Regex through the engine ---
#[test]
fn search_and_not_regex_combinator() {
    // Matches a line that /refus.d/ AND does NOT contain "timeout".
    let content = "\
error refused
timeout refused
error ok
info refused
";
    let p = write_tmp(content);
    let mut s = Session::open(&p).unwrap();
    let fmt = s.format().clone();
    let q = Query::build(QueryNode::Branch {
        combinator: Combinator::And,
        children: vec![
            QueryNode::Leaf(Predicate::Regex(regex::Regex::new("refus.d").unwrap())),
            QueryNode::Leaf(Predicate::Not(Box::new(Predicate::Text(
                "timeout".into(),
            )))),
        ],
    })
    .unwrap();
    let tok = CancellationToken::new();
    let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
    // line 0 "error refused"  → regex matches, no "timeout" → match
    // line 1 "timeout refused"→ regex matches, has "timeout" → Not fails → no match
    // line 2 "error ok"       → regex no match → no match
    // line 3 "info refused"   → regex matches, no "timeout" → match
    assert_eq!(res.matches, vec![0, 3]);
    let _ = std::fs::remove_file(&p);
}

// --- strengthened end-to-end: assert search content, not just viewport count ---
#[test]
fn end_to_end_session_search() {
    let p = tmp_path("-e2e.log");
    let content: String = (0..5000)
        .map(|i| {
            if i % 1000 == 0 {
                format!("2026-07-12 14:22:0{} ERROR refused\n", i % 10)
            } else {
                format!("2026-07-12 14:22:0{} INFO ok\n", i % 10)
            }
        })
        .collect();
    std::fs::write(&p, content).unwrap();
    let mut s = Session::open(&p).unwrap();
    assert_eq!(s.line_count(), 5000);
    // mid-file window
    let mid = s.get_lines(2500, 3);
    assert_eq!(mid.len(), 3);
    // Strengthened: a full Text search returns exactly the 5 ERROR lines.
    let q = Query::build(QueryNode::Leaf(Predicate::Text("refused".into()))).unwrap();
    let tok = CancellationToken::new();
    let fmt = s.format().clone();
    let res = QueryEngine::search(&mut s, &q, &fmt, &tok, usize::MAX);
    assert_eq!(res.matches, vec![0, 1000, 2000, 3000, 4000]);
    let _ = std::fs::remove_file(&p);
}

fn epoch_ms(s: &str) -> i64 {
    use chrono::{NaiveDateTime, TimeZone, Utc};
    let dt = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
    Utc.from_utc_datetime(&dt).timestamp_millis()
}
