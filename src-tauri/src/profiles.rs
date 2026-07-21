use crate::db::{AppError, ConnectionConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "tusk";
const FILE: &str = "connections.json";
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024;

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
    /// "postgres" (default for old profiles) | "duckdb" | "sqlite" | "mysql".
    #[serde(default)]
    pub driver: Option<String>,
    /// Database file path for embedded drivers (DuckDB/SQLite); empty = :memory:.
    #[serde(default)]
    pub path: Option<String>,
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
    use std::io::Read;
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut data = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| AppError::new(e.to_string()))?
        .take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| AppError::new(e.to_string()))?;
    if data.len() as u64 > MAX_STORE_BYTES {
        return Err(AppError::new("saved connection file exceeds 2 MiB"));
    }
    serde_json::from_slice(&data).map_err(|e| AppError::new(format!("invalid saved connection file: {e}")))
}

fn save_all(app: &tauri::AppHandle, list: &[Profile]) -> Result<(), AppError> {
    use std::io::Write;
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(list).map_err(|e| AppError::new(e.to_string()))?;
    if data.len() as u64 > MAX_STORE_BYTES {
        return Err(AppError::new("saved connection file exceeds 2 MiB"));
    }
    let parent = path.parent().ok_or_else(|| AppError::new("connection store has no parent directory"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| AppError::new(e.to_string()))?;
    if let Ok(meta) = std::fs::metadata(&path) {
        temp.as_file().set_permissions(meta.permissions()).map_err(|e| AppError::new(e.to_string()))?;
    }
    temp.write_all(data.as_bytes()).map_err(|e| AppError::new(e.to_string()))?;
    temp.as_file_mut().sync_all().map_err(|e| AppError::new(e.to_string()))?;
    temp.persist(&path).map_err(|e| AppError::new(e.error.to_string()))?;
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
    if p.id.len() > 200 || p.name.is_empty() || p.name.len() > 200 {
        return Err(AppError::new("profile id/name is empty or too long"));
    }
    if password.as_ref().is_some_and(|pw| pw.len() > 64 * 1024) {
        return Err(AppError::new("password exceeds the 65536-byte limit"));
    }
    ConnectionConfig {
        driver: p.driver.clone(),
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        password: String::new(),
        dbname: p.dbname.clone(),
        sslmode: p.sslmode.clone(),
        read_only: p.read_only,
        path: p.path.clone(),
    }
    .validate()?;

    let original = load_all(app)?;
    let mut list = original.clone();
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
    let credential = if p.save_password {
        match password.as_deref().filter(|pw| !pw.is_empty()) {
            Some(pw) => keyring::Entry::new(KEYCHAIN_SERVICE, &p.id)
                .map_err(|e| AppError::new(e.to_string()))
                .and_then(|entry| entry.set_password(pw).map_err(|e| AppError::new(e.to_string()))),
            None => Ok(()),
        }
    } else {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &p.id) {
            let _ = entry.delete_credential();
        }
        Ok(())
    };
    if let Err(e) = credential {
        if let Err(rollback) = save_all(app, &original) {
            return Err(AppError::new(format!("{0}; profile rollback also failed: {1}", e.message, rollback.message)));
        }
        return Err(e);
    }
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
