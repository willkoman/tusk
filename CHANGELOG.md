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
- **Schema sidebar previews** — expandable tables show columns + types inline; **Refresh** button; **auto-refresh after DDL** (`CREATE`/`ALTER`/`DROP`/…). Single-click previews, double-click runs `SELECT *`.
- **Editor QoL** — open / save `.sql` files (webview-native, no plugins); **run selection vs whole** (selected text runs alone, otherwise the full editor); auto-close brackets & quotes.
- **Resizable editor / results split** — drag the divider between the SQL editor and the result grid; the grid re-virtualizes to the new size.
- **TLS connections** — `sslmode` per connection (`disable` / `prefer` / `require` / `verify-full`) over native platform TLS (SecureTransport / SChannel — no OpenSSL on mac/Windows). `prefer`/`require` encrypt without verifying the cert (libpq semantics, works with self-signed); `verify-full` verifies. Persisted on saved profiles.
- **Read-only connections** — opt-in per connection: sets `default_transaction_read_only = on` server-side **and** blocks writes/DDL client-side with a clear message. Persisted on saved profiles. Safe for browsing production.
- **Import / export (multi-format)** — **streaming export** of the current query to **CSV / TSV / JSON / SQL inserts / Markdown**: backend (`export_to_file` + `export.rs`) reads a server-side cursor in 10k-row batches, formats each batch, and writes straight to a file chosen via a **native save dialog** — constant memory, any table size. Import **CSV / JSON** into an existing table or a new auto-created table (all-`text` columns) via Postgres `COPY FROM STDIN` (`import_rows`). Import dialog: file pick, header toggle, target selector. Both blocked on read-only connections (import).
- **SQL script runner** — Run auto-detects multi-statement input (e.g. an opened `.sql` dump) and runs it as a script in one transaction (`src-tauri/src/script.rs`): a lexer splits statements respecting comments, quoted strings/identifiers and **dollar-quoted bodies**, executes `COPY … FROM stdin` + `\.` data blocks via the COPY protocol, and skips psql backslash meta-commands. Single statements still stream to the result grid. Reports statement/row counts, or the failing statement with context. Lets you run `pg_dump` files (e.g. pagila.sql).
- **Database explorer sidebar** — full object hierarchy (databases → schemas → Tables / Views / Sequences / Functions, and per-table **Columns / Indexes / Constraints**) with rich icons (🔑 primary key, 🔗 foreign key, 🔒 unique, ✓ check), column types + NOT NULL, and index/constraint definitions on hover. Backend `db_tree` introspects `pg_catalog` (`src-tauri/src/tree.rs`); UI in `src/Tree.tsx`. Sidebar is now **resizable** (drag the divider); double-click a table to `SELECT *`.
- **SQL error highlighting** — live syntax-error underlines + gutter markers from the Lezer parser (`@codemirror/lint`).
- **Editor larger than results by default** (~60/40 split from window height), still freely resizable.

### Fixed
- **`COPY … FROM stdin` after comment headers** — pg_dump prefixes each COPY with a `--` comment block, which made the script runner miss the COPY (it saw `--`), send it via `batch_execute`, and desync the protocol ("unexpected message from server"). COPY is now detected by the first non-comment token, and `copy_in` receives the comment-stripped statement.
- **Dollar-quoted function bodies corrupted by autocomplete** — Enter no longer silently accepts a completion (accept is **Tab-only**), and `$`-sigils (`$_$`, `$1`) no longer trigger completion. Fixes `CREATE FUNCTION … AS $_$ … $1 … $_$` failing with "syntax error at or near 1".
- **Empty export writes no file** — the output file is created lazily on the first row, so a 0-row result never touches disk.
- **Cropped UI on launch** — default window is now 1200×820 (min 900×600, centered); the connect screen scrolls if its form is taller than the window.
- **Error surfacing** — `tokio-postgres` errors previously surfaced as the useless string "db error"; now the real Postgres message (DbError) or source-chain detail is shown. Added a precise message when a saved keychain password can't be read in unsigned dev builds.

### Known issues / dev notes
- macOS keychain ties items to the binary's code signature; each `cargo` rebuild re-prompts and can invalidate dev-saved passwords. Production (signed) builds are seamless. Optional encrypted-on-disk dev fallback available on request.
- TLS not yet implemented (local / LAN only) — required before connecting the work server (default to read-only + guard destructive queries then).

### Roadmap (next, user's order)
1. Schema refresh + table previews — expandable sidebar (columns/types inline), refresh button, auto-refresh after DDL.
2. Editor QoL — open `.sql` files, run selection vs whole statement, auto-close brackets/quotes.
3. Coverage — MySQL / SQLite / MSSQL drivers behind a `Driver` trait (autocomplete dialect specs already staged).
4. TLS for remote servers; AI text-to-SQL + explain/optimize.
