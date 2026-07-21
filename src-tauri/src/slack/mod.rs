//! Slack integration (v0.7.0): a Socket Mode bot hosted INSIDE the desktop app —
//! outbound WebSocket + Web API only, no server, no public endpoint. Natural-language
//! question → AI-proposed SQL → human Approve/Reject buttons → capped read-only
//! execution on the active connection → inline table / file / chart reply.
//! See docs/v0.7.0-ai-slack-integration.md for the full spec.

pub mod api;
pub mod approval;
pub mod blocks;
pub mod chart;
pub mod config;
pub mod context;
pub mod format;
pub mod processor;
pub mod socket;

use crate::db::AppError;
use approval::{ApprovalStore, ResultStore};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

/// Managed Tauri state for the bot's runtime (status, shutdown token, proposals).
#[derive(Default)]
pub struct SlackRuntime {
    status: Mutex<StatusInfo>,
    cancel: Mutex<Option<CancellationToken>>,
    /// Session generation: bumped on every `start()`. A consumer task only runs its
    /// teardown (clear stores + mark disconnected) if it's STILL the current generation,
    /// so an old session finishing an in-flight query after a restart can't wipe the new
    /// session's proposals/results or stomp its status.
    generation: AtomicU64,
    pub approvals: ApprovalStore,
    /// Finished results kept for their "Export as…" buttons (TTL'd + capped).
    pub results: ResultStore,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub running: bool,
    /// "disconnected" | "connecting" | "connected"
    pub state: String,
    pub error: Option<String>,
}

impl Default for StatusInfo {
    fn default() -> Self {
        Self { running: false, state: "disconnected".into(), error: None }
    }
}

impl SlackRuntime {
    pub fn set_status(&self, state: &str, error: Option<String>) {
        let mut s = crate::lock_sync(&self.status);
        s.state = state.to_string();
        s.error = error;
        s.running = state != "disconnected";
    }

    pub fn status_info(&self) -> StatusInfo {
        crate::lock_sync(&self.status).clone()
    }

    fn take_cancel(&self) -> Option<CancellationToken> {
        crate::lock_sync(&self.cancel).take()
    }

    fn set_cancel(&self, t: CancellationToken) {
        if let Some(old) = crate::lock_sync(&self.cancel).replace(t) {
            old.cancel();
        }
    }

    /// Begin a new session generation; returns its id.
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// Start the bot: validate tokens, spawn the socket loop + event consumer.
/// Idempotent — a running bot is stopped first.
pub async fn start(app: AppHandle) -> Result<(), AppError> {
    stop(&app); // drop any previous session

    // Config is (re)loaded per-event by the consumer, not captured here.
    let bot_token = config::bot_token()
        .ok_or_else(|| AppError::new("no Slack bot token saved — add it in Settings → Slack"))?;
    let app_token = config::app_token()
        .ok_or_else(|| AppError::new("no Slack app-level token saved — add it in Settings → Slack"))?;

    let api = api::SlackApi::new(bot_token);
    // Validates the bot token AND captures the bot's user id for self-loop filtering.
    let (_team, bot_user_id) = api.auth_test().await?;

    let runtime = app.state::<SlackRuntime>();
    let cancel = CancellationToken::new();
    runtime.set_cancel(cancel.clone());
    let my_gen = runtime.next_generation();
    // A prior session may still be tearing down its own stores — clear here, under the
    // new generation, so the new session starts clean regardless of teardown ordering.
    runtime.approvals.clear();
    runtime.results.clear();
    runtime.set_status("connecting", None);
    let _ = app.emit("slack:status", runtime.status_info());

    let (tx, mut rx) = tokio::sync::mpsc::channel::<socket::SlackEvent>(64);
    tauri::async_runtime::spawn(socket::run_socket_mode(app_token, bot_user_id, tx, cancel.clone()));

    // Consumer: sequential event handling ("one query at a time") + a 60s sweep that
    // expires stale proposals and updates their cards.
    let consumer_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut sweep = tokio::time::interval(std::time::Duration::from_secs(60));
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = sweep.tick() => {
                    let runtime = consumer_app.state::<SlackRuntime>();
                    for p in runtime.approvals.expire() {
                        let _ = api
                            .update_message(
                                &p.channel,
                                &p.message_ts,
                                "Proposal expired",
                                blocks::resolved_proposal_card(&p.explanation, &p.sql, "⏰ Expired — ask again."),
                            )
                            .await;
                    }
                }
                ev = rx.recv() => {
                    match ev {
                        // Reload config PER EVENT so allowlist / timeout / row-cap /
                        // destructive-policy / AI-provider changes take effect on Save
                        // without a bot restart. Parse/validation failure is fail-closed:
                        // never replace allowlists with permissive defaults.
                        Some(ev) => {
                            match config::load(&consumer_app) {
                                Ok(cfg) => {
                                    // Panic-contained: an unwind out of handle_event would
                                    // kill this consumer task silently — the status badge
                                    // would keep saying "connected" while the bot never
                                    // answers again. Contain it, report it, keep consuming.
                                    let fut = std::panic::AssertUnwindSafe(
                                        processor::handle_event(&consumer_app, &api, &cfg, ev),
                                    );
                                    if futures_util::FutureExt::catch_unwind(fut).await.is_err() {
                                        let runtime = consumer_app.state::<SlackRuntime>();
                                        runtime.set_status(
                                            "error",
                                            Some("internal error handling a Slack event (recovered — see last-crash.txt)".to_string()),
                                        );
                                        let _ = consumer_app.emit("slack:status", runtime.status_info());
                                    }
                                }
                                Err(e) => {
                                    let runtime = consumer_app.state::<SlackRuntime>();
                                    runtime.set_status("error", Some(e.message));
                                    let _ = consumer_app.emit("slack:status", runtime.status_info());
                                }
                            }
                        }
                        None => break, // socket task ended
                    }
                }
            }
        }
        // Only tear down if we're still the current session — a newer start() supersedes us.
        let runtime = consumer_app.state::<SlackRuntime>();
        if runtime.current_generation() == my_gen {
            runtime.approvals.clear();
            runtime.results.clear();
            runtime.set_status("disconnected", None);
            let _ = consumer_app.emit("slack:status", runtime.status_info());
        }
    });

    Ok(())
}

/// Stop the bot (cancels the socket + consumer tasks). Safe when not running.
pub fn stop(app: &AppHandle) {
    let runtime = app.state::<SlackRuntime>();
    if let Some(t) = runtime.take_cancel() {
        t.cancel();
    }
}
