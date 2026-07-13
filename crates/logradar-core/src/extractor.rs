use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const MARKER: &str = ".logradar-extracted";
const MAX_DEPTH: usize = 10;

/// Extract a (possibly nested) archive to a sibling directory (for `.zip`) or
/// sibling file (for `.gz` — the `.gz` suffix is stripped). Returns the
/// extracted path. `on_progress(done, total, current_file)` is called per
/// extracted file. Reuses a prior extract if the target carries the marker;
/// rejects a conflict with a pre-existing user dir/file without a marker.
pub fn extract_archive(
    archive_path: &Path,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> io::Result<PathBuf> {
    let target = resolve_target(&compute_target(archive_path)?);
    if target.exists() && has_marker(&target) {
        return Ok(target); // reuse
    }
    // Pre-create the target dir for `.zip` (a directory target). A `.gz` target
    // is a file path — creating it as a dir would corrupt the extraction, so
    // only directory targets are pre-created here.
    if is_zip(archive_path) {
        fs::create_dir_all(&target)?;
    }
    let mut state = ProgressState { done: 0, total: 0 };
    let res = extract_into(archive_path, &target, 0, &mut state, &mut on_progress);
    if let Err(e) = res {
        let _ = fs::remove_dir_all(&target); // cleanup partial on any error
        return Err(e);
    }
    // Marker only on directory targets (i.e. `.zip`); a `.gz` produces a
    // single output file, which is itself the signal of completion.
    if is_zip(archive_path) {
        fs::write(target.join(MARKER), "")?;
    }
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

fn has_marker(dir: &Path) -> bool {
    dir.join(MARKER).exists()
}

struct ProgressState { done: u64, total: u64 }

/// Extract `archive`'s contents into `target` (a dir for `.zip`; a file path
/// for `.gz`), then recurse into any nested archive found among the extracted
/// files. Depth-capped at `MAX_DEPTH` to bound recursive archives.
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

fn is_zip(path: &Path) -> bool {
    has_magic(path, &[0x50, 0x4b, 0x03, 0x04])
        || path.extension().and_then(|e| e.to_str()) == Some("zip")
}
fn is_gz(path: &Path) -> bool {
    has_magic(path, &[0x1f, 0x8b])
        || path.extension().and_then(|e| e.to_str()) == Some("gz")
}
fn is_archive(path: &Path) -> bool { is_zip(path) || is_gz(path) }

fn has_magic(path: &Path, magic: &[u8]) -> bool {
    match fs::File::open(path) {
        Ok(mut f) => {
            let mut head = vec![0u8; magic.len()];
            f.read(&mut head).unwrap_or(0) >= magic.len() && head == magic
        }
        Err(_) => false,
    }
}

fn extract_zip_entries(
    archive: &Path,
    target: &Path,
    state: &mut ProgressState,
    on_progress: &mut impl FnMut(u64, u64, &str),
) -> io::Result<()> {
    fs::create_dir_all(target)?; // ensure target exists (also for canonicalize in safe_join)
    let f = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(f)?;
    state.total += zip.len() as u64;
    for i in 0..zip.len() {
        let mut z = zip.by_index(i)?;
        if z.is_dir() { continue; }
        let name = z.name().to_string();
        let out_path = safe_join(target, &name)?; // zip-slip hardened
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut z, &mut out)?;
        state.done += 1;
        on_progress(state.done, state.total, &name);
    }
    Ok(())
}

/// Join `name` onto `target` with zip-slip hardening: strip a leading `/`,
/// reject any `..` component, and (belt-and-suspenders) verify via
/// canonicalize that the resolved path stays within `target`.
fn safe_join(target: &Path, name: &str) -> io::Result<PathBuf> {
    let rel = Path::new(name);
    let rel = rel.strip_prefix("/").unwrap_or(rel); // strip a leading '/'
    if rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "zip entry path contains `..` (zip-slip)",
        ));
    }
    let out_path = target.join(rel);
    // belt-and-suspenders: canonicalize target and the entry's parent dir and
    // assert containment (catches symlink-based escapes). Degrades gracefully
    // if canonicalize fails — the `..` / leading-`/` checks above are primary.
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
        if let (Ok(canon_target), Ok(canon_parent)) =
            (target.canonicalize(), parent.canonicalize())
        {
            if !canon_parent.starts_with(&canon_target) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "zip entry path escapes target (zip-slip)",
                ));
            }
        }
    }
    Ok(out_path)
}

fn extract_gz_to_file(
    gz: &Path,
    out: &Path,
    state: &mut ProgressState,
    on_progress: &mut impl FnMut(u64, u64, &str),
) -> io::Result<()> {
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

/// Walk `dir` and return paths of files whose magic/ext says `.zip` or `.gz`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::FileOptions::default();
        for (name, content) in entries {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(content.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    fn write_gz(path: &Path, content: &str) {
        let f = std::fs::File::create(path).unwrap();
        let mut enc = GzEncoder::new(f, Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        enc.finish().unwrap();
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

    #[test]
    fn zip_slip_entry_is_rejected() {
        // A crafted zip entry with a `..` component must be rejected, and the
        // file must NOT be written outside the target dir (zip-slip defense).
        let dir = std::env::temp_dir().join(format!("lr-ext-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("evil.zip");
        write_zip(&zip_path, &[("../escape.log", "pwned\n")]);
        let res = extract_archive(&zip_path, |_, _, _| {});
        assert!(res.is_err(), "zip-slip entry must be rejected");
        assert!(!dir.join("escape.log").exists(),
            "escape.log must NOT be created outside target");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
}
