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
        let n = file.take(4).read(&mut head)?; // head is up to 4 bytes
        let head = &head[..n];
        if is_gz(head) {
            let mut view = GzView::build(path)?;
            let total = view.line_count();
            let sample: Vec<Vec<u8>> = (0..5).filter_map(|i| view.line_at(i)).collect();
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
            let sample: Vec<Vec<u8>> = (0..5).filter_map(|i| zip_line_at(path, &entry, i)).collect();
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
        // Hoist the Copy encoding into a local so the `line_at` closure can hold
        // `&mut self` without conflicting on the `self.encoding` field read.
        let enc = self.encoding;
        (start..start + count as u64)
            .filter_map(|n| self.line_at(n))
            .map(|b| {
                let mut s = encoding::decode(enc, &b);
                // CRLF handling: LineIndexer/GzView/Zip all split on `\n` only,
                // so a CRLF line comes back with a trailing `\r`. Strip exactly
                // one. LF-only lines are unaffected (`ends_with('\r')` is false).
                // This is the single chokepoint for all sources.
                if s.ends_with('\r') { s.pop(); }
                s
            })
            .collect()
    }
    fn line_at(&mut self, n: u64) -> Option<Vec<u8>> {
        match &mut self.src {
            Source::Mmap(m) => self.index.as_ref()
                .and_then(|idx| idx.line_at(&m[..], n).map(|s| s.to_vec())),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn write_tmp(content: &str) -> std::path::PathBuf {
        let p = tempfile();
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }
    fn tempfile() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Unique per call: tests run in parallel and would otherwise clobber a
        // path keyed only on PID (a real bug surfaced once a 2nd plain-file test
        // was added). Counter + PID guarantees uniqueness across threads.
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("lr-test-{}-{}.log", std::process::id(), n));
        let _ = std::fs::remove_file(&p);
        p
    }
    #[test]
    fn opens_plain_and_serves_windows() {
        let p = write_tmp("2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n2026-07-12 14:22:03 WARN c\n");
        let mut s = Session::open(&p).unwrap();
        assert_eq!(s.line_count(), 3);
        let win = s.get_lines(1, 2);
        assert_eq!(win.len(), 2);
        assert!(win[0].contains("ERROR b"));
    }
    #[test]
    fn strips_crlf_trailing_cr_in_plain_file() {
        // CRLF line endings: LineIndexer splits on \n only, so a decoded line
        // would carry a trailing \r unless get_lines strips it.
        let p = write_tmp("2026-07-12 14:22:01 INFO a\r\n2026-07-12 14:22:02 ERROR b\r\n");
        let mut s = Session::open(&p).unwrap();
        assert_eq!(s.line_count(), 2);
        let lines = s.get_lines(0, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("INFO a"));
        assert!(!lines[0].ends_with('\r'), "line 0 should not end with \\r, got: {:?}", lines[0]);
    }
}

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
        let mut s = Session::open(&p).unwrap();
        assert_eq!(s.line_count(), 2);
        assert!(s.get_lines(1, 1)[0].contains("ERROR b"));
    }
}
