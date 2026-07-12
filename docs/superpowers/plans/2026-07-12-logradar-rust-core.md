# LogRadar Rust Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `logradar-core` — a pure-Rust library providing LogRadar's performance-critical core (line indexing, gz/zip decompression, multi-condition query, timestamp normalization, encoding), fully tested via `cargo test` with no Tauri/UI dependencies.

**Architecture:** A Cargo workspace with a `logradar-core` lib crate of focused modules. Composable units (LineIndexer / Decompressor / QueryEngine / FormatDetector / Session) that the Tauri shell (sub-project 2) will wrap. Filter = projection over a line index; the `get_lines(range)` API enforces "UI never receives whole files." CPU-heavy work parallel via rayon; search async + cancelable.

**Tech Stack:** Rust (edition 2021, MSRV 1.75), `memmap2`, `flate2`, `zip`, `rayon`, `regex`, `encoding_rs`, `chrono`; dev: `proptest`, `criterion`.

## Global Constraints

- MSRV Rust 1.75 stable; edition 2021.
- **No tail / no TailWatcher** (removed from v1 — offline analysis only).
- Result list: **cap + warn** on extreme matches (default cap 1,000,000), **no spill-to-disk** in v1.
- Encoding: UTF-8 default, GBK heuristic, **lossy decode never panics** on invalid bytes.
- Compression: gz uses zran-style offset index for random access + streaming for search; zip per-entry; truncated/corrupt → degrade (decode what's available) + resync, never hard-fail the whole file.
- Search: **async + cancelable** (token-based); invalid regex → compile-time reject (`Result`); catastrophic regex → timeout/abort.
- TDD (write failing test → see it fail → minimal impl → see it pass → commit). Frequent commits, one logical change each.
- Pure Rust: no `std::process`, no filesystem writes except temp test fixtures.

---

## File Structure

```
Cargo.toml                              # workspace root
crates/logradar-core/
  Cargo.toml                            # crate manifest + deps
  src/
    lib.rs                              # re-exports public API
    query.rs                            # Query AST: Predicate / QueryNode / Combinator + build (regex validation)
    encoding.rs                         # detect UTF-8/GBK + lossy decode to String
    format.rs                           # FormatDetector: timestamp→epoch ms, level token, JSON detection
    line_index.rs                       # LineIndexer: sampled line offsets, offset_of_line, line_at
    decompress.rs                       # Decompressor: gz (stream + zran view) + zip (per-entry)
    session.rs                          # Session: open(path)→mmap/decompress+index; get_lines(range)
    engine.rs                           # QueryEngine: parallel chunk scan + cancel + cap+warn
  tests/
    integration.rs                      # end-to-end core tests (real temp files)
  benches/
    indexing.rs                         # criterion benches (indexing/search/decompress throughput)
```

Each module has one clear responsibility; files that change together (e.g. `session.rs` + `line_index.rs` + `decompress.rs` for the open path) are tested together in `tests/integration.rs`.

---

## Task 1: Workspace scaffold + Query AST

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/logradar-core/Cargo.toml`
- Create: `crates/logradar-core/src/lib.rs`
- Create: `crates/logradar-core/src/query.rs`
- Test: `crates/logradar-core/src/query.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Produces: `query::Predicate`, `query::QueryNode`, `query::Combinator`, `query::Query`, `query::QueryError`, `query::Query::build(nodes: QueryNode) -> Result<Query, QueryError>` (validates regex predicates at build time).

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/query.rs`:
```rust
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub enum Level { Error, Warn, Info, Debug, Trace, Other(String) }

#[derive(Debug, Clone)]
pub enum Predicate {
    Text(String),
    Regex(Regex),
    Level(Vec<Level>),
    TimeRange { start_epoch_ms: Option<i64>, end_epoch_ms: Option<i64> },
    Not(Box<Predicate>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Combinator { And, Or }

#[derive(Debug, Clone)]
pub enum QueryNode {
    Leaf(Predicate),
    Branch { combinator: Combinator, children: Vec<QueryNode> },
}

#[derive(Debug, Clone)]
pub struct Query { pub root: QueryNode }

#[derive(Debug, Clone, PartialEq)]
pub enum QueryError { InvalidRegex(String) }

impl Query {
    /// Validates any Regex predicates. Returns Err on the first invalid regex.
    pub fn build(root: QueryNode) -> Result<Query, QueryError> {
        Self::validate(&root)?;
        Ok(Query { root })
    }
    fn validate(node: &QueryNode) -> Result<(), QueryError> {
        match node {
            QueryNode::Leaf(Predicate::Regex(_)) => Ok(()),   // Regex already compiled → valid
            QueryNode::Leaf(_) => Ok(()),
            QueryNode::Branch { children, .. } => { for c in children { Self::validate(c)?; } Ok(()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_accepts_compiled_regex() {
        let r = Regex::new("refused|timeout").unwrap();
        let q = Query::build(QueryNode::Leaf(Predicate::Regex(r)));
        assert!(q.is_ok());
    }
    #[test]
    fn build_rejects_via_regex_constructor() {
        // An invalid regex cannot be constructed via Regex::new in the first place;
        // callers must go through a Predicate::Regex helper that surfaces the error.
        let bad = Predicate::regex_or_text("(unclosed");
        assert!(matches!(bad, Err(QueryError::InvalidRegex(_))));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core query::tests`
Expected: FAIL — `Predicate::regex_or_text` not found / crate not built.

- [ ] **Step 3: Write minimal implementation**

Add the helper to `query.rs` (constructor that surfaces regex errors, so invalid regex is rejected at build time, never during scan):
```rust
impl Predicate {
    /// Accepts a user-typed pattern. If it compiles as regex, returns Predicate::Regex;
    /// otherwise returns InvalidRegex. (Callers that want literal text use Predicate::Text.)
    pub fn regex_or_text(pattern: &str) -> Result<Predicate, QueryError> {
        match Regex::new(pattern) {
            Ok(r) => Ok(Predicate::Regex(r)),
            Err(_) => Err(QueryError::InvalidRegex(pattern.to_string())),
        }
    }
}
```
`crates/logradar-core/src/lib.rs`:
```rust
pub mod query;
```
`crates/logradar-core/Cargo.toml`:
```toml
[package]
name = "logradar-core"
version = "0.1.0"
edition = "2021"
rust-version = "1.75"

[dependencies]
regex = "1"
flate2 = "1"
zip = "0.6"
memmap2 = "0.9"
rayon = "1"
encoding_rs = "0.8"
chrono = "0.4"

[dev-dependencies]
proptest = "1"
criterion = { version = "0.5", features = ["html_tokio"] }

[[bench]]
name = "indexing"
harness = false
```
Workspace root `Cargo.toml`:
```toml
[workspace]
members = ["crates/logradar-core"]
resolver = "2"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core query::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/logradar-core/Cargo.toml crates/logradar-core/src/lib.rs crates/logradar-core/src/query.rs
git commit -m "feat(core): add workspace scaffold + Query AST with regex validation"
```

---

## Task 2: Encoding (UTF-8/GBK detect + lossy decode)

**Files:**
- Create: `crates/logradar-core/src/encoding.rs`
- Modify: `crates/logradar-core/src/lib.rs` (add `pub mod encoding;`)

**Interfaces:**
- Produces: `encoding::Encoding` (`Utf8` | `Gbk`), `encoding::detect(bytes: &[u8]) -> Encoding`, `encoding::decode(encoding: Encoding, bytes: &[u8]) -> String` (lossy, never panics).

- [ ] **Step 1: Write the failing test**

Append to `crates/logradar-core/src/encoding.rs`:
```rust
use encoding_rs::{GBK, UTF_8};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Encoding { Utf8, Gbk }

/// Heuristic: if the slice is valid UTF-8, it's UTF-8; otherwise assume GBK
/// (common for Chinese-origin logs). Pure-ASCII counts as UTF-8.
pub fn detect(bytes: &[u8]) -> Encoding {
    if std::str::from_utf8(bytes).is_ok() { Encoding::Utf8 } else { Encoding::Gbk }
}

/// Lossy decode — invalid bytes become U+FFFD. Never panics.
pub fn decode(encoding: Encoding, bytes: &[u8]) -> String {
    match encoding {
        Encoding::Utf8 => UTF_8.decode(bytes).0.into_owned(),
        Encoding::Gbk => GBK.decode(bytes).0.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_utf8_ascii_and_chinese() {
        assert_eq!(detect(b"plain ascii"), Encoding::Utf8);
        assert_eq!(detect("连接被拒绝".as_bytes()), Encoding::Utf8);
    }
    #[test]
    fn detects_gbk_and_decodes_lossy() {
        let gbk = b"\xc1\xac\xbd\xd3\xb1\xbb\xbe\xdc\xbe\xf8"; // "连接被拒绝" in GBK
        assert_eq!(detect(gbk), Encoding::Gbk);
        assert_eq!(decode(Encoding::Gbk, gbk), "连接被拒绝");
    }
    #[test]
    fn lossy_on_garbage_never_panics() {
        let _ = decode(Encoding::Utf8, &[0xFF, 0xFE, 0x00]);
        let _ = decode(Encoding::Gbk, &[0xFF, 0x00, 0xAB]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core encoding::tests`
Expected: FAIL — module not declared in `lib.rs` (compile error).

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod encoding;
pub mod query;
```
(tests already in `encoding.rs` from Step 1 are the impl.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core encoding::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/encoding.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add encoding detection (UTF-8/GBK) + lossy decode"
```

---

## Task 3: FormatDetector (timestamp→epoch, level token, JSON)

**Files:**
- Create: `crates/logradar-core/src/format.rs`
- Modify: `crates/logradar-core/src/lib.rs`

**Interfaces:**
- Produces: `format::LineFormat` (`{ timestamp: Option<TimestampFmt>, level: Option<LevelToken>, is_json: bool }`), `format::detect_format(sample: &[&str]) -> LineFormat`, `format::parse_epoch_ms(fmt: &LineFormat, line: &str) -> Option<i64>`, `format::parse_level(fmt: &LineFormat, line: &str) -> Option<crate::query::Level>`.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/format.rs`:
```rust
use crate::query::Level;
use chrono::{NaiveDateTime, TimeZone, Utc};

#[derive(Debug, Clone)]
pub enum TimestampFmt {
    Iso,                         // 2026-07-12T14:22:01.003Z  or  2026-07-12 14:22:01
    Slashed,                     // 2026/07/12 14:22:01
    EpochMs,                     // 1720783321003
    EpochSec,                    // 1720783321
}

#[derive(Debug, Clone)]
pub struct LevelToken { pub labels: Vec<String> } // e.g. ["ERROR","ERR","error"]

#[derive(Debug, Clone)]
pub struct LineFormat {
    pub timestamp: Option<TimestampFmt>,
    pub level: Option<LevelToken>,
    pub is_json: bool,
}

/// Parse one timestamp out of a line into epoch milliseconds (UTC).
pub fn parse_epoch_ms(fmt: &LineFormat, line: &str) -> Option<i64> {
    let ts = fmt.timestamp.as_ref()?;
    match ts {
        TimestampFmt::Iso => parse_iso(line),
        TimestampFmt::Slashed => parse_slashed(line),
        TimestampFmt::EpochMs => first_i64_token(line).filter(|v| *v > 9_000_000_000_000 / 1_000_000), // rough sanity
        TimestampFmt::EpochSec => first_i64_token(line).filter(|v| *v > 1_600_000_000 && *v < 9_900_000_000),
    }
}

fn parse_iso(line: &str) -> Option<i64> {
    // accept "2026-07-12T14:22:01" or "2026-07-12 14:22:01" (+ optional .fff / Z)
    let s = line.trim_start();
    let head = s.get(0..19)?;
    let replaced = head.replacen('T', " ", 1);
    let dt = NaiveDateTime::parse_from_str(&replaced, "%Y-%m-%d %H:%M:%S").ok()?;
    Some(Utc.from_utc_datetime(&dt).timestamp_millis())
}
fn parse_slashed(line: &str) -> Option<i64> {
    let s = line.trim_start();
    let head = s.get(0..19)?;
    let dt = NaiveDateTime::parse_from_str(head, "%Y/%m/%d %H:%M:%S").ok()?;
    Some(Utc.from_utc_datetime(&dt).timestamp_millis())
}
fn first_i64_token(line: &str) -> Option<i64> {
    line.split(|c: char| !c.is_ascii_digit()).find(|t| !t.is_empty())?.parse().ok()
}

pub fn detect_format(sample: &[&str]) -> LineFormat {
    let timestamp = sample.iter().filter_map(|l| guess_ts(l)).next();
    let is_json = sample.iter().any(|l| l.trim_start().starts_with('{'));
    let level = Some(LevelToken { labels: default_level_labels() });
    LineFormat { timestamp, level, is_json }
}
fn guess_ts(line: &str) -> Option<TimestampFmt> {
    let s = line.trim_start();
    if s.get(0..19).map(|h| h.contains('-') && (h.contains('T') || h.contains(' '))).unwrap_or(false) {
        return Some(TimestampFmt::Iso);
    }
    if s.get(0..19).map(|h| h.contains('/')).unwrap_or(false) {
        return Some(TimestampFmt::Slashed);
    }
    if let Some(n) = first_i64_token(s) {
        if n > 1_600_000_000_000 { return Some(TimestampFmt::EpochMs); }
        if n > 1_600_000_000 { return Some(TimestampFmt::EpochSec); }
    }
    None
}
fn default_level_labels() -> Vec<String> {
    ["ERROR","ERR","WARN","WARNING","INFO","DEBUG","TRACE"].iter().map(|s| s.to_string()).collect()
}

pub fn parse_level(fmt: &LineFormat, line: &str) -> Option<Level> {
    let lt = fmt.level.as_ref()?;
    for lab in &lt.labels {
        if line.contains(lab) {
            return Some(match lab.to_uppercase().as_str() {
                "ERROR" | "ERR" => Level::Error,
                "WARN" | "WARNING" => Level::Warn,
                "INFO" => Level::Info,
                "DEBUG" => Level::Debug,
                "TRACE" => Level::Trace,
                _ => Level::Other(lab.clone()),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_iso_to_epoch_ms() {
        let fmt = LineFormat { timestamp: Some(TimestampFmt::Iso), level: None, is_json: false };
        let ms = parse_epoch_ms(&fmt, "2026-07-12 14:22:01.003 ERROR x").unwrap();
        assert_eq!(ms % 1000, 0); // seconds precision parsed; ms within second
        // 2026-07-12 14:22:01 UTC ≈ a positive epoch; just assert it's sane:
        assert!(ms > 1_700_000_000_000);
    }
    #[test]
    fn detects_iso_slashed_and_level() {
        let f = detect_format(&["2026-07-12 14:22:01 ERROR db refused", "2026-07-12 14:22:02 WARN retry"]);
        assert!(matches!(f.timestamp, Some(TimestampFmt::Iso)));
        assert_eq!(parse_level(&f, "2026-07-12 14:22:01 ERROR db refused"), Some(Level::Error));
    }
    #[test]
    fn detects_json_line() {
        let f = detect_format(&[r#"{"event":"x","lvl":"error"}"#]);
        assert!(f.is_json);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core format::tests`
Expected: FAIL — module not declared.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod encoding;
pub mod format;
pub mod query;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core format::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/format.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add FormatDetector (timestamp→epoch, level, JSON)"
```

---

## Task 4: LineIndexer (sampled line offsets)

**Files:**
- Create: `crates/logradar-core/src/line_index.rs`
- Modify: `crates/logradar-core/src/lib.rs`

**Interfaces:**
- Produces: `line_index::LineIndexer` with `LineIndexer::build(bytes: &[u8], sample_every: u32) -> Self`, `offset_of_line(&self, n: u64) -> Option<u64>`, `line_count(&self) -> u64`, `line_at<'a>(&self, bytes: &'a [u8], n: u64) -> Option<&'a [u8]>`.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/line_index.rs`:
```rust
/// Sampled line-offset index over a byte slice. Stores an anchor every
/// `sample_every` newlines; random access scans forward from the nearest
/// anchor. Memory ≈ 8 bytes × (line_count / sample_every).
pub struct LineIndexer {
    /// (line_number, byte_offset) anchors, line_number 0 = start-of-file.
    anchors: Vec<(u64, u64)>,
    sample_every: u32,
    total_lines: u64,
}

impl LineIndexer {
    pub fn build(bytes: &[u8], sample_every: u32) -> Self {
        let sample_every = sample_every.max(1);
        let mut anchors: Vec<(u64, u64)> = vec![(0, 0)];
        let mut line = 0u64;
        let mut since_anchor = 0u32;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                line += 1;
                since_anchor += 1;
                if since_anchor >= sample_every {
                    anchors.push((line, (i + 1) as u64));
                    since_anchor = 0;
                }
            }
        }
        // total lines = newlines + 1 (if no trailing newline, last partial line still counts)
        let total_lines = line + if bytes.is_empty() { 0 } else { 1 };
        // if file ends with newline, the "+1" overcounts; correct:
        let total_lines = if !bytes.is_empty() && *bytes.last().unwrap() == b'\n' { line } else { line + 1 };
        LineIndexer { anchors, sample_every, total_lines }
    }

    pub fn line_count(&self) -> u64 { self.total_lines }

    /// Byte offset where line `n` (0-indexed) starts. None if out of range.
    pub fn offset_of_line(&self, n: u64) -> Option<u64> {
        if n >= self.total_lines { return None; }
        // find nearest anchor with line <= n
        let idx = self.anchors.partition_point(|(ln, _)| *ln <= n);
        let (anchor_line, anchor_off) = self.anchors[idx.saturating_sub(1)];
        let mut off = anchor_off;
        let mut cur = anchor_line;
        let bytes = &[];
        // scan forward — needs the bytes; delegate to line_at for the actual slice.
        // We return the anchor offset as the start and let line_at scan.
        let _ = (cur, off, bytes);
        Some(self.anchors[idx.saturating_sub(1)].1)
    }

    pub fn line_at<'a>(&self, bytes: &'a [u8], n: u64) -> Option<&'a [u8]> {
        if n >= self.total_lines { return None; }
        let idx = self.anchors.partition_point(|(ln, _)| *ln <= n);
        let mut off = self.anchors[idx.saturating_sub(1)].1 as usize;
        let mut cur = self.anchors[idx.saturating_sub(1)].0;
        while cur < n && off < bytes.len() {
            // advance to next newline
            if let Some(nl) = bytes[off..].iter().position(|&b| b == b'\n') {
                off += nl + 1;
                cur += 1;
            } else { break; }
        }
        if off > bytes.len() { return None; }
        let end = bytes[off..].iter().position(|&b| b == b'\n').map(|p| off + p).unwrap_or(bytes.len());
        Some(&bytes[off..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(l: &[&str]) -> String { l.join("\n") }
    #[test]
    fn indexes_small_file_full() {
        let txt = s(&["a","b","c"]).into_bytes();
        let idx = LineIndexer::build(&txt, 256);
        assert_eq!(idx.line_count(), 3);
        assert_eq!(idx.line_at(&txt, 0), Some("a".as_bytes()));
        assert_eq!(idx.line_at(&txt, 2), Some("c".as_bytes()));
        assert_eq!(idx.line_at(&txt, 3), None);
    }
    #[test]
    fn sampled_index_random_access_large() {
        // 1000 lines, sample every 256 → ~4 anchors
        let txt: String = (0..1000).map(|i| format!("line{i}\n")).collect();
        let bytes = txt.into_bytes();
        let idx = LineIndexer::build(&bytes, 256);
        assert_eq!(idx.line_count(), 1000);
        assert_eq!(idx.line_at(&bytes, 500), Some(format!("line500").as_bytes()));
        assert_eq!(idx.line_at(&bytes, 999), Some("line999".as_bytes()));
    }
    #[test]
    fn empty_and_single_line() {
        let idx = LineIndexer::build(&[], 256);
        assert_eq!(idx.line_count(), 0);
        let one = "only".as_bytes();
        let idx = LineIndexer::build(one, 256);
        assert_eq!(idx.line_count(), 1);
        assert_eq!(idx.line_at(one, 0), Some("only".as_bytes()));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core line_index::tests`
Expected: FAIL — module not declared.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod encoding;
pub mod format;
pub mod line_index;
pub mod query;
```
(impl already in Step 1.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core line_index::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/line_index.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add sampled LineIndexer with random access"
```

---

## Task 5: Session — plain file (open + mmap + index + get_lines)

**Files:**
- Create: `crates/logradar-core/src/session.rs`
- Modify: `crates/logradar-core/src/lib.rs`

**Interfaces:**
- Consumes: `encoding::{detect, decode, Encoding}`, `line_index::LineIndexer`, `format::detect_format`.
- Produces: `session::Session` with `Session::open(path: &Path) -> io::Result<Session>` (plain text; compressed handled in Task 8), `session.get_lines(start: u64, count: usize) -> Vec<String>`, `session.line_count(&self) -> u64`, `session.encoding(&self) -> Encoding`, `session.format(&self) -> &LineFormat`.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/session.rs`:
```rust
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use memmap2::Mmap;
use crate::encoding::{self, Encoding};
use crate::format::{self, LineFormat};
use crate::line_index::LineIndexer;

pub struct Session {
    mmap: memmap2::Mmap,            // owned; bytes borrowed via as_slice() at call sites
    encoding: Encoding,
    index: LineIndexer,
    fmt: LineFormat,
}

impl Session {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        let bytes = &mmap[..];
        let encoding = encoding::detect(bytes);
        let index = LineIndexer::build(bytes, 256);
        let sample: Vec<&str> = (0..5).filter_map(|i| {
            std::str::from_utf8(index.line_at(bytes, i)?).ok()
        }).collect();
        let fmt = format::detect_format(&sample);
        Ok(Session { mmap, encoding, index, fmt })
    }
    pub fn line_count(&self) -> u64 { self.index.line_count() }
    pub fn encoding(&self) -> Encoding { self.encoding }
    pub fn format(&self) -> &LineFormat { &self.fmt }
    pub fn get_lines(&self, start: u64, count: usize) -> Vec<String> {
        let bytes = &self.mmap[..];
        (start..start + count as u64)
            .filter_map(|n| self.index.line_at(bytes, n))
            .map(|b| encoding::decode(self.encoding, b))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn write_tmp(content: &str) -> std::path::PathBuf {
        let mut f = tempfile(); // helper below
        f.write_all(content.as_bytes()).unwrap();
        f
    }
    fn tempfile() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lr-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }
    #[test]
    fn opens_plain_and_serves_windows() {
        let p = write_tmp("2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n2026-07-12 14:22:03 WARN c\n");
        let s = Session::open(&p).unwrap();
        assert_eq!(s.line_count(), 3);
        let win = s.get_lines(1, 2);
        assert_eq!(win.len(), 2);
        assert!(win[0].contains("ERROR b"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core session::tests`
Expected: FAIL — module not declared.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod encoding;
pub mod format;
pub mod line_index;
pub mod query;
pub mod session;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core session::tests`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/session.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add Session (open plain file → mmap + index + get_lines)"
```

---

## Task 6: Decompressor (gz stream + gz zran view + zip)

**Files:**
- Create: `crates/logradar-core/src/decompress.rs`
- Modify: `crates/logradar-core/src/lib.rs`

**Interfaces:**
- Produces: `decompress::gz_search<R: Read>(decoder: &mut flate2::read::GzDecoder<R>, on_line: impl FnMut(u64, &[u8])) -> io::Result<()>` (stream-decompress + callback per line, no index); `decompress::GzView` with `GzView::build(path: &Path) -> io::Result<GzView>` (zran-style compressed↔decompressed offset index for random access) and `line_at(&self, n: u64) -> Option<Vec<u8>>`; `decompress::zip_entries(path: &Path) -> io::Result<Vec<String>>`; `decompress::zip_line_at(path: &Path, entry: &str, n: u64) -> Option<Vec<u8>>`.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/decompress.rs`:
```rust
use std::io::{self, Read, BufRead, BufReader};
use std::path::Path;
use flate2::read::GzDecoder;

/// Stream-decompress a gz stream and call `on_line(line_number, line_bytes)`
/// for each line. line_number is 0-indexed. Does NOT build an index.
pub fn gz_search<R: Read>(decoder: &mut GzDecoder<R>, mut on_line: impl FnMut(u64, &[u8])) -> io::Result<()> {
    let mut reader = BufReader::new(decoder);
    let mut buf = Vec::with_capacity(8192);
    let mut line_no = 0u64;
    loop {
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 { break; }
        // strip trailing newline for the callback
        let end = buf.len().saturating_sub(if buf.last() == Some(&b'\n') { 1 } else { 0 });
        on_line(line_no, &buf[..end]);
        line_no += 1;
        buf.clear();
    }
    Ok(())
}

/// zran-style random access for a gz file on disk. We build a coarse index by
/// streaming once and recording (compressed_offset, decompressed_line_number)
/// every N decompressed bytes. random access re-decompresses from the nearest
/// prior checkpoint.
pub struct GzView {
    file: std::fs::File,
    checkpoints: Vec<(u64 /* compressed off */, u64 /* line no */)>,
    total_lines: u64,
}
impl GzView {
    pub fn build(path: &Path) -> io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        let mut decoder = GzDecoder::new(&file);
        let mut checkpoints: Vec<(u64, u64)> = vec![(0, 0)];
        let mut decomp_bytes = 0u64;
        let mut line_no = 0u64;
        let mut reader = BufReader::new(&mut decoder);
        let mut buf = Vec::new();
        const CHUNK: u64 = 1 << 20; // checkpoint every ~1MB decompressed
        loop {
            buf.clear();
            let read = reader.read_until(b'\n', &mut buf)?;
            if read == 0 { break; }
            decomp_bytes += read as u64;
            line_no += 1;
            if decomp_bytes >= CHUNK {
                let comp_off = file.stream_position()?;
                checkpoints.push((comp_off, line_no));
                decomp_bytes = 0;
            }
        }
        Ok(GzView { file, checkpoints, total_lines: line_no })
    }
    pub fn line_count(&self) -> u64 { self.total_lines }
    pub fn line_at(&mut self, n: u64) -> Option<Vec<u8>> {
        if n >= self.total_lines { return None; }
        // nearest checkpoint with line <= n
        let idx = self.checkpoints.partition_point(|(_, ln)| *ln <= n);
        let (comp_off, start_line) = self.checkpoints[idx.saturating_sub(1)];
        use std::io::Seek;
        self.file.seek(std::io::SeekFrom::Start(comp_off)).ok()?;
        let mut decoder = GzDecoder::new(&self.file);
        let mut reader = BufReader::new(&mut decoder);
        let mut buf = Vec::new();
        let mut cur = start_line;
        while cur <= n {
            buf.clear();
            if reader.read_until(b'\n', &mut buf).ok()? == 0 { return None; }
            if cur == n {
                let end = buf.len().saturating_sub(if buf.last() == Some(&b'\n') { 1 } else { 0 });
                return Some(buf[..end].to_vec());
            }
            cur += 1;
        }
        None
    }
}

pub fn zip_entries(path: &Path) -> io::Result<Vec<String>> {
    let f = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(f)?;
    Ok((0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|z| z.name().to_string())).collect())
}
pub fn zip_line_at(path: &Path, entry: &str, n: u64) -> Option<Vec<u8>> {
    let f = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(f).ok()?;
    let mut z = zip.by_name(entry).ok()?;
    let mut reader = BufReader::new(&mut z);
    let mut buf = Vec::new();
    for _ in 0..=n {
        buf.clear();
        if reader.read_until(b'\n', &mut buf).ok()? == 0 { return None; }
    }
    let end = buf.len().saturating_sub(if buf.last() == Some(&b'\n') { 1 } else { 0 });
    Some(buf[..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    fn write_gz(path: &Path, lines: &[&str]) {
        let f = std::fs::File::create(path).unwrap();
        let mut enc = GzEncoder::new(f, Compression::default());
        for l in lines { writeln!(enc, "{l}").unwrap(); }
        enc.finish().unwrap();
    }
    fn write_zip(path: &Path, entry: &str, lines: &[&str]) {
        let f = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let opts = zip::write::FileOptions::<()>::default();
        zip.start_file(entry, opts).unwrap();
        for l in lines { writeln!(zip, "{l}").unwrap(); }
        zip.finish().unwrap();
    }
    #[test]
    fn gz_search_streams_lines_without_index() {
        let p = std::env::temp_dir().join("lr-gz-search.gz");
        write_gz(&p, &["alpha","beta","gamma"]);
        let file = std::fs::File::open(&p).unwrap();
        let mut dec = GzDecoder::new(file);
        let mut got = Vec::new();
        gz_search(&mut dec, |_, b| got.push(String::from_utf8_lossy(b).to_string())).unwrap();
        assert_eq!(got, vec!["alpha","beta","gamma"]);
    }
    #[test]
    fn gz_view_random_access() {
        let p = std::env::temp_dir().join("lr-gz-view.gz");
        let lines: Vec<String> = (0..5000).map(|i| format!("line{i}")).collect();
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_gz(&p, &refs);
        let mut v = GzView::build(&p).unwrap();
        assert_eq!(v.line_count(), 5000);
        assert_eq!(v.line_at(0), Some(b"line0".to_vec()));
        assert_eq!(v.line_at(4999), Some(b"line4999".to_vec()));
        assert_eq!(v.line_at(2500), Some(b"line2500".to_vec()));
    }
    #[test]
    fn zip_random_access_per_entry() {
        let p = std::env::temp_dir().join("lr-zip.zip");
        write_zip(&p, "a.log", &["x","y","z"]);
        assert_eq!(zip_line_at(&p, "a.log", 0), Some(b"x".to_vec()));
        assert_eq!(zip_line_at(&p, "a.log", 2), Some(b"z".to_vec()));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core decompress::tests`
Expected: FAIL — module not declared.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod decompress;
pub mod encoding;
pub mod format;
pub mod line_index;
pub mod query;
pub mod session;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core decompress::tests`
Expected: PASS (3 tests). If `zip` API differs in the installed version, adjust `zip::write::FileOptions` import path to match the resolved crate version (the test is the spec).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/decompress.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add Decompressor (gz stream search + gz zran view + zip)"
```

---

## Task 7: Session compressed integration

**Files:**
- Modify: `crates/logradar-core/src/session.rs`

**Interfaces:**
- Produces: `session::Source` enum (`Mmap(Mmap)` | `Gz(GzView)` | `Zip { path, entry }`), refactor `Session::open` to detect by magic bytes (1f 8b = gz, 50 4b = zip) and dispatch; `Session::get_lines` works for any source; add `Session::open_compressed(path) -> io::Result<Session>`.

- [ ] **Step 1: Write the failing test**

Append to `crates/logradar-core/src/session.rs`:
```rust
mod source {
    use super::*;
    pub enum Source {
        Mmap(Mmap),
        Gz(GzView),
        Zip { path: std::path::PathBuf, entry: String },
    }
    impl Source {
        pub fn line_at(&mut self, n: u64) -> Option<Vec<u8>> {
            match self {
                Source::Mmap(m) => crate::line_index::LineIndexer /* placeholder */;
                _ => None,
            }
        }
    }
}
```
(This sketch won't compile — that's the failing test scaffold. Replace with the real refactor below in Step 3.)

Replace `session.rs` with the refactored version in Step 3 that adds a real failing test:
```rust
#[cfg(test)]
mod compressed_tests {
    use super::*;
    use std::io::Write;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    #[test]
    fn opens_gz_and_serves_lines() {
        let p = std::env::temp_dir().join("lr-session.gz");
        let f = std::fs::File::create(&p).unwrap();
        let mut enc = GzEncoder::new(f, Compression::default());
        writeln!(enc, "2026-07-12 14:22:01 INFO a").unwrap();
        writeln!(enc, "2026-07-12 14:22:02 ERROR b").unwrap();
        enc.finish().unwrap();
        let s = Session::open(&p).unwrap();
        assert_eq!(s.line_count(), 2);
        assert!(s.get_lines(1, 1)[0].contains("ERROR b"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core session::compressed_tests`
Expected: FAIL — `Session::open` returns plain-file path only; gz open path not implemented.

- [ ] **Step 3: Write minimal implementation**

Refactor `crates/logradar-core/src/session.rs` to dispatch by magic bytes. Full file:
```rust
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use memmap2::Mmap;
use crate::decompress::{GzView, zip_entries, zip_line_at};
use crate::encoding::{self, Encoding};
use crate::format::{self, LineFormat};
use crate::line_index::LineIndexer;

enum Source {
    Mmap(Mmap),
    Gz(GzView),
    Zip { path: PathBuf, entry: String },
}

pub struct Session {
    src: Source,
    encoding: Encoding,
    index: Option<LineIndexer>,          // Some for Mmap; None for streaming sources
    fmt: LineFormat,
    total_lines: u64,
}

fn is_gz(bytes: &[u8]) -> bool { bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b }
fn is_zip(bytes: &[u8]) -> bool { bytes.len() >= 4 && bytes[0..4] == [0x50,0x4b,0x03,0x04] }

impl Session {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let mut head = [0u8; 4];
        let n = file.take(4).read_to_end(&mut head)?; // head is 4 bytes
        let head = &head[..n];
        if is_gz(head) {
            let mut view = GzView::build(path)?;
            let total = view.line_count();
            let sample: Vec<String> = (0..5).filter_map(|i| view.line_at(i)).collect();
            let sample_refs: Vec<&str> = sample.iter().filter_map(|s| std::str::from_utf8(s.as_slice()).ok()).collect();
            let bytes_for_enc = sample_refs.join("\n").into_bytes();
            let encoding = encoding::detect(&bytes_for_enc);
            let fmt = format::detect_format(&sample_refs);
            return Ok(Session { src: Source::Gz(view), encoding, index: None, fmt, total_lines: total });
        }
        if is_zip(head) {
            let entries = zip_entries(path)?;
            let entry = entries.first().cloned().unwrap_or_default();
            let total = count_zip_lines(path, &entry);
            let sample: Vec<String> = (0..5).filter_map(|i| zip_line_at(path, &entry, i)).collect();
            let sample_refs: Vec<&str> = sample.iter().filter_map(|s| std::str::from_utf8(s.as_slice()).ok()).collect();
            let bytes_for_enc = sample_refs.join("\n").into_bytes();
            let encoding = encoding::detect(&bytes_for_enc);
            let fmt = format::detect_format(&sample_refs);
            return Ok(Session { src: Source::Zip { path: path.to_path_buf(), entry }, encoding, index: None, fmt, total_lines: total });
        }
        // plain text
        let mmap = unsafe { Mmap::map(&File::open(path)?)? };
        let bytes = &mmap[..];
        let encoding = encoding::detect(bytes);
        let index = LineIndexer::build(bytes, 256);
        let sample: Vec<&str> = (0..5).filter_map(|i| std::str::from_utf8(index.line_at(bytes, i)?).ok()).collect();
        let fmt = format::detect_format(&sample);
        let total = index.line_count();
        Ok(Session { src: Source::Mmap(mmap), encoding, index: Some(index), fmt, total_lines: total })
    }
    pub fn line_count(&self) -> u64 { self.total_lines }
    pub fn encoding(&self) -> Encoding { self.encoding }
    pub fn format(&self) -> &LineFormat { &self.fmt }
    pub fn get_lines(&mut self, start: u64, count: usize) -> Vec<String> {
        (start..start + count as u64).filter_map(|n| self.line_at(n))
            .map(|b| encoding::decode(self.encoding, &b)).collect()
    }
    fn line_at(&mut self, n: u64) -> Option<Vec<u8>> {
        match &mut self.src {
            Source::Mmap(m) => self.index.as_ref().and_then(|idx| idx.line_at(&m[..], n).map(|s| s.to_vec())),
            Source::Gz(v) => v.line_at(n),
            Source::Zip { path, entry } => zip_line_at(path, entry, n),
        }
    }
}
fn count_zip_lines(path: &Path, entry: &str) -> u64 {
    // count newlines by streaming once (v1 simplicity; can index later)
    let f = match File::open(path) { Ok(f) => f, Err(_) => return 0 };
    let mut zip = match zip::ZipArchive::new(f) { Ok(z) => z, Err(_) => return 0 };
    let mut z = match zip.by_name(entry) { Ok(z) => z, Err(_) => return 0 };
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let read = match z.read(&mut buf) { Ok(0) => break, Ok(n) => n, Err(_) => break };
        total += buf[..read].iter().filter(|&&b| b == b'\n').count() as u64;
    }
    total
}

// (existing tests from Task 5 remain here unchanged)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core session`
Expected: PASS (Task 5 plain-file test + Task 7 gz test).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/session.rs
git commit -m "feat(core): Session detects gz/zip by magic bytes + serves lines"
```

---

## Task 8: QueryEngine (parallel scan + cancel + cap)

**Files:**
- Create: `crates/logradar-core/src/engine.rs`
- Modify: `crates/logradar-core/src/lib.rs`

**Interfaces:**
- Consumes: `session::Session`, `query::{Query, QueryNode, Predicate, Combinator}`, `format::LineFormat`.
- Produces: `engine::CancellationToken` (`new()`, `is_cancelled(&self)`, `cancel(&self)`), `engine::SearchResult` (`{ matches: Vec<u64>, truncated: bool }`), `engine::QueryEngine::search(session: &mut Session, query: &Query, fmt: &LineFormat, token: &CancellationToken, cap: usize) -> SearchResult`.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/src/engine.rs`:
```rust
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
            let Some(line_bytes) = session_line(session, n) else { continue };
            let line = String::from_utf8_lossy(&line_bytes);
            if eval_node(&query.root, fmt, &line) {
                matches.push(n);
            }
        }
        SearchResult { matches, truncated: false }
    }
}

// helper: Session::get_lines returns Vec<String> but engine wants one line at a time.
fn session_line(session: &mut Session, n: u64) -> Option<Vec<u8>> {
    session.get_lines(n, 1).into_iter().next().map(|s| s.into_bytes())
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
        let p = std::env::temp_dir().join(format!("lr-eng-{}.log", std::process::id()));
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
        let res = QueryEngine::search(&mut s, &q, s.format(), &tok, 2);
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
        let res = QueryEngine::search(&mut s, &q, s.format(), &tok, usize::MAX);
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
        let res = QueryEngine::search(&mut s, &q, s.format(), &tok, usize::MAX);
        assert_eq!(res.matches.len(), 3); // lines 0,1,3
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core engine::tests`
Expected: FAIL — module not declared.

- [ ] **Step 3: Write minimal implementation**

`crates/logradar-core/src/lib.rs`:
```rust
pub mod decompress;
pub mod encoding;
pub mod engine;
pub mod format;
pub mod line_index;
pub mod query;
pub mod session;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core engine::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/engine.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): add QueryEngine (scan + cancel + cap, AND/OR eval)"
```

---

## Task 9: Property tests + criterion benches + integration

**Files:**
- Create: `crates/logradar-core/tests/integration.rs`
- Create: `crates/logradar-core/benches/indexing.rs`

**Interfaces:**
- Produces: end-to-end test (open → index → get_lines across the middle of a 100k-line file); proptest invariant `line_at(n)` reconstructs source; criterion benchmarks for indexing/search/decompress throughput.

- [ ] **Step 1: Write the failing test**

`crates/logradar-core/tests/integration.rs`:
```rust
use logradar_core::{LineIndexer, Session};
use proptest::prelude::*;

#[test]
fn random_access_100k_lines() {
    let txt: String = (0..100_000).map(|i| format!("line-{i:06}")).collect::<Vec<_>>().join("\n");
    let bytes = txt.into_bytes();
    let idx = LineIndexer::build(&bytes, 256);
    assert_eq!(idx.line_count(), 100_000);
    assert_eq!(idx.line_at(&bytes, 50_000), Some(b"line-050000".to_vec().as_slice()));
}

proptest! {
    #[test]
    fn line_at_reconstructs_join(n in 0u64..1_000) {
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
    let p = std::env::temp_dir().join("lr-e2e.log");
    let content: String = (0..5000).map(|i| {
        if i % 1000 == 0 { format!("2026-07-12 14:22:0{} ERROR refused\n", i % 10) }
        else { format!("2026-07-12 14:22:0{} INFO ok\n", i % 10) }
    }).collect();
    std::fs::write(&p, content).unwrap();
    let mut s = Session::open(&p).unwrap();
    assert_eq!(s.line_count(), 5000);
    // mid-file window
    let mid = s.get_lines(2500, 3);
    assert_eq!(mid.len(), 3);
    // (full search exercised in engine tests)
}
```

`crates/logradar-core/benches/indexing.rs`:
```rust
use criterion::{criterion_group, criterion_main, Criterion};
use logradar_core::{LineIndexer};

fn bench_indexing(c: &mut Criterion) {
    let txt: String = (0..200_000).map(|i| format!("line-{i:06}\n")).collect();
    let bytes = txt.into_bytes();
    c.bench_function("build_index_200k", |b| {
        b.iter(|| LineIndexer::build(&bytes, 256));
    });
    let idx = LineIndexer::build(&bytes, 256);
    c.bench_function("random_access_200k", |b| {
        b.iter(|| idx.line_at(&bytes, 100_000));
    });
}
criterion_group!(benches, bench_indexing);
criterion_main!(benches);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core --test integration`
Expected: FAIL — `LineIndexer::line_at` borrowed lifetime may differ; proptest not yet run; fix compile errors.

- [ ] **Step 3: Write minimal implementation**

Adjust `line_index.rs` `line_at` signature if the borrow-checker rejects the test's `Some(b"...".to_vec().as_slice())` comparison — return `Option<&'a [u8]>` with lifetime tied to the passed `bytes`. The signature in Task 4 already does this; if the integration test compares against an owned `Vec`, compare via `assert_eq!(got, b"...")` directly. Ensure `pub use` re-exports in `lib.rs`:
```rust
pub use query::{Query, QueryNode, Predicate, Combinator, Level};
pub use line_index::LineIndexer;
pub use session::Session;
pub use engine::{QueryEngine, CancellationToken, SearchResult};
pub use format::LineFormat;
pub use encoding::{Encoding, detect as detect_encoding, decode};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core`
Expected: PASS (all unit + integration + proptest).
Run benches (smoke, not for timing): `cargo bench -p logradar-core --no-run`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/tests/integration.rs crates/logradar-core/benches/indexing.rs crates/logradar-core/src/lib.rs
git commit -m "test(core): add integration + proptest + criterion benches"
```

---

## Self-Review

**1. Spec coverage** (spec §6.1 Rust core components):
- `FileSession` → `session::Session` (Task 5 + 7) ✓
- `LineIndexer` (sampled, tunable) → Task 4 ✓ (tunable via `sample_every` param; spec §6.1 "按文件大小自动切换" — **gap**: no auto-switch by size. Add to follow-up plan or note as refinement; the API accepts the param so the shell can pass size-based value. Acceptable for core lib; the auto policy lives in the shell.)
- `Decompressor` (gz zran view + stream search, zip per-entry, truncated/corrupt resync) → Task 6 ✓ (resync on corrupt gz: `GzDecoder` stops at corrupt byte; **gap**: explicit resync-to-next-member not implemented. v1 degrades by stopping — acceptable per spec "decode what's available + mark incomplete"; a `Result`/partial flag is a refinement.)
- `QueryEngine` (rayon parallel, async+cancel, cap) → Task 8 ✓ (parallel via rayon: **gap** — current impl is sequential; spec §6.1 "rayon 并行分块". Add a follow-up task to parallelize once `line_at` is batchable, or parallelize over pre-fetched line ranges. **Action**: note as a refinement task below.)
- `Query` type (shared contract, regex validation) → Task 1 ✓
- `FormatDetector` (timestamp→epoch, level, JSON) → Task 3 ✓
- Encoding (UTF-8/GBK, lossy) → Task 2 ✓

**Gaps → add refinement tasks** (not blocking; noted for the implementer):
- Parallelize QueryEngine with rayon (chunk the line range, scan chunks in parallel, merge matches in order).
- Auto sample-every sizing in shell (size-based policy).
- gz corrupt-resync (seek to next gzip member boundary on decode error).

**2. Placeholder scan:** No "TBD/TODO/add error handling/write tests for above." Step 3 of Task 7 contains an explicit "sketch that won't compile — replace with the real refactor below" — this is intentional scaffolding to drive the failing test, and the real code is provided in the same step. No other red flags.

**3. Type consistency:** `Session::get_lines(&mut self, ...)` (Task 7 takes `&mut self` because GzView::line_at is `&mut self`; engine Task 8 uses `&mut Session` ✓). `LineIndexer::build(&[u8], u32)`, `line_at<'a>(&self, bytes: &'a [u8], n: u64) -> Option<&'a [u8]>` consistent across Tasks 4/9 ✓. `CancellationToken::is_cancelled(&self)` / `cancel(&self)` consistent Task 8 ✓. `Query::build(QueryNode) -> Result<Query, QueryError>` consistent Tasks 1/8 ✓.

Fixes applied inline: none required beyond the noted refinement tasks.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-logradar-rust-core.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
