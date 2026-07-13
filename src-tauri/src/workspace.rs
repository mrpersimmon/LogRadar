use serde::{Serialize, Deserialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub name: String,
    pub files: Vec<String>,
    pub queries: Vec<serde_json::Value>, // full Query (keywords+level+time+exclusion) as JSON
}

pub fn config_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    p.push("logradar");
    p.push("workspaces");
    let _ = std::fs::create_dir_all(&p);
    p
}

/// I7: validate a workspace name before using it as a filename. Rejects path
/// traversal / control chars: empty, `/`, `\`, `..`, NUL, or a leading `.`.
/// `ws.name`/`name` is otherwise used verbatim as `{name}.json` under the
/// workspaces dir, so a name like `../evil` would write/read outside it.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
        || name.starts_with('.')
    {
        return Err("invalid workspace name".to_string());
    }
    Ok(())
}

pub fn save(ws: &Workspace) -> Result<(), String> {
    validate_name(&ws.name)?;
    let mut p = config_dir();
    p.push(format!("{}.json", ws.name));
    let data = serde_json::to_string_pretty(ws).map_err(|e| e.to_string())?;
    std::fs::write(&p, data).map_err(|e| e.to_string())
}
pub fn load(name: &str) -> Result<Workspace, String> {
    validate_name(name)?;
    let mut p = config_dir();
    p.push(format!("{name}.json"));
    let data = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}
pub fn list() -> Result<Vec<String>, String> {
    let dir = config_dir();
    let mut names = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        if let Some(name) = ent.path().file_stem().and_then(|s| s.to_str()) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unique(name: &str) -> String { format!("{}-{}", name, uuid::Uuid::new_v4()) }
    #[test]
    fn save_load_round_trip() {
        let name = unique("test");
        let ws = Workspace { name: name.clone(), files: vec!["a.log".into()], queries: vec![serde_json::json!({"root":{}})] };
        save(&ws).unwrap();
        let loaded = load(&name).unwrap();
        assert_eq!(loaded.name, name);
        assert_eq!(loaded.files, vec!["a.log"]);
    }
    #[test]
    fn list_includes_saved() {
        let name = unique("lst");
        save(&Workspace { name: name.clone(), files: vec![], queries: vec![] }).unwrap();
        let names = list().unwrap();
        assert!(names.contains(&name));
    }
    #[test]
    fn load_missing_errors() {
        assert!(load(&unique("nope")).is_err());
    }
    // --- I7 RED→GREEN: workspace name sanitization (path traversal) ---
    //
    // `save`/`load` use the workspace `name` verbatim as a filename
    // (`{name}.json`) under the workspaces dir. A name like `../evil` would
    // write/read OUTSIDE that dir (path traversal). The fix rejects names that
    // are empty, contain `/`, `\`, `..`, NUL, or start with a leading `.`.
    #[test]
    fn save_rejects_path_traversal_names() {
        let bad = ["../evil", "a/b", "a\\b", "..", "a..b", ".hidden", "", "x\0y"];
        for name in bad {
            let ws = Workspace { name: name.to_string(), files: vec![], queries: vec![] };
            let res = save(&ws);
            assert!(res.is_err(), "name {:?} must be rejected (path traversal / control char)", name);
        }
        // Regression guard: a legitimate name still saves fine.
        let good = unique("clean");
        save(&Workspace { name: good.clone(), files: vec!["a".into()], queries: vec![] }).unwrap();
        assert!(load(&good).is_ok());
    }
    // --- ④b Task 1: config_dir delegates to dirs::config_dir() (platform-correct
    // OS config dir: ~/Library/Application Support on macOS, %APPDATA% on Windows,
    // ~/.config on Linux), NOT the old ~/.config fallback.
    //
    // On macOS/Windows the fallback (~/.config) differs from dirs::config_dir(),
    // so this assertion RED-fails against the fallback and GREEN-passes once
    // config_dir() delegates to dirs::config_dir().
    #[test]
    fn config_dir_delegates_to_dirs_config_dir() {
        let os_root = dirs::config_dir()
            .expect("dirs::config_dir should resolve on this platform");
        let expected = os_root.join("logradar").join("workspaces");
        assert_eq!(
            config_dir(),
            expected,
            "config_dir must derive from dirs::config_dir() (platform-correct OS \
             config dir), not the ~/.config fallback"
        );
    }
    #[test]
    fn load_rejects_path_traversal_names() {
        let bad = ["../evil", "a/b", "a\\b", "..", ".hidden", "", "x\0y"];
        for name in bad {
            assert!(load(name).is_err(), "load name {:?} must be rejected before touching the fs", name);
        }
    }
}
