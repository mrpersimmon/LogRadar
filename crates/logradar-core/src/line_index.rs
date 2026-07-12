/// Sampled line-offset index over a byte slice. Stores an anchor every
/// `sample_every` newlines; random access scans forward from the nearest
/// anchor. Memory ≈ 8 bytes × (line_count / sample_every).
pub struct LineIndexer {
    /// (line_number, byte_offset) anchors, line_number 0 = start-of-file.
    anchors: Vec<(u64, u64)>,
    /// Sampling rate used at build time; retained as index metadata (not yet
    /// read by any accessor — expected to be consumed by `Session` in Task 5).
    #[allow(dead_code)]
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
        // total lines = 0 for empty; `line` if the file ends with a newline
        // (no trailing partial line); `line + 1` otherwise (last partial line
        // still counts).
        let total_lines = if bytes.is_empty() {
            0
        } else if *bytes.last().unwrap() == b'\n' {
            line
        } else {
            line + 1
        };
        LineIndexer { anchors, sample_every, total_lines }
    }

    pub fn line_count(&self) -> u64 { self.total_lines }

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
