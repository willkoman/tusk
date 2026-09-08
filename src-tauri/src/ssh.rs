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
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
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

/// Record a host key the user explicitly trusted. Idempotent, and it never *replaces* a
/// differing fingerprint silently — a changed key adds a second accepted entry only
/// because the user answered the prompt for that exact fingerprint.
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
}

/// OpenSSH-style SHA256 fingerprint (`SHA256:<unpadded base64>`).
pub fn fingerprint_of(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn key_algorithm(key: &PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

/// Classify a presented host key against both trust sources. Pure over its path
/// arguments so the decision table is directly testable.
pub fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    tusk_store: Option<&Path>,
    openssh_known_hosts: Option<&Path>,
) -> HostKeyVerdict {
    let presented = fingerprint_of(key);

    // Tusk's own store wins: it is the record of an explicit in-app decision.
    if let Some(path) = tusk_store {
        if let Ok(list) = load_trusted(path) {
            let mut saw_host = false;
            for entry in &list {
                if entry.host == host && entry.port == port {
                    saw_host = true;
                    if entry.fingerprint == presented {
                        return HostKeyVerdict::Trusted;
                    }
                }
            }
            if saw_host {
                return HostKeyVerdict::Changed;
            }
        }
    }

    // `known_host_keys_path` understands plain, `[host]:port`, comma-list, and hashed
    // (`|1|salt|hash`) host patterns, so both entry shapes resolve here.
    let Some(path) = openssh_known_hosts else {
        return HostKeyVerdict::Unknown;
    };
    let Ok(recorded) = russh::keys::known_hosts::known_host_keys_path(host, port, path) else {
        return HostKeyVerdict::Unknown;
    };
    let mut same_algorithm = false;
    for (_line, candidate) in &recorded {
        if fingerprint_of(candidate) == presented {
            return HostKeyVerdict::Trusted;
        }
        // OpenSSH only treats a key as *changed* when the same algorithm produces a
        // different key; a host that has an ed25519 entry and now offers RSA is an
        // unknown key, not an attack signal.
        if candidate.algorithm() == key.algorithm() {
            same_algorithm = true;
        }
    }
    if same_algorithm {
        HostKeyVerdict::Changed
    } else {
        HostKeyVerdict::Unknown
    }
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
            let verdict = verify_host_key(&host, port, &key, tusk.as_deref(), openssh.as_deref());
            let fingerprint = fingerprint_of(&key);
            let algorithm = key_algorithm(&key);
            match verdict {
                HostKeyVerdict::Trusted => Ok(true),
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
        let task = spawn_forwarder(
            listener,
            Arc::clone(&session),
            Arc::clone(&accepting),
            Arc::clone(&forward_error),
            target_host.to_string(),
            target_port,
        );

        Ok(Tunnel {
            local_port,
            session,
            accepting,
            forward_error,
            task,
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
            let session = Arc::clone(&session);
            let forward_error = Arc::clone(&forward_error);
            let host = target_host.clone();
            tauri::async_runtime::spawn(async move {
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
            verify_host_key("db.example", 22, &key, None, Some(&plain)),
            HostKeyVerdict::Trusted
        );
        // Same algorithm, different key at the same host = changed, never accepted.
        assert_eq!(
            verify_host_key("db.example", 22, &other, None, Some(&plain)),
            HostKeyVerdict::Changed
        );
        // A key of a different type is unknown, matching OpenSSH: the host simply has
        // no entry for that algorithm yet.
        assert_eq!(
            verify_host_key("db.example", 22, &test_key(RSA), None, Some(&plain)),
            HostKeyVerdict::Unknown
        );
        // A different host in the same file is simply unknown.
        assert_eq!(
            verify_host_key("elsewhere", 22, &key, None, Some(&plain)),
            HostKeyVerdict::Unknown
        );

        // Comma-separated patterns are one entry covering several names.
        let multi = dir.path().join("multi");
        std::fs::write(&multi, known_hosts_line("alpha,beta,gamma", &key)).unwrap();
        assert_eq!(
            verify_host_key("beta", 22, &key, None, Some(&multi)),
            HostKeyVerdict::Trusted
        );

        // Non-default ports are recorded as `[host]:port`.
        let ported = dir.path().join("ported");
        std::fs::write(&ported, known_hosts_line("[db.example]:2222", &key)).unwrap();
        assert_eq!(
            verify_host_key("db.example", 2222, &key, None, Some(&ported)),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&ported)),
            HostKeyVerdict::Unknown
        );

        // Hashed entry produced by `ssh-keygen -H` for the host `db.example`:
        // |1|<base64 salt>|<base64 HMAC-SHA1(salt, hostname)>.
        const HASHED_DB_EXAMPLE: &str =
            "|1|MVV2AwM3Qy6i2/XJXqXU2Suvo3E=|h7UCHp65SB4OntHagxIW1NgHwQ0=";
        let hashed = dir.path().join("hashed");
        std::fs::write(&hashed, known_hosts_line(HASHED_DB_EXAMPLE, &key)).unwrap();
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&hashed)),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &other, None, Some(&hashed)),
            HostKeyVerdict::Changed
        );
        assert_eq!(
            verify_host_key("other.example", 22, &key, None, Some(&hashed)),
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
            verify_host_key("db.example", 22, &key, None, Some(&commented)),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            verify_host_key("db.example", 22, &key, None, Some(&dir.path().join("nope"))),
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
            verify_host_key("bastion", 22, &key, Some(&store), None),
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
            verify_host_key("bastion", 22, &key, Some(&store), None),
            HostKeyVerdict::Trusted
        );
        // A different key for a host we already trust is a change, never silent.
        assert_eq!(
            verify_host_key("bastion", 22, &rotated, Some(&store), None),
            HostKeyVerdict::Changed
        );
        // The port is part of the identity.
        assert_eq!(
            verify_host_key("bastion", 2222, &key, Some(&store), None),
            HostKeyVerdict::Unknown
        );
        // The Tusk store answers before known_hosts is consulted.
        let known = dir.path().join("known_hosts");
        std::fs::write(&known, known_hosts_line("bastion", &rotated)).unwrap();
        assert_eq!(
            verify_host_key("bastion", 22, &rotated, Some(&store), Some(&known)),
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
            verify_host_key("h", 22, &key, Some(&store), None),
            HostKeyVerdict::Trusted
        );

        // Trusting a rotated key replaces the record rather than accumulating both.
        let rotated = test_key(ED25519_B);
        trust_host("h", 22, &fingerprint_of(&rotated)).unwrap();
        assert_eq!(load_trusted(&store).unwrap().len(), 1);
        assert_eq!(
            verify_host_key("h", 22, &key, Some(&store), None),
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
    }
}
