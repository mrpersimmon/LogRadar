pub mod commands;
pub mod state;

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::ping, commands::open_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ping_returns_expected_string() {
        assert_eq!(commands::ping(), "pong");
    }
}
