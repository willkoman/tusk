import { lex } from "./editor/lexer";

export type TransactionState = "idle" | "configured" | "active" | "failed" | "lost";
export type TransactionMode = "none" | "explicit" | "autocommit_off";
export type TransactionHealth = "healthy" | "recovery_required" | "lost";

export type TransactionStatus = {
  state: TransactionState;
  revision: number;
  id: string | null;
  owner: string | null;
  mode: TransactionMode;
  health: TransactionHealth;
};

export type TransactionEvent = "begin" | "commit" | "rollback" | "rollback_to" | "savepoint" | "release" | "configure" | "grid_apply" | "statement";

export const IDLE_TRANSACTION: TransactionStatus = {
  state: "idle",
  revision: 0,
  id: null,
  owner: null,
  mode: "none",
  health: "healthy",
};

const STATES = new Set<TransactionState>(["idle", "configured", "active", "failed", "lost"]);
const MODES = new Set<TransactionMode>(["none", "explicit", "autocommit_off"]);
const HEALTH = new Set<TransactionHealth>(["healthy", "recovery_required", "lost"]);

export function isTransactionStatus(value: unknown): value is TransactionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const structurallyValid = STATES.has(v.state as TransactionState) &&
    typeof v.revision === "number" && Number.isSafeInteger(v.revision) && v.revision >= 0 &&
    (v.id === null || (typeof v.id === "string" && v.id.length > 0 && v.id.length <= 128)) &&
    (v.owner === null || (typeof v.owner === "string" && v.owner.length > 0 && v.owner.length <= 128)) &&
    MODES.has(v.mode as TransactionMode) && HEALTH.has(v.health as TransactionHealth);
  if (!structurallyValid) return false;
  if (v.state === "idle") return v.id === null && v.owner === null && v.mode === "none" && v.health === "healthy";
  if (v.id === null || v.owner === null || v.mode === "none") return false;
  if (v.state === "failed") return v.health === "recovery_required";
  if (v.state === "lost") return v.health === "lost";
  return v.health === "healthy";
}

export function transactionOpen(status: TransactionStatus): boolean {
  return status.state !== "idle";
}

export function transactionOwnedBy(status: TransactionStatus, tabId: string): boolean {
  return transactionOpen(status) && status.owner === tabId;
}

export function transactionDatabaseAllowed(status: TransactionStatus, tabId: string): boolean {
  return status.state === "idle" || (status.state !== "lost" && status.owner === tabId);
}

export type TransactionControlAvailability = {
  start: boolean;
  commit: boolean;
  rollback: boolean;
  clearConfiguration: boolean;
};

/** Controls valid for the current owner. `configured` is MySQL's next-transaction state. */
export function transactionControlAvailability(
  status: TransactionStatus,
  tabId: string,
  pending: number,
  busy: boolean,
): TransactionControlAvailability {
  const available = transactionOwnedBy(status, tabId) && pending === 0 && !busy;
  return {
    start: available && status.state === "configured",
    commit: available && status.state === "active",
    rollback: available && (status.state === "active" || status.state === "failed"),
    clearConfiguration: available && status.state === "configured",
  };
}

export type AcceptedTransaction = { accepted: boolean; status: TransactionStatus };

function sameTransactionStatus(a: TransactionStatus, b: TransactionStatus): boolean {
  return a.state === b.state && a.revision === b.revision && a.id === b.id && a.owner === b.owner && a.mode === b.mode && a.health === b.health;
}

/** Accept only authoritative state from this connection generation, monotonically by revision. */
export function acceptTransactionStatus(
  current: TransactionStatus,
  incoming: unknown,
  sourceGeneration: number,
  currentGeneration: number,
): AcceptedTransaction {
  if (sourceGeneration !== currentGeneration || !isTransactionStatus(incoming)) return { accepted: false, status: current };
  if (incoming.revision < current.revision) return { accepted: false, status: current };
  if (incoming.revision === current.revision && !sameTransactionStatus(incoming, current)) {
    return { accepted: false, status: current };
  }
  return { accepted: true, status: incoming };
}

export function transactionFromError(error: unknown): TransactionStatus | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const status = (error as Record<string, unknown>).transaction;
  return isTransactionStatus(status) ? status : null;
}

function statementTransactionEvent(sql: string): TransactionEvent {
  const parsed = lex(sql);
  const first = parsed.stmts[0];
  if (!first) return "statement";
  let text = first.text.toLowerCase();
  for (const span of parsed.spans) {
    if (span.to <= first.from || span.from >= first.to || (span.kind !== "line-comment" && span.kind !== "block-comment")) continue;
    const from = Math.max(span.from, first.from) - first.from;
    const to = Math.min(span.to, first.to) - first.from;
    text = text.slice(0, from) + " ".repeat(to - from) + text.slice(to);
  }
  text = text.trimStart();
  if (/^(begin\b|start\s+transaction\b)/.test(text)) return "begin";
  if (/^(commit|end)\b/.test(text)) return "commit";
  if (/^rollback(?:\s+(?:work|transaction))?\s+to\b/.test(text)) return "rollback_to";
  if (/^(rollback|abort)\b/.test(text)) return "rollback";
  if (/^savepoint\b/.test(text)) return "savepoint";
  if (/^release(?:\s+savepoint)?\b/.test(text)) return "release";
  const autocommit = /^set\s+(?:(?:session|local)\s+|@@(?:session|local)\s*\.\s*)?autocommit\s*(?:=\s*)?(0|off|1|on)\b/.exec(text);
  if (/^set\s+transaction\b/.test(text) || autocommit?.[1] === "0" || autocommit?.[1] === "off") return "configure";
  if (autocommit?.[1] === "1" || autocommit?.[1] === "on") return "commit";
  return "statement";
}

/** Classify the first transaction boundary anywhere in a script, then other controls. */
export function transactionEvent(sql: string): TransactionEvent {
  const events = lex(sql).stmts.map((statement) => statementTransactionEvent(statement.text));
  return events.find((event) => event === "commit" || event === "rollback")
    ?? events.find((event) => event === "rollback_to")
    ?? events.find((event) => event !== "statement")
    ?? "statement";
}

/** Failed sessions may only send a recovery-first script. Backend remains authoritative. */
export function transactionRecoveryAllowed(status: TransactionStatus, sql: string): boolean {
  if (status.state !== "failed") return true;
  const first = lex(sql).stmts[0];
  if (!first) return false;
  const event = statementTransactionEvent(first.text);
  return event === "rollback" || event === "rollback_to";
}

export function transactionHistorySql(sql: string, transactionKey: string | null, revision: number, event: TransactionEvent): string {
  if (!transactionKey) return sql;
  return `-- [Transaction ${transactionKey}; revision ${revision}; ${event}]\n${sql}`;
}

/** Choose a history scope without claiming a final transaction owned an earlier boundary. */
export function transactionHistoryScope(
  before: TransactionStatus,
  after: TransactionStatus,
  event: TransactionEvent,
  currentKey: string | null,
  priorKey: string | null,
): string | null {
  const advanced = after.revision > before.revision;
  const boundary = event === "commit" || event === "rollback" || event === "rollback_to";
  if (advanced && boundary && after.id && before.id !== after.id) {
    return `transition@revision-${after.revision}`;
  }
  if (after.id) return currentKey;
  if (before.id) return priorKey;
  return advanced && event !== "statement" ? `completed@revision-${after.revision}` : null;
}

export function transactionStaleReason(event: TransactionEvent, next: TransactionStatus): string | null {
  if (next.state === "lost") return "transaction session lost; result provenance is no longer trustworthy";
  if (event === "rollback" || event === "rollback_to") return "transaction changes were rolled back; rerun before editing";
  if (event === "commit") return "transaction unit ended; rerun before editing";
  return null;
}

export function transactionBoundaryStaleReason(
  previous: TransactionStatus,
  next: TransactionStatus,
  event: TransactionEvent,
): string | null {
  if (!previous.id) {
    const completedWithinResponse = next.revision > previous.revision &&
      (event === "commit" || event === "rollback" || event === "rollback_to");
    return completedWithinResponse ? transactionStaleReason(event, next) : null;
  }
  if (next.state !== "lost" && next.id === previous.id) {
    const boundaryAdvanced = next.revision > previous.revision &&
      (event === "commit" || event === "rollback" || event === "rollback_to");
    if (!boundaryAdvanced) return null;
  }
  return transactionStaleReason(event, next) ?? "transaction ended; rerun before editing";
}

/** Match snapshots older than a proven transaction boundary, including pre-BEGIN rows. */
export function transactionProvenanceNeedsRefresh(
  transactionId: string | null | undefined,
  revision: number | undefined,
  previous: TransactionStatus,
  next: TransactionStatus,
): boolean {
  if (next.revision <= previous.revision) return false;
  return (previous.id !== null && transactionId === previous.id) ||
    (revision !== undefined && revision < next.revision);
}

export type InterruptedTransactionMarker = {
  connectionKey: string;
  target: string;
  transactionId: string;
  mode: TransactionMode;
  state: Exclude<TransactionState, "idle">;
  startedAt: number;
};

export const INTERRUPTED_TRANSACTION_KEY = "tusk.transaction.interrupted";
export const INTERRUPTED_TRANSACTION_MAX_BYTES = 4096;

export function encodeInterruptedTransaction(
  connectionKey: string,
  target: string,
  status: TransactionStatus,
  startedAt: number,
): string | null {
  if (!transactionOpen(status) || !status.id || !Number.isFinite(startedAt)) return null;
  const marker: InterruptedTransactionMarker = {
    connectionKey: connectionKey.slice(0, 2048),
    target: target.slice(0, 512),
    transactionId: status.id.slice(0, 128),
    mode: status.mode,
    state: status.state as Exclude<TransactionState, "idle">,
    startedAt: Math.max(0, Math.floor(startedAt)),
  };
  const raw = JSON.stringify(marker);
  return raw.length <= INTERRUPTED_TRANSACTION_MAX_BYTES ? raw : null;
}

export function decodeInterruptedTransaction(raw: string | null): InterruptedTransactionMarker | null {
  if (!raw || raw.length > INTERRUPTED_TRANSACTION_MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.connectionKey !== "string" || value.connectionKey.length > 2048 ||
        typeof value.target !== "string" || value.target.length > 512 ||
        typeof value.transactionId !== "string" || !value.transactionId || value.transactionId.length > 128 ||
        !MODES.has(value.mode as TransactionMode) || value.mode === "none" ||
        !STATES.has(value.state as TransactionState) || value.state === "idle" ||
        typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0) return null;
    return value as InterruptedTransactionMarker;
  } catch {
    return null;
  }
}
