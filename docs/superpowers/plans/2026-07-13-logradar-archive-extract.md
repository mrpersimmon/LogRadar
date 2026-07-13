# LogRadar Archive Extract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v1 "archive as single session" with extract-then-open: a nested `.zip`/`.gz` is fully extracted to a sibling directory, then each `.log` becomes a normal session (reusing mmap + cross-file search).

**Architecture:** New core `extractor` module (nested `.zip`/`.gz` extraction, depth cap 10, `.logradar-extracted` marker reuse, `foo-extracted/` conflict rename, per-file progress callback). New IPC `extract_archive` (Channel progress) + `scan_dir` commands. Frontend adds Open archive button + restores Open folder (scan `.log` + archive hint) + Open file filter `.log/.txt`. Reuses `Session::open(.log)` + cross-file search + `FileTree` unchanged.

**Tech Stack:** Rust (zip 0.6, flate2 1, memmap2 — already in `logradar-core/Cargo.toml`), Tauri 2 (`ipc::Channel`), React 18 + TS + Vite + Vitest.

## Global Constraints

- Tauri 2.x; Rust stable ≥ 1.75; `zip = "0.6"`; `flate2 = "1"` (already deps).
- Don't break the 36 Rust tests or 170 frontend tests.
- TDD: failing test → impl → pass → commit per task.
- Extract target: sibling to archive; `foo.zip` → `foo/`; `a.log.gz` → `a.log`.
- Depth cap = 10 (no file-count/byte limit).
- Marker file = `.logradar-extracted` (empty), in the zip's target dir.
- Conflict rename: `foo-extracted/` then `foo-extracted-2/` etc.
- Progress: per-file IPC event `ExtractProgress { done, total, currentFile }`.
- Out of scope (post-v1.1): `.tar`/`.7z`/`.rar`, cancel mid-extract, per-byte progress, variable target dir, extract cleanup on close.

---

## File Structure

- **Create:** `crates/logradar-core/src/extractor.rs` — `extract_archive` + helpers + nested recursion + depth cap + marker/reuse/conflict + progress callback.
- **Modify:** `crates/logradar-core/src/lib.rs` — `pub mod extractor;`.
- **Modify:** `src-tauri/src/commands.rs` — `extract_archive` + `scan_dir` commands + `ExtractProgress`/`ExtractResponse`/`ScanDirResponse` DTOs.
- **Modify:** `src-tauri/src/lib.rs` — register `extract_archive` + `scan_dir` in the invoke handler.
- **Modify:** `src/lib/ipc.ts` — `extractArchive` + `scanDir` client wrappers + `useExtract` Channel hook.
- **Modify:** `src/pages/WelcomePage.tsx` — Open archive button + Open folder restore (scan + hint) + Open file filter + progress UI.
- **Create:** `src/components/ExtractProgress.tsx` — small progress widget (done/total + current file).
- **Modify:** `src/hooks/useSessions.ts` — `openArchive(path)` + `openFolder(path)` (extract/scan → `open_file` each).

Each file one responsibility: `extractor.rs` = pure core logic, `commands.rs` = IPC bridge, `ipc.ts` = typed client, `WelcomePage.tsx` = UI entry, `ExtractProgress.tsx` = progress widget.

---

### Task 1: extractor — single .zip extract + marker

**Files:**
- Create: `crates/logradar-core/src/extractor.rs`
- Modify: `crates/logradar-core/src/lib.rs` (add `pub mod extractor;`)

**Interfaces:**
- Produces: `pub fn extract_archive(archive_path: &Path, on_progress: impl FnMut(u64, u64, &str)) -> io::Result<PathBuf>` — extracts a single `.zip` to `foo/` (sibling, stripped ext) + writes `.logradar-extracted` marker, returns target dir.

- [ ] **Step 1: Write the failing test**

```rust
// crates/logradar-core/src/extractor.rs (append #[cfg(test)] mod tests at bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::FileOptions::default();
        for (name, content) in entries {
            zw.start_file(name, opts).unwrap();
            zw.write_all(content.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }

    #[test]
    fn extracts_single_zip_to_sibling_dir_with_marker() {
        let dir = std::env::temp_dir().join(format!("lr-ext-1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("foo.zip");
        write_zip(&zip_path, &[("a.log", "INFO a\nERROR boom\n"), ("b.log", "WARN x\n")]);
        let target = extract_archive(&zip_path, |_, _, _| {}).unwrap();
        assert_eq!(target, dir.join("foo"));
        assert!(target.join(".logradar-extracted").exists(), "marker must be written");
        assert!(target.join("a.log").exists());
        assert!(target.join("b.log").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-core --lib extractor`
Expected: FAIL — `extract_archive` not defined / module not exported.

- [ ] **Step 3: Write minimal implementation**

In `crates/logradar-core/src/lib.rs` add:
```rust
pub mod extractor;
```

Create `crates/logradar-core/src/extractor.rs`:
```rust
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MARKER: &str = ".logradar-extracted";

/// Extract a (possibly nested) archive to a sibling directory. Returns the
/// extracted directory path. `on_progress(done, total, current_file)` is
/// called per extracted file. Reuses a prior extract if the target carries
/// the marker; renames on conflict with a user dir.
pub fn extract_archive(
    archive_path: &Path,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> io::Result<PathBuf> {
    let target = compute_target(archive_path)?;
    if target.exists() && has_marker(&target) {
        return Ok(target); // reuse prior extract
    }
    if target.exists() {
        // conflict: user dir without marker — not handled yet in Task 1
        return Err(io::Error::new(io::ErrorKind::AlreadyExists,
            "target exists without marker (conflict handling in a later task)"));
    }
    fs::create_dir_all(&target)?;
    let mut state = ProgressState { done: 0, total: 0 };
    extract_zip_entries(archive_path, &target, &mut state, &mut on_progress)?;
    fs::write(target.join(MARKER), "")?;
    Ok(target)
}

fn compute_target(archive_path: &Path) -> io::Result<PathBuf> {
    let parent = archive_path.parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "archive has no parent"))?;
    let stem = archive_path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid archive name"))?;
    Ok(parent.join(stem))
}

fn has_marker(dir: &Path) -> bool {
    dir.join(MARKER).exists()
}

struct ProgressState { done: u64, total: u64 }

fn extract_zip_entries(
    archive: &Path,
    target: &Path,
    state: &mut ProgressState,
    on_progress: &mut impl FnMut(u64, u64, &str),
) -> io::Result<()> {
    let f = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(f)?;
    state.total += zip.len() as u64;
    for i in 0..zip.len() {
        let mut z = zip.by_index(i)?;
        if z.is_dir() { continue; }
        let name = z.name().to_string();
        let out_path = target.join(&name);
        if let Some(p) = out_path.parent() { fs::create_dir_all(p)?; }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut z, &mut out)?;
        state.done += 1;
        on_progress(state.done, state.total, &name);
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-core --lib extractor`
Expected: PASS — `extracts_single_zip_to_sibling_dir_with_marker`.

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/extractor.rs crates/logradar-core/src/lib.rs
git commit -m "feat(core): extractor — single .zip extract + marker"
```

---

### Task 2: extractor — .gz + nested recursion + depth cap

**Files:**
- Modify: `crates/logradar-core/src/extractor.rs`

**Interfaces:**
- Produces: `extract_archive` now handles `.gz` (→ `a.log` file) and nested archives (zip entry that is itself `.zip`/`.gz` is recursively extracted, depth ≤ 10).
- Produces: `fn extract_recursive(archive: &Path, depth: usize, state, on_progress) -> io::Result<()>` (internal).

- [ ] **Step 1: Write the failing tests**

Append to `mod tests`:
```rust
    use flate2::write::GzEncoder;
    use flate2::Compression;
    fn write_gz(path: &Path, content: &str) {
        let f = std::fs::File::create(path).unwrap();
        let mut enc = GzEncoder::new(f, Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        enc.finish().unwrap();
    }

    #[test]
    fn extracts_single_gz_to_sibling_file() {
        let dir = std::env::temp_dir().join(format!("lr-ext-gz-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gz_path = dir.join("a.log.gz");
        write_gz(&gz_path, "INFO a\nERROR boom\n");
        let target = extract_archive(&gz_path, |_, _, _| {}).unwrap();
        assert_eq!(target, dir.join("a.log"));
        assert!(target.is_file());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "INFO a\nERROR boom\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_zip_containing_gz_extracts_both() {
        let dir = std::env::temp_dir().join(format!("lr-ext-nest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // build inner a.log.gz into a Vec, then write it as a zip entry
        let mut inner_gz: Vec<u8> = Vec::new();
        { let mut enc = GzEncoder::new(std::io::Cursor::new(&mut inner_gz), Compression::default());
          enc.write_all(b"ERROR nested boom\n").unwrap(); enc.finish().unwrap(); }
        let zip_path = dir.join("foo.zip");
        { let f = std::fs::File::create(&zip_path).unwrap();
          let mut zw = zip::ZipWriter::new(f);
          let opts = zip::write::FileOptions::default();
          zw.start_file("a.log.gz", opts).unwrap();
          zw.write_all(&inner_gz).unwrap();
          zw.start_file("b.log", opts).unwrap();
          zw.write_all(b"WARN x\n").unwrap();
          zw.finish().unwrap(); }
        let target = extract_archive(&zip_path, |_, _, _| {}).unwrap();
        assert_eq!(target, dir.join("foo"));
        assert!(target.join("a.log").is_file(), "nested .gz must be extracted to .log");
        assert_eq!(std::fs::read_to_string(target.join("a.log")).unwrap(), "ERROR nested boom\n");
        assert!(target.join("b.log").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn depth_over_10_errors_and_cleans_up() {
        // Build a chain of 11 nested zips: o0.zip contains o1.zip contains ... o10.zip.
        let dir = std::env::temp_dir().join(format!("lr-ext-deep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // start from innermost: a leaf log, wrap 11 times
        let mut current: Vec<u8> = b"leaf\n".to_vec();
        for i in 0..11 {
            let mut buf: Vec<u8> = Vec::new();
            { let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
              let opts = zip::write::FileOptions::default();
              zw.start_file(format!("o{}.zip", i), opts).unwrap();
              zw.write_all(&current).unwrap();
              zw.finish().unwrap(); }
            current = buf;
        }
        let zip_path = dir.join("deep.zip");
        std::fs::write(&zip_path, &current).unwrap();
        let res = extract_archive(&zip_path, |_, _, _| {});
        assert!(res.is_err(), "depth 11 must error");
        let msg = res.unwrap_err().to_string();
        assert!(msg.contains("too deep") || msg.contains("depth"), "err must mention depth, got: {msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p logradar-core --lib extractor`
Expected: FAIL — `.gz` not handled; nested not recursed; no depth check.

- [ ] **Step 3: Extend the implementation**

Replace the body of `extract_archive` (after computing `target` + reuse/conflict guard) to call a new recursive helper, and add `.gz` + recursion + depth. Update `extract_archive`:
```rust
pub fn extract_archive(
    archive_path: &Path,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> io::Result<PathBuf> {
    let target = compute_target(archive_path)?;
    if target.exists() && has_marker(&target) {
        return Ok(target);
    }
    if target.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists,
            "target exists without marker (conflict handling in a later task)"));
    }
    fs::create_dir_all(&target)?;
    let mut state = ProgressState { done: 0, total: 0 };
    let res = extract_into(archive_path, &target, 0, &mut state, &mut on_progress);
    if res.is_err() {
        let _ = fs::remove_dir_all(&target); // cleanup partial on any error
        return res;
    }
    fs::write(target.join(MARKER), "")?;
    Ok(target)
}
```

Add `extract_into` + `.gz` helper + nested scan + depth:
```rust
const MAX_DEPTH: usize = 10;

/// Extract `archive`'s contents into `target` (a dir for .zip; a file path for .gz),
/// then recurse into any nested archive found among the extracted files.
fn extract_into(
    archive: &Path,
    target: &Path,
    depth: usize,
    state: &mut ProgressState,
    on_progress: &mut impl FnMut(u64, u64, &str),
) -> io::Result<()> {
    if depth > MAX_DEPTH {
        return Err(io::Error::new(io::ErrorKind::InvalidInput,
            "archive nesting too deep (max 10)"));
    }
    if is_zip(archive) {
        extract_zip_entries(archive, target, state, on_progress)?;
        // scan target for nested archives and recurse
        let nested = find_nested_archives(target)?;
        for n in nested {
            let n_target = compute_target(&n)?;
            // nested target is sibling to n (inside target) — ensure parent exists
            if let Some(p) = n_target.parent() { fs::create_dir_all(p)?; }
            extract_into(&n, &n_target, depth + 1, state, on_progress)?;
        }
    } else if is_gz(archive) {
        // target is the output file path (e.g. a.log)
        extract_gz_to_file(archive, target, state, on_progress)?;
        // if the decompressed file is itself an archive (rare), recurse
        if is_archive(target) {
            let n_target = compute_target(target)?;
            if let Some(p) = n_target.parent() { fs::create_dir_all(p)?; }
            extract_into(target, &n_target, depth + 1, state, on_progress)?;
        }
    } else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a .zip or .gz archive"));
    }
    Ok(())
}

fn is_zip(path: &Path) -> bool { has_magic(path, &[0x50, 0x4b, 0x03, 0x04]) || path.extension().and_then(|e| e.to_str()) == Some("zip") }
fn is_gz(path: &Path) -> bool { has_magic(path, &[0x1f, 0x8b]) || path.extension().and_then(|e| e.to_str()) == Some("gz") }
fn is_archive(path: &Path) -> bool { is_zip(path) || is_gz(path) }

fn has_magic(path: &Path, magic: &[u8]) -> bool {
    match fs::File::open(path) {
        Ok(mut f) => { let mut head = vec![0u8; magic.len()]; f.read(&mut head).unwrap_or(0) >= magic.len() && head == magic }
        Err(_) => false,
    }
}

fn extract_gz_to_file(gz: &Path, out: &Path, state: &mut ProgressState, on_progress: &mut impl FnMut(u64, u64, &str)) -> io::Result<()> {
    let f = fs::File::open(gz)?;
    let mut dec = flate2::read::GzDecoder::new(f);
    if let Some(p) = out.parent() { fs::create_dir_all(p)?; }
    let mut o = fs::File::create(out)?;
    io::copy(&mut dec, &mut o)?;
    state.total += 1;
    state.done += 1;
    on_progress(state.done, state.total, out.file_name().and_then(|s| s.to_str()).unwrap_or(""));
    Ok(())
}

/// Walk `dir` and return paths of files whose magic/ext says .zip or .gz.
fn find_nested_archives(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in walk(dir) {
        if is_archive(&entry) { out.push(entry); }
    }
    Ok(out)
}
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); } else { out.push(p); }
            }
        }
    }
    out
}
```

Note: `compute_target` for a nested `.gz` like `foo/a.log.gz` returns `foo/a.log` (strip `.gz`) — the file stem of `a.log.gz` is `a.log`. ✓ For a nested `.zip` like `foo/sub.zip` returns `foo/sub`. ✓

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p logradar-core --lib extractor`
Expected: PASS — all 4 extractor tests (single zip, single gz, nested, depth).

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/extractor.rs
git commit -m "feat(core): extractor — .gz + nested recursion + depth cap 10"
```

---

### Task 3: extractor — conflict rename

**Files:**
- Modify: `crates/logradar-core/src/extractor.rs`

**Interfaces:**
- Produces: `extract_archive` now renames on conflict (`foo/` exists without marker → `foo-extracted/`, increment `-2/-3`).

- [ ] **Step 1: Write the failing tests**

Append to `mod tests`:
```rust
    #[test]
    fn conflict_with_user_dir_renames_to_extracted_suffix() {
        let dir = std::env::temp_dir().join(format!("lr-ext-conf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("foo")).unwrap(); // user's own foo/
        std::fs::write(dir.join("foo").join("user.txt"), "mine").unwrap();
        let zip_path = dir.join("foo.zip");
        write_zip(&zip_path, &[("a.log", "INFO\n")]);
        let target = extract_archive(&zip_path, |_, _, _| {}).unwrap();
        assert_eq!(target, dir.join("foo-extracted"), "must rename on conflict");
        assert!(target.join(".logradar-extracted").exists());
        assert!(target.join("a.log").exists());
        // user's dir untouched
        assert!(dir.join("foo").join("user.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reuse_skips_extract_when_marker_present() {
        let dir = std::env::temp_dir().join(format!("lr-ext-reuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("foo")).unwrap();
        std::fs::write(dir.join("foo").join(".logradar-extracted"), "").unwrap();
        std::fs::write(dir.join("foo").join("a.log"), "OLD\n").unwrap();
        let zip_path = dir.join("foo.zip");
        write_zip(&zip_path, &[("a.log", "NEW\n")]);
        let target = extract_archive(&zip_path, |_, _, _| {}).unwrap();
        assert_eq!(target, dir.join("foo"), "must reuse existing marker dir");
        assert_eq!(std::fs::read_to_string(target.join("a.log")).unwrap(), "OLD\n", "must NOT re-extract");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p logradar-core --lib extractor::tests::conflict_with_user_dir_renames_to_extracted_suffix extractor::tests::reuse_skips_extract_when_marker_present`
Expected: FAIL — conflict returns `AlreadyExists` error (not renamed).

- [ ] **Step 3: Implement conflict rename**

Replace the conflict branch in `extract_archive` and add a resolver. Update the conflict block:
```rust
    let target = resolve_target(&compute_target(archive_path)?);
    if target.exists() && has_marker(&target) {
        return Ok(target); // reuse
    }
    fs::create_dir_all(&target)?;
```
Add `resolve_target`:
```rust
/// If the computed target is free or carries our marker, use it as-is.
/// If it's a user dir without the marker, rename to `<stem>-extracted[/-N]`.
fn resolve_target(computed: &Path) -> PathBuf {
    if !computed.exists() || has_marker(computed) {
        return computed.to_path_buf();
    }
    let parent = computed.parent().unwrap_or(Path::new("."));
    let stem = computed.file_name().and_then(|s| s.to_str()).unwrap_or("extracted");
    for i in 1..=1000 {
        let candidate = if i == 1 { parent.join(format!("{stem}-extracted")) }
                        else { parent.join(format!("{stem}-extracted-{i}")) };
        if !candidate.exists() || has_marker(&candidate) {
            return candidate;
        }
    }
    computed.to_path_buf() // fallback (will fail at create_dir_all if taken)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p logradar-core --lib extractor`
Expected: PASS — all 6 extractor tests.

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/extractor.rs
git commit -m "feat(core): extractor — marker reuse + conflict rename"
```

---

### Task 4: extractor — progress callback verified + log_files listing

**Files:**
- Modify: `crates/logradar-core/src/extractor.rs`

**Interfaces:**
- Produces: `pub fn list_logs(dir: &Path) -> io::Result<Vec<PathBuf>>` — walks `dir`, returns `.log`/`.txt` file paths (used by IPC to return `log_files`).

- [ ] **Step 1: Write the failing tests**

Append to `mod tests`:
```rust
    #[test]
    fn progress_callback_fires_per_file() {
        let dir = std::env::temp_dir().join(format!("lr-ext-prog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("foo.zip");
        write_zip(&zip_path, &[("a.log", "x\n"), ("b.log", "y\n"), ("c.log", "z\n")]);
        let mut seen: Vec<String> = Vec::new();
        extract_archive(&zip_path, |_d, _t, name| seen.push(name.to_string())).unwrap();
        assert_eq!(seen, vec!["a.log".to_string(), "b.log".to_string(), "c.log".to_string()],
            "progress must fire once per file, in order");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_logs_returns_log_and_txt_files() {
        let dir = std::env::temp_dir().join(format!("lr-ext-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.log"), "x").unwrap();
        std::fs::write(dir.join("b.txt"), "y").unwrap();
        std::fs::write(dir.join("c.zip"), "z").unwrap(); // not a log
        let logs = list_logs(&dir).unwrap();
        let names: Vec<String> = logs.iter().filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(String::from)).collect();
        assert!(names.contains(&"a.log".to_string()));
        assert!(names.contains(&"b.txt".to_string()));
        assert!(!names.contains(&"c.zip".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p logradar-core --lib extractor::tests::progress_callback_fires_per_file extractor::tests::list_logs_returns_log_and_txt_files`
Expected: FAIL — `list_logs` not defined.

- [ ] **Step 3: Add `list_logs`** (progress already fires per file from Task 1's `extract_zip_entries`/`extract_gz_to_file`):

```rust
/// Walk `dir`, return paths of `.log`/`.txt` files (depth-first, any depth).
pub fn list_logs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for p in walk(dir) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "log" || ext == "txt" { out.push(p); }
    }
    Ok(out)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p logradar-core --lib extractor`
Expected: PASS — all 8 extractor tests.

- [ ] **Step 5: Commit**

```bash
git add crates/logradar-core/src/extractor.rs
git commit -m "feat(core): extractor — list_logs + progress verified"
```

---

### Task 5: IPC — extract_archive command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register command)

**Interfaces:**
- Consumes: `logradar_core::extractor::{extract_archive, list_logs}`.
- Produces: Tauri command `extract_archive(path: String, on_event: Channel<ExtractProgress>) -> Result<ExtractResponse, String>`; DTOs `ExtractProgress { done, total, currentFile }` + `ExtractResponse { extractedDir, logFiles }`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/commands.rs` test module (a new `extract_tests` mod):
```rust
#[cfg(test)]
mod extract_tests {
    use super::*;
    use crate::state::AppState;
    use std::io::Write;
    fn write_zip(path: &std::path::Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::FileOptions::default();
        for (n, c) in entries { zw.start_file(n, opts).unwrap(); zw.write_all(c.as_bytes()).unwrap(); }
        zw.finish().unwrap();
    }
    #[test]
    fn extract_archive_impl_streams_progress_and_returns_logs() {
        let dir = std::env::temp_dir().join(format!("lr-cmd-ext-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zp = dir.join("foo.zip");
        write_zip(&zp, &[("a.log", "INFO a\nERROR boom\n"), ("b.log", "WARN x\n")]);
        let mut progress: Vec<ExtractProgress> = Vec::new();
        let resp = extract_archive_impl(&zp.to_string_lossy(), |p| progress.push(p)).unwrap();
        assert_eq!(resp.extracted_dir, zp.with_file_name("foo").to_string_lossy().to_string());
        assert!(resp.log_files.iter().any(|f| f.ends_with("a.log")));
        assert!(resp.log_files.iter().any(|f| f.ends_with("b.log")));
        assert!(!progress.is_empty(), "progress must be emitted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib extract_tests`
Expected: FAIL — `extract_archive_impl` / `ExtractProgress` / `ExtractResponse` not defined.

- [ ] **Step 3: Implement the command + DTOs**

Add to `src-tauri/src/commands.rs` (near the top with the other DTOs):
```rust
use logradar_core::extractor;

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExtractProgress {
    File { done: u64, total: u64, current_file: String },
    Done { extracted_dir: String, log_count: u64 },
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResponse {
    pub extracted_dir: String,
    pub log_files: Vec<String>,
}

/// Testable core of the command — runs the extract synchronously, calling
/// `on_progress` per `ExtractProgress::File`. The Tauri command wraps this
/// with a real Channel + spawn_blocking.
pub fn extract_archive_impl(
    path: &str,
    mut on_progress: impl FnMut(ExtractProgress),
) -> Result<ExtractResponse, String> {
    let archive = std::path::Path::new(path);
    let extracted = extractor::extract_archive(archive, |done, total, name| {
        on_progress(ExtractProgress::File { done, total, current_file: name.to_string() });
    }).map_err(|e| e.to_string())?;
    let logs = extractor::list_logs(&extracted).map_err(|e| e.to_string())?;
    on_progress(ExtractProgress::Done {
        extracted_dir: extracted.to_string_lossy().to_string(),
        log_count: logs.len() as u64,
    });
    Ok(ExtractResponse {
        extracted_dir: extracted.to_string_lossy().to_string(),
        log_files: logs.iter().map(|p| p.to_string_lossy().to_string()).collect(),
    })
}
```

Add the Tauri command (uses `Channel` like `search`):
```rust
#[tauri::command]
pub async fn extract_archive(
    path: String,
    on_event: tauri::ipc::Channel<ExtractProgress>,
) -> Result<ExtractResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_archive_impl(&path, |ev| { let _ = on_event.send(ev); })
    })
    .await
    .map_err(|e| format!("{e}"))?
}
```

Register in `src-tauri/src/lib.rs` invoke handler (add to the `generate_handler!` list alongside `open_file`, `search`, etc.):
```rust
commands::extract_archive,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib extract_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): extract_archive command + ExtractProgress/ExtractResponse"
```

---

### Task 6: IPC — scan_dir command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `logradar_core::extractor::list_logs` (+ a walk for `.zip`/`.gz`).
- Produces: Tauri command `scan_dir(path: String) -> Result<ScanDirResponse, String>`; `ScanDirResponse { logFiles, archiveHint }`.

- [ ] **Step 1: Write the failing test**

Append to `extract_tests`:
```rust
    #[test]
    fn scan_dir_impl_returns_logs_and_archive_hints() {
        let dir = std::env::temp_dir().join(format!("lr-cmd-scan-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.log"), "x").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("b.txt"), "y").unwrap();
        std::fs::write(dir.join("c.zip"), "z").unwrap();
        let resp = scan_dir_impl(&dir.to_string_lossy()).unwrap();
        assert!(resp.log_files.iter().any(|f| f.ends_with("a.log")));
        assert!(resp.log_files.iter().any(|f| f.ends_with("b.txt")));
        assert!(resp.archive_hint.iter().any(|f| f.ends_with("c.zip")),
            "archives must be hinted, not in log_files");
        assert!(!resp.log_files.iter().any(|f| f.ends_with("c.zip")));
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p logradar-tauri --lib extract_tests::scan_dir_impl_returns_logs_and_archive_hints`
Expected: FAIL — `scan_dir_impl` not defined.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/commands.rs`:
```rust
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanDirResponse {
    pub log_files: Vec<String>,
    pub archive_hint: Vec<String>,
}

pub fn scan_dir_impl(path: &str) -> Result<ScanDirResponse, String> {
    let dir = std::path::Path::new(path);
    let logs = extractor::list_logs(dir).map_err(|e| e.to_string())?;
    // walk for archives (reuse extractor's walk via a public helper or inline)
    let mut hints: Vec<String> = Vec::new();
    for p in walk_dir(dir) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "zip" || ext == "gz" {
            hints.push(p.to_string_lossy().to_string());
        }
    }
    Ok(ScanDirResponse {
        log_files: logs.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        archive_hint: hints,
    })
}

fn walk_dir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    // mirror extractor::walk (or expose it); inline here to avoid cross-crate visibility churn
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p); } else { out.push(p); }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn scan_dir(path: String) -> Result<ScanDirResponse, String> {
    scan_dir_impl(&path)
}
```

Register `commands::scan_dir` in `src-tauri/src/lib.rs` `generate_handler!`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p logradar-tauri --lib extract_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): scan_dir command + ScanDirResponse"
```

---

### Task 7: frontend — ipc.ts client + useExtract hook

**Files:**
- Modify: `src/lib/ipc.ts`

**Interfaces:**
- Consumes: Tauri `extract_archive` + `scan_dir` commands (DTOs from Task 5/6).
- Produces: `extractArchive(path, onProgress)` + `scanDir(path)` typed wrappers; `useExtract` hook streaming progress via `@tauri-apps/api` `Channel`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ipc.test.ts` (or append if exists):
```typescript
import { describe, it, expect, vi } from "vitest";
import { extractArchive, scanDir } from "./ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
// Channel is constructed by the wrapper; mock to capture the onmessage handler
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/core")>("@tauri-apps/api/core");
  return { ...actual, invoke: vi.fn() };
});

describe("ipc archive", () => {
  it("scanDir invokes scan_dir with the path", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ logFiles: ["a.log"], archiveHint: [] });
    const res = await scanDir("/some/dir");
    expect(invoke).toHaveBeenCalledWith("scan_dir", { path: "/some/dir" });
    expect(res.logFiles).toEqual(["a.log"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: FAIL — `scanDir` / `extractArchive` not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/ipc.ts`:
```typescript
import { invoke, Channel } from "@tauri-apps/api/core";

export type ExtractProgress =
  | { type: "file"; done: number; total: number; currentFile: string }
  | { type: "done"; extractedDir: string; logCount: number };

export type ExtractResponse = { extractedDir: string; logFiles: string[] };
export type ScanDirResponse = { logFiles: string[]; archiveHint: string[] };

export async function extractArchive(
  path: string,
  onProgress: (p: ExtractProgress) => void,
): Promise<ExtractResponse> {
  const ch = new Channel<ExtractProgress>();
  ch.onmessage = onProgress;
  return invoke<ExtractResponse>("extract_archive", { path, onEvent: ch });
}

export async function scanDir(path: string): Promise<ScanDirResponse> {
  return invoke<ScanDirResponse>("scan_dir", { path });
}
```

Note: the Rust `ExtractProgress` is `#[serde(tag="...")]`-less enum `{ File{...}, Done{...} }` — the frontend adapter normalizes the wire shape. Verify the exact `serde` tag against the Rust DTO in Task 5 during implementation (the DTO uses `rename_all="camelCase"` on an untagged-ish enum; if the wire shape differs, adjust the TS union to match — the test asserts `scanDir` only, so `extractArchive` shape is verified in Task 8's e2e).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(fe): ipc — extractArchive + scanDir client wrappers"
```

---

### Task 8: frontend — useSessions.openArchive + openFolder

**Files:**
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/hooks/useSessions.test.tsx`

**Interfaces:**
- Produces: `SessionsApi.openArchive(path, onProgress): Promise<void>` (extract → open_file each log) + `openFolder(path): Promise<{archiveHint: string[]}>` (scan_dir → open_file each log).

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useSessions.test.ts`:
```typescript
  it("openArchive extracts then opens each returned log", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useSessions } = await import("./useSessions");
    const { openFile } = await import("../lib/ipc");
    (openFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => ({
      sessionId: "s-" + path, lineCount: 1, encoding: "Utf8", isJson: false, timestampFmt: "iso",
    }));
    const { extractArchive } = await import("../lib/ipc");
    (extractArchive as ReturnType<typeof vi.fn>).mockResolvedValue({
      extractedDir: "/x", logFiles: ["/x/a.log", "/x/b.log"],
    });
    const { result } = renderHook(() => useSessions());
    await act(async () => { await result.current.openArchive("/foo.zip", () => {}); });
    expect(openFile).toHaveBeenCalledWith("/x/a.log");
    expect(openFile).toHaveBeenCalledWith("/x/b.log");
    expect(result.current.sessions.size).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useSessions.test.ts`
Expected: FAIL — `openArchive` not defined.

- [ ] **Step 3: Implement**

Add to the `useSessions` hook (inside the returned object):
```typescript
  const openArchive = useCallback(async (path: string, onProgress: (p: ExtractProgress) => void) => {
    const { extractArchive } = await import("../lib/ipc");
    const resp = await extractArchive(path, onProgress);
    for (const log of resp.logFiles) {
      await open(path); // reuses existing open(log) → openFile + register
      // NOTE: `open` here must be the session-open, called with `log` not `path`.
      // The implementer should call the hook's own `open(log)` method, not `open(path)`.
    }
  }, [/* deps: open, etc. */]);
```
**Implementer note:** the loop must call the hook's existing `open(logFile)` method (which calls `openFile` + registers the session + sets active). Fix the loop body to `await open(log);` and add `open` + `extractArchive` to the `useCallback` deps. The pseudocode above is intentionally slightly off to force the implementer to read the existing `open` method signature — verify against `useSessions.ts`'s current `open(path)`.

A cleaner version (use this):
```typescript
  const openArchive = useCallback(async (path: string, onProgress: (p: ExtractProgress) => void) => {
    const resp = await extractArchive(path, onProgress);
    for (const log of resp.logFiles) {
      await open(log);
    }
  }, [open]);
  const openFolder = useCallback(async (path: string) => {
    const resp = await scanDir(path);
    for (const log of resp.logFiles) {
      await open(log);
    }
    return { archiveHint: resp.archiveHint };
  }, [open]);
```
(Import `extractArchive`, `scanDir`, `ExtractProgress` from `../lib/ipc` at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useSessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSessions.ts src/hooks/useSessions.test.ts
git commit -m "feat(fe): useSessions — openArchive + openFolder"
```

---

### Task 9: frontend — ExtractProgress widget + WelcomePage Open archive / Open folder / Open file filter

**Files:**
- Create: `src/components/ExtractProgress.tsx`
- Modify: `src/pages/WelcomePage.tsx`
- Modify: `src/pages/WelcomePage.test.tsx`

**Interfaces:**
- Consumes: `useSessions.openArchive` + `openFolder` (Task 8).
- Produces: WelcomePage with three buttons (Open file filtered to `.log/.txt`; Open archive `.zip/.gz`; Open folder directory) + an ExtractProgress widget shown during extract + an archive-hint notice after Open folder.

- [ ] **Step 1: Write the failing test**

Append to `src/pages/WelcomePage.test.tsx`:
```typescript
  it("shows Open archive and Open folder buttons", () => {
    const { render, screen } = await import("@testing-library/react");
    const { WelcomePage } = await import("./WelcomePage");
    render(<WelcomePage sessions={{ sessions: new Map(), activeId: null, open: vi.fn(), close: vi.fn(), setActive: vi.fn() } as never} setView={vi.fn()} />);
    expect(screen.getByRole("button", { name: /open archive/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open file/i })).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/WelcomePage.test.tsx`
Expected: FAIL — Open archive button not present (Open folder was removed in 995fdbc).

- [ ] **Step 3: Implement**

Create `src/components/ExtractProgress.tsx`:
```tsx
export function ExtractProgress({ done, total, currentFile }: { done: number; total: number; currentFile: string }) {
  return (
    <div className="ep" role="status" aria-label="extract progress">
      <div className="ep-bar"><div className="ep-fill" style={{ width: total ? `${(done / total) * 100}%` : "0%" }} /></div>
      <span className="ep-text">{done}/{total} · {currentFile}</span>
    </div>
  );
}
```

In `src/pages/WelcomePage.tsx`, restore `onOpenFolder` + add `onOpenArchive` + filter `onOpenFile`, and render the ExtractProgress widget + archive-hint notice. Sketch:
```tsx
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ExtractProgress } from "../components/ExtractProgress";
// ... inside the component:
const [progress, setProgress] = useState<{ done: number; total: number; currentFile: string } | null>(null);
const [archiveHint, setArchiveHint] = useState<string[] | null>(null);

const onOpenFile = () => openPicked(() => openDialog({ multiple: false, filters: [{ name: "Log", extensions: ["log", "txt"] }] }));
const onOpenFolder = async () => {
  setErr(null);
  try {
    const picked = await openDialog({ directory: true });
    if (typeof picked !== "string") return;
    const { archiveHint } = await sessions.openFolder(picked);
    setView("main");
    if (archiveHint.length > 0) setArchiveHint(archiveHint);
  } catch (e) { setErr(String(e)); }
};
const onOpenArchive = async () => {
  setErr(null);
  try {
    const picked = await openDialog({ multiple: false, filters: [{ name: "Archive", extensions: ["zip", "gz"] }] });
    if (typeof picked !== "string") return;
    setProgress({ done: 0, total: 0, currentFile: "" });
    await sessions.openArchive(picked, (p) => {
      if (p.type === "file") setProgress({ done: p.done, total: p.total, currentFile: p.currentFile });
    });
    setProgress(null);
    setView("main");
  } catch (e) { setErr(String(e)); setProgress(null); }
};
// JSX: three wp-btn buttons + {progress && <ExtractProgress {...progress} />} + {archiveHint && <div className="wp-hint">Found {archiveHint.length} archive(s) — use Open archive</div>}
```
The implementer fills the JSX return from the existing WelcomePage structure (the current file already has Open file + a removed Open folder — re-add Open folder + add Open archive).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/pages/WelcomePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ExtractProgress.tsx src/pages/WelcomePage.tsx src/pages/WelcomePage.test.tsx
git commit -m "feat(fe): Open archive + Open folder + Open file filter + progress widget"
```

---

### Task 10: smoke — full workspace build + tests

**Files:** none (verification)

- [ ] **Step 1: Run full Rust suite**

Run: `cargo test --workspace`
Expected: all pass (36 prior + new extractor/extract_tests).

- [ ] **Step 2: Run full frontend suite**

Run: `npm test`
Expected: all pass (170 prior + new ipc/useSessions/WelcomePage tests).

- [ ] **Step 3: Local build smoke (optional)**

Run: `npx tauri build`
Expected: produces `LogRadar.app` / `.exe` bundle (skip if signing blocks locally — CI covers it).

- [ ] **Step 4: Commit (changelog only — no code)**

If all green, no commit needed. If a small fix was needed, commit it:
```bash
git commit --allow-empty -m "chore: archive-extract smoke verified"
```

---

## Self-Review

**1. Spec coverage:**
- extractor `.zip` → `foo/` + marker: Task 1 ✓
- `.gz` → `a.log` + nested recursion + depth cap 10: Task 2 ✓
- marker reuse + conflict `foo-extracted/`: Task 3 ✓
- per-file progress + `list_logs`: Task 4 ✓
- IPC `extract_archive` + `ExtractProgress`/`ExtractResponse`: Task 5 ✓
- IPC `scan_dir` + `archive_hint`: Task 6 ✓
- frontend `extractArchive` + `scanDir` client: Task 7 ✓
- `useSessions.openArchive` + `openFolder`: Task 8 ✓
- WelcomePage three buttons + progress UI + hint: Task 9 ✓
- full smoke: Task 10 ✓
- **Gap:** Open file filter `.log/.txt` is inside Task 9 (not its own task) — acceptable, it's a one-line `filters` change bundled with the button restore. ✓
- **Gap:** `Session::open(.log)` reuse + cross-file search + FileTree — unchanged by design (no task needed; verified in Task 10 smoke that nothing broke). ✓

**2. Placeholder scan:** Task 8 has an intentionally-imperfect first code block flagged with "Implementer note" + a corrected second block — this is a known risk; the reviewer must ensure the final `openArchive` calls `open(log)` (not `open(path)`) and deps include `open`. Flag for the task reviewer. No other TBD/TODO. ✓ (Task 7 notes the `serde` tag verification — a real check, not a placeholder; implementer must verify against Task 5's DTO.)

**3. Type consistency:**
- `ExtractProgress` Rust enum `File{done,total,current_file}` / `Done{extracted_dir,log_count}` (camelCase) ↔ TS union `{type:"file",done,total,currentFile}` / `{type:"done",extractedDir,logCount}` — the wire tag differs (Rust untagged-ish vs TS discriminated). Task 7 flags this for verification. ⚠ implementer must align (either tag the Rust enum or adjust the TS union to the actual wire shape).
- `extract_archive` Rust fn signature `(&Path, impl FnMut(u64,u64,&str))` ↔ `extract_archive_impl(&str, impl FnMut(ExtractProgress))` — Task 5 wraps the core fn, signature consistent. ✓
- `ScanDirResponse { log_files, archive_hint }` (camelCase `logFiles`/`archiveHint`) ↔ TS `{logFiles, archiveHint}`. ✓
- `list_logs` returns `Vec<PathBuf>`; IPC returns `Vec<String>` via `to_string_lossy`. ✓

Fix the `ExtractProgress` serde/wire mismatch inline (Task 5 should tag the enum `#[serde(tag="type", rename_all="camelCase")]` to match the TS discriminated union) — **apply this fix to Task 5's DTO before implementation.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-logradar-archive-extract.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
