# Changelog

All notable changes to **Tusk** (fast native Postgres-first DB client). Format loosely follows Keep a Changelog. Newest first.

## [Unreleased]

### Added
- **Project scaffold** — Tauri v2 + SolidJS + TypeScript, Rust backend. Working name **Tusk** (Postgres elephant nod).
- **Postgres backend** (`src-tauri/src/db.rs`, `lib.rs`) — connect via `tokio-postgres`; arbitrary user SQL over the text protocol (`simple_query`) so any column type renders without per-type mapping.
- **Streaming reads** — large `SELECT`s run through a server-side cursor (`BEGIN` / `DECLARE` / `FETCH FORWARD` in 1000-row pages) with `fetch_more`; non-cursorable statements run directly and report rows-affected. This is the "millions of rows without choking" wedge.
- **Schema introspection** — `list_schema` returns schemas → tables → columns (name + data_type).
- **Virtualized result grid** (`src/App.tsx`) — renders only visible rows; millions scroll smoothly. Sticky header, NULL styling, streaming status bar, elapsed-ms.
- **CodeMirror 6 SQL editor** (`src/SqlEditor.tsx`) — syntax highlighting, line numbers, bracket matching, undo history, ⌘/Ctrl+Enter to run.
- **Saved connections** (`src-tauri/src/profiles.rs`) — profiles persisted to `connections.json` (app config dir); passwords stored in the **OS keychain** (`keyring`, macOS `apple-native`) — never plaintext, never sent to the frontend. `connect_profile` loads the password server-side. Edit / delete; ad-hoc connect still supported.
- **Context-aware, multi-dialect autocomplete engine** (`src/sql/dialects.ts`, `src/sql/completion.ts`) — custom completion source: clause-aware (tables after FROM/JOIN, columns after SELECT/WHERE/ON/GROUP BY/…), table-alias resolution (`u.` → that table's columns), schema qualification (`schema.table.col`), ranked in-scope columns > tables > functions > keywords. Per-dialect keyword/function/type lists (Postgres complete; MySQL/SQLite/MSSQL stubs ready for when those drivers land). Uppercase keyword completions; column types shown inline. Accepts completion on **Tab**; **live auto-capitalization** of keywords (SELECT, FROM, GROUP BY, JOIN, …) as you type, skipping strings and qualified names.
- **Windows / cross-platform deploy prep** — target-specific `keyring` backends (macOS Keychain / Windows Credential Manager / Linux Secret Service); lightweight Windows bundle (NSIS **per-user**, WebView2 `downloadBootstrapper`); GitHub Actions `release` workflow (`.github/workflows/release.yml`) builds + publishes mac (universal) + Windows installers on a `v*` tag as a draft release.
- **README** — overview, features, quickstart, project layout, and roadmap.

### Fixed
- **Error surfacing** — `tokio-postgres` errors previously surfaced as the useless string "db error"; now the real Postgres message (DbError) or source-chain detail is shown. Added a precise message when a saved keychain password can't be read in unsigned dev builds.

### Known issues / dev notes
- macOS keychain ties items to the binary's code signature; each `cargo` rebuild re-prompts and can invalidate dev-saved passwords. Production (signed) builds are seamless. Optional encrypted-on-disk dev fallback available on request.
- TLS not yet implemented (local / LAN only) — required before connecting the work server (default to read-only + guard destructive queries then).

### Roadmap (next, user's order)
1. Schema refresh + table previews — expandable sidebar (columns/types inline), refresh button, auto-refresh after DDL.
2. Editor QoL — open `.sql` files, run selection vs whole statement, auto-close brackets/quotes.
3. Coverage — MySQL / SQLite / MSSQL drivers behind a `Driver` trait (autocomplete dialect specs already staged).
4. TLS for remote servers; AI text-to-SQL + explain/optimize.
