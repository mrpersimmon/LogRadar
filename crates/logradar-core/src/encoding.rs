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
