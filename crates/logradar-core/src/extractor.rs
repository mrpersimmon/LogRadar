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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
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
