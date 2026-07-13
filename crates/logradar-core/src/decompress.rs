use std::io::{self, Read, Seek, BufRead, BufReader};
use std::path::Path;
use flate2::read::GzDecoder;

/// Stream-decompress a gz stream and call `on_line(line_number, line_bytes)`
/// for each line. line_number is 0-indexed. Does NOT build an index. The
/// callback returns `bool`: `true` = continue scanning, `false` = stop early
/// (returning early lets the caller halt decompression on cancel/cap instead
/// of walking the rest of the stream).
pub fn gz_search<R: Read>(
    decoder: &mut GzDecoder<R>,
    mut on_line: impl FnMut(u64, &[u8]) -> bool,
) -> io::Result<()> {
    let mut reader = BufReader::new(decoder);
    let mut buf = Vec::with_capacity(8192);
    let mut line_no = 0u64;
    loop {
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 { break; }
        // strip trailing newline for the callback
        let end = buf.len().saturating_sub(if buf.last() == Some(&b'\n') { 1 } else { 0 });
        if !on_line(line_no, &buf[..end]) { break; }
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
        let file = std::fs::File::open(path)?;
        // Separate fd sharing the same OS file offset so we can probe the
        // compressed position while `decoder`/`reader` borrow `file`. The probed
        // value is the BufReader-read-ahead position (the documented drift).
        let mut probe = file.try_clone()?;
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
                let comp_off = probe.stream_position()?;
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
    // Skip directory entries (name ends with '/', 0 bytes) — they're not
    // indexable log files. Pre-fix, a zip whose first entry was a directory
    // (`logs/`) had `Session::open` pick it via `entries.first()`, yielding
    // line_count=0 and an empty search ("无法检索").
    let mut names = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        if let Ok(z) = zip.by_index(i) {
            if !z.is_dir() {
                names.push(z.name().to_string());
            }
        }
    }
    Ok(names)
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
        let opts = zip::write::FileOptions::default();
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
        gz_search(&mut dec, |_, b| { got.push(String::from_utf8_lossy(b).to_string()); true }).unwrap();
        assert_eq!(got, vec!["alpha","beta","gamma"]);
    }
    #[test]
    fn gz_search_stops_when_callback_returns_false() {
        // Early-stop: the callback returning `false` must halt decompression
        // after the first line (proves gz_search honors the early-stop signal
        // rather than walking the whole stream).
        let p = std::env::temp_dir().join("lr-gz-search-stop.gz");
        write_gz(&p, &["alpha","beta","gamma","delta","epsilon"]);
        let file = std::fs::File::open(&p).unwrap();
        let mut dec = GzDecoder::new(file);
        let mut calls = 0u64;
        gz_search(&mut dec, |_, _| { calls += 1; false }).unwrap();
        assert_eq!(calls, 1, "gz_search must stop after the callback returns false");
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
