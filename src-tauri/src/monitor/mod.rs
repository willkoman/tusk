//! Live database monitor (docs/db-monitor-plan.md), PostgreSQL first.
//!
//! The monitor never touches the user's session: there is one result cursor per
//! connection, every metadata read rolls it back, and a manual transaction freezes
//! it. Instead it clones the connection's config from the registry's lock-free
//! snapshot (`RegisteredConn::config`, so starting a monitor never waits behind a
//! running query), opens its own engine-read-only sidecar session (with its own SSH
//! tunnel and TLS through the usual driver path), and runs Tusk's fixed SQL from one
//! tokio task per monitored connection:
//!
//! - the fast tier every tick (ONE statement, one row),
//! - the activity tier (the bounded process list) every two seconds while a view
//!   that shows it is open,
//! - the view tiers (`views.rs`: locks, replication, progress, maintenance, I/O,
//!   statements), each on its own cadence and only while its view is open.
//!
//! Rates are computed here, so the frontend receives one `monitor-sample` event per
//! tick and only draws. `MissedTickBehavior::Skip` drops a slow tick instead of
//! queueing a burst; a dropped session reconnects with 1 s → 30 s backoff and never
//! retries a statement (the next tick is the retry). Pausing stops the queries, not
//! just the drawing. Cancel/Terminate are the only state-changing statements; they
//! run on the sidecar, are refused for read-only connections and for the monitor's
//! own pid, and re-identify their target by backend start before signalling.

mod pg;
mod rates;
mod views;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::db::{AppError, ConnectionConfig};
use crate::{lock_sync, AppState};
#[cfg(test)]
pub(crate) use pg::ActivityRow;
pub(crate) use pg::SignalAction;
use pg::{Activity, PgSession, Probe, Sessions};
use rates::{Ingest, RateTracker, Rates};
pub(crate) use views::ViewSet;
use views::{
    Io, IoTracker, Locks, Maintenance, Progress, Replication, StatementTracker, Statements, Tier,
};

pub(crate) const EVENT: &str = "monitor-sample";
const MIN_INTERVAL_MS: u64 = 250;
const MAX_INTERVAL_MS: u64 = 60_000;
const DEFAULT_INTERVAL_MS: u64 = 1_000;
/// The process list is refreshed at most this often (and at most once per tick).
const ACTIVITY_EVERY: Duration = Duration::from_secs(2);
const RECONNECT_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// What a sampler is told to do. Sent whole on every change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settings {
    pub interval: Duration,
    /// No queries at all while paused (the session stays open for a quick resume).
    pub paused: bool,
    /// Run the activity tier (a view showing the process list is open).
    pub activity: bool,
    /// Which view tiers run.
    pub views: ViewSet,
}

/// Settings as the frontend sends them.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorOptions {
    pub interval_ms: Option<u64>,
    pub paused: Option<bool>,
    pub activity: Option<bool>,
    pub views: Option<ViewSet>,
}

impl MonitorOptions {
    pub(crate) fn settings(self) -> Settings {
        Settings {
            interval: Duration::from_millis(
                self.interval_ms
                    .unwrap_or(DEFAULT_INTERVAL_MS)
                    .clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS),
            ),
            paused: self.paused.unwrap_or(false),
            activity: self.activity.unwrap_or(true),
            views: self.views.unwrap_or_default(),
        }
    }
}

enum Command {
    Configure(Settings),
    Signal {
        pid: i32,
        backend_start: String,
        action: SignalAction,
        reply: oneshot::Sender<Result<bool, AppError>>,
    },
}

/// Where samples go: a Tauri event in the app, a channel in the conformance suite.
pub(crate) type Sink = Arc<dyn Fn(&MonitorEvent) + Send + Sync>;

/// A running sampler. Dropping the sender ends the loop; `stop` also aborts the task
/// so a tick stuck in the network is not waited for. Either way the sidecar session
/// and its tunnel drop with the task.
pub(crate) struct MonitorHandle {
    generation: u64,
    commands: mpsc::Sender<Command>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl MonitorHandle {
    pub(crate) fn configure(&self, settings: Settings) -> Result<(), AppError> {
        self.commands
            .try_send(Command::Configure(settings))
            .map_err(|_| AppError::new("the monitor is busy or has stopped; reopen it"))
    }

    pub(crate) fn stop(self) {
        self.task.abort();
    }
}

async fn send_signal(
    commands: mpsc::Sender<Command>,
    pid: i32,
    backend_start: String,
    action: SignalAction,
) -> Result<bool, AppError> {
    let (reply, answer) = oneshot::channel();
    commands
        .send(Command::Signal {
            pid,
            backend_start,
            action,
            reply,
        })
        .await
        .map_err(|_| AppError::new("the monitor has stopped; reopen it"))?;
    answer
        .await
        .map_err(|_| AppError::new("the monitor stopped before the server answered"))?
}

/// Why a cancel/terminate must not be sent, or `None`. Read-only means Tusk changes
/// nothing on the server (plan decision 2); the monitor's own pid would only kill
/// the monitor.
pub(crate) fn signal_refusal(user_read_only: bool, own_pid: i32, pid: i32) -> Option<&'static str> {
    if user_read_only {
        return Some(
            "this connection is read-only: Tusk does not cancel or terminate sessions on it",
        );
    }
    if pid == own_pid {
        return Some("that is the monitor's own session");
    }
    if pid <= 0 {
        return Some("not a backend pid");
    }
    None
}

/// One sidecar per monitored connection. Lives in `AppState`.
#[derive(Default)]
pub(crate) struct Monitors {
    running: Mutex<HashMap<String, MonitorHandle>>,
    next_generation: AtomicU64,
}

impl Monitors {
    fn next_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Stop the monitor for `connection_id` (only if it is `generation`, when given).
    /// Idempotent.
    pub(crate) fn stop(&self, connection_id: &str, generation: Option<u64>) {
        let mut running = lock_sync(&self.running);
        let matches = running
            .get(connection_id)
            .is_some_and(|r| generation.is_none_or(|g| g == r.generation));
        if matches {
            if let Some(r) = running.remove(connection_id) {
                r.stop();
            }
        }
    }

    /// Stop every sampler. The frontend calls this on mount: a webview reload leaves
    /// the old page's monitors registered and sampling (spike finding 4).
    pub(crate) fn stop_all(&self) -> usize {
        let drained: Vec<MonitorHandle> =
            lock_sync(&self.running).drain().map(|(_, h)| h).collect();
        let n = drained.len();
        for h in drained {
            h.stop();
        }
        n
    }

    fn install(&self, connection_id: &str, handle: MonitorHandle) {
        let previous = lock_sync(&self.running).insert(connection_id.to_string(), handle);
        if let Some(previous) = previous {
            previous.stop();
        }
    }

    fn with<R>(
        &self,
        connection_id: &str,
        generation: u64,
        f: impl FnOnce(&MonitorHandle) -> R,
    ) -> Result<R, AppError> {
        let running = lock_sync(&self.running);
        match running.get(connection_id) {
            Some(h) if h.generation == generation => Ok(f(h)),
            _ => Err(AppError::new("this monitor has stopped; reopen it")),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock_sync(&self.running).len()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorStarted {
    pub generation: u64,
    pub interval_ms: u64,
    /// The USER's connection is read-only: Cancel/Terminate are refused.
    pub read_only: bool,
    pub server: Probe,
    pub wait_types: [&'static str; 11],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorEvent {
    pub connection_id: String,
    pub generation: u64,
    pub seq: u64,
    /// Milliseconds since the monitor started, on a monotonic clock, when the reading
    /// came back — the frontend spaces points by this, never by IPC arrival.
    pub mono_ms: f64,
    pub server_ms: Option<i64>,
    /// Round trip of the fast-tier statement as seen from the app.
    pub latency_ms: f64,
    /// The interval the sampler is running at, so a gap is judged against the
    /// cadence that produced it.
    pub interval_ms: u64,
    /// "live" | "error" | "reconnecting".
    pub status: &'static str,
    pub error: Option<String>,
    /// The counters were discontinuous (stats reset, restart, failover) and this
    /// reading is a new baseline.
    pub reset: bool,
    pub rates: Option<Rates>,
    pub sessions: Option<Sessions>,
    /// Active sessions per wait type, in `wait_types` order.
    pub load: Option<[u32; 11]>,
    pub oldest_xact_ms: Option<i64>,
    pub blocked: Option<u32>,
    pub replication_lag_ms: Option<i64>,
    pub activity: Option<Activity>,
    pub activity_error: Option<String>,
    pub locks: Option<Locks>,
    pub replication: Option<Replication>,
    pub progress: Option<Vec<Progress>>,
    pub maintenance: Option<Maintenance>,
    pub io: Option<Io>,
    pub statements: Option<Statements>,
    /// A view tier that failed this tick, by tier name, with the server's reason.
    pub view_errors: Option<BTreeMap<&'static str, String>>,
}

impl MonitorEvent {
    fn new(connection_id: &str, generation: u64, seq: u64, interval: Duration) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            generation,
            seq,
            mono_ms: 0.0,
            server_ms: None,
            latency_ms: 0.0,
            interval_ms: interval.as_millis() as u64,
            status: "live",
            error: None,
            reset: false,
            rates: None,
            sessions: None,
            load: None,
            oldest_xact_ms: None,
            blocked: None,
            replication_lag_ms: None,
            activity: None,
            activity_error: None,
            locks: None,
            replication: None,
            progress: None,
            maintenance: None,
            io: None,
            statements: None,
            view_errors: None,
        }
    }

    fn view_error(&mut self, tier: Tier, message: String) {
        self.view_errors
            .get_or_insert_with(BTreeMap::new)
            .insert(tier.name(), message);
    }
}

/// Open a sidecar on a read-only clone of `config`. Network PostgreSQL only.
pub(crate) async fn open_sidecar(config: &ConnectionConfig) -> Result<PgSession, AppError> {
    if config.driver.as_deref().unwrap_or("postgres") != "postgres" {
        return Err(AppError::new(
            "the database monitor is PostgreSQL-only for now",
        ));
    }
    let mut sidecar = config.clone();
    sidecar.read_only = true;
    PgSession::open(&sidecar).await
}

/// Spawn the sampler for an open sidecar.
pub(crate) fn spawn(
    session: PgSession,
    connection_id: String,
    generation: u64,
    settings: Settings,
    sink: Sink,
) -> MonitorHandle {
    let (commands, inbox) = mpsc::channel(16);
    let sampler = Sampler {
        session,
        connection_id,
        generation,
        settings,
        sink,
        started: Instant::now(),
        tracker: RateTracker::default(),
        seq: 0,
        backoff: RECONNECT_BACKOFF_MIN,
        retry_at: None,
        last_activity: None,
        last_tier: HashMap::new(),
        io: IoTracker::default(),
        statements: StatementTracker::default(),
    };
    let task = tauri::async_runtime::spawn(sampler.run(inbox));
    MonitorHandle {
        generation,
        commands,
        task,
    }
}

struct Sampler {
    session: PgSession,
    connection_id: String,
    generation: u64,
    settings: Settings,
    sink: Sink,
    started: Instant,
    tracker: RateTracker,
    seq: u64,
    backoff: Duration,
    retry_at: Option<Instant>,
    last_activity: Option<Instant>,
    last_tier: HashMap<Tier, Instant>,
    io: IoTracker,
    statements: StatementTracker,
}

fn ticker(interval: Duration) -> tokio::time::Interval {
    let mut t = tokio::time::interval(interval);
    // A slow tick is skipped, never queued: a burst of catch-up samples would be
    // useless and would hit the server back to back.
    t.set_missed_tick_behavior(MissedTickBehavior::Skip);
    t
}

impl Sampler {
    async fn run(mut self, mut inbox: mpsc::Receiver<Command>) {
        let mut tick = ticker(self.settings.interval);
        loop {
            tokio::select! {
                command = inbox.recv() => match command {
                    None => break,
                    Some(Command::Configure(next)) => {
                        let resumed = self.settings.paused && !next.paused;
                        let retimed = next.interval != self.settings.interval;
                        let activity_on = next.activity && !self.settings.activity;
                        let before = self.settings.views;
                        self.settings = next;
                        for tier in Tier::ALL {
                            let (was, is) = (tier.enabled(before), tier.enabled(next.views));
                            if is && !was {
                                // A view just opened: fetch its tier on the next tick.
                                self.last_tier.remove(&tier);
                            }
                            if was && !is {
                                self.forget_tier(tier);
                            }
                        }
                        if resumed {
                            // Nothing was sampled while paused: diffing across the pause
                            // would show its average as one point.
                            self.tracker.clear();
                            self.forget_views();
                        }
                        if resumed || activity_on {
                            self.last_activity = None;
                        }
                        if resumed || retimed {
                            tick = ticker(self.settings.interval);
                        }
                    }
                    Some(Command::Signal { pid, backend_start, action, reply }) => {
                        let result = self.signal(pid, &backend_start, action).await;
                        // The list should show the outcome on the next tick, not in 2 s.
                        self.last_activity = None;
                        let _ = reply.send(result);
                    }
                },
                _ = tick.tick(), if !self.settings.paused => {
                    if let Some(event) = self.tick().await {
                        (self.sink)(&event);
                    }
                }
            }
        }
    }

    async fn signal(
        &mut self,
        pid: i32,
        backend_start: &str,
        action: SignalAction,
    ) -> Result<bool, AppError> {
        if let Some(reason) = signal_refusal(false, self.session.probe.pid, pid) {
            return Err(AppError::new(reason));
        }
        if self.session.is_closed() {
            return Err(AppError::new(
                "the monitor session is reconnecting; try again in a moment",
            ));
        }
        self.session.signal(pid, backend_start, action).await
    }

    /// A tier's baseline no longer describes the server's recent past.
    fn forget_tier(&mut self, tier: Tier) {
        self.last_tier.remove(&tier);
        match tier {
            Tier::Io => self.io.clear(),
            Tier::Statements => self.statements.clear(),
            _ => {}
        }
    }

    fn forget_views(&mut self) {
        for tier in Tier::ALL {
            self.forget_tier(tier);
        }
    }

    fn tier_due(&self, tier: Tier, now: Instant) -> bool {
        if !tier.enabled(self.settings.views) || !self.tier_supported(tier) {
            return false;
        }
        let every = tier.every().max(self.settings.interval);
        let slack = Duration::from_millis(100);
        self.last_tier
            .get(&tier)
            .is_none_or(|last| now.duration_since(*last) + slack >= every)
    }

    /// A tier the server cannot answer is never queried; the frontend explains why
    /// from the probe (version, extension).
    fn tier_supported(&self, tier: Tier) -> bool {
        let probe = &self.session.probe;
        match tier {
            Tier::Io => probe.version_num >= views::IO_VERSION_NUM,
            Tier::Statements => probe.statements_available,
            _ => true,
        }
    }

    /// Run every view tier that is due, filling `event`. A failing tier is reported
    /// by name and never fails the tick.
    async fn view_tiers(&mut self, event: &mut MonitorEvent, now: Instant) {
        for tier in Tier::ALL {
            if !self.tier_due(tier, now) {
                continue;
            }
            self.last_tier.insert(tier, now);
            let at = now.duration_since(self.started);
            let outcome = match tier {
                Tier::Locks => self.session.locks().await.map(|v| event.locks = Some(v)),
                Tier::Replication => self
                    .session
                    .replication()
                    .await
                    .map(|v| event.replication = Some(v)),
                Tier::Progress => self
                    .session
                    .progress()
                    .await
                    .map(|v| event.progress = Some(v)),
                Tier::Maintenance => self
                    .session
                    .maintenance()
                    .await
                    .map(|v| event.maintenance = Some(v)),
                Tier::Io => match self.session.io_rows().await {
                    Ok((c, rows)) => self.io.ingest(&c, &rows, at).map(|v| event.io = v),
                    Err(e) => Err(e),
                },
                Tier::Statements => self.statement_tier(event, at).await,
            };
            if let Err(e) = outcome {
                event.view_error(tier, e.message);
            }
        }
    }

    async fn statement_tier(
        &mut self,
        event: &mut MonitorEvent,
        at: Duration,
    ) -> Result<(), AppError> {
        let (c, rows) = self.session.statement_rows().await?;
        let Some((mut stmts, missing)) = self.statements.ingest(&c, &rows, at)? else {
            return Ok(());
        };
        if !missing.is_empty() {
            // Texts are a nicety: a failure here still shows the numbers.
            if let Ok((tc, tr)) = self.session.statement_texts(&missing).await {
                self.statements.fill_texts(&tc, &tr, &mut stmts);
            }
        }
        event.statements = Some(stmts);
        Ok(())
    }

    fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    /// One tick. `None` only when there is nothing worth sending.
    async fn tick(&mut self) -> Option<MonitorEvent> {
        self.seq += 1;
        let mut event = MonitorEvent::new(
            &self.connection_id,
            self.generation,
            self.seq,
            self.settings.interval,
        );
        if self.session.is_closed() {
            if self.retry_at.is_some_and(|at| Instant::now() < at) {
                event.status = "reconnecting";
                event.mono_ms = self.elapsed_ms();
                return Some(event);
            }
            if let Err(e) = self.session.reopen().await {
                self.retry_at = Some(Instant::now() + self.backoff);
                self.backoff = (self.backoff * 2).min(RECONNECT_BACKOFF_MAX);
                event.status = "reconnecting";
                event.error = Some(e.message);
                event.mono_ms = self.elapsed_ms();
                return Some(event);
            }
            // The new session has no history with us.
            self.tracker.clear();
            self.forget_views();
            self.retry_at = None;
            self.backoff = RECONNECT_BACKOFF_MIN;
            self.last_activity = None;
        }
        let sent = Instant::now();
        let result = self.session.sample().await;
        let done = Instant::now();
        event.latency_ms = done.duration_since(sent).as_secs_f64() * 1000.0;
        let at = done.duration_since(self.started);
        event.mono_ms = at.as_secs_f64() * 1000.0;
        match result {
            Ok(sample) => {
                match self.tracker.ingest(sample.counters, at) {
                    Ingest::Baseline => {}
                    Ingest::Reset => event.reset = true,
                    Ingest::Rates(r) => event.rates = Some(r),
                }
                event.server_ms = sample.server_ms;
                event.sessions = Some(sample.sessions);
                event.load = Some(sample.load);
                event.oldest_xact_ms = sample.oldest_xact_ms;
                event.blocked = Some(sample.blocked);
                event.replication_lag_ms = sample.replication_lag_ms;
            }
            Err(e) => {
                event.status = "error";
                event.error = Some(e.message);
                return Some(event);
            }
        }
        if self.activity_due(done) {
            self.last_activity = Some(done);
            match self.session.activity().await {
                Ok(activity) => event.activity = Some(activity),
                Err(e) => event.activity_error = Some(e.message),
            }
        }
        self.view_tiers(&mut event, done).await;
        Some(event)
    }

    fn activity_due(&self, now: Instant) -> bool {
        if !self.settings.activity {
            return false;
        }
        let every = ACTIVITY_EVERY.max(self.settings.interval);
        // A tick lands a few ms either side of its slot; don't let that skip a turn.
        let slack = Duration::from_millis(100);
        self.last_activity
            .is_none_or(|last| now.duration_since(last) + slack >= every)
    }
}

fn app_sink(app: AppHandle) -> Sink {
    Arc::new(move |event: &MonitorEvent| {
        let _ = app.emit(EVENT, event);
    })
}

/// Start (or restart) the monitor for one connection. Reads the registry's config
/// snapshot, so it never waits behind a query running on the user's session.
pub(crate) async fn start(
    state: &AppState,
    connection_id: &str,
    options: MonitorOptions,
    sink: Sink,
) -> Result<MonitorStarted, AppError> {
    let settings = options.settings();
    let config = state.config_snapshot(connection_id)?;
    let read_only = config.read_only;
    let session = open_sidecar(&config).await?;
    let server = session.probe.clone();
    let generation = state.monitors.next_generation();
    // Spawn and install while the connection is still registered: a disconnect racing
    // this start either removed it first (refused here, and the sidecar drops with the
    // closure) or removes it after, and then its `monitors.stop` finds this task.
    state.while_registered(connection_id, || {
        let handle = spawn(
            session,
            connection_id.to_string(),
            generation,
            settings,
            sink,
        );
        state.monitors.install(connection_id, handle);
    })?;
    Ok(MonitorStarted {
        generation,
        interval_ms: settings.interval.as_millis() as u64,
        read_only,
        server,
        wait_types: pg::WAIT_TYPES,
    })
}

/// Change cadence, pause or resume, and switch the activity tier.
pub(crate) fn configure(
    state: &AppState,
    connection_id: &str,
    generation: u64,
    options: MonitorOptions,
) -> Result<(), AppError> {
    let settings = options.settings();
    state
        .monitors
        .with(connection_id, generation, |h| h.configure(settings))?
}

/// Cancel the running query of, or terminate, one backend, on the sidecar.
pub(crate) async fn signal(
    state: &AppState,
    connection_id: &str,
    generation: u64,
    pid: i32,
    backend_start: String,
    action: SignalAction,
) -> Result<bool, AppError> {
    let config = state.config_snapshot(connection_id)?;
    // The own-pid half of the refusal is checked by the sampler, which knows it.
    if let Some(reason) = signal_refusal(config.read_only, 0, pid) {
        return Err(AppError::new(reason));
    }
    if backend_start.is_empty() || backend_start.len() > 64 {
        return Err(AppError::new("that session cannot be identified"));
    }
    let commands = state
        .monitors
        .with(connection_id, generation, |h| h.commands.clone())?;
    send_signal(commands, pid, backend_start, action).await
}

#[tauri::command]
pub(crate) async fn monitor_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    connection_id: String,
    options: Option<MonitorOptions>,
) -> Result<MonitorStarted, AppError> {
    start(
        &state,
        &connection_id,
        options.unwrap_or_default(),
        app_sink(app),
    )
    .await
}

#[tauri::command]
pub(crate) async fn monitor_configure(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    generation: u64,
    options: MonitorOptions,
) -> Result<(), AppError> {
    configure(&state, &connection_id, generation, options)
}

#[tauri::command]
pub(crate) async fn monitor_stop(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    generation: Option<u64>,
) -> Result<(), AppError> {
    state.monitors.stop(&connection_id, generation);
    Ok(())
}

/// Stop every monitor; returns how many were running.
#[tauri::command]
pub(crate) async fn monitor_stop_all(state: tauri::State<'_, AppState>) -> Result<usize, AppError> {
    Ok(state.monitors.stop_all())
}

#[tauri::command]
pub(crate) async fn monitor_signal(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    generation: u64,
    pid: i32,
    backend_start: String,
    action: SignalAction,
) -> Result<bool, AppError> {
    signal(
        &state,
        &connection_id,
        generation,
        pid,
        backend_start,
        action,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_clamp_the_interval_and_default_to_live_with_activity() {
        let s = MonitorOptions::default().settings();
        assert_eq!(s.interval, Duration::from_secs(1));
        assert!(!s.paused);
        assert!(s.activity);
        let fast = MonitorOptions {
            interval_ms: Some(1),
            ..Default::default()
        }
        .settings();
        assert_eq!(fast.interval, Duration::from_millis(MIN_INTERVAL_MS));
        let slow = MonitorOptions {
            interval_ms: Some(u64::MAX),
            paused: Some(true),
            activity: Some(false),
            views: None,
        }
        .settings();
        assert_eq!(slow.interval, Duration::from_millis(MAX_INTERVAL_MS));
        assert!(slow.paused);
        assert!(!slow.activity);
    }

    #[test]
    fn signals_are_refused_on_read_only_connections_and_for_the_monitor_itself() {
        assert!(signal_refusal(true, 10, 20).unwrap().contains("read-only"));
        assert!(signal_refusal(false, 10, 10)
            .unwrap()
            .contains("monitor's own"));
        assert!(signal_refusal(false, 10, 0).is_some());
        assert!(signal_refusal(false, 10, -5).is_some());
        assert_eq!(signal_refusal(false, 10, 20), None);
        // Read-only wins: the reason names the policy, not the pid.
        assert!(signal_refusal(true, 10, 10).unwrap().contains("read-only"));
    }

    #[test]
    fn signal_action_deserializes_from_the_frontend_words() {
        let cancel: SignalAction = serde_json::from_str("\"cancel\"").unwrap();
        let terminate: SignalAction = serde_json::from_str("\"terminate\"").unwrap();
        assert_eq!(cancel, SignalAction::Cancel);
        assert_eq!(terminate, SignalAction::Terminate);
        assert!(serde_json::from_str::<SignalAction>("\"kill\"").is_err());
    }

    #[test]
    fn the_event_serializes_in_camel_case_with_absent_tiers_as_null() {
        let event = MonitorEvent::new("conn-1", 3, 7, Duration::from_millis(1500));
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["connectionId"], "conn-1");
        assert_eq!(json["intervalMs"], 1500);
        assert_eq!(json["status"], "live");
        assert!(json["activity"].is_null());
        assert!(json["rates"].is_null());
    }

    #[test]
    fn stop_all_and_stop_by_generation() {
        let monitors = Monitors::default();
        assert_eq!(monitors.stop_all(), 0);
        monitors.stop("conn-1", Some(1));
        assert_eq!(monitors.len(), 0);
        assert!(monitors.with("conn-1", 1, |_| ()).is_err());
    }
}
