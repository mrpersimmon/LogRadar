use logradar_core::{LineIndexer, Session};
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

#[test]
fn end_to_end_session_search() {
    let p = std::env::temp_dir().join(format!("lr-e2e-{}.log", std::process::id()));
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
    // (full search exercised in engine tests)
    let _ = std::fs::remove_file(&p);
}
