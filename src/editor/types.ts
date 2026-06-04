import type { DialectId } from "../sql/dialects";
import type { Table } from "../sql/aliases";

export type { Table };

/** User-facing editor preferences, persisted globally (see src/store.ts). */
export type EditorPrefs = {
  fontSize: number;
  wordWrap: boolean;
  dialect: DialectId;
  /** Single theme today; an enum so a future light theme is a one-line change. */
  theme: "oneDark";
  /** Auto-fold large inline literals (the headline editor feature). */
  autoFold: boolean;
  /** Round-trip statements to Postgres for parser-grade diagnostics on idle. */
  serverLint: boolean;
  /** Include column names as a header row when copying from the result grid. */
  copyHeaders: boolean;
};

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  wordWrap: false,
  dialect: "postgres",
  theme: "oneDark",
  autoFold: true,
  serverLint: true,
  copyHeaders: false,
};

/** One diagnostic from the backend `validate_sql` command. */
export type ServerDiag = {
  /** Index into the canonical statement split (matches src-tauri script::split order). */
  stmtIndex: number;
  message: string;
  /** 1-based character offset within the statement, or null if Postgres gave none. */
  position: number | null;
};

/** Transport the editor calls to validate the whole buffer; null when disconnected. */
export type ValidateFn = (sql: string) => Promise<ServerDiag[]>;

/** Cursor / statement readout surfaced to the status bar. */
export type CursorInfo = {
  line: number;
  col: number;
  stmtIndex: number;
  stmtCount: number;
  selChars: number;
};
