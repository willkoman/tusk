//! Self-contained SSH tunnel integration tests.
//!
//! Everything runs in-process: a russh **server** with a freshly generated host key
//! stands in for the bastion, a plain TCP echo server stands in for the database, and
//! the production `ssh::Tunnel` connects the two. No Docker, no network, no fixtures on
//! disk beyond a per-test temporary directory.
//!
//! What is pinned here is exactly the behaviour that must never regress: bytes make it
//! through the forward, a wrong password fails at the *authentication* stage (not
//! later, as a database error), and an untrusted host key is refused with its
//! fingerprint until the user trusts it.

// `trust_store_guard` intentionally spans the whole async test body: it serializes the
// process-wide trust-store setting these tests repoint, and releasing it at the first
// await would let a concurrent test change the store mid-connect.
#![allow(clippy::await_holding_lock)]

use std::sync::Arc;
use std::time::Duration;

use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelOpenFailure};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ssh::{self, SshConfig, Tunnel};

const USER: &str = "tusk";
const PASSWORD: &str = "correct horse";

// --- the stand-in bastion -------------------------------------------------

#[derive(Clone)]
struct TestSshServer;

impl server::Server for TestSshServer {
    type Handler = Self;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for TestSshServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USER && password == PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = format!("{host_to_connect}:{port_to_connect}");
        let Ok(upstream) = TcpStream::connect(&target).await else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        // Nothing may be written to the channel before it is accepted.
        reply.accept().await;
        tokio::spawn(async move {
            let mut upstream = upstream;
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut upstream, &mut stream).await;
        });
        Ok(())
    }
}

struct RunningSsh {
    port: u16,
    host_key: PublicKey,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for RunningSsh {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start_ssh_server() -> RunningSsh {
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        // Keep rejections quick so the wrong-password test is not dominated by the
        // library's constant-time rejection delay.
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut server = TestSshServer;
        let _ = server.run_on_socket(config, &listener).await;
    });
    RunningSsh {
        port,
        host_key: public,
        task,
    }
}

// --- the stand-in database ------------------------------------------------

/// Uppercases everything it receives — enough to prove both directions of the forward
/// carry real bytes rather than echoing a buffer back locally.
async fn start_echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let upper: Vec<u8> = buf[..n].to_ascii_uppercase();
                            if socket.write_all(&upper).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    (port, task)
}

// --- helpers --------------------------------------------------------------

fn ssh_config(port: u16, password: &str) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: USER.into(),
        auth: "password".into(),
        key_path: None,
        ssh_password: password.into(),
        ssh_key_passphrase: String::new(),
    }
}

/// Point the process-wide trust store at a fresh directory and pre-trust `key` for
/// `127.0.0.1:port`.
///
/// The OpenSSH fallback is left alone deliberately: every server here binds an ephemeral
/// high port, so a real `~/.ssh/known_hosts` cannot hold a `[127.0.0.1]:<port>` entry
/// that would accidentally satisfy the check.
fn trust(dir: &tempfile::TempDir, port: u16, key: &PublicKey) {
    ssh::set_trust_dir(dir.path().to_path_buf());
    ssh::trust_host("127.0.0.1", port, &ssh::fingerprint_of(key)).unwrap();
}

/// The trust store is a process-wide setting, so the tests that repoint it run one at a
/// time. Recovered on poisoning: a panicking test must not wedge the rest.
fn trust_store_guard() -> std::sync::MutexGuard<'static, ()> {
    ssh::trust_test_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

async fn round_trip(tunnel: &Tunnel, payload: &str) -> String {
    let mut client = TcpStream::connect(("127.0.0.1", tunnel.local_port()))
        .await
        .expect("the tunnel's loopback port accepts connections");
    client.write_all(payload.as_bytes()).await.unwrap();
    let mut got = vec![0u8; payload.len()];
    client.read_exact(&mut got).await.unwrap();
    String::from_utf8(got).unwrap()
}

// --- tests ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn tunnel_forwards_bytes_in_both_directions() {
    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();
    let ssh_server = start_ssh_server().await;
    let (db_port, _db) = start_echo_server().await;
    trust(&dir, ssh_server.port, &ssh_server.host_key);

    let tunnel = Tunnel::open(&ssh_config(ssh_server.port, PASSWORD), "127.0.0.1", db_port)
        .await
        .expect("tunnel opens against a trusted host with the right password");

    assert_ne!(
        tunnel.local_port(),
        db_port,
        "the driver must dial the tunnel's own loopback port, not the database directly"
    );
    assert!(tunnel.is_alive());
    assert_eq!(round_trip(&tunnel, "select 1").await, "SELECT 1");
    // A second connection proves the accept loop keeps serving, not just the first.
    assert_eq!(round_trip(&tunnel, "again").await, "AGAIN");

    // Dropping the tunnel takes the loopback listener with it, so nothing can later
    // reach the database through a port Tusk no longer owns.
    let port = tunnel.local_port();
    drop(tunnel);
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the tunnel's local listener stayed open after the tunnel was dropped");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_password_fails_at_the_authentication_stage() {
    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();
    let ssh_server = start_ssh_server().await;
    trust(&dir, ssh_server.port, &ssh_server.host_key);

    let error = Tunnel::open(&ssh_config(ssh_server.port, "wrong"), "127.0.0.1", 1)
        .await
        .expect_err("a bad password must not produce a tunnel");
    let message = error.message.to_ascii_lowercase();
    assert!(
        message.contains("authentication"),
        "the error must name the SSH auth stage: {}",
        error.message
    );
    assert!(
        !message.contains("wrong"),
        "the attempted password must never appear in an error: {}",
        error.message
    );
    assert!(
        error.ssh_host_key.is_none(),
        "an auth failure must not offer a trust-this-host prompt"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_host_key_is_refused_until_it_is_trusted() {
    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();
    let ssh_server = start_ssh_server().await;
    let (db_port, _db) = start_echo_server().await;
    // An empty trust store, and nothing in `~/.ssh/known_hosts` can match an ephemeral
    // `[127.0.0.1]:<port>` endpoint.
    ssh::set_trust_dir(dir.path().to_path_buf());

    let config = ssh_config(ssh_server.port, PASSWORD);
    let error = Tunnel::open(&config, "127.0.0.1", db_port)
        .await
        .expect_err("an unknown host key must refuse the connection");
    let prompt = error
        .ssh_host_key
        .as_ref()
        .expect("an unknown host key must carry a prompt payload");
    assert_eq!(prompt.host, "127.0.0.1");
    assert_eq!(prompt.port, ssh_server.port);
    assert_eq!(prompt.algorithm, "ssh-ed25519");
    assert_eq!(
        prompt.fingerprint,
        ssh::fingerprint_of(&ssh_server.host_key)
    );
    assert!(prompt.fingerprint.starts_with("SHA256:"));
    assert!(
        error.message.contains(&prompt.fingerprint),
        "the message shows the fingerprint the user must compare: {}",
        error.message
    );

    // Exactly what the frontend's Trust button does, then retry.
    ssh::trust_host(&prompt.host, prompt.port, &prompt.fingerprint).unwrap();
    let tunnel = Tunnel::open(&config, "127.0.0.1", db_port)
        .await
        .expect("the same host connects once its key is trusted");
    assert_eq!(round_trip(&tunnel, "trusted").await, "TRUSTED");

    // A *different* key at the same endpoint is a change, and no prompt is offered for
    // it — there is no one-click answer to a host key that moved.
    let impostor = start_ssh_server().await;
    ssh::trust_host(
        "127.0.0.1",
        impostor.port,
        &ssh::fingerprint_of(&ssh_server.host_key),
    )
    .unwrap();
    let changed = Tunnel::open(&ssh_config(impostor.port, PASSWORD), "127.0.0.1", db_port)
        .await
        .expect_err("a host key that changed must be refused");
    assert!(
        changed.message.contains("CHANGED"),
        "the message must call out the change: {}",
        changed.message
    );
    assert!(
        changed.ssh_host_key.is_none(),
        "a changed host key must never offer a Trust button"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_reuses_a_live_tunnel_and_rebuilds_a_dead_one() {
    use crate::db::ConnectionConfig;

    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();
    let ssh_server = start_ssh_server().await;
    let (db_port, _db) = start_echo_server().await;
    trust(&dir, ssh_server.port, &ssh_server.host_key);

    let config = ConnectionConfig {
        driver: Some("postgres".into()),
        host: "127.0.0.1".into(),
        port: db_port,
        user: "u".into(),
        password: String::new(),
        dbname: "d".into(),
        sslmode: Some("disable".into()),
        read_only: false,
        path: None,
        ssh: Some(ssh_config(ssh_server.port, PASSWORD)),
    };

    let tunnel = ssh::ensure(None, &config).await.unwrap().unwrap();
    let first_port = tunnel.local_port();
    // The dial config points the driver at the tunnel, never at the real endpoint, and
    // must not carry the SSH settings back into a nested setup.
    let dial = ssh::dial_config(&config, Some(&tunnel));
    assert_eq!(dial.host, "127.0.0.1");
    assert_eq!(dial.port, first_port);
    assert!(dial.ssh.is_none());
    assert_eq!(dial.dbname, "d");
    assert!(config.tunnelled());

    // A live tunnel is reused as-is: the loopback port must not move under the driver.
    let tunnel = ssh::ensure(Some(tunnel), &config).await.unwrap().unwrap();
    assert_eq!(tunnel.local_port(), first_port);
    assert_eq!(round_trip(&tunnel, "reused").await, "REUSED");

    // Removing the SSH settings drops the tunnel entirely.
    let direct = ConnectionConfig {
        ssh: None,
        ..config.clone()
    };
    assert!(ssh::ensure(Some(tunnel), &direct).await.unwrap().is_none());
    assert!(!direct.tunnelled());
    assert_eq!(ssh::dial_config(&direct, None).port, db_port);

    // A tunnel whose bastion died is never reused: `ensure` rebuilds, and when the
    // rebuild cannot succeed it reports that instead of handing back a stale port.
    let doomed = start_ssh_server().await;
    trust(&dir, doomed.port, &doomed.host_key);
    let mut doomed_config = config.clone();
    doomed_config.ssh = Some(ssh_config(doomed.port, PASSWORD));
    let dead = ssh::ensure(None, &doomed_config).await.unwrap().unwrap();
    let dead_port = dead.local_port();
    assert!(dead.is_alive());
    drop(doomed); // aborts the server task, so the SSH session goes away
    for _ in 0..100 {
        if !dead.is_alive() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!dead.is_alive(), "a tunnel must notice its session died");
    let rebuilt = ssh::ensure(Some(dead), &doomed_config).await;
    match rebuilt {
        Err(e) => assert!(
            !e.message.is_empty(),
            "a failed rebuild must explain which stage failed"
        ),
        Ok(Some(tunnel)) => assert_ne!(
            tunnel.local_port(),
            dead_port,
            "a rebuilt tunnel must never hand back the dead tunnel's port"
        ),
        Ok(None) => panic!("a tunnelled config must always yield a tunnel"),
    }
}

// --- live end-to-end (opt-in) ---------------------------------------------

/// The whole feature against real software: OpenSSH's `sshd` forwarding to a real
/// PostgreSQL server, driven through `driver::connect` exactly as the app does it.
///
/// Skipped unless `scripts/conformance.sh` (or the reviewer) exports
/// `TUSK_TEST_SSH_PORT`; `TUSK_TEST_SSH_DB_HOST`/`_PORT` name the database as the SSH
/// container sees it, and `TUSK_TEST_SSH_USER`/`_PASSWORD` its login.
#[tokio::test(flavor = "multi_thread")]
async fn postgres_connects_through_a_real_sshd() {
    use crate::db::ConnectionConfig;

    let Some(ssh_port) = std::env::var("TUSK_TEST_SSH_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
    else {
        return;
    };
    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();
    ssh::set_trust_dir(dir.path().to_path_buf());

    let config = ConnectionConfig {
        driver: Some("postgres".into()),
        // Resolved inside the SSH container, not on this machine.
        host: std::env::var("TUSK_TEST_SSH_DB_HOST").unwrap_or_else(|_| "tusk-it-pg".into()),
        port: std::env::var("TUSK_TEST_SSH_DB_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5432),
        user: "postgres".into(),
        password: "test".into(),
        dbname: "postgres".into(),
        sslmode: Some("disable".into()),
        read_only: false,
        path: None,
        ssh: Some(SshConfig {
            host: "127.0.0.1".into(),
            port: ssh_port,
            user: std::env::var("TUSK_TEST_SSH_USER").unwrap_or_else(|_| "tusk".into()),
            auth: "password".into(),
            key_path: None,
            ssh_password: std::env::var("TUSK_TEST_SSH_PASSWORD").unwrap_or_else(|_| "test".into()),
            ssh_key_passphrase: String::new(),
        }),
    };

    // A container's host key is new every run, so the first attempt must be the
    // unknown-host refusal — the same path the connect screen takes.
    let refused = crate::driver::connect(&config)
        .await
        .err()
        .expect("a never-seen sshd host key must refuse the first connect");
    let prompt = refused
        .ssh_host_key
        .expect("the refusal must carry a fingerprint to show the user");
    assert!(prompt.fingerprint.starts_with("SHA256:"));
    ssh::trust_host(&prompt.host, prompt.port, &prompt.fingerprint).unwrap();

    let (mut backend, version) = crate::driver::connect(&config)
        .await
        .expect("PostgreSQL connects through the tunnel once the host key is trusted");
    assert!(!version.is_empty());
    assert_eq!(backend.database_name().await, "postgres");
    match backend
        .run_single("SELECT 42 AS answer", 100, false)
        .await
        .unwrap()
    {
        crate::db::QueryOutcome::Rows { columns, rows, .. } => {
            assert_eq!(columns, vec!["answer".to_string()]);
            assert_eq!(rows[0][0].as_deref(), Some("42"));
        }
        other => panic!("expected rows through the tunnel, got {other:?}"),
    }

    // Reconnect keeps working over the same tunnel.
    backend
        .reopen()
        .await
        .expect("reconnect through the tunnel");
    assert_eq!(backend.database_name().await, "postgres");
}

/// A server that authenticates fine but refuses `direct-tcpip` — what
/// `AllowTcpForwarding no` looks like on the wire. Without the annotation the driver
/// only reports a reset loopback socket, which reads as an unreachable database.
#[derive(Clone)]
struct NoForwardingServer;

impl server::Server for NoForwardingServer {
    type Handler = Self;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for NoForwardingServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USER && password == PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_forward_is_reported_as_an_ssh_problem() {
    let _guard = trust_store_guard();
    let dir = tempfile::tempdir().unwrap();

    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        nodelay: true,
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_task = tokio::spawn(async move {
        let mut server = NoForwardingServer;
        let _ = server.run_on_socket(config, &listener).await;
    });
    trust(&dir, port, &public);

    let tunnel = Tunnel::open(&ssh_config(port, PASSWORD), "db.internal", 5432)
        .await
        .expect("the tunnel itself opens — only forwarding is refused");

    // Drive one connection through it, exactly as a driver would.
    let mut client = TcpStream::connect(("127.0.0.1", tunnel.local_port()))
        .await
        .unwrap();
    let _ = client.write_all(b"hello").await;
    let mut sink = Vec::new();
    let _ = client.read_to_end(&mut sink).await;

    // The forwarder records the reason before the loopback socket drops, so by the time
    // the driver's own error surfaces the annotation is available.
    let mut reason = None;
    for _ in 0..100 {
        reason = tunnel.take_forward_error();
        if reason.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let reason = reason.expect("a refused forward must be recorded");
    assert!(reason.contains("db.internal:5432"), "{reason}");
    assert!(reason.contains("AllowTcpForwarding"), "{reason}");

    // …and it is taken, not cloned, so a later unrelated failure is not misattributed.
    assert!(tunnel.take_forward_error().is_none());

    let annotated =
        crate::ssh::explain_db_failure(Some(&tunnel), crate::db::AppError::new("connection reset"));
    assert_eq!(
        annotated.message, "connection reset",
        "nothing left to blame"
    );

    server_task.abort();
}
