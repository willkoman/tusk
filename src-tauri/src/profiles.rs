use crate::db::{AppError, ConnectionConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "tusk";
const FILE: &str = "connections.json";
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

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
    serde_json::from_slice(&data)
        .map_err(|e| AppError::new(format!("invalid saved connection file: {e}")))
}

fn save_all(app: &tauri::AppHandle, list: &[Profile]) -> Result<(), AppError> {
    use std::io::Write;
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(list).map_err(|e| AppError::new(e.to_string()))?;
    if data.len() as u64 > MAX_STORE_BYTES {
        return Err(AppError::new("saved connection file exceeds 2 MiB"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("connection store has no parent directory"))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::new(e.to_string()))?;
    if let Ok(meta) = std::fs::metadata(&path) {
        temp.as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    temp.write_all(data.as_bytes())
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.persist(&path)
        .map_err(|e| AppError::new(e.error.to_string()))?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| AppError::new(format!("cannot sync connection-store directory: {e}")))?;
    Ok(())
}

fn same_destination(a: &Profile, b: &Profile) -> bool {
    a.driver.as_deref().unwrap_or("postgres") == b.driver.as_deref().unwrap_or("postgres")
        && a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && a.dbname == b.dbname
        && a.path.as_deref().unwrap_or("") == b.path.as_deref().unwrap_or("")
}

fn keychain_entry(id: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id)
        .map_err(|e| AppError::new(format!("cannot access saved password: {e}")))
}

fn saved_password(id: &str) -> Result<Option<String>, AppError> {
    match keychain_entry(id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::new(format!("cannot read saved password: {e}"))),
    }
}

fn set_saved_password(id: &str, password: &str) -> Result<(), AppError> {
    keychain_entry(id)?
        .set_password(password)
        .map_err(|e| AppError::new(format!("cannot save password: {e}")))
}

fn delete_saved_password(id: &str) -> Result<(), AppError> {
    match keychain_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new(format!("cannot delete saved password: {e}"))),
    }
}

fn restore_saved_password(id: &str, previous: Option<&str>) -> Result<(), AppError> {
    match previous {
        Some(password) => set_saved_password(id, password),
        None => delete_saved_password(id),
    }
}

#[derive(Debug, PartialEq)]
enum CredentialChange {
    None,
    Set(String),
    Delete,
}

fn credential_change(
    p: &Profile,
    existing: Option<&Profile>,
    password: Option<String>,
) -> Result<CredentialChange, AppError> {
    let password = password.filter(|pw| !pw.is_empty());
    if p.save_password {
        if let Some(password) = password {
            return Ok(CredentialChange::Set(password));
        }
        if existing.is_some_and(|old| old.save_password && same_destination(old, p)) {
            return Ok(CredentialChange::None);
        }
        return Err(AppError::new(if existing.is_some() {
            "re-enter the password after changing the connection destination, or turn off Save password"
        } else {
            "enter a password to save, or turn off Save password"
        }));
    }
    if existing.is_some_and(|old| old.save_password) {
        Ok(CredentialChange::Delete)
    } else {
        Ok(CredentialChange::None)
    }
}

fn apply_credential_change(
    id: &str,
    change: &CredentialChange,
) -> Result<Option<String>, AppError> {
    match change {
        CredentialChange::None => Ok(None),
        CredentialChange::Set(password) => {
            let previous = saved_password(id)?;
            set_saved_password(id, password)?;
            Ok(previous)
        }
        CredentialChange::Delete => {
            let previous = saved_password(id)?;
            delete_saved_password(id)?;
            Ok(previous)
        }
    }
}

fn requires_credential_handoff(
    change: &CredentialChange,
    existing: Option<&Profile>,
    p: &Profile,
) -> bool {
    matches!(change, CredentialChange::Set(_))
        && existing
            .map(|old| !same_destination(old, p))
            .unwrap_or(true)
}

/// Insert or update a profile. An existing password may only be retained for the
/// same destination; changing the destination requires re-entry or explicit clearing.
pub fn upsert(
    app: &tauri::AppHandle,
    mut p: Profile,
    password: Option<String>,
) -> Result<Profile, AppError> {
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

    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let original = load_all(app)?;
    if p.id.is_empty() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut suffix = 0_u32;
        loop {
            let id = if suffix == 0 {
                format!("p{nanos}")
            } else {
                format!("p{nanos}-{suffix}")
            };
            if !original.iter().any(|x| x.id == id) {
                p.id = id;
                break;
            }
            suffix = suffix.saturating_add(1);
        }
    }
    let existing = original.iter().find(|x| x.id == p.id);
    let change = credential_change(&p, existing, password)?;
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

    // On a destination change, pass through a credential-free state: clear the old
    // key, persist the new metadata, then install the new key. Every crash point is
    // safe (at worst the visible profile temporarily has no password); setting the new
    // password first could expose it to the old host after a crash.
    if requires_credential_handoff(&change, existing, &p) {
        let CredentialChange::Set(password) = &change else {
            unreachable!("credential handoff only applies to password changes")
        };
        let previous = saved_password(&p.id)?;
        delete_saved_password(&p.id)?;
        if let Err(save_error) = save_all(app, &list) {
            if let Err(rollback) = restore_saved_password(&p.id, previous.as_deref()) {
                return Err(AppError::new(format!(
                    "{}; saved-password rollback also failed: {}",
                    save_error.message, rollback.message
                )));
            }
            return Err(save_error);
        }
        if let Err(password_error) = set_saved_password(&p.id, password) {
            if let Err(profile_rollback) = save_all(app, &original) {
                return Err(AppError::new(format!(
                    "{}; profile rollback also failed: {}. The saved password was cleared to prevent credential reuse against the wrong destination",
                    password_error.message, profile_rollback.message
                )));
            }
            if let Err(password_rollback) = restore_saved_password(&p.id, previous.as_deref()) {
                return Err(AppError::new(format!(
                    "{}; saved-password rollback also failed: {}",
                    password_error.message, password_rollback.message
                )));
            }
            return Err(password_error);
        }
        return Ok(p);
    }

    // Same-destination updates and deletes can change the keychain first without ever
    // binding a credential to different connection metadata.
    let previous = apply_credential_change(&p.id, &change)?;
    if let Err(save_error) = save_all(app, &list) {
        if change != CredentialChange::None {
            if let Err(rollback) = restore_saved_password(&p.id, previous.as_deref()) {
                return Err(AppError::new(format!(
                    "{}; saved-password rollback also failed: {}",
                    save_error.message, rollback.message
                )));
            }
        }
        return Err(save_error);
    }
    Ok(p)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), AppError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_all(app)?;
    let had_saved_password = list.iter().any(|x| x.id == id && x.save_password);
    list.retain(|x| x.id != id);
    if !had_saved_password {
        return save_all(app, &list);
    }
    let previous = saved_password(id)?;
    delete_saved_password(id)?;
    if let Err(save_error) = save_all(app, &list) {
        if let Err(rollback) = restore_saved_password(id, previous.as_deref()) {
            return Err(AppError::new(format!(
                "{}; saved-password rollback also failed: {}",
                save_error.message, rollback.message
            )));
        }
        return Err(save_error);
    }
    Ok(())
}

pub fn get_password(id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id)
        .ok()?
        .get_password()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Profile {
        Profile {
            id: "p1".into(),
            name: "local".into(),
            host: "localhost".into(),
            port: 5432,
            user: "postgres".into(),
            dbname: "app".into(),
            save_password: true,
            sslmode: None,
            read_only: false,
            default_connect: false,
            driver: None,
            path: None,
        }
    }

    #[test]
    fn unchanged_destination_keeps_an_existing_password() {
        let old = profile();
        let mut next = old.clone();
        next.driver = Some("postgres".into());
        assert_eq!(
            credential_change(&next, Some(&old), None).unwrap(),
            CredentialChange::None
        );
        assert!(next.save_password);
    }

    #[test]
    fn changed_destination_requires_password_reconfirmation() {
        let old = profile();
        let mut next = old.clone();
        next.host = "production.example".into();
        assert!(credential_change(&next, Some(&old), None)
            .unwrap_err()
            .message
            .contains("re-enter"));

        let confirmed = next.clone();
        assert_eq!(
            credential_change(&confirmed, Some(&old), Some("new secret".into())).unwrap(),
            CredentialChange::Set("new secret".into())
        );
        assert!(confirmed.save_password);

        let mut cleared = next;
        cleared.save_password = false;
        assert_eq!(
            credential_change(&cleared, Some(&old), None).unwrap(),
            CredentialChange::Delete
        );
    }

    #[test]
    fn destination_changes_use_a_credential_free_handoff() {
        let old = profile();
        let same = old.clone();
        let mut changed = old.clone();
        changed.host = "other.example".into();
        let set = CredentialChange::Set("new".into());
        assert!(!requires_credential_handoff(&set, Some(&old), &same));
        assert!(requires_credential_handoff(&set, Some(&old), &changed));
        assert!(requires_credential_handoff(&set, None, &changed));
        assert!(!requires_credential_handoff(
            &CredentialChange::Delete,
            Some(&old),
            &changed
        ));
    }

    #[test]
    fn new_profile_cannot_claim_a_password_without_providing_one() {
        let next = profile();
        assert!(credential_change(&next, None, None).is_err());
    }
}
