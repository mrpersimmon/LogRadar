use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use logradar_core::{CancellationToken, Session};

pub type SessionId = String;

pub struct SessionEntry {
    pub session: Mutex<Session>,
    pub search_token: Mutex<Option<Arc<CancellationToken>>>,
}

#[derive(Default)]
pub struct AppState {
    pub sessions: Mutex<HashMap<SessionId, Arc<SessionEntry>>>,
}

impl AppState {
    pub fn insert(&self, session: Session) -> SessionId {
        let id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(SessionEntry {
            session: Mutex::new(session),
            search_token: Mutex::new(None),
        });
        self.sessions.lock().unwrap().insert(id.clone(), entry);
        id
    }
    pub fn get(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    pub fn set_search_token(&self, id: &str, token: Arc<CancellationToken>) {
        if let Some(e) = self.get(id) { *e.search_token.lock().unwrap() = Some(token); }
    }
    /// Cancel the in-flight search (if any) and remove the session.
    pub fn close(&self, id: &str) -> bool {
        let entry = self.sessions.lock().unwrap().remove(id);
        if let Some(e) = entry {
            if let Some(tok) = e.search_token.lock().unwrap().take() { tok.cancel(); }
            true
        } else { false }
    }
    pub fn cancel_search(&self, id: &str) -> bool {
        if let Some(e) = self.get(id) {
            if let Some(tok) = e.search_token.lock().unwrap().as_ref() { tok.cancel(); return true; }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp_session() -> Session {
        // write a tiny temp file + open via logradar-core
        let p = std::env::temp_dir().join(format!("lr-reg-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&p, "2026-07-12 14:22:01 INFO a\n2026-07-12 14:22:02 ERROR b\n").unwrap();
        Session::open(&p).unwrap()
    }
    #[test]
    fn insert_get_close_lifecycle() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        assert!(state.get(&id).is_some());
        assert!(state.close(&id));
        assert!(state.get(&id).is_none());
    }
    #[test]
    fn close_cancels_in_flight_search_token() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        let tok = Arc::new(CancellationToken::new());
        state.set_search_token(&id, tok.clone());
        assert!(!tok.is_cancelled());
        assert!(state.close(&id));
        assert!(tok.is_cancelled(), "closing a session must cancel its in-flight search");
    }
    #[test]
    fn cancel_search_sets_token() {
        let state = AppState::default();
        let id = state.insert(tmp_session());
        let tok = Arc::new(CancellationToken::new());
        state.set_search_token(&id, tok.clone());
        assert!(state.cancel_search(&id));
        assert!(tok.is_cancelled());
    }
}
