import type { DialectId } from "../sql/dialects";
import type { Table } from "../sql/aliases";

export type { Table };

/**
 * User-facing preferences, persisted globally (see src/store.ts). Keys stay FLAT —
 * prefsStore.load() shallow-merges over DEFAULT_PREFS, so old saved blobs pick up
 * new keys for free; nested objects would silently lose new sub-keys.
 */
export type EditorPrefs = {
  fontSize: number;
  wordWrap: boolean;
  dialect: DialectId;
  /** Editor + UI theme; "system" follows the OS light/dark preference. */
  theme: "oneDark" | "light" | "system";
  /** Auto-fold large inline literals (the headline editor feature). */
  autoFold: boolean;
  /** Round-trip statements to Postgres for parser-grade diagnostics on idle. */
  serverLint: boolean;
  /** Include column names as a header row when copying from the result grid. */
  copyHeaders: boolean;
  /** Monospace font for the editor + result grid; "" = the built-in stack. */
  fontFamily: string;
  /** Accent color driving --accent / --accent-soft. */
  accent: string;
  /** Result-grid row density: compact = 22px rows, normal = 28px. */
  gridDensity: "compact" | "normal";
  /** Zebra-stripe result-grid rows. */
  gridZebra: boolean;
  /** How NULL cells render in the grid (display-only; copy is unaffected). */
  gridNullStyle: "null" | "empty" | "dash";
  /** Default result-grid column width (px) before autofit/manual resize. */
  gridColWidth: number;
  /** Plan view: tree direction (vertical = root on top). */
  planOrientation: "vertical" | "horizontal";
  /** Plan view: which metric drives node heat coloring. */
  planHeat: "cost" | "time" | "rows" | "off";
  /** Plan view: node card detail density. */
  planDensity: "compact" | "normal";
};

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  wordWrap: false,
  dialect: "postgres",
  theme: "oneDark",
  autoFold: true,
  serverLint: true,
  copyHeaders: false,
  fontFamily: "",
  accent: "#3b82f6",
  gridDensity: "normal",
  gridZebra: false,
  gridNullStyle: "null",
  gridColWidth: 180,
  planOrientation: "vertical",
  planHeat: "cost",
  planDensity: "normal",
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
