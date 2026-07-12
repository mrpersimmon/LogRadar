#[tauri::command]
pub fn ping() -> String { "pong".to_string() }

use serde::Serialize;
use tauri::State;
use crate::state::AppState;

#[derive(Serialize, Debug)]
pub struct OpenResponse {
    pub session_id: String,
    pub line_count: u64,
    pub encoding: String,
    pub is_json: bool,
    pub timestamp_fmt: String,
}

pub fn open_file_impl(state: &AppState, path: &str) -> Result<OpenResponse, String> {
    let session = logradar_core::Session::open(std::path::Path::new(path))
        .map_err(|e| e.to_string())?;
    let line_count = session.line_count();
    let encoding = format!("{:?}", session.encoding());
    let fmt = session.format().clone();
    let is_json = fmt.is_json;
    let timestamp_fmt = format!("{:?}", fmt.timestamp);
    let session_id = state.insert(session);
    Ok(OpenResponse { session_id, line_count, encoding, is_json, timestamp_fmt })
}

#[tauri::command]
pub async fn open_file(state: State<'_, AppState>, path: String) -> Result<OpenResponse, String> {
    open_file_impl(&state, &path)
}

pub fn get_lines_impl(state: &AppState, session_id: &str, start: u64, count: usize) -> Result<Vec<String>, String> {
    let entry = state.get(session_id).ok_or("session not found".to_string())?;
    let mut session = entry.session.lock().map_err(|e| e.to_string())?;
    Ok(session.get_lines(start, count))
}

#[tauri::command]
pub async fn get_lines(state: State<'_, AppState>, session_id: String, start: u64, count: usize) -> Result<Vec<String>, String> {
    get_lines_impl(&state, &session_id, start, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    fn write_tmp(name: &str, content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lr-open-{}-{}.log", name, uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        p
    }
    #[test]
    fn open_file_returns_metadata_and_registers_session() {
        let state = AppState::default();
        let p = write_tmp("a", "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n");
        let resp = open_file_impl(&state, p.to_str().unwrap()).unwrap();
        assert_eq!(resp.line_count, 2);
        assert!(resp.encoding.contains("Utf8"));
        assert!(!resp.session_id.is_empty());
        assert!(state.get(&resp.session_id).is_some(), "session must be registered");
    }
    #[test]
    fn open_file_missing_path_errors() {
        let state = AppState::default();
        let err = open_file_impl(&state, "/nonexistent/path.log").unwrap_err();
        assert!(!err.is_empty());
    }
}

#[cfg(test)]
mod get_lines_tests {
    use super::*;
    use crate::state::AppState;
    fn open_tmp(state: &AppState, content: &str) -> String {
        let p = std::env::temp_dir().join(format!("lr-gl-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, content).unwrap();
        open_file_impl(state, p.to_str().unwrap()).unwrap().session_id
    }
    #[test]
    fn get_lines_returns_window() {
        let state = AppState::default();
        let id = open_tmp(&state, "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n2026-07-12 14:22:03 WARN c\n");
        let win = get_lines_impl(&state, &id, 1, 2).unwrap();
        assert_eq!(win.len(), 2);
        assert!(win[0].contains("ERROR b"));
    }
    #[test]
    fn get_lines_unknown_session_errors() {
        let state = AppState::default();
        assert!(get_lines_impl(&state, "nope", 0, 1).is_err());
    }
}
