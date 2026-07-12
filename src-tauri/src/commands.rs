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
