# LogRadar Archive Extract Design

> **For agentic workers:** This is a design spec (brainstorming output). The implementation plan follows via the writing-plans skill.

## Overview

LogRadar v1 treats `.zip`/`.gz` as single-file sessions: `Session::open(.zip)` takes only the first file entry, and a nested `.gz` entry is read as raw gzip bytes — so keyword search finds nothing, and the archive can't be expanded in the sidebar tree. Users with multi-entry zips containing nested `.gz` archives (a common incident-handling bundle) can neither browse entries nor search.

This design replaces "archive as single session" with **extract-then-open**: a nested archive is fully extracted to a sibling directory on disk, then each extracted `.log` becomes a normal session, reusing v1's mmap + line index + cross-file search. There is no `.gz-in-zip` random-access complexity — after extraction everything is a plain file on disk.

## v1 现状 + 问题

- `Session::open(.zip)` (`crates/logradar-core/src/session.rs:47-56`) takes `entries.first()` (first file entry, directory-filtered by `zip_entries`) → `Source::Zip { path, entry }`.
- `scan_lines` Zip branch (`session.rs:133-149`) reads only that one entry's raw bytes via `read_until`. If the entry is a `.gz`, the bytes are gzip-compressed → keyword predicates match nothing.
- `FileTree.buildTree` (`src/components/FileTree.tsx:46-74`) groups sessions by their `path`; a `.zip` is one session rendered as a non-expandable `FileNode` (no caret/children).
- Result: multi-entry zip can't expand; nested `.gz` can't be searched.

## 核心思路：extract-then-open

An archive (`.zip`/`.gz`, possibly nested) is **fully extracted to a sibling directory** before any session is created. Each extracted `.log` becomes a normal session via the existing `Session::open(.log)` (mmap + `LineIndexer`). Search uses the existing cross-file search (already aggregates across sessions). `FileTree` is unchanged — extracted `foo/*.log` paths auto-group under a `foo/` dir node.

No changes to `Session`/`scan_lines`/`get_lines` for archive sources — archives become plain files post-extract, so random access stays on the proven mmap/`zip_line_at` paths.

## 组件

### Extractor (core `extractor` module — new file `crates/logradar-core/src/extractor.rs`)

Public API:

```rust
/// Extract a (possibly nested) archive to a sibling directory. Returns the
/// extracted directory path. `on_progress(done, total, current_file)` is
/// called per extracted file. Reuses a prior extract if the target carries
/// the `.logradar-extracted` marker; renames on conflict with a user dir.
pub fn extract_archive(
    archive_path: &Path,
    on_progress: impl FnMut(u64, u64, &str),
) -> io::Result<PathBuf>
```

Behavior:

- **Target**: `foo.zip` → `foo/` (strip `.zip`); `a.log.gz` → `a.log` (strip `.gz`). Sibling to the archive.
- **Reuse**: if target dir exists AND contains a `.logradar-extracted` marker file → skip extraction, return target (previous extract reused — "保留" per user decision).
- **Conflict**: if target exists WITHOUT the marker (user's own dir) → rename to `foo-extracted/`; if that's taken, increment `foo-extracted-2/`, `-3/`, …; create marker in the chosen target. Exhausted → `Err("could not find a free extract directory for <archive>")`.
- **Marker**: create `.logradar-extracted` (empty file) in target after a successful extract.
- **Nested recursion**: after extracting a `.zip`'s entries, scan the target for any `.zip`/`.gz` among them and recurse into each (a `.gz` decompresses to its stripped name; if that stripped file is itself a `.zip`, recurse again). All nested archives are extracted — "把里面所有压缩文件都解压了" per user decision.
- **Depth cap = 10**: recursion depth limit. Exceeding → `Err("archive nesting too deep (max 10)")` + cleanup the partially-extracted target + remove marker. **No file-count or byte-size limit** (per user decision — only depth is capped).
- **Progress**: `on_progress(done, total, current_file)` called per file extracted, where `total` is the running count of discovered files (may grow as nesting unfolds) and `done` is files extracted so far.
- **I/O error** (corrupt zip/gz, disk full mid-extract) → `Err` + cleanup partial target + remove marker.

Helpers: `is_archive(path)` (`.zip`/`.gz` by extension), `strip_archive_ext(name)`.

### IPC (src-tauri/src/commands.rs)

New command:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress { pub done: u64, pub total: u64, pub current_file: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResponse { pub extracted_dir: String, pub log_files: Vec<String> }

#[tauri::command]
pub async fn extract_archive(
    path: String,
    on_event: Channel<ExtractProgress>,
) -> Result<ExtractResponse, String>
```

- Calls core `extract_archive` with `on_progress` → emits `ExtractProgress` events via the Channel (mirrors `search`'s `Batch`/`Done` pattern).
- After extract, scans the extracted dir for `.log` files → returns `log_files`.
- Runs on `spawn_blocking` (extract is blocking I/O).

New command for Open folder scan:

```rust
#[tauri::command]
pub async fn scan_dir(path: String) -> Result<ScanDirResponse, String>
// ScanDirResponse { log_files: Vec<String>, archive_hint: Vec<String> }
```

- Recursively scans the picked dir for `.log`/`.txt` → `log_files`.
- Also lists `.zip`/`.gz` found → `archive_hint` (frontend shows "these look like archives — use Open archive").

### Frontend

**WelcomePage** (`src/pages/WelcomePage.tsx`): three buttons (restore Open folder + add Open archive):
- **Open file**: `openDialog({ multiple: false })`, filter `.log/.txt` → `open_file` (unchanged).
- **Open archive** (new): `openDialog`, filter `.zip/.gz` → `extract_archive` → progress UI → `open_file` each returned `log_file` → `setView("main")`.
- **Open folder** (restored): `openDialog({ directory: true })` → `scan_dir` → `open_file` each `log_file`. If `archive_hint` non-empty, show a hint: "Found N archive(s) in this folder — use Open archive to extract them."

**Progress UI**: a small component (extracting: `done/total` files, current filename) shown during `extract_archive`. Disables the welcome actions while extracting.

**FileTree**: unchanged (`buildTree` by path; `foo/*.log` auto-groups under `foo/`).

**cross-file search**: unchanged (already aggregates across sessions).

## 数据流

1. User clicks **Open archive** → picks `foo.zip`.
2. Frontend `extract_archive(foo.zip)` → IPC → core `extract_archive` extracts to `foo/` (nested recursion, depth ≤ 10) → streams `ExtractProgress` events.
3. Core returns `{ extractedDir: "foo/", logFiles: ["foo/a.log", "foo/b.log", ...] }`.
4. Frontend `open_file` each `.log` → sessions registered → FileTree shows `foo/` + files.
5. User searches → cross-file search across the `foo/*.log` sessions.

Open folder is the same minus the extract step: `scan_dir` → `open_file` each `.log` (+ archive hint).

## 错误处理

- Depth > 10 → `Err("archive nesting too deep (max 10)")` + cleanup partial target + remove marker.
- Corrupt archive / I/O error mid-extract → `Err(<io error>)` + cleanup + remove marker.
- Target conflict exhausted → `Err("could not find a free extract directory")`.
- Open folder `archive_hint` → not an error, a suggestion to use Open archive.

## 测试

**extractor unit tests** (`extractor.rs` `#[cfg(test)]`):
- Single `.zip` → extracts to `foo/`, marker present.
- Single `.gz` → extracts to `a.log`, marker present.
- Nested `.zip` containing `.gz` → both extracted; `.log` present.
- Nested depth 10 → ok; depth 11 → `Err` + target cleaned up + no marker.
- Reuse: target with marker → skip extract, return existing dir.
- Conflict: target without marker → renamed to `foo-extracted/`; second conflict → `foo-extracted-2/`.

**IPC contract tests** (`tests/ipc_contract.rs` or unit):
- `extract_archive` streams `ExtractProgress` events + returns `ExtractResponse` with `log_files`.
- `scan_dir` returns `log_files` + `archive_hint`.

**e2e (frontend)**:
- Open archive → progress shown → sessions created → search finds keyword in extracted `.log`.

## 范围 + deferrals

**In scope**: extract-then-open for `.zip`/`.gz` (nested, depth ≤ 10); Open archive button; Open folder restore (scan `.log` + archive hint); progress UI; reuse via marker; conflict rename.

**Deferred (post-v1.1)**: variable extract target (user-chosen dir); per-byte progress; `.tar`/`.7z`/`.rar` formats; cancel mid-extract; extract cleanup on session close (current: keep on disk, reuse next open); depth cap configurability.

## Open questions

None — all design points clarified with the user:
- entry model: extract-then-open (extract to disk, plain-file sessions).
- extract target: sibling to archive, keep (reuse).
- nesting: all nested archives extracted, depth cap 10, no file/size limit.
- Open folder: scans `.log` only, archive hint to use Open archive.
- conflict: rename to `foo-extracted/`.
- progress: per-file.
