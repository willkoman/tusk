use crate::db::{AppError, ConnectionConfig};
use crate::ssh::{SshAuth, SshConfig};
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
/// The SSH tunnel's password / key passphrase follows the same rule under the
/// `<id>:ssh` account; `SshConfig` drops both secret fields when it serializes, so
/// neither `connections.json` nor the profile list sent to the frontend can carry one.
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
    /// "postgres" (default for old profiles) | "duckdb" | "sqlite" | "mysql" | "mssql".
    #[serde(default)]
    pub driver: Option<String>,
    /// Database file path for embedded drivers (DuckDB/SQLite); empty = :memory:.
    #[serde(default)]
    pub path: Option<String>,
    /// SSH tunnel metadata (network drivers only). `None` = direct connection.
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Keep the SSH password / key passphrase in the OS keychain.
    #[serde(default)]
    pub save_ssh_secret: bool,
}

/// The keychain account holding this profile's SSH secret. Distinct from the DB
/// password account (the bare id) so the two never overwrite each other.
///
/// The namespacing only holds while ids cannot contain `:` — see `check_id`, which
/// `upsert` applies to every id that reaches the store. Without it, a profile with the
/// id `p123:ssh` would share a keychain account with profile `p123`'s SSH secret, and
/// saving either would overwrite the other's credential.
fn ssh_account(id: &str) -> String {
    format!("{id}:ssh")
}

/// Ids address keychain accounts, so they are restricted to characters that cannot
/// collide with the `:`-suffixed SSH account or be mistaken for a path. Generated ids
/// (`p<nanos>` / `p<nanos>-<n>`) already satisfy this.
fn check_id(id: &str) -> Result<(), AppError> {
    if id.len() > 200 {
        return Err(AppError::new("profile id is too long"));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return Err(AppError::new(
            "profile id may only contain letters, digits, '-', '_' and '.'",
        ));
    }
    Ok(())
}

/// Agent auth has nothing to store, and a profile without a tunnel obviously does not.
fn ssh_secret_applies(p: &Profile) -> bool {
    p.ssh
        .as_ref()
        .is_some_and(|ssh| !matches!(ssh.auth_method(), Ok(SshAuth::Agent)))
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

/// Two profiles reach the same machine. The SSH endpoint is part of the destination:
/// the database host/port are resolved *from the bastion*, so swapping bastions sends
/// the same credentials somewhere else entirely.
fn same_destination(a: &Profile, b: &Profile) -> bool {
    a.driver.as_deref().unwrap_or("postgres") == b.driver.as_deref().unwrap_or("postgres")
        && a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && a.dbname == b.dbname
        && a.path.as_deref().unwrap_or("") == b.path.as_deref().unwrap_or("")
        && same_ssh_endpoint(a, b)
}

fn same_ssh_endpoint(a: &Profile, b: &Profile) -> bool {
    match (&a.ssh, &b.ssh) {
        (None, None) => true,
        (Some(x), Some(y)) => x.same_endpoint(y),
        _ => false,
    }
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| AppError::new(format!("cannot access saved password: {e}")))
}

fn saved_password(account: &str) -> Result<Option<String>, AppError> {
    match keychain_entry(account)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::new(format!("cannot read saved password: {e}"))),
    }
}

fn set_saved_password(account: &str, password: &str) -> Result<(), AppError> {
    keychain_entry(account)?
        .set_password(password)
        .map_err(|e| AppError::new(format!("cannot save password: {e}")))
}

fn delete_saved_password(account: &str) -> Result<(), AppError> {
    match keychain_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new(format!("cannot delete saved password: {e}"))),
    }
}

fn restore_saved_password(account: &str, previous: Option<&str>) -> Result<(), AppError> {
    match previous {
        Some(password) => set_saved_password(account, password),
        None => delete_saved_password(account),
    }
}

/// Put every recorded keychain account back the way it was. Best effort by design:
/// the caller is already reporting a failure and must report a rollback failure too.
fn restore_all(previous: &[(String, Option<String>)]) -> Result<(), AppError> {
    let mut failure: Option<AppError> = None;
    for (account, secret) in previous {
        if let Err(e) = restore_saved_password(account, secret.as_deref()) {
            failure.get_or_insert(e);
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
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

/// Same rules as the database password, for the SSH password / key passphrase. Agent
/// auth and a profile without a tunnel have nothing to store, so any previously saved
/// secret is cleared rather than silently kept.
fn ssh_credential_change(
    p: &Profile,
    existing: Option<&Profile>,
    secret: Option<String>,
) -> Result<CredentialChange, AppError> {
    let had_secret = existing.is_some_and(|old| old.save_ssh_secret && ssh_secret_applies(old));
    if !ssh_secret_applies(p) || !p.save_ssh_secret {
        return Ok(if had_secret {
            CredentialChange::Delete
        } else {
            CredentialChange::None
        });
    }
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        return Ok(CredentialChange::Set(secret));
    }
    if had_secret && existing.is_some_and(|old| same_ssh_endpoint(old, p)) {
        return Ok(CredentialChange::None);
    }
    Err(AppError::new(if existing.is_some() {
        "re-enter the SSH password or key passphrase after changing the SSH destination, or turn off Save SSH secret"
    } else {
        "enter the SSH password or key passphrase to save, or turn off Save SSH secret"
    }))
}

fn apply_credential_change(
    account: &str,
    change: &CredentialChange,
) -> Result<Option<String>, AppError> {
    match change {
        CredentialChange::None => Ok(None),
        CredentialChange::Set(password) => {
            let previous = saved_password(account)?;
            set_saved_password(account, password)?;
            Ok(previous)
        }
        CredentialChange::Delete => {
            let previous = saved_password(account)?;
            delete_saved_password(account)?;
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

/// One keychain account and what should happen to it in this save.
struct CredentialPlan {
    account: String,
    change: CredentialChange,
    /// The destination changed, so the old secret must be cleared *before* the new
    /// metadata is written.
    handoff: bool,
}

/// Insert or update a profile. An existing password may only be retained for the
/// same destination; changing the destination requires re-entry or explicit clearing.
pub fn upsert(
    app: &tauri::AppHandle,
    mut p: Profile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<Profile, AppError> {
    if p.name.is_empty() || p.name.len() > 200 {
        return Err(AppError::new("profile name is empty or too long"));
    }
    check_id(&p.id)?;
    if password.as_ref().is_some_and(|pw| pw.len() > 64 * 1024)
        || ssh_secret.as_ref().is_some_and(|s| s.len() > 64 * 1024)
    {
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
        ssh: p.ssh.clone(),
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
    let ssh_change = ssh_credential_change(&p, existing, ssh_secret)?;
    let plans = [
        CredentialPlan {
            account: p.id.clone(),
            handoff: requires_credential_handoff(&change, existing, &p),
            change,
        },
        CredentialPlan {
            // The SSH secret follows the SSH endpoint, not the database destination.
            handoff: matches!(ssh_change, CredentialChange::Set(_))
                && !existing.is_some_and(|old| same_ssh_endpoint(old, &p)),
            account: ssh_account(&p.id),
            change: ssh_change,
        },
    ];
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

    // Every account whose secret this save touched, with the value to put back if a
    // later step fails.
    let mut previous: Vec<(String, Option<String>)> = Vec::new();

    // Same-destination updates and deletes can change the keychain first without ever
    // binding a credential to different connection metadata.
    for plan in plans.iter().filter(|plan| !plan.handoff) {
        if plan.change == CredentialChange::None {
            continue;
        }
        match apply_credential_change(&plan.account, &plan.change) {
            Ok(before) => previous.push((plan.account.clone(), before)),
            Err(e) => {
                return Err(match restore_all(&previous) {
                    Ok(()) => e,
                    Err(rollback) => AppError::new(format!(
                        "{}; saved-password rollback also failed: {}",
                        e.message, rollback.message
                    )),
                })
            }
        }
    }

    // On a destination change, pass through a credential-free state: clear the old
    // key, persist the new metadata, then install the new key. Every crash point is
    // safe (at worst the visible profile temporarily has no password); setting the new
    // password first could expose it to the old host after a crash.
    let handoff: Vec<&CredentialPlan> = plans.iter().filter(|plan| plan.handoff).collect();
    for plan in &handoff {
        match saved_password(&plan.account).and_then(|before| {
            delete_saved_password(&plan.account)?;
            Ok(before)
        }) {
            Ok(before) => previous.push((plan.account.clone(), before)),
            Err(e) => {
                return Err(match restore_all(&previous) {
                    Ok(()) => e,
                    Err(rollback) => AppError::new(format!(
                        "{}; saved-password rollback also failed: {}",
                        e.message, rollback.message
                    )),
                })
            }
        }
    }

    if let Err(save_error) = save_all(app, &list) {
        if let Err(rollback) = restore_all(&previous) {
            return Err(AppError::new(format!(
                "{}; saved-password rollback also failed: {}",
                save_error.message, rollback.message
            )));
        }
        return Err(save_error);
    }

    for plan in &handoff {
        let CredentialChange::Set(secret) = &plan.change else {
            unreachable!("credential handoff only applies to password changes")
        };
        if let Err(password_error) = set_saved_password(&plan.account, secret) {
            if let Err(profile_rollback) = save_all(app, &original) {
                return Err(AppError::new(format!(
                    "{}; profile rollback also failed: {}. The saved password was cleared to prevent credential reuse against the wrong destination",
                    password_error.message, profile_rollback.message
                )));
            }
            if let Err(password_rollback) = restore_all(&previous) {
                return Err(AppError::new(format!(
                    "{}; saved-password rollback also failed: {}",
                    password_error.message, password_rollback.message
                )));
            }
            return Err(password_error);
        }
    }
    Ok(p)
}

pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), AppError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_all(app)?;
    let mut accounts: Vec<String> = Vec::new();
    for profile in list.iter().filter(|x| x.id == id) {
        if profile.save_password {
            accounts.push(id.to_string());
        }
        // Delete an SSH secret whenever the profile could have stored one, even if the
        // flag was toggled off without a save — leaving it behind would orphan it.
        if profile.ssh.is_some() {
            accounts.push(ssh_account(id));
        }
    }
    list.retain(|x| x.id != id);
    if accounts.is_empty() {
        return save_all(app, &list);
    }
    let mut previous: Vec<(String, Option<String>)> = Vec::new();
    for account in &accounts {
        let before = saved_password(account)?;
        delete_saved_password(account)?;
        previous.push((account.clone(), before));
    }
    if let Err(save_error) = save_all(app, &list) {
        if let Err(rollback) = restore_all(&previous) {
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

/// The stored SSH password / key passphrase for a profile, read server-side at connect
/// time only. Never returned through a command.
pub fn get_ssh_secret(id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &ssh_account(id))
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
            ssh: None,
            save_ssh_secret: false,
        }
    }

    fn tunnelled() -> Profile {
        Profile {
            ssh: Some(SshConfig {
                host: "bastion.example".into(),
                port: 22,
                user: "deploy".into(),
                auth: "password".into(),
                key_path: None,
                ssh_password: String::new(),
                ssh_key_passphrase: String::new(),
            }),
            save_ssh_secret: true,
            ..profile()
        }
    }

    #[test]
    fn profile_ids_cannot_collide_with_the_ssh_keychain_account() {
        // `ssh_account` namespaces by suffixing `:ssh`, so an id containing `:` could
        // address another profile's SSH secret — `p1:ssh` would be exactly the account
        // holding profile `p1`'s SSH passphrase.
        assert_eq!(ssh_account("p1"), "p1:ssh");
        assert!(check_id("p1:ssh").is_err());
        assert!(check_id("p1/../p2").is_err());
        assert!(check_id("p1 p2").is_err());
        assert!(check_id(&"p".repeat(201)).is_err());
        // Generated ids and the shapes users actually type stay valid.
        assert!(check_id("").is_ok()); // assigned by upsert before use
        assert!(check_id("p1759000000000000000").is_ok());
        assert!(check_id("p1759000000000000000-1").is_ok());
        assert!(check_id("my_profile.2").is_ok());
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

    #[test]
    fn changing_the_bastion_changes_the_database_destination() {
        // The database host/port are resolved from the SSH server, so a new bastion is
        // a different machine even though every database field is unchanged.
        let old = tunnelled();
        let mut moved = old.clone();
        moved.ssh.as_mut().unwrap().host = "attacker.example".into();
        assert!(!same_destination(&old, &moved));
        assert!(credential_change(&moved, Some(&old), None)
            .unwrap_err()
            .message
            .contains("re-enter"));

        // Adding or removing the tunnel is likewise a destination change.
        let direct = profile();
        assert!(!same_destination(&direct, &old));
        assert!(!same_destination(&old, &direct));
        assert!(same_destination(&old, &old.clone()));
    }

    #[test]
    fn ssh_secret_follows_the_same_retention_rules_as_the_password() {
        let old = tunnelled();

        // Same endpoint, no new secret typed: keep what is stored.
        assert_eq!(
            ssh_credential_change(&old, Some(&old), None).unwrap(),
            CredentialChange::None
        );
        // A newly typed secret always wins.
        assert_eq!(
            ssh_credential_change(&old, Some(&old), Some("phrase".into())).unwrap(),
            CredentialChange::Set("phrase".into())
        );
        // A changed SSH endpoint demands re-entry.
        let mut moved = old.clone();
        moved.ssh.as_mut().unwrap().user = "root".into();
        assert!(ssh_credential_change(&moved, Some(&old), None)
            .unwrap_err()
            .message
            .contains("re-enter"));
        assert_eq!(
            ssh_credential_change(&moved, Some(&old), Some("new".into())).unwrap(),
            CredentialChange::Set("new".into())
        );
        // A brand-new profile cannot claim a stored secret it never wrote.
        assert!(ssh_credential_change(&old, None, None).is_err());

        // Turning the tunnel off, switching to agent auth, or clearing the save flag
        // all remove the stored secret rather than orphaning it.
        for mutate in [
            (|p: &mut Profile| p.ssh = None) as fn(&mut Profile),
            |p: &mut Profile| p.ssh.as_mut().unwrap().auth = "agent".into(),
            |p: &mut Profile| p.save_ssh_secret = false,
        ] {
            let mut off = old.clone();
            mutate(&mut off);
            assert_eq!(
                ssh_credential_change(&off, Some(&old), None).unwrap(),
                CredentialChange::Delete
            );
            // …and doing it twice is not an extra delete.
            assert_eq!(
                ssh_credential_change(&off, Some(&off), None).unwrap(),
                CredentialChange::None
            );
        }
    }

    #[test]
    fn a_direct_connection_never_touches_the_ssh_keychain_account() {
        let direct = profile();
        assert_eq!(
            ssh_credential_change(&direct, Some(&direct), None).unwrap(),
            CredentialChange::None
        );
        assert_eq!(ssh_account("p1"), "p1:ssh");
        assert_ne!(ssh_account("p1"), "p1");
    }

    #[test]
    fn serialized_profiles_carry_ssh_metadata_but_no_secret() {
        let mut p = tunnelled();
        let ssh = p.ssh.as_mut().unwrap();
        ssh.auth = "key".into();
        ssh.key_path = Some("/home/me/.ssh/id_ed25519".into());
        ssh.ssh_key_passphrase = "top secret".into();
        ssh.ssh_password = "also secret".into();

        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("bastion.example"), "{json}");
        assert!(json.contains("id_ed25519"), "{json}");
        assert!(!json.contains("top secret"), "{json}");
        assert!(!json.contains("also secret"), "{json}");

        let back: Profile = serde_json::from_str(&json).unwrap();
        let back_ssh = back.ssh.unwrap();
        assert_eq!(back_ssh.host, "bastion.example");
        assert_eq!(back_ssh.auth, "key");
        assert!(back_ssh.ssh_key_passphrase.is_empty());
        assert!(back_ssh.ssh_password.is_empty());
        assert!(back.save_ssh_secret);
    }

    #[test]
    fn legacy_profiles_without_ssh_fields_still_load() {
        let json = r#"{"id":"p1","name":"local","host":"h","port":5432,"user":"u","dbname":"d"}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert!(p.ssh.is_none());
        assert!(!p.save_ssh_secret);
    }
}
