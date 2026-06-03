use crate::db::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "tusk";
const FILE: &str = "connections.json";

/// A saved connection profile. The password is NEVER stored here — it lives in
/// the OS keychain, keyed by `id`, and is only fetched server-side at connect time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub sslmode: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// Auto-connect to this profile on app launch (at most one profile).
    #[serde(default)]
    pub default_connect: bool,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::new(e.to_string()))?;
    Ok(dir.join(FILE))
}

pub fn load_all(app: &tauri::AppHandle) -> Result<Vec<Profile>, AppError> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| AppError::new(e.to_string()))?;
    Ok(serde_json::from_str(&data).unwrap_or_default())
}

fn save_all(app: &tauri::AppHandle, list: &[Profile]) -> Result<(), AppError> {
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(list).map_err(|e| AppError::new(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| AppError::new(e.to_string()))?;
    Ok(())
}

/// Insert or update a profile. Stores the password in the keychain when
/// `save_password` is set and a password is provided; clears it otherwise.
pub fn upsert(
    app: &tauri::AppHandle,
    mut p: Profile,
    password: Option<String>,
) -> Result<Profile, AppError> {
    if p.id.is_empty() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        p.id = format!("p{nanos}");
    }

    if p.save_password {
        if let Some(pw) = password {
            if !pw.is_empty() {
                let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &p.id)
                    .map_err(|e| AppError::new(e.to_string()))?;
                entry
                    .set_password(&pw)
                    .map_err(|e| AppError::new(e.to_string()))?;
            }
        }
    } else if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &p.id) {
        let _ = entry.delete_credential();
    }

    let mut list = load_all(app)?;
    // Only one profile may be the default — clear the flag on all others.
    if p.default_connect {
        for x in list.iter_mut() {
            x.default_connect = false;
        }
    }
    if let Some(existing) = list.iter_mut().find(|x| x.id == p.id) {
        *existing = p.clone();
    } else {
        list.push(p.clone());
    }
    save_all(app, &list)?;
    Ok(p)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), AppError> {
    let mut list = load_all(app)?;
    list.retain(|x| x.id != id);
    save_all(app, &list)?;
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub fn get_password(id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id)
        .ok()?
        .get_password()
        .ok()
}
