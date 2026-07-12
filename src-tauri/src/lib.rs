pub mod commands;
pub mod state;
pub mod workspace;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ping, commands::open_file, commands::get_lines,
            commands::search, commands::cancel_search, commands::close_session,
            commands::export,
            commands::workspace_save, commands::workspace_load, commands::workspace_list,
        ])
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
