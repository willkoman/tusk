/**
 * The frontend's one description of the backend: every Tauri command Tusk registers,
 * with its name, payload shape and reply shape in one place.
 *
 * Nothing else in `src/` calls `invoke` directly. A Rust command rename or a payload
 * change is an edit here, and `grep commands\.` answers "what does the frontend ask the
 * backend for". Argument names are the Rust parameter names camelCased (Tauri's
 * default); reply field casing follows each Rust struct's serde attributes, which is
 * why a few replies (profiles, connect, the tree types) stay snake_case.
 *
 * Tests mock `@tauri-apps/api/core` (see history/store.test.ts) and reach every
 * command through this module.
 */
import { invoke, type Channel } from "@tauri-apps/api/core";
import type { AiEvent } from "./ai/store";
import type { Skill } from "./ai/skills";
import type { BackupOptions, BackupSummary, RestoreOptions, RestoreSummary } from "./backup";
import type { Capabilities, Permissions, TableInfo } from "./connections";
import type { ServerDiag } from "./editor/types";
import type { ExportOptions } from "./export";
import type { BackupFileInfo } from "./forms/RestoreDialog";
import type { SshMeta } from "./forms/SshSection";
import type { ImportOptions, ImportPreview, ImportSummary, ImportTarget } from "./import";
import type { SlackConfig, SlackConfigInfo, SlackStatus } from "./slack/bind";
import type { FkEdge } from "./sql/fk";
import type { TransactionStatus } from "./transaction";
import type { DbTree, RelationDetail } from "./Tree";

/** The message of a backend error (an `AppError` arrives as `{ message, … }`), or the value as text. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ---- reply and payload shapes owned here ------------------------------------

export type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  save_password: boolean;
  sslmode?: string | null;
  read_only: boolean;
  default_connect: boolean;
  driver?: string | null;
  path?: string | null;
  ssh?: SshMeta | null;
  save_ssh_secret: boolean;
  /** "dev" | "staging" | "prod"; null/absent = untagged. See src/environment.ts. */
  environment?: string | null;
};

export type QueryOutcome =
  | { kind: "rows"; columns: string[]; rows: (string | null)[][]; done: boolean; note?: string }
  | { kind: "exec"; message: string };
export type QueryResult = QueryOutcome & { transaction: TransactionStatus };
export type FetchResult = { rows: (string | null)[][]; done: boolean; interrupted?: boolean; transaction: TransactionStatus };
export type ConnectReply = { connection_id: string; server_version: string; read_only: boolean; viaSsh?: boolean };
export type SampleRows = { columns: string[]; rows: (string | null)[][] };
export type SchemaGraphReply = { tables: unknown[]; edges: FkEdge[] };
export type TableExportResult = { schema: string; name: string; path: string; rows: number; error: string };

export type RunQueryArgs = {
  connectionId: string;
  ownerId: string;
  sql: string;
  pageSize?: number;
  searchPath?: string | null;
};

export type ExportToFileArgs = {
  connectionId?: string | null;
  /** Re-run this read server-side (all rows) … */
  sql?: string;
  /** … or write these already-loaded rows. */
  columns?: string[];
  rows?: (string | null)[][];
  options: ExportOptions;
  path: string;
  searchPath?: string | null;
};

export type AiChatRequest = {
  provider: string;
  wire: string;
  model: string;
  baseUrl: string | null;
  system: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  requestId: string;
  allowNoKey: boolean;
};

export type AiCatalogArgs = {
  provider: string;
  wire?: string;
  baseUrl?: string | null;
  allowNoKey?: boolean;
  /** A keyed probe: Test uses a real completion, never a public model-list 200. */
  probe?: unknown;
};

// ---- the commands --------------------------------------------------------------

export const commands = {
  // connections
  connect: (config: unknown) => invoke<ConnectReply>("connect", { config }),
  connectProfile: (id: string) => invoke<ConnectReply>("connect_profile", { id }),
  disconnect: (connectionId: string) => invoke<void>("disconnect", { connectionId }),
  setActiveConnection: (connectionId: string) => invoke<void>("set_active_connection", { connectionId }),
  sshTrustHost: (host: string, port: number, fingerprint: string) => invoke<void>("ssh_trust_host", { host, port, fingerprint }),
  capabilities: (connectionId: string) => invoke<Capabilities>("capabilities", { connectionId }),
  transactionStatus: (connectionId: string) => invoke<TransactionStatus>("transaction_status", { connectionId }),
  cancelOperation: (connectionId: string, ownerId: string) => invoke<TransactionStatus>("cancel_operation", { connectionId, ownerId }),

  // profiles
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile: Profile, password: string | null, sshSecret: string | null) =>
    invoke<Profile>("save_profile", { profile, password, sshSecret }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),

  // queries
  runQuery: (args: RunQueryArgs) => invoke<QueryResult>("run_query", args),
  fetchMore: (connectionId: string, ownerId: string, pageSize?: number) =>
    invoke<FetchResult>("fetch_more", { connectionId, ownerId, pageSize }),
  validateSql: (connectionId: string, sql: string, searchPath: string | null) =>
    invoke<ServerDiag[]>("validate_sql", { connectionId, sql, searchPath }),

  // introspection
  dbTree: (connectionId: string) => invoke<DbTree>("db_tree", { connectionId }),
  listSchema: (connectionId: string) => invoke<TableInfo[]>("list_schema", { connectionId }),
  listFunctions: (connectionId: string) => invoke<string[]>("list_functions", { connectionId }),
  tableDetail: (connectionId: string, schema: string, name: string) =>
    invoke<RelationDetail>("table_detail", { connectionId, schema, name }),
  objectDdl: (connectionId: string, kind: string, schema: string, name: string) =>
    invoke<string>("object_ddl", { connectionId, kind, schema, name }),
  sampleRows: (connectionId: string, schema: string, name: string, limit?: number) =>
    invoke<SampleRows>("sample_rows", { connectionId, schema, name, limit }),
  tableRelationships: (connectionId: string, schema: string, name: string) =>
    invoke<unknown>("table_relationships", { connectionId, schema, name }),
  schemaRelationships: (connectionId: string, schema: string) =>
    invoke<SchemaGraphReply>("schema_relationships", { connectionId, schema }),
  permissions: (connectionId: string) => invoke<Permissions>("permissions", { connectionId }),

  // export / import / backup
  exportToFile: (args: ExportToFileArgs) => invoke<number>("export_to_file", args),
  exportTables: (connectionId: string, tables: { schema: string; name: string }[], options: ExportOptions, directory: string) =>
    invoke<TableExportResult[]>("export_tables", { connectionId, tables, options, directory }),
  importPreview: (path: string, options: ImportOptions) => invoke<ImportPreview>("import_preview", { path, options }),
  importFromFile: (connectionId: string, path: string, options: ImportOptions, target: ImportTarget) =>
    invoke<ImportSummary>("import_from_file", { connectionId, path, options, target }),
  backupToFile: (connectionId: string, path: string, options: BackupOptions) =>
    invoke<BackupSummary>("backup_to_file", { connectionId, path, options }),
  readBackupHeader: (path: string) => invoke<BackupFileInfo>("read_backup_header", { path }),
  restoreFromFile: (connectionId: string, path: string, options: RestoreOptions) =>
    invoke<RestoreSummary>("restore_from_file", { connectionId, path, options }),

  // files + history
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  loadHistory: (connKey: string) => invoke<string>("load_history", { connKey }),
  saveHistory: (connKey: string, json: string) => invoke<void>("save_history", { connKey, json }),
  migrateHistory: (fromKey: string, toKey: string) => invoke<string>("migrate_history", { fromKey, toKey }),

  // AI
  aiChat: (req: AiChatRequest, onEvent: Channel<AiEvent>) => invoke<void>("ai_chat", { req, onEvent }),
  aiCancel: (requestId: string) => invoke<void>("ai_cancel", { requestId }),
  aiHasKey: (provider: string, baseUrl: string | null) => invoke<boolean>("ai_has_key", { provider, baseUrl }),
  aiSaveKey: (provider: string, key: string, baseUrl: string | null, approveOrigin: boolean) =>
    invoke<void>("ai_save_key", { provider, key, baseUrl, approveOrigin }),
  aiClearKey: (provider: string) => invoke<void>("ai_clear_key", { provider }),
  aiListModels: (args: AiCatalogArgs) => invoke<string[]>("ai_list_models", args),

  // skills
  skillsList: () => invoke<Skill[]>("skills_list"),
  skillsSave: (skill: Skill) => invoke<Skill>("skills_save", { skill }),
  skillsDelete: (id: string) => invoke<void>("skills_delete", { id }),
  skillsExport: (id: string) => invoke<string>("skills_export", { id }),
  skillsImport: (text: string, fallbackName: string) => invoke<Skill>("skills_import", { text, fallbackName }),

  // Slack
  slackLoadConfig: () => invoke<SlackConfigInfo>("slack_load_config"),
  slackSaveConfig: (config: SlackConfig, botToken: string | null, appToken: string | null) =>
    invoke<void>("slack_save_config", { config, botToken, appToken }),
  slackClearTokens: () => invoke<void>("slack_clear_tokens"),
  slackStart: (connectionId: string | null) => invoke<void>("slack_start", { connectionId }),
  slackStop: () => invoke<void>("slack_stop"),
  slackSetConnection: (connectionId: string) => invoke<void>("slack_set_connection", { connectionId }),
  slackStatus: () => invoke<SlackStatus>("slack_status"),
  slackTest: () => invoke<string>("slack_test"),

  // app
  crashReportGet: () => invoke<string | null>("crash_report_get"),
  crashReportWrite: (report: string) => invoke<void>("crash_report_write", { report }),
  crashReportClear: () => invoke<void>("crash_report_clear"),
  distributionChannel: () => invoke<string>("distribution_channel"),
} as const;

export type Commands = typeof commands;
