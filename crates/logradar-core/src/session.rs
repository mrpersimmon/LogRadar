use std::fs::File;
use std::io;
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
            .map(|b| {
                let mut s = encoding::decode(self.encoding, b);
                // Strip a single trailing '\r' left by line_at on CRLF lines.
                if s.ends_with('\r') { s.pop(); }
                s
            })
            .collect()
    }
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
