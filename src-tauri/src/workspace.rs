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
    let mut p = dirs_or_temp();
    p.push("logradar");
    p.push("workspaces");
    let _ = std::fs::create_dir_all(&p);
    p
}
fn dirs_or_temp() -> PathBuf {
    // v1: use the OS config dir if available, else temp. (Avoids a dirs dep for the core shell;
    // sub-project 4 can swap in the `dirs` crate.)
    std::env::var_os("HOME").map(PathBuf::from).map(|h| h.join(".config"))
        .unwrap_or_else(|| std::env::temp_dir())
}

pub fn save(ws: &Workspace) -> Result<(), String> {
    let mut p = config_dir();
    p.push(format!("{}.json", ws.name));
    let data = serde_json::to_string_pretty(ws).map_err(|e| e.to_string())?;
    std::fs::write(&p, data).map_err(|e| e.to_string())
}
pub fn load(name: &str) -> Result<Workspace, String> {
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
}
