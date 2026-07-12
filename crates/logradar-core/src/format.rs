use crate::query::Level;
use chrono::{NaiveDateTime, TimeZone, Utc};

#[derive(Debug, Clone)]
pub enum TimestampFmt {
    Iso,      // 2026-07-12T14:22:01.003Z  or  2026-07-12 14:22:01
    Slashed,  // 2026/07/12 14:22:01
    EpochMs,  // 1720783321003
    EpochSec, // 1720783321
}

#[derive(Debug, Clone)]
pub struct LevelToken {
    pub labels: Vec<String>,
} // e.g. ["ERROR","ERR","error"]

#[derive(Debug, Clone)]
pub struct LineFormat {
    pub timestamp: Option<TimestampFmt>,
    pub level: Option<LevelToken>,
    pub is_json: bool,
}

/// Parse one timestamp out of a line into epoch milliseconds (UTC).
/// Returns `None` gracefully on malformed input — never panics.
pub fn parse_epoch_ms(fmt: &LineFormat, line: &str) -> Option<i64> {
    let ts = fmt.timestamp.as_ref()?;
    match ts {
        TimestampFmt::Iso => parse_iso(line),
        TimestampFmt::Slashed => parse_slashed(line),
        // Bug 1 fix: threshold was `9_000_000_000_000 / 1_000_000` (= 9_000_000),
        // which would let epoch-seconds (~1.7e9) wrongly pass the EpochMs filter.
        // Use `> 1_600_000_000_000`, consistent with `guess_ts`. Value is already ms.
        TimestampFmt::EpochMs => first_i64_token(line).filter(|v| *v > 1_600_000_000_000),
        // Bug 2 fix: EpochSec branch returned raw seconds (off by 1000×).
        // `parse_epoch_ms` must return ms, so multiply seconds by 1000 after the filter.
        TimestampFmt::EpochSec => first_i64_token(line)
            .filter(|v| *v > 1_600_000_000 && *v < 9_900_000_000)
            .map(|v| v * 1000),
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
    line.split(|c: char| !c.is_ascii_digit())
        .find(|t| !t.is_empty())?
        .parse()
        .ok()
}

pub fn detect_format(sample: &[&str]) -> LineFormat {
    let timestamp = sample.iter().filter_map(|l| guess_ts(l)).next();
    let is_json = sample.iter().any(|l| l.trim_start().starts_with('{'));
    let level = Some(LevelToken {
        labels: default_level_labels(),
    });
    LineFormat {
        timestamp,
        level,
        is_json,
    }
}
fn guess_ts(line: &str) -> Option<TimestampFmt> {
    let s = line.trim_start();
    if s.get(0..19)
        .map(|h| h.contains('-') && (h.contains('T') || h.contains(' ')))
        .unwrap_or(false)
    {
        return Some(TimestampFmt::Iso);
    }
    if s.get(0..19).map(|h| h.contains('/')).unwrap_or(false) {
        return Some(TimestampFmt::Slashed);
    }
    if let Some(n) = first_i64_token(s) {
        if n > 1_600_000_000_000 {
            return Some(TimestampFmt::EpochMs);
        }
        if n > 1_600_000_000 {
            return Some(TimestampFmt::EpochSec);
        }
    }
    None
}
fn default_level_labels() -> Vec<String> {
    ["ERROR", "ERR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

pub fn parse_level(fmt: &LineFormat, line: &str) -> Option<Level> {
    let lt = fmt.level.as_ref()?;
    for lab in &lt.labels {
        if contains_word(line, lab) {
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

/// Case-insensitive, whole-word substring test.
///
/// `needle` matches only where it is bounded on both sides by a non-alphanumeric
/// character (or string start/end). This prevents `"INFO"` matching inside
/// `"INFORMATION"` (false positives) while still matching lowercase `"error"`
/// in mixed-case lines (false negatives) — see `parse_level`.
fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    // ASCII-only lowercasing keeps byte length stable, so byte indexing stays safe.
    let h = haystack.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    let hb = h.as_bytes();
    let nlen = n.len();
    let mut start = 0;
    while let Some(rel) = h[start..].find(&n) {
        let s = start + rel;
        let e = s + nlen;
        let left_ok = s == 0 || !hb[s - 1].is_ascii_alphanumeric();
        let right_ok = e == h.len() || !hb[e].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        start = s + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_to_epoch_ms() {
        let fmt = LineFormat {
            timestamp: Some(TimestampFmt::Iso),
            level: None,
            is_json: false,
        };
        let ms = parse_epoch_ms(&fmt, "2026-07-12 14:22:01.003 ERROR x").unwrap();
        assert_eq!(ms % 1000, 0); // seconds precision parsed; ms within second
                                  // 2026-07-12 14:22:01 UTC ≈ a positive epoch; just assert it's sane:
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn detects_iso_slashed_and_level() {
        let f = detect_format(&[
            "2026-07-12 14:22:01 ERROR db refused",
            "2026-07-12 14:22:02 WARN retry",
        ]);
        assert!(matches!(f.timestamp, Some(TimestampFmt::Iso)));
        assert_eq!(
            parse_level(&f, "2026-07-12 14:22:01 ERROR db refused"),
            Some(Level::Error)
        );
    }

    #[test]
    fn detects_json_line() {
        let f = detect_format(&[r#"{"event":"x","lvl":"error"}"#]);
        assert!(f.is_json);
    }

    // Added tests covering the EpochMs / EpochSec branches the brief omitted.

    #[test]
    fn detects_and_parses_epoch_ms() {
        let f = detect_format(&["1720783321003 ERROR x"]);
        assert!(matches!(f.timestamp, Some(TimestampFmt::EpochMs)));
        assert_eq!(
            parse_epoch_ms(&f, "1720783321003 ERROR x"),
            Some(1_720_783_321_003)
        );
    }

    #[test]
    fn detects_and_parses_epoch_sec() {
        let f = detect_format(&["1720783321 INFO y"]);
        assert!(matches!(f.timestamp, Some(TimestampFmt::EpochSec)));
        // seconds → ms (×1000)
        assert_eq!(
            parse_epoch_ms(&f, "1720783321 INFO y"),
            Some(1_720_783_321_000)
        );
    }

    #[test]
    fn parse_epoch_ms_returns_none_on_malformed() {
        // No timestamp configured → None.
        let no_ts = LineFormat {
            timestamp: None,
            level: None,
            is_json: false,
        };
        assert_eq!(parse_epoch_ms(&no_ts, "1720783321003 ERROR x"), None);
        // ISO format but line has no parseable head → None, no panic.
        let iso = LineFormat {
            timestamp: Some(TimestampFmt::Iso),
            level: None,
            is_json: false,
        };
        assert_eq!(parse_epoch_ms(&iso, "no timestamp here ERROR x"), None);
        // EpochMs configured but no digit token → None, no panic.
        let ems = LineFormat {
            timestamp: Some(TimestampFmt::EpochMs),
            level: None,
            is_json: false,
        };
        assert_eq!(parse_epoch_ms(&ems, "no digits at all"), None);
        // EpochMs configured but token below threshold (looks like seconds) → None.
        assert_eq!(parse_epoch_ms(&ems, "1720783321 too small"), None);
    }

    // --- parse_level hardening: case-insensitive + whole-word matching ---

    fn fmt_with_default_levels() -> LineFormat {
        LineFormat {
            timestamp: None,
            level: Some(LevelToken {
                labels: default_level_labels(),
            }),
            is_json: false,
        }
    }

    #[test]
    fn parse_level_matches_lowercase_case_insensitively() {
        let fmt = fmt_with_default_levels();
        // Lowercase "error" must match (case-insensitive) — currently a false negative.
        assert_eq!(
            parse_level(&fmt, "2026-07-12 14:22:01 error db refused"),
            Some(Level::Error)
        );
    }

    #[test]
    fn parse_level_word_boundary_suppresses_information_false_positive() {
        let fmt = fmt_with_default_levels();
        // "INFO" must NOT match inside "INFORMATION" — word boundary required.
        assert_eq!(parse_level(&fmt, "INFORMATION about the system"), None);
    }

    #[test]
    fn parse_level_matches_mixed_case_warning() {
        let fmt = fmt_with_default_levels();
        // "WARNING" must resolve to Level::Warn via its own label entry;
        // word-boundary must not let "WARN" steal it nor block "WARNING".
        assert_eq!(
            parse_level(&fmt, "2026-07-12 14:22:01 WARNING retry"),
            Some(Level::Warn)
        );
    }

    #[test]
    fn parse_level_still_matches_uppercase_error() {
        let fmt = fmt_with_default_levels();
        // Regression guard: existing uppercase behaviour preserved.
        assert_eq!(
            parse_level(&fmt, "2026-07-12 14:22:01 ERROR db refused"),
            Some(Level::Error)
        );
    }
}
