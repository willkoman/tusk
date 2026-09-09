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
    /// The ONE Tusk connection this bot answers against. Several connections are open
    /// at once, so "the active connection" is not a stable answer: the binding is
    /// chosen when the bot starts (default: whatever the workbench had focused) and
    /// can be repointed from Settings → Slack. It lives here, under the SAME mutex as
    /// `running`, so the two can never be observed or written out of step.
    pub connection_id: Option<String>,
}

impl Default for StatusInfo {
    fn default() -> Self {
        Self {
            running: false,
            state: "disconnected".into(),
            error: None,
            connection_id: None,
        }
    }
}

impl SlackRuntime {
    pub fn set_status(&self, state: &str, error: Option<String>) {
        let running = state != "disconnected";
        let mut s = crate::lock_sync(&self.status);
        s.state = state.to_string();
        s.error = error;
        s.running = running;
        // A stopped bot is bound to nothing, and it is cleared under the same lock
        // that publishes `running:false` — otherwise a concurrent bind could leave a
        // stopped bot holding a binding, which would make `on_connection_closed`
        // claim a dead bot and stop the workbench ever rebinding a fresh one.
        if !running {
            s.connection_id = None;
        }
    }

    pub fn status_info(&self) -> StatusInfo {
        crate::lock_sync(&self.status).clone()
    }

    /// The connection id this bot is bound to, when it is running.
    pub fn bound_connection(&self) -> Option<String> {
        crate::lock_sync(&self.status).connection_id.clone()
    }

    fn set_connection(&self, id: Option<String>) {
        crate::lock_sync(&self.status).connection_id = id;
    }

    /// Bind a RUNNING bot to `id`, atomically. Returns false when the bot stopped
    /// between the caller's check and this write.
    fn bind_if_running(&self, id: String) -> bool {
        let mut s = crate::lock_sync(&self.status);
        if !s.running {
            return false;
        }
        s.connection_id = Some(id);
        true
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
    pub(crate) fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub(crate) fn session_active(&self, generation: u64, cancel: &CancellationToken) -> bool {
        !cancel.is_cancelled() && self.current_generation() == generation
    }
    pub(crate) fn set_status_for(
        &self,
        generation: u64,
        cancel: &CancellationToken,
        state: &str,
        error: Option<String>,
    ) -> bool {
        if !self.session_active(generation, cancel) {
            return false;
        }
        self.set_status(state, error);
        true
    }
}

/// Check that an explicitly requested connection is really open.
fn require_open(app: &AppHandle, id: &str) -> Result<String, AppError> {
    app.state::<crate::AppState>()
        .get(id)
        .map(|_| id.to_string())
        .map_err(|_| {
            AppError::new(
                "the connection chosen for the Slack bot is no longer open — pick another in Settings → Slack",
            )
        })
}

/// Repoint a running bot at another open connection. Takes effect on the next
/// question; proposals already pending stay pinned to the connection that made them
/// and fail closed on approval, which is the intended conservative outcome.
pub fn bind_connection(app: &AppHandle, connection_id: &str) -> Result<(), AppError> {
    let runtime = app.state::<SlackRuntime>();
    // Validate the target BEFORE taking the status lock, then commit the binding and
    // the running check together, so a stop racing this cannot leave a stopped bot
    // bound to something.
    let id = require_open(app, connection_id)?;
    if !runtime.bind_if_running(id) {
        return Err(AppError::new("the Slack bot is not running"));
    }
    let _ = app.emit("slack:status", runtime.status_info());
    Ok(())
}

/// Stop a bot whose bound connection just went away, and say why. Called from
/// `disconnect`; a no-op for every other connection, so closing one session never
/// disturbs a bot bound to a different one.
pub fn on_connection_closed(app: &AppHandle, connection_id: &str) {
    let runtime = app.state::<SlackRuntime>();
    if runtime.bound_connection().as_deref() != Some(connection_id) {
        return;
    }
    // Tear down without publishing, then publish ONE status carrying the reason: two
    // events (an empty "disconnected" followed by the real one) let a listener that
    // coalesces show the blank one and hide why the bot stopped.
    teardown(app);
    // Disarm autostart too. Left `enabled: true` on disk, the bot came back on the next
    // launch bound to whichever connection opened first — a different database than the
    // one it was answering against, chosen by nobody. Re-enable it (and pick a target)
    // in Settings → Slack. Best-effort: a config write failure must not swallow the
    // status the workbench needs to show.
    let disarmed = config::load(app)
        .ok()
        .filter(|cfg| cfg.enabled)
        .is_some_and(|mut cfg| {
            config::disarm_autostart(&mut cfg);
            config::save(app, &cfg).is_ok()
        });
    let reason = if disarmed {
        "Slack bot stopped: the Tusk connection it was answering against was disconnected. Autostart is now off — re-enable it and pick a connection in Settings → Slack."
    } else {
        "Slack bot stopped: the Tusk connection it was answering against was disconnected."
    };
    runtime.set_status("disconnected", Some(reason.to_string()));
    let _ = app.emit("slack:status", runtime.status_info());
}

/// Start the bot: validate tokens, spawn the socket loop + event consumer.
/// Idempotent — a running bot is stopped first. `connection_id` pins the ONE Tusk
/// connection it answers against (None = whichever the workbench has focused).
pub async fn start(app: AppHandle, connection_id: Option<String>) -> Result<(), AppError> {
    stop(&app); // drop any previous session

    let runtime = app.state::<SlackRuntime>();
    // Resolve the binding BEFORE any status is published: an explicit pick that is not
    // open is a hard error, while "no pick and nothing connected yet" is the ordinary
    // autostart case — the bot starts UNBOUND and the workbench binds it as soon as it
    // opens a connection. Questions asked before that are refused with a clear reason
    // rather than silently answered from whichever session happens to exist.
    let bound = match connection_id {
        Some(requested) => match require_open(&app, &requested) {
            Ok(id) => Some(id),
            Err(e) => {
                runtime.set_status("disconnected", Some(e.message.clone()));
                let _ = app.emit("slack:status", runtime.status_info());
                return Err(e);
            }
        },
        None => app
            .state::<crate::AppState>()
            .active()
            .ok()
            .map(|(id, _)| id),
    };
    let cancel = CancellationToken::new();
    let my_gen = runtime.next_generation();
    runtime.set_connection(bound);
    runtime.set_cancel(cancel.clone());
    runtime.approvals.clear();
    runtime.results.clear();
    runtime.set_status("connecting", None);
    let _ = app.emit("slack:status", runtime.status_info());

    // Config is (re)loaded per-event by the consumer, not captured here.
    let tokens = config::bot_token()
        .ok_or_else(|| AppError::new("no Slack bot token saved — add it in Settings → Slack"))
        .and_then(|bot| {
            config::app_token()
                .map(|app_token| (bot, app_token))
                .ok_or_else(|| {
                    AppError::new("no Slack app-level token saved — add it in Settings → Slack")
                })
        });
    let (bot_token, app_token) = match tokens {
        Ok(tokens) => tokens,
        Err(e) => {
            if runtime.set_status_for(my_gen, &cancel, "disconnected", Some(e.message.clone())) {
                let _ = app.emit("slack:status", runtime.status_info());
            }
            return Err(e);
        }
    };

    let api = api::SlackApi::new(bot_token);
    // Validates the bot token AND captures the bot's user id for self-loop filtering.
    let auth = tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::new("Slack start was superseded")),
        result = api.auth_test() => result,
    };
    let (_team, bot_user_id) = match auth {
        Ok(value) if runtime.session_active(my_gen, &cancel) => value,
        Ok(_) => return Err(AppError::new("Slack start was superseded")),
        Err(e) => {
            if runtime.set_status_for(my_gen, &cancel, "disconnected", Some(e.message.clone())) {
                let _ = app.emit("slack:status", runtime.status_info());
            }
            return Err(e);
        }
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<socket::SlackEvent>(64);
    tauri::async_runtime::spawn(socket::run_socket_mode(
        app_token,
        bot_user_id,
        tx,
        cancel.clone(),
    ));

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
                        let update = api.update_message(
                                &p.channel,
                                &p.message_ts,
                                "Proposal expired",
                                blocks::resolved_proposal_card(&p.explanation, &p.sql, "⏰ Expired — ask again."),
                            );
                        tokio::select! {
                            _ = cancel.cancelled() => break,
                            _ = update => {}
                        }
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
                                        processor::handle_event(
                                            &consumer_app,
                                            &api,
                                            &cfg,
                                            ev,
                                            my_gen,
                                            &cancel,
                                        ),
                                    );
                                    let handled = tokio::select! {
                                        _ = cancel.cancelled() => break,
                                        result = futures_util::FutureExt::catch_unwind(fut) => result,
                                    };
                                    if handled.is_err() {
                                        let runtime = consumer_app.state::<SlackRuntime>();
                                        if runtime.set_status_for(
                                            my_gen,
                                            &cancel,
                                            "error",
                                            Some("internal error handling a Slack event (recovered — see last-crash.txt)".to_string()),
                                        ) {
                                            let _ = consumer_app.emit("slack:status", runtime.status_info());
                                        }
                                    }
                                }
                                Err(e) => {
                                    let runtime = consumer_app.state::<SlackRuntime>();
                                    if runtime.set_status_for(my_gen, &cancel, "error", Some(e.message)) {
                                        let _ = consumer_app.emit("slack:status", runtime.status_info());
                                    }
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

/// Tear the session down without publishing a status, so a caller that wants to
/// report WHY the bot stopped emits exactly one event.
fn teardown(app: &AppHandle) {
    let runtime = app.state::<SlackRuntime>();
    runtime.next_generation();
    if let Some(t) = runtime.take_cancel() {
        t.cancel();
    }
    runtime.approvals.clear();
    runtime.results.clear();
    runtime.set_status("disconnected", None);
}

/// Stop the bot (cancels the socket + consumer tasks). Safe when not running.
pub fn stop(app: &AppHandle) {
    teardown(app);
    let _ = app.emit("slack:status", app.state::<SlackRuntime>().status_info());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations_invalidate_old_sessions() {
        let runtime = SlackRuntime::default();
        let cancel = CancellationToken::new();
        let first = runtime.next_generation();
        assert!(runtime.session_active(first, &cancel));
        runtime.next_generation();
        assert!(!runtime.session_active(first, &cancel));

        let current = runtime.current_generation();
        cancel.cancel();
        assert!(!runtime.session_active(current, &cancel));
    }
}
