//! SSH tunnelling (local port forwarding) for the network drivers.
//!
//! A tunnel binds a listener on `127.0.0.1:0`, and every connection accepted there is
//! forwarded over a `direct-tcpip` channel to the configured database host/port. The
//! driver then dials the loopback port instead of the real host, so no driver code has
//! to know about SSH. The session and its accept loop live exactly as long as the
//! `Tunnel` value: dropping it aborts the loop and closes the SSH session, and the
//! loopback port is never reused for a different destination because a replacement
//! tunnel always binds a fresh port.
//!
//! Host keys are verified against `~/.ssh/known_hosts` and a Tusk-owned trust store
//! (`<app-config>/ssh_known_hosts.json`). An unknown host is a structured error
//! carrying the key type and SHA256 fingerprint so the UI can ask; a *changed* key is
//! refused outright with no bypass.

use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{ssh_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::db::{AppError, ConnectionConfig, SshHostKeyPrompt};

pub const DEFAULT_SSH_PORT: u16 = 22;

/// Bounds the whole SSH bring-up (TCP connect + key exchange + authentication), matching
/// the 10s database connect timeout. It never caps forwarded query duration — the
/// accept loop and its channels have no deadline.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FIELD_BYTES: usize = 1_000;
const MAX_PATH_BYTES: usize = 32_768;
const MAX_SECRET_BYTES: usize = 64 * 1024;

/// Trust-store bounds. The file is a small list of host/fingerprint records; anything
/// larger is corruption or tampering rather than legitimate use.
const MAX_TRUST_ENTRIES: usize = 1_000;
const MAX_TRUST_BYTES: u64 = 256 * 1024;
const TRUST_FILE: &str = "ssh_known_hosts.json";
/// `~/.ssh/known_hosts` is read whole; a file larger than this is not a key list.
const MAX_KNOWN_HOSTS_BYTES: u64 = 8 * 1024 * 1024;

/// SSH tunnel settings attached to a network connection.
///
/// The two secret fields deserialize (so a connect payload and the keychain can fill
/// them) but never serialize: `connections.json` and every profile list sent to the
/// frontend therefore carry metadata only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshConfig {
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// "password" | "key" | "agent".
    #[serde(default = "default_ssh_auth")]
    pub auth: String,
    /// Private-key file for `auth = "key"`.
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing)]
    pub ssh_password: String,
    #[serde(default, skip_serializing)]
    pub ssh_key_passphrase: String,
}

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

fn default_ssh_auth() -> String {
    "password".to_string()
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: DEFAULT_SSH_PORT,
            user: String::new(),
            auth: default_ssh_auth(),
            key_path: None,
            ssh_password: String::new(),
            ssh_key_passphrase: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshAuth {
    Password,
    Key,
    Agent,
}

impl SshConfig {
    pub fn auth_method(&self) -> Result<SshAuth, AppError> {
        match self.auth.as_str() {
            "password" => Ok(SshAuth::Password),
            "key" => Ok(SshAuth::Key),
            "agent" => Ok(SshAuth::Agent),
            other => Err(AppError::new(format!(
                "unknown SSH authentication method: {other}"
            ))),
        }
    }

    /// The secret this configuration stores in the keychain: the login password for
    /// password auth, the key passphrase for key auth, nothing for agent auth.
    #[cfg(test)]
    fn secret(&self) -> &str {
        match self.auth_method() {
            Ok(SshAuth::Password) => &self.ssh_password,
            Ok(SshAuth::Key) => &self.ssh_key_passphrase,
            _ => "",
        }
    }

    /// Install a keychain-loaded secret into the field its auth method reads.
    pub fn set_secret(&mut self, secret: String) {
        match self.auth_method() {
            Ok(SshAuth::Password) => self.ssh_password = secret,
            Ok(SshAuth::Key) => self.ssh_key_passphrase = secret,
            _ => {}
        }
    }

    /// True when the two configurations point at the same SSH endpoint with the same
    /// credential shape — the condition under which a stored secret may be retained.
    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.host == other.host
            && self.port == other.port
            && self.user == other.user
            && self.auth == other.auth
            && self.key_path.as_deref().unwrap_or("") == other.key_path.as_deref().unwrap_or("")
    }

    pub fn validate(&self) -> Result<(), AppError> {
        if self.host.trim().is_empty() {
            return Err(AppError::new("SSH tunnel: host is required"));
        }
        if self.user.trim().is_empty() {
            return Err(AppError::new("SSH tunnel: user is required"));
        }
        if self.port == 0 {
            return Err(AppError::new(
                "SSH tunnel: port must be between 1 and 65535",
            ));
        }
        if self.host.len() > MAX_FIELD_BYTES || self.user.len() > MAX_FIELD_BYTES {
            return Err(AppError::new("SSH tunnel field exceeds its size limit"));
        }
        if self.ssh_password.len() > MAX_SECRET_BYTES
            || self.ssh_key_passphrase.len() > MAX_SECRET_BYTES
        {
            return Err(AppError::new("SSH tunnel secret exceeds its size limit"));
        }
        let key_path = self.key_path.as_deref().unwrap_or("");
        if key_path.len() > MAX_PATH_BYTES {
            return Err(AppError::new("SSH tunnel: key path is too long"));
        }
        if self.auth_method()? == SshAuth::Key && key_path.trim().is_empty() {
            return Err(AppError::new(
                "SSH tunnel: private key authentication needs a key file",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Host-key trust store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TrustedHost {
    host: String,
    port: u16,
    fingerprint: String,
}

/// The app-config directory, published once at startup. Kept in a `Mutex` rather than a
/// `OnceLock` so tests can point the trust store at a temporary directory.
static TRUST_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Serializes the tests that repoint the process-wide trust store.
#[cfg(test)]
pub(crate) fn trust_test_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

pub fn set_trust_dir(dir: PathBuf) {
    *TRUST_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
}

fn trust_store_path() -> Option<PathBuf> {
    TRUST_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|dir| dir.join(TRUST_FILE))
}

/// `$HOME` (or `%USERPROFILE%` on Windows). Read from the environment rather than
/// `std::env::home_dir` so the lookup is identical on every supported platform.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

fn openssh_known_hosts_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

fn load_trusted(path: &Path) -> Result<Vec<TrustedHost>, AppError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(AppError::new(format!("cannot read {TRUST_FILE}: {e}"))),
    };
    let mut data = Vec::new();
    file.take(MAX_TRUST_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| AppError::new(format!("cannot read {TRUST_FILE}: {e}")))?;
    if data.len() as u64 > MAX_TRUST_BYTES {
        return Err(AppError::new(format!(
            "{TRUST_FILE} exceeds its {MAX_TRUST_BYTES}-byte limit"
        )));
    }
    let list: Vec<TrustedHost> = serde_json::from_slice(&data)
        .map_err(|e| AppError::new(format!("invalid {TRUST_FILE}: {e}")))?;
    if list.len() > MAX_TRUST_ENTRIES {
        return Err(AppError::new(format!(
            "{TRUST_FILE} holds more than {MAX_TRUST_ENTRIES} entries"
        )));
    }
    Ok(list)
}

fn save_trusted(path: &Path, list: &[TrustedHost]) -> Result<(), AppError> {
    use std::io::Write;
    let data = serde_json::to_string_pretty(list).map_err(|e| AppError::new(e.to_string()))?;
    if data.len() as u64 > MAX_TRUST_BYTES {
        return Err(AppError::new(format!(
            "{TRUST_FILE} exceeds its {MAX_TRUST_BYTES}-byte limit"
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("SSH trust store has no parent directory"))?;
    std::fs::create_dir_all(parent).map_err(|e| AppError::new(e.to_string()))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::new(e.to_string()))?;
    temp.write_all(data.as_bytes())
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.persist(path)
        .map_err(|e| AppError::new(e.error.to_string()))?;
    Ok(())
}

/// Record a host key the user explicitly trusted. Idempotent. A host has at most ONE
/// trusted fingerprint: trusting a rotated key supersedes the previous record (which
/// the user only ever reaches by answering the prompt for that exact fingerprint), so
/// a later rotation back to the old key prompts again instead of passing silently.
pub fn trust_host(host: &str, port: u16, fingerprint: &str) -> Result<(), AppError> {
    if host.trim().is_empty() || host.len() > MAX_FIELD_BYTES {
        return Err(AppError::new("SSH host is empty or too long"));
    }
    if port == 0 {
        return Err(AppError::new("SSH port must be between 1 and 65535"));
    }
    if !fingerprint.starts_with("SHA256:") || fingerprint.len() > 200 {
        return Err(AppError::new("expected a SHA256 host-key fingerprint"));
    }
    let path = trust_store_path()
        .ok_or_else(|| AppError::new("the SSH trust store location is unavailable"))?;
    let mut list = load_trusted(&path)?;
    if list
        .iter()
        .any(|e| e.host == host && e.port == port && e.fingerprint == fingerprint)
    {
        return Ok(());
    }
    // Trusting a replacement key supersedes the old record for that host, so a later
    // rotation back to the previous key still prompts.
    list.retain(|e| !(e.host == host && e.port == port));
    if list.len() >= MAX_TRUST_ENTRIES {
        return Err(AppError::new(format!(
            "the SSH trust store already holds {MAX_TRUST_ENTRIES} hosts"
        )));
    }
    list.push(TrustedHost {
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
    });
    save_trusted(&path, &list)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Trusted,
    Unknown,
    Changed,
    /// The key is listed under an OpenSSH `@revoked` marker. Never connectable, and
    /// never offered for trust.
    Revoked,
}

/// OpenSSH-style SHA256 fingerprint (`SHA256:<unpadded base64>`).
pub fn fingerprint_of(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn key_algorithm(key: &PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

/// Case-insensitive OpenSSH host pattern glob (`*` = any run, `?` = one character).
/// Iterative with a single backtrack point, so a pathological pattern cannot blow up.
fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let v: Vec<char> = value.chars().flat_map(char::to_lowercase).collect();
    let (mut pi, mut vi) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);
    while vi < v.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == v[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            resume = vi;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            resume += 1;
            vi = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Does this entry's host field cover `host:port`? Handles comma lists, `!` negation,
/// `[host]:port`, globs, and `|1|salt|hash` hashed names.
fn host_patterns_match(
    patterns: &ssh_key::known_hosts::HostPatterns,
    host: &str,
    port: u16,
) -> bool {
    use hmac::{KeyInit, Mac};
    let target = if port == DEFAULT_SSH_PORT {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    match patterns {
        ssh_key::known_hosts::HostPatterns::HashedName { salt, hash } => {
            let Ok(mac) = hmac::Hmac::<sha1::Sha1>::new_from_slice(salt) else {
                return false;
            };
            mac.chain_update(target.as_bytes())
                .verify_slice(hash)
                .is_ok()
        }
        ssh_key::known_hosts::HostPatterns::Patterns(list) => {
            let mut matched = false;
            for entry in list {
                let (negated, pattern) = match entry.strip_prefix('!') {
                    Some(rest) => (true, rest),
                    None => (false, entry.as_str()),
                };
                if glob_match(pattern, &target) {
                    // OpenSSH: one negated match disqualifies the whole line.
                    if negated {
                        return false;
                    }
                    matched = true;
                }
            }
            matched
        }
    }
}

/// One `known_hosts` record that applies to the host being verified.
struct HostRecord {
    marker: Option<ssh_key::known_hosts::Marker>,
    key: PublicKey,
}

/// Read `~/.ssh/known_hosts` and return the records covering `host:port`.
///
/// Parsed HERE rather than through `russh::keys::known_hosts`, whose parser splits each
/// line on a single ASCII space, takes field 3 as the key blob, and propagates a parse
/// failure out of the WHOLE file with `?`. One line Tusk cannot fully model — an
/// `@cert-authority`/`@revoked` marker, a double space, a tab, an unsupported key type —
/// therefore aborted the scan, and the caller turned that `Err` into "host not known",
/// silently downgrading a CHANGED key (no bypass) to an unknown one (Trust button).
///
/// An unreadable or over-sized file is an error the caller must refuse on; individual
/// malformed lines are skipped the way OpenSSH skips them, EXCEPT when the line's host
/// field covers this host — a record we cannot decode for this exact host is never
/// treated as absence.
fn scan_known_hosts(host: &str, port: u16, path: &Path) -> Result<Vec<HostRecord>, AppError> {
    use ssh_key::known_hosts::{Entry, HostPatterns};
    use std::str::FromStr;

    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => {
            return Err(AppError::new(format!(
                "cannot read {}: {e}",
                path.display()
            )))
        }
    };
    let mut data = Vec::new();
    file.take(MAX_KNOWN_HOSTS_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", path.display())))?;
    if data.len() as u64 > MAX_KNOWN_HOSTS_BYTES {
        return Err(AppError::new(format!(
            "{} exceeds the {MAX_KNOWN_HOSTS_BYTES}-byte limit Tusk will read",
            path.display()
        )));
    }

    let mut out = Vec::new();
    for raw in data.split(|b| *b == b'\n') {
        // A line that is not UTF-8 cannot be a host pattern or a base64 key.
        let Ok(line) = std::str::from_utf8(raw) else {
            continue;
        };
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Collapse the whitespace OpenSSH tolerates (tabs, runs of spaces) into the
        // single spaces the entry parser expects.
        let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
        match Entry::from_str(&normalized) {
            Ok(entry) => {
                if host_patterns_match(entry.host_patterns(), host, port) {
                    out.push(HostRecord {
                        marker: entry.marker().copied(),
                        key: entry.public_key().clone(),
                    });
                }
            }
            Err(_) => {
                // Could the line we failed to decode have been about THIS host? If so
                // we must not report "no record"; anything else is another host's
                // problem and is skipped, exactly as OpenSSH does.
                let mut fields = normalized.split(' ');
                let first = fields.next().unwrap_or("");
                let hosts = if first.starts_with('@') {
                    fields.next().unwrap_or("")
                } else {
                    first
                };
                if HostPatterns::from_str(hosts).is_ok_and(|p| host_patterns_match(&p, host, port))
                {
                    return Err(AppError::new(format!(
                        "{} holds an entry for this host that Tusk cannot parse — \
                         fix or remove that line before connecting",
                        path.display()
                    )));
                }
            }
        }
    }
    Ok(out)
}

/// Classify a presented host key against both trust sources. Pure over its path
/// arguments so the decision table is directly testable.
///
/// `Err` means the trust sources could not be read at all: the caller must REFUSE the
/// connection, never fall back to "unknown host, would you like to trust it?".
pub fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    tusk_store: Option<&Path>,
    openssh_known_hosts: Option<&Path>,
) -> Result<HostKeyVerdict, AppError> {
    let presented = fingerprint_of(key);

    // Tusk's own store wins: it is the record of an explicit in-app decision. A store
    // we cannot read is an error, not an empty store.
    if let Some(path) = tusk_store {
        let list = load_trusted(path)?;
        let mut saw_host = false;
        for entry in &list {
            if entry.host == host && entry.port == port {
                saw_host = true;
                if entry.fingerprint == presented {
                    return Ok(HostKeyVerdict::Trusted);
                }
            }
        }
        if saw_host {
            return Ok(HostKeyVerdict::Changed);
        }
    }

    let Some(path) = openssh_known_hosts else {
        return Ok(HostKeyVerdict::Unknown);
    };
    let recorded = scan_known_hosts(host, port, path)?;
    let mut same_algorithm = false;
    for record in &recorded {
        let same_key = fingerprint_of(&record.key) == presented;
        match record.marker {
            // A revoked key is refused whatever else the file says.
            Some(ssh_key::known_hosts::Marker::Revoked) if same_key => {
                return Ok(HostKeyVerdict::Revoked)
            }
            // A CA entry authorises certificates, not this bare key, and Tusk does not
            // verify certificates yet — it neither trusts nor condemns anything here.
            Some(_) => continue,
            None => {}
        }
        if same_key {
            return Ok(HostKeyVerdict::Trusted);
        }
        // OpenSSH only treats a key as *changed* when the same algorithm produces a
        // different key; a host that has an ed25519 entry and now offers RSA is an
        // unknown key, not an attack signal.
        if record.key.algorithm() == key.algorithm() {
            same_algorithm = true;
        }
    }
    // A revocation of this host's key under a different algorithm is not about the key
    // being presented, so it does not change the verdict — but a revoked entry matching
    // the presented key was already returned above.
    Ok(if same_algorithm {
        HostKeyVerdict::Changed
    } else {
        HostKeyVerdict::Unknown
    })
}

// ---------------------------------------------------------------------------
// Client session
// ---------------------------------------------------------------------------

struct TunnelHandler {
    host: String,
    port: u16,
    /// Set when the key is refused, so the caller can replace russh's generic
    /// "connection closed" with the structured verdict.
    rejection: Arc<Mutex<Option<AppError>>>,
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => Some(key.clone()),
            PublicKeyOrCertificate::Certificate(_) => None,
        };
        let host = self.host.clone();
        let port = self.port;
        let rejection = Arc::clone(&self.rejection);
        async move {
            let Some(key) = key else {
                *rejection.lock().unwrap_or_else(|e| e.into_inner()) = Some(AppError::new(
                    "SSH host key: the server presented a host certificate, which Tusk cannot verify yet",
                ));
                return Ok(false);
            };
            let tusk = trust_store_path();
            let openssh = openssh_known_hosts_path();
            let fingerprint = fingerprint_of(&key);
            let algorithm = key_algorithm(&key);
            // A trust source we cannot read is a REFUSAL, never "unknown host": the
            // Trust button would otherwise be offered for a host whose recorded key
            // Tusk simply failed to look at.
            let verdict =
                match verify_host_key(&host, port, &key, tusk.as_deref(), openssh.as_deref()) {
                    Ok(verdict) => verdict,
                    Err(e) => {
                        *rejection.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(AppError::new(format!(
                                "SSH host key for {host}:{port} could not be checked: {}. \
                             Tusk will not offer to trust a key it could not compare \
                             against your existing records.",
                                e.message
                            )));
                        return Ok(false);
                    }
                };
            match verdict {
                HostKeyVerdict::Trusted => Ok(true),
                HostKeyVerdict::Revoked => {
                    *rejection.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(AppError::new(format!(
                            "SSH host key for {host}:{port} is marked @revoked in your known_hosts \
                             ({algorithm} {fingerprint}). Tusk will not connect to it."
                        )));
                    Ok(false)
                }
                HostKeyVerdict::Unknown => {
                    *rejection.lock().unwrap_or_else(|e| e.into_inner()) = Some(
                        AppError::new(format!(
                            "SSH host key for {host}:{port} is not known ({algorithm} {fingerprint})"
                        ))
                        .with_ssh_host_key(SshHostKeyPrompt {
                            host: host.clone(),
                            port,
                            algorithm,
                            fingerprint,
                        }),
                    );
                    Ok(false)
                }
                HostKeyVerdict::Changed => {
                    *rejection.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(AppError::new(format!(
                            "SSH host key for {host}:{port} has CHANGED (now {algorithm} {fingerprint}). \
                             This may be a man-in-the-middle attack. Remove the old entry from your \
                             known_hosts or from Tusk's SSH trust store only if you are certain the \
                             change is legitimate."
                        )));
                    Ok(false)
                }
            }
        }
    }
}

/// Try every identity the agent offers, in the order the agent lists them. `AgentClient`
/// is itself russh's `Signer`, so the private key never leaves the agent.
async fn agent_authenticate<S>(
    session: &mut client::Handle<TunnelHandler>,
    user: &str,
    mut agent: AgentClient<S>,
) -> Result<bool, AppError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new(format!("SSH agent did not list identities: {e}")))?;
    let keys: Vec<PublicKey> = identities
        .into_iter()
        .filter_map(|id| match id {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            // Host/user certificates would need `authenticate_openssh_cert`, which the
            // agent path does not model yet.
            AgentIdentity::Certificate { .. } => None,
        })
        .collect();
    if keys.is_empty() {
        return Err(AppError::new(
            "the SSH agent holds no usable identities (certificates are not supported yet)",
        ));
    }
    let hash_alg = session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for key in keys {
        let result = session
            .authenticate_publickey_with(user, key, hash_alg, &mut agent)
            .await
            .map_err(|e| AppError::new(format!("SSH agent authentication failed: {e}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn authenticate(
    session: &mut client::Handle<TunnelHandler>,
    ssh: &SshConfig,
) -> Result<bool, AppError> {
    match ssh.auth_method()? {
        SshAuth::Password => Ok(session
            .authenticate_password(ssh.user.clone(), ssh.ssh_password.clone())
            .await
            .map_err(|e| AppError::new(format!("SSH password authentication failed: {e}")))?
            .success()),
        SshAuth::Key => {
            let path = ssh.key_path.as_deref().unwrap_or("");
            let passphrase =
                (!ssh.ssh_key_passphrase.is_empty()).then_some(&*ssh.ssh_key_passphrase);
            let key = russh::keys::load_secret_key(path, passphrase).map_err(|e| {
                AppError::new(format!("SSH private key `{path}` could not be loaded: {e}"))
            })?;
            // RSA keys must be signed with the hash the server advertises; anything
            // else ignores the value.
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            Ok(session
                .authenticate_publickey(
                    ssh.user.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::new(format!("SSH key authentication failed: {e}")))?
                .success())
        }
        SshAuth::Agent => {
            #[cfg(unix)]
            {
                let agent = AgentClient::connect_env().await.map_err(|e| {
                    AppError::new(format!(
                        "cannot reach the ssh-agent via $SSH_AUTH_SOCK: {e}"
                    ))
                })?;
                agent_authenticate(session, &ssh.user, agent).await
            }
            #[cfg(windows)]
            {
                const PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
                let agent = AgentClient::connect_named_pipe(PIPE).await.map_err(|e| {
                    AppError::new(format!(
                        "cannot reach the OpenSSH agent at {PIPE}: {e} — start the `ssh-agent` service, or use password/key authentication"
                    ))
                })?;
                agent_authenticate(session, &ssh.user, agent).await
            }
            #[cfg(not(any(unix, windows)))]
            {
                let _ = session;
                Err(AppError::new(
                    "SSH agent authentication isn't supported on this platform yet",
                ))
            }
        }
    }
}

/// Concurrent forwarded connections one tunnel will carry. A driver needs a handful
/// (pool connections plus the odd cancel socket); anything beyond this is a runaway
/// loop, and each forwarder holds an SSH channel.
const MAX_FORWARDS: usize = 64;

/// A live SSH session plus the loopback listener that forwards into it.
pub struct Tunnel {
    local_port: u16,
    session: Arc<client::Handle<TunnelHandler>>,
    accepting: Arc<AtomicBool>,
    /// The last reason a forward failed. Without it the driver only ever sees a reset
    /// loopback socket and reports it as a database error — a server with
    /// `AllowTcpForwarding no` would look like an unreachable database.
    forward_error: Arc<Mutex<Option<String>>>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Every in-flight forwarding task. Aborting only the accept loop left these
    /// copying between a loopback socket and an SSH channel after the tunnel was
    /// dropped — a replaced connection kept pumping into the old session.
    forwards: Arc<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>>,
}

impl std::fmt::Debug for Tunnel {
    /// Deliberately opaque: the SSH session holds credential-derived state, so a
    /// `{:?}` on a connect error must not widen what ends up in a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tunnel")
            .field("local_port", &self.local_port)
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accepting.store(false, Ordering::Release);
        self.task.abort();
        // The accept loop is only half of it: abort every forwarder too, or a
        // half-open database connection keeps copying into a session the app has
        // already replaced.
        for task in self
            .forwards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            task.abort();
        }
    }
}

impl Tunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// False once the SSH session or the accept loop has gone away. Checked before every
    /// reconnect so a dead tunnel is rebuilt rather than dialled into a closed port.
    pub fn is_alive(&self) -> bool {
        self.accepting.load(Ordering::Acquire) && !self.session.is_closed()
    }

    /// Consume the last forward failure, if the tunnel recorded one. Taken rather than
    /// read so a stale reason cannot be blamed for a later, unrelated failure.
    pub fn take_forward_error(&self) -> Option<String> {
        self.forward_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub async fn open(
        ssh: &SshConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<Tunnel, AppError> {
        ssh.validate()?;
        let rejection: Arc<Mutex<Option<AppError>>> = Arc::new(Mutex::new(None));
        let config = Arc::new(client::Config {
            // No inactivity timeout: an idle database connection must not tear the
            // tunnel down. Keepalives still surface a dead link.
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let handler = TunnelHandler {
            host: ssh.host.clone(),
            port: ssh.port,
            rejection: Arc::clone(&rejection),
        };

        let bring_up = async {
            let mut session =
                client::connect(config, (ssh.host.clone(), ssh.port), handler).await?;
            let ok = authenticate(&mut session, ssh)
                .await
                .map_err(BringUp::App)?;
            Ok::<_, BringUp>((session, ok))
        };

        let take_rejection = || rejection.lock().unwrap_or_else(|e| e.into_inner()).take();

        let (session, authenticated) = match tokio::time::timeout(HANDSHAKE_TIMEOUT, bring_up).await
        {
            Err(_) => {
                // A host-key refusal can also end the handshake without a reply.
                if let Some(structured) = take_rejection() {
                    return Err(structured);
                }
                return Err(AppError::new(format!(
                    "SSH connect to {}:{} timed out after {}s",
                    ssh.host,
                    ssh.port,
                    HANDSHAKE_TIMEOUT.as_secs()
                )));
            }
            Ok(Err(BringUp::App(e))) => return Err(e),
            Ok(Err(BringUp::Ssh(e))) => {
                // russh reports a refused host key as a generic transport failure;
                // the handler recorded the real reason.
                if let Some(structured) = take_rejection() {
                    return Err(structured);
                }
                return Err(AppError::new(format!(
                    "SSH connect to {}:{} failed: {e}",
                    ssh.host, ssh.port
                )));
            }
            Ok(Ok(pair)) => pair,
        };
        if let Some(structured) = take_rejection() {
            return Err(structured);
        }
        if !authenticated {
            return Err(AppError::new(format!(
                "SSH authentication failed for {}@{}:{} — the server rejected the {} credentials",
                ssh.user, ssh.host, ssh.port, ssh.auth
            )));
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| AppError::new(format!("SSH tunnel could not bind a local port: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AppError::new(format!("SSH tunnel could not bind a local port: {e}")))?
            .port();

        let session = Arc::new(session);
        let accepting = Arc::new(AtomicBool::new(true));
        let forward_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let forwards: Arc<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>> =
            Arc::new(Mutex::new(Vec::new()));
        let task = spawn_forwarder(
            listener,
            Arc::clone(&session),
            Arc::clone(&accepting),
            Arc::clone(&forward_error),
            Arc::clone(&forwards),
            target_host.to_string(),
            target_port,
        );

        Ok(Tunnel {
            local_port,
            session,
            accepting,
            forward_error,
            task,
            forwards,
        })
    }
}

/// Internal bring-up error so the timeout wrapper can distinguish an SSH transport
/// failure (which may hide a host-key refusal) from an already-structured app error.
enum BringUp {
    Ssh(russh::Error),
    App(AppError),
}

impl From<russh::Error> for BringUp {
    fn from(e: russh::Error) -> Self {
        Self::Ssh(e)
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_forwarder(
    listener: TcpListener,
    session: Arc<client::Handle<TunnelHandler>>,
    accepting: Arc<AtomicBool>,
    forward_error: Arc<Mutex<Option<String>>>,
    forwards: Arc<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>>,
    target_host: String,
    target_port: u16,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            if session.is_closed() {
                break;
            }
            let Ok((mut socket, peer)) = listener.accept().await else {
                break;
            };
            // Reap finished forwarders and refuse to grow past the cap; each one
            // holds an SSH channel, so an unbounded list is a resource leak.
            {
                let mut live = forwards.lock().unwrap_or_else(|e| e.into_inner());
                live.retain(|task| !task.inner().is_finished());
                if live.len() >= MAX_FORWARDS {
                    let reason = format!(
                        "the SSH tunnel already carries {MAX_FORWARDS} forwarded connections \
                         — refusing another to {target_host}:{target_port}"
                    );
                    eprintln!("[tusk] ssh tunnel: {reason}");
                    *forward_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
                    continue; // dropping `socket` resets the caller's attempt
                }
            }
            let session = Arc::clone(&session);
            let forward_error = Arc::clone(&forward_error);
            let host = target_host.clone();
            let task = tauri::async_runtime::spawn(async move {
                let channel = session
                    .channel_open_direct_tcpip(
                        host.clone(),
                        u32::from(target_port),
                        peer.ip().to_string(),
                        u32::from(peer.port()),
                    )
                    .await;
                match channel {
                    // Dropping `socket` on failure resets the driver's connection
                    // attempt — it never reaches an unintended destination. The reason
                    // is recorded BEFORE the socket drops, so the driver's own error
                    // can be annotated with it.
                    Err(e) => {
                        let reason = format!(
                            "the SSH server refused to forward to {host}:{target_port} ({e}) \
                             — check that it allows TCP forwarding (`AllowTcpForwarding yes`) \
                             and can reach that address"
                        );
                        eprintln!("[tusk] ssh tunnel: {reason}");
                        *forward_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
                    }
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut socket, &mut stream).await
                        {
                            eprintln!("[tusk] ssh tunnel: forward ended: {e}");
                        }
                    }
                }
            });
            forwards
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(task);
        }
        accepting.store(false, Ordering::Release);
    })
}

// ---------------------------------------------------------------------------
// Driver integration
// ---------------------------------------------------------------------------

/// Reuse a live tunnel, rebuild a dead one, or drop it entirely when the connection no
/// longer tunnels. Returning the tunnel by value keeps its lifetime tied to the backend
/// that dials through it.
pub async fn ensure(
    existing: Option<Tunnel>,
    cfg: &ConnectionConfig,
) -> Result<Option<Tunnel>, AppError> {
    let Some(ssh) = cfg.ssh.as_ref() else {
        // Dropping `existing` closes the session and its listener.
        return Ok(None);
    };
    if let Some(tunnel) = existing {
        if tunnel.is_alive() {
            return Ok(Some(tunnel));
        }
    }
    Ok(Some(Tunnel::open(ssh, &cfg.host, cfg.port).await?))
}

/// Re-label a database connect failure that was really the tunnel's fault. Through a
/// tunnel the driver only ever sees a reset loopback socket, so without this a refused
/// forward reads as "the database is unreachable".
pub fn explain_db_failure(tunnel: Option<&Tunnel>, error: AppError) -> AppError {
    let Some(reason) = tunnel.and_then(Tunnel::take_forward_error) else {
        return error;
    };
    AppError::new(format!(
        "{reason}. The database reported: {}",
        error.message
    ))
}

/// The configuration the driver actually dials: loopback when tunnelled, unchanged
/// otherwise. The original config is kept by the backend so profile/Slack/metadata
/// paths still see the destination the user configured.
pub fn dial_config(cfg: &ConnectionConfig, tunnel: Option<&Tunnel>) -> ConnectionConfig {
    match tunnel {
        None => cfg.clone(),
        Some(tunnel) => ConnectionConfig {
            host: "127.0.0.1".to_string(),
            port: tunnel.local_port(),
            // The dial config must never re-enter tunnel setup.
            ssh: None,
            ..cfg.clone()
        },
    }
}

/// The name the server's TLS certificate must be valid for.
///
/// SSH forwards raw TCP, so the TLS session is still end to end with the real database
/// server — but the *socket* the driver opens is loopback, and verifying a certificate
/// against `127.0.0.1` fails every time. The certificate has to be checked against the
/// host the user configured, which is what this returns when (and only when) the
/// connection is tunnelled.
pub fn tls_host(cfg: &ConnectionConfig, tunnel: Option<&Tunnel>) -> Option<String> {
    tunnel.map(|_| cfg.host.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SshConfig {
        SshConfig {
            host: "bastion.example".into(),
            port: 22,
            user: "deploy".into(),
            auth: "password".into(),
            key_path: None,
            ssh_password: "hunter2".into(),
            ssh_key_passphrase: String::new(),
        }
    }

    #[test]
    fn validation_requires_an_endpoint_and_a_usable_credential() {
        assert!(cfg().validate().is_ok());

        let mut blank = cfg();
        blank.host = "  ".into();
        assert!(blank.validate().unwrap_err().message.contains("host"));

        let mut nouser = cfg();
        nouser.user = String::new();
        assert!(nouser.validate().unwrap_err().message.contains("user"));

        let mut zero = cfg();
        zero.port = 0;
        assert!(zero.validate().unwrap_err().message.contains("port"));

        let mut unknown = cfg();
        unknown.auth = "kerberos".into();
        assert!(unknown
            .validate()
            .unwrap_err()
            .message
            .contains("unknown SSH authentication method"));

        let mut keyless = cfg();
        keyless.auth = "key".into();
        assert!(keyless
            .validate()
            .unwrap_err()
            .message
            .contains("needs a key file"));
        keyless.key_path = Some("/home/me/.ssh/id_ed25519".into());
        assert!(keyless.validate().is_ok());

        let mut agent = cfg();
        agent.auth = "agent".into();
        agent.ssh_password = String::new();
        assert!(agent.validate().is_ok());

        let mut huge = cfg();
        huge.ssh_password = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(huge.validate().is_err());
    }

    #[test]
    fn secrets_never_reach_serialized_metadata() {
        let mut key = cfg();
        key.auth = "key".into();
        key.key_path = Some("/keys/id".into());
        key.ssh_key_passphrase = "passphrase".into();

        for config in [cfg(), key] {
            let json = serde_json::to_string(&config).unwrap();
            assert!(!json.contains("ssh_password"), "{json}");
            assert!(!json.contains("ssh_key_passphrase"), "{json}");
            assert!(!json.contains("hunter2"), "{json}");
            assert!(!json.contains("passphrase"), "{json}");
            // Metadata still round-trips, with the secrets defaulted back to empty.
            let back: SshConfig = serde_json::from_str(&json).unwrap();
            assert_eq!(back.host, config.host);
            assert_eq!(back.port, config.port);
            assert_eq!(back.user, config.user);
            assert_eq!(back.auth, config.auth);
            assert_eq!(back.key_path, config.key_path);
            assert!(back.ssh_password.is_empty());
            assert!(back.ssh_key_passphrase.is_empty());
        }
    }

    #[test]
    fn missing_fields_deserialize_to_the_documented_defaults() {
        let parsed: SshConfig = serde_json::from_str(r#"{"host":"h","user":"u"}"#).unwrap();
        assert_eq!(parsed.port, DEFAULT_SSH_PORT);
        assert_eq!(parsed.auth, "password");
        assert_eq!(parsed.auth_method().unwrap(), SshAuth::Password);
    }

    #[test]
    fn secret_routing_follows_the_auth_method() {
        let mut password = cfg();
        assert_eq!(password.secret(), "hunter2");
        password.set_secret("other".into());
        assert_eq!(password.ssh_password, "other");
        assert!(password.ssh_key_passphrase.is_empty());

        let mut key = cfg();
        key.auth = "key".into();
        key.key_path = Some("/k".into());
        key.ssh_password = String::new();
        key.set_secret("phrase".into());
        assert_eq!(key.secret(), "phrase");
        assert_eq!(key.ssh_key_passphrase, "phrase");

        let mut agent = cfg();
        agent.auth = "agent".into();
        agent.set_secret("ignored".into());
        assert_eq!(agent.secret(), "");
    }

    #[test]
    fn endpoint_comparison_notices_every_credential_relevant_field() {
        let base = cfg();
        assert!(base.same_endpoint(&base.clone()));
        for mutate in [
            (|c: &mut SshConfig| c.host = "other".into()) as fn(&mut SshConfig),
            |c: &mut SshConfig| c.port = 2222,
            |c: &mut SshConfig| c.user = "root".into(),
            |c: &mut SshConfig| c.auth = "key".into(),
            |c: &mut SshConfig| c.key_path = Some("/k".into()),
        ] {
            let mut changed = base.clone();
            mutate(&mut changed);
            assert!(!base.same_endpoint(&changed));
        }
        // A secret change alone is not a destination change.
        let mut resecret = base.clone();
        resecret.ssh_password = "new".into();
        assert!(base.same_endpoint(&resecret));
    }

    // Fixed *public* keys (no private half exists in this repo) so fingerprints and
    // known_hosts lines are byte-stable across runs.
    const ED25519_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPwCpIlzHq+rKJuuF0cOonFVWb3LzXQ0Wds5xmvq6Rog";
    const ED25519_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII9+8cyVpY2DFk3kW8lF8D3Ad4D+71kHoWpWTYgJn5ru";
    const ED25519_C: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEGFPFLrsWc5Q6RU5bXBN935PmnMzQsL7mJONgPzKCtN";
    const RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDOThbgwkAmjEmjYXPIx1TM3kbf2o5s9D4iK9vsatrnu2u4NmVpriRlsOGOTUzvKAzAHyhCta3UL8ZDiEnrn/ejbsfiTGXqAJLCn40ZSFLScH6E+/yBzH1+U72kFvGvEVUbFhSBxDG92rdaaNkAbG/YnK9taTJQt3g6S4Y89blCLkBgS5M7HCZegbqs9dZ6S4XQhmljO9aCMuM5gXsS/WjsFIPeIpHXjh3YhYfwsdZ03tYkq2TXIFyXgB0nlmtjoo9yuxQknRqWdYdEOEh96Y097KYNxy/otDKqB/aT7kKDy9LiNOz82RaSzrcBCdHGEkbMYmLURkTTz4OWgCsPuHFv";

    fn test_key(openssh: &str) -> PublicKey {
        PublicKey::from_openssh(openssh).expect("fixture public key parses")
    }

    #[test]
    fn fingerprints_use_the_openssh_sha256_form() {
        let key = test_key(ED25519_A);
        let fp = fingerprint_of(&key);
        assert!(fp.starts_with("SHA256:"), "{fp}");
        // Unpadded base64 of a 32-byte digest — exactly what `ssh-keygen -l` prints.
        assert_eq!(fp.len(), "SHA256:".len() + 43);
        assert!(!fp.ends_with('='), "{fp}");
        assert_ne!(fp, fingerprint_of(&test_key(ED25519_B)));
        assert_eq!(key_algorithm(&key), "ssh-ed25519");
        assert_eq!(key_algorithm(&test_key(RSA)), "ssh-rsa");
    }

    /// `<pattern> <algorithm> <base64>` — `to_openssh` already emits the trailing two
    /// fields, so only the host pattern is prepended.
    fn known_hosts_line(host: &str, key: &PublicKey) -> String {
        format!("{host} {}\n", key.to_openssh().unwrap())
    }

    #[test]
    fn openssh_known_hosts_matches_plain_and_hashed_entries() {
        let dir = tempfile::tempdir().unwrap();
        let key = test_key(ED25519_A);
        let other = test_key(ED25519_B);

        // Plain entry, default port.
        let plain = dir.path().join("plain");
        std::fs::write(&plain, known_hosts_line("db.example", &key)).unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&plain)).unwrap(),
            HostKeyVerdict::Trusted
        );
        // Same algorithm, different key at the same host = changed, never accepted.
        assert_eq!(
            verify_host_key("db.example", 22, &other, None, Some(&plain)).unwrap(),
            HostKeyVerdict::Changed
        );
        // A key of a different type is unknown, matching OpenSSH: the host simply has
        // no entry for that algorithm yet.
        assert_eq!(
            verify_host_key("db.example", 22, &test_key(RSA), None, Some(&plain)).unwrap(),
            HostKeyVerdict::Unknown
        );
        // A different host in the same file is simply unknown.
        assert_eq!(
            verify_host_key("elsewhere", 22, &key, None, Some(&plain)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // Comma-separated patterns are one entry covering several names.
        let multi = dir.path().join("multi");
        std::fs::write(&multi, known_hosts_line("alpha,beta,gamma", &key)).unwrap();
        assert_eq!(
            verify_host_key("beta", 22, &key, None, Some(&multi)).unwrap(),
            HostKeyVerdict::Trusted
        );

        // Non-default ports are recorded as `[host]:port`.
        let ported = dir.path().join("ported");
        std::fs::write(&ported, known_hosts_line("[db.example]:2222", &key)).unwrap();
        assert_eq!(
            verify_host_key("db.example", 2222, &key, None, Some(&ported)).unwrap(),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&ported)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // Hashed entry produced by `ssh-keygen -H` for the host `db.example`:
        // |1|<base64 salt>|<base64 HMAC-SHA1(salt, hostname)>.
        const HASHED_DB_EXAMPLE: &str =
            "|1|MVV2AwM3Qy6i2/XJXqXU2Suvo3E=|h7UCHp65SB4OntHagxIW1NgHwQ0=";
        let hashed = dir.path().join("hashed");
        std::fs::write(&hashed, known_hosts_line(HASHED_DB_EXAMPLE, &key)).unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&hashed)).unwrap(),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &other, None, Some(&hashed)).unwrap(),
            HostKeyVerdict::Changed
        );
        assert_eq!(
            verify_host_key("other.example", 22, &key, None, Some(&hashed)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // Comments and a missing file are both benign.
        let commented = dir.path().join("commented");
        std::fs::write(
            &commented,
            format!("# a comment\n{}", known_hosts_line("db.example", &key)),
        )
        .unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&commented)).unwrap(),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&dir.path().join("nope"))).unwrap(),
            HostKeyVerdict::Unknown
        );
    }

    #[test]
    fn tusk_trust_store_records_and_supersedes() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join(TRUST_FILE);
        let key = test_key(ED25519_A);
        let rotated = test_key(ED25519_C);

        assert_eq!(
            verify_host_key("bastion", 22, &key, Some(&store), None).unwrap(),
            HostKeyVerdict::Unknown
        );
        save_trusted(
            &store,
            &[TrustedHost {
                host: "bastion".into(),
                port: 22,
                fingerprint: fingerprint_of(&key),
            }],
        )
        .unwrap();
        assert_eq!(
            verify_host_key("bastion", 22, &key, Some(&store), None).unwrap(),
            HostKeyVerdict::Trusted
        );
        // A different key for a host we already trust is a change, never silent.
        assert_eq!(
            verify_host_key("bastion", 22, &rotated, Some(&store), None).unwrap(),
            HostKeyVerdict::Changed
        );
        // The port is part of the identity.
        assert_eq!(
            verify_host_key("bastion", 2222, &key, Some(&store), None).unwrap(),
            HostKeyVerdict::Unknown
        );
        // The Tusk store answers before known_hosts is consulted.
        let known = dir.path().join("known_hosts");
        std::fs::write(&known, known_hosts_line("bastion", &rotated)).unwrap();
        assert_eq!(
            verify_host_key("bastion", 22, &rotated, Some(&store), Some(&known)).unwrap(),
            HostKeyVerdict::Changed
        );
    }

    #[test]
    fn trust_host_rejects_malformed_input() {
        let _guard = trust_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        set_trust_dir(dir.path().to_path_buf());
        assert!(trust_host("", 22, "SHA256:abc").is_err());
        assert!(trust_host("h", 0, "SHA256:abc").is_err());
        assert!(trust_host("h", 22, "MD5:aa:bb").is_err());

        let key = test_key(ED25519_A);
        let fp = fingerprint_of(&key);
        trust_host("h", 22, &fp).unwrap();
        trust_host("h", 22, &fp).unwrap(); // idempotent
        let store = dir.path().join(TRUST_FILE);
        assert_eq!(load_trusted(&store).unwrap().len(), 1);
        assert_eq!(
            verify_host_key("h", 22, &key, Some(&store), None).unwrap(),
            HostKeyVerdict::Trusted
        );

        // Trusting a rotated key replaces the record rather than accumulating both.
        let rotated = test_key(ED25519_B);
        trust_host("h", 22, &fingerprint_of(&rotated)).unwrap();
        assert_eq!(load_trusted(&store).unwrap().len(), 1);
        assert_eq!(
            verify_host_key("h", 22, &key, Some(&store), None).unwrap(),
            HostKeyVerdict::Changed
        );
        set_trust_dir(dir.path().to_path_buf());
    }

    #[test]
    fn dial_config_redirects_only_the_endpoint() {
        let base = ConnectionConfig {
            driver: Some("postgres".into()),
            host: "db.internal".into(),
            port: 5432,
            user: "app".into(),
            password: "pw".into(),
            dbname: "prod".into(),
            sslmode: Some("require".into()),
            read_only: true,
            path: None,
            ssh: Some(cfg()),
        };
        let untunnelled = dial_config(&base, None);
        assert_eq!(untunnelled.host, "db.internal");
        assert_eq!(untunnelled.port, 5432);
        assert!(untunnelled.ssh.is_some());
        // Untunnelled, TLS is validated against the host that was dialled.
        assert_eq!(tls_host(&base, None), None);
    }

    // --- known_hosts parsing -------------------------------------------------

    #[test]
    fn one_unparsable_line_can_never_downgrade_a_changed_key_to_unknown() {
        // russh's parser splits each line on ONE space, reads field 3 as the key blob,
        // and `?`s the whole file on a parse failure — which Tusk used to map to
        // `Unknown`, i.e. "not known, want to trust it?" for a key that had CHANGED.
        let dir = tempfile::tempdir().unwrap();
        let key = test_key(ED25519_A);
        let attacker = test_key(ED25519_B);

        let other_key = test_key(ED25519_C);
        let blob = key.to_openssh().unwrap();
        for prefix in [
            // A double space before the key type: russh reads field 3 as "" and
            // `parse_public_key_base64("ssh-ed25519")` aborts the WHOLE file.
            format!("db.example  {blob}\n"),
            // Tab separation: russh's single-space split makes the line one field, so
            // the record is silently invisible to it.
            format!("db.example\t{blob}\n"),
            // Markers russh does not model at all.
            format!(
                "@cert-authority {}",
                known_hosts_line("*.example", &other_key)
            ),
            format!("@revoked {}", known_hosts_line("stale.example", &other_key)),
            // Garbage about ANOTHER host is skipped, exactly as OpenSSH skips it.
            "broken.example ssh-ed25519 %%%not-base64%%%\n".to_string(),
            // A key type this build cannot decode, for another host.
            "legacy.example ssh-dss-vendor AAAAnot-a-key\n".to_string(),
        ] {
            let path = dir.path().join("known_hosts");
            std::fs::write(
                &path,
                format!("{prefix}{}", known_hosts_line("db.example", &key)),
            )
            .unwrap();
            assert_eq!(
                verify_host_key("db.example", 22, &key, None, Some(&path)).unwrap(),
                HostKeyVerdict::Trusted,
                "the good entry must still be found past `{prefix}`"
            );
            assert_eq!(
                verify_host_key("db.example", 22, &attacker, None, Some(&path)).unwrap(),
                HostKeyVerdict::Changed,
                "a substituted key must stay CHANGED (no Trust button) past `{prefix}`"
            );
        }
    }

    #[test]
    fn markers_are_understood_rather_than_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let key = test_key(ED25519_A);
        let other = test_key(ED25519_B);

        // @revoked wins outright, and is never offered for trust.
        let revoked = dir.path().join("revoked");
        std::fs::write(
            &revoked,
            format!("@revoked {}", known_hosts_line("db.example", &key)),
        )
        .unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&revoked)).unwrap(),
            HostKeyVerdict::Revoked
        );
        // A revoked entry records a key that must never be accepted — it does NOT
        // record the host's legitimate key, so a different key is unknown (which is
        // what OpenSSH reports too), not a detected change.
        assert_eq!(
            verify_host_key("db.example", 22, &other, None, Some(&revoked)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // @cert-authority authorises certificates, not this bare key: it neither
        // trusts it nor condemns it.
        let ca = dir.path().join("ca");
        std::fs::write(
            &ca,
            format!("@cert-authority {}", known_hosts_line("*.example", &key)),
        )
        .unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&ca)).unwrap(),
            HostKeyVerdict::Unknown
        );
    }

    #[test]
    fn host_patterns_cover_globs_negation_and_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let key = test_key(ED25519_A);

        let glob = dir.path().join("glob");
        std::fs::write(
            &glob,
            known_hosts_line("*.example.net,!secret.example.net", &key),
        )
        .unwrap();
        assert_eq!(
            verify_host_key("db.example.net", 22, &key, None, Some(&glob)).unwrap(),
            HostKeyVerdict::Trusted
        );
        // Case folds, as OpenSSH's hostname matching does.
        assert_eq!(
            verify_host_key("DB.Example.NET", 22, &key, None, Some(&glob)).unwrap(),
            HostKeyVerdict::Trusted
        );
        // A negated pattern disqualifies the line even though the glob matched.
        assert_eq!(
            verify_host_key("secret.example.net", 22, &key, None, Some(&glob)).unwrap(),
            HostKeyVerdict::Unknown
        );
        assert_eq!(
            verify_host_key("db.example.org", 22, &key, None, Some(&glob)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // `?` matches exactly one character.
        let single = dir.path().join("single");
        std::fs::write(&single, known_hosts_line("db?.example", &key)).unwrap();
        assert_eq!(
            verify_host_key("db1.example", 22, &key, None, Some(&single)).unwrap(),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db12.example", 22, &key, None, Some(&single)).unwrap(),
            HostKeyVerdict::Unknown
        );

        // Tabs and repeated spaces are accepted, as OpenSSH accepts them.
        let spaced = dir.path().join("spaced");
        std::fs::write(
            &spaced,
            format!("db.example\t\t{}\n", key.to_openssh().unwrap()),
        )
        .unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&spaced)).unwrap(),
            HostKeyVerdict::Trusted
        );
    }

    #[test]
    fn an_unreadable_trust_source_is_refused_not_treated_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let key = test_key(ED25519_A);

        // A record for THIS host that cannot be decoded is an error, never "unknown".
        let broken = dir.path().join("broken");
        std::fs::write(&broken, "db.example ssh-ed25519 %%%not-base64%%%\n").unwrap();
        assert!(verify_host_key("db.example", 22, &key, None, Some(&broken)).is_err());

        // A corrupt Tusk trust store is an error too, not an empty store.
        let store = dir.path().join(TRUST_FILE);
        std::fs::write(&store, "{ not json").unwrap();
        assert!(verify_host_key("db.example", 22, &key, Some(&store), None).is_err());

        // An oversized known_hosts is refused rather than silently truncated.
        let huge = dir.path().join("huge");
        std::fs::write(&huge, vec![b'#'; (MAX_KNOWN_HOSTS_BYTES + 2) as usize]).unwrap();
        assert!(verify_host_key("db.example", 22, &key, None, Some(&huge)).is_err());
    }

    #[test]
    fn glob_matching_is_anchored_and_terminates() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*c", "abbbc"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*c", "abbbd"));
        assert!(!glob_match("abc", "abcd"));
        assert!(!glob_match("abcd", "abc"));
        assert!(glob_match("[db.example]:2222", "[DB.example]:2222"));
        // Pathological pattern: must terminate, and stay anchored at the end.
        assert!(glob_match(&"*a".repeat(24), &"a".repeat(40)));
        assert!(!glob_match(
            &format!("{}b", "*a".repeat(24)),
            &"a".repeat(40)
        ));
    }
}
