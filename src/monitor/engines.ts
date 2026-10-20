/**
 * What differs between the engines the monitor watches, in one table: which views
 * exist, what each chart and tile is called and where its numbers come from, which
 * series an engine has no counter for, the wait-bucket labels, the events it can
 * report, and how Cancel/Terminate are spelled. The backend maps every engine onto
 * the same sample model (src-tauri/src/monitor/{pg,mysql,mssql}.rs), so rendering
 * never branches on engine — it reads this profile.
 */

import { WAIT_TYPES, type EventKind, type TileKey } from "./model";
import type { MonitorView } from "./session";

export type MonitorEngine = "postgres" | "mysql" | "mssql";

export const isMonitorEngine = (kind: string | null | undefined): kind is MonitorEngine =>
  kind === "postgres" || kind === "mysql" || kind === "mssql";

export type ChartId = "load" | "sessions" | "tps" | "tuples" | "io" | "wal" | "writes";

/** An engine's override for one Overview chart. Per pane: series relabelled, series omitted. */
export type ChartText = {
  hidden?: boolean;
  title?: string;
  source?: string;
  labels?: Record<number, string>[];
  omit?: number[][];
};

export type SignalWord = "cancel" | "terminate";

export type EngineProfile = {
  engine: MonitorEngine;
  views: readonly MonitorView[];
  charts: Partial<Record<ChartId, ChartText>>;
  tiles: Partial<Record<TileKey, { label?: string; source: string }>>;
  /** Labels for the eleven wait buckets, in `WAIT_TYPES` order. */
  waitLabels: readonly string[];
  /** Event kinds this engine can report, and their names here. */
  events: readonly EventKind[];
  eventLabels: Partial<Record<EventKind, string>>;
  eventsSource: string;
  /** The engine can stop a running query without ending the session. */
  canCancel: boolean;
  /** The engine counts rollbacks (SQL Server keeps no such counter). */
  rollbacks: boolean;
  /** The statement Cancel/Terminate runs, as history records it. */
  signalSql: (action: SignalWord, pid: number) => string;
  /** What the confirmation says each action does. */
  signalEffect: Record<SignalWord, string>;
  /** Shown when the monitor's role cannot see other accounts' sessions. */
  visibilityNote: string;
};

const PG: EngineProfile = {
  engine: "postgres",
  views: ["overview", "activity", "locks", "statements", "replication", "tables", "io"],
  charts: {},
  tiles: {},
  waitLabels: WAIT_TYPES,
  events: ["checkpoint", "checkpoint-requested", "deadlock", "conflict", "temp-file", "reset"],
  eventLabels: {},
  eventsSource:
    "Discrete events per sample, from pg_stat_database (deadlocks, recovery conflicts, temp files), the checkpoint counters, and counter resets. A larger dot is more in one interval.",
  canCancel: true,
  rollbacks: true,
  signalSql: (action, pid) => `SELECT ${action === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend"}(${pid})`,
  signalEffect: {
    cancel: "Sends pg_cancel_backend: the running statement stops with an error, and a transaction it was part of can only roll back. The session stays connected.",
    terminate: "Sends pg_terminate_backend: the session disconnects and its open transaction rolls back.",
  },
  visibilityNote: "Other users' queries are hidden. Grant pg_monitor to see them.",
};

const MYSQL: EngineProfile = {
  engine: "mysql",
  views: ["overview", "activity"],
  charts: {
    load: {
      source:
        "The process list (performance_schema.processlist on MySQL 8.0.22+) with InnoDB's transactions: running threads by what they wait for. Lock = an InnoDB row lock or a metadata, table or global lock; I/O = temporary tables, opening tables and commit flushes; Client = the network; Sleep = SLEEP(); Running = none of those. Never the monitor.",
      omit: [[2, 4, 7, 8, 9]],
    },
    sessions: {
      source:
        "Client threads by command, against max_connections (the dashed line, drawn once the sessions reach half of it): Sleep is idle, Sleep with an open InnoDB transaction is idle in transaction, anything else is active. Other is replication and killed threads.",
      omit: [[2]],
    },
    tps: {
      source:
        "Δ Handler_commit and Handler_rollback (global status) per second: storage-engine commits, so every autocommit statement counts, as PostgreSQL counts them. The dashed line is the 10-second average.",
    },
    tuples: {
      title: "Rows per second",
      source: "InnoDB rows: written (Δ Innodb_rows_inserted, _updated, _deleted) above, read (Δ Innodb_rows_read) below, per second.",
      labels: [{}, { 1: "Read" }],
      omit: [[], [0]],
    },
    io: {
      title: "Buffer pool I/O",
      source:
        "InnoDB buffer pool, as bytes per second (× innodb_page_size): reads served from memory (Δ Innodb_buffer_pool_read_requests − Innodb_buffer_pool_reads) and pages read from disk (Δ Innodb_buffer_pool_reads).",
      omit: [[2]],
    },
    wal: {
      title: "Redo log",
      source: "Δ Innodb_os_log_written: redo log bytes written per second.",
      labels: [{ 0: "Redo log" }],
    },
    writes: {
      title: "Buffer pool flushing",
      source: "Dirty pages written back from the buffer pool per second, as bytes (Δ Innodb_buffer_pool_pages_flushed × innodb_page_size).",
      labels: [{ 0: "Pages flushed" }],
      omit: [[1, 2]],
    },
  },
  tiles: {
    load: { source: "Average running threads over the last minute (the process list, excluding the monitor and idle connections)." },
    sessions: { source: "Client threads: active / total, and max_connections. Amber and red at the shares of max_connections set in Settings → Monitor." },
    tps: { source: "Δ(Handler_commit + Handler_rollback) per second (global status). Below: the 10-second average and the rollback share." },
    cacheHit: { source: "InnoDB buffer pool: reads served from memory / all read requests, over the last tick — not the lifetime ratio, which hides incidents." },
    wal: { label: "Redo log", source: "Δ Innodb_os_log_written per second." },
    oldestXact: { source: "now − min(trx_started) over information_schema.INNODB_TRX (needs PROCESS). Amber and red ages are set in Settings → Monitor." },
    blocked: { source: "Threads waiting on an InnoDB row lock (INNODB_TRX in LOCK WAIT) plus threads waiting for a metadata, table or global lock. Click for Activity." },
  },
  waitLabels: ["Running", "Lock", "Latch", "I/O", "IPC", "Client", "Sleep", "BufferPin", "Activity", "Extension", "Other waits"],
  events: ["deadlock", "temp-file", "reset"],
  eventLabels: { "temp-file": "On-disk temp tables" },
  eventsSource:
    "Discrete events per sample: InnoDB deadlocks (INNODB_METRICS lock_deadlocks, or Innodb_deadlocks on MariaDB), internal temporary tables that went to disk (Created_tmp_disk_tables), and counter resets such as a server restart.",
  canCancel: true,
  rollbacks: true,
  signalSql: (action, pid) => (action === "cancel" ? `KILL QUERY ${pid}` : `KILL CONNECTION ${pid}`),
  signalEffect: {
    cancel: "Runs KILL QUERY: the running statement stops with an error. The connection stays, and so does a transaction it was part of.",
    terminate: "Runs KILL CONNECTION: the connection closes and its open transaction rolls back.",
  },
  visibilityNote: "Only this account's threads are listed. Grant PROCESS to see every account's.",
};

const MSSQL: EngineProfile = {
  engine: "mssql",
  views: ["overview", "activity"],
  charts: {
    load: {
      source:
        "sys.dm_exec_requests for user sessions (never the monitor): running requests by wait type. Lock = LCK_M_*, Latch = PAGELATCH_* / LATCH_*, I/O = PAGEIOLATCH_*, WRITELOG and other I/O completions, Parallelism = CX*, Client = ASYNC_NETWORK_IO, WAITFOR; CPU = running or runnable.",
      omit: [[7, 8, 9]],
    },
    sessions: {
      source:
        "User sessions (sys.dm_exec_sessions) against @@MAX_CONNECTIONS (the dashed line, drawn once the sessions reach half of it): a running request is active, an open transaction without one is idle in transaction.",
      omit: [[2]],
    },
    tps: {
      source:
        "Δ Transactions/sec (_Total, sys.dm_os_performance_counters): transactions started in every database, per second. SQL Server keeps no rollback counter. The dashed line is the 10-second average.",
      omit: [[1]],
    },
    tuples: { hidden: true },
    io: {
      title: "Buffer pool I/O",
      source:
        "Buffer Manager counters, as bytes per second (× 8 KiB pages): lookups served from memory (Δ Page lookups/sec − Page reads/sec) and pages read from disk (Δ Page reads/sec).",
      omit: [[2]],
    },
    wal: {
      title: "Transaction log",
      source: "Δ Log Bytes Flushed/sec (_Total): transaction-log bytes flushed to disk per second, every database.",
      labels: [{ 0: "Log flushed" }],
    },
    writes: {
      title: "Checkpoints and lazy writes",
      source: "Pages written per second as bytes: by checkpoints (Δ Checkpoint pages/sec) and by the lazy writer freeing buffers (Δ Lazy writes/sec).",
      labels: [{ 0: "Checkpoint", 1: "Lazy writer" }],
      omit: [[2]],
    },
  },
  tiles: {
    load: { source: "Average running requests over the last minute (sys.dm_exec_requests, user sessions, excluding the monitor)." },
    sessions: { source: "User sessions: active / total, and @@MAX_CONNECTIONS. Amber and red at the shares set in Settings → Monitor." },
    tps: { label: "Transactions/s", source: "Δ Transactions/sec (_Total) per second. Below: the 10-second average." },
    cacheHit: { source: "Page lookups served from memory / all page lookups over the last tick (Buffer Manager) — not the lifetime Buffer cache hit ratio." },
    wal: { label: "Log flush", source: "Δ Log Bytes Flushed/sec (_Total) per second." },
    oldestXact: { source: "now − the earliest transaction_begin_time of any session (sys.dm_tran_active_transactions). Amber and red ages are set in Settings → Monitor." },
    blocked: { source: "Requests whose blocking_session_id is set (sys.dm_exec_requests). Click for Activity." },
  },
  waitLabels: ["CPU", "Lock", "Latch", "I/O", "Parallelism", "Client", "WAITFOR", "BufferPin", "Activity", "Extension", "Other"],
  events: ["deadlock", "temp-file", "reset"],
  eventLabels: { "temp-file": "Workfiles" },
  eventsSource:
    "Discrete events per sample: deadlocks (Number of Deadlocks/sec), hash and sort spills to tempdb workfiles (Workfiles Created/sec), and counter resets such as a server restart.",
  canCancel: false,
  rollbacks: false,
  signalSql: (_action, pid) => `KILL ${pid}`,
  signalEffect: {
    cancel: "SQL Server cannot cancel only a session's running query.",
    terminate: "Runs KILL: the session disconnects and its open transaction rolls back (a long transaction can take a while to roll back).",
  },
  visibilityNote: "",
};

export function engineProfile(engine: MonitorEngine): EngineProfile {
  return engine === "mysql" ? MYSQL : engine === "mssql" ? MSSQL : PG;
}

/** The view to show: the requested one if this engine has it, else Overview. */
export function viewFor(profile: EngineProfile, view: MonitorView): MonitorView {
  return profile.views.includes(view) ? view : "overview";
}

/** The series of one pane an engine has no counter for. */
export function omitted(text: ChartText | undefined, pane: number): ReadonlySet<number> {
  return new Set(text?.omit?.[pane] ?? []);
}

/** A series label as this engine calls it. */
export function seriesLabel(text: ChartText | undefined, pane: number, k: number, fallback: string): string {
  return text?.labels?.[pane]?.[k] ?? fallback;
}
