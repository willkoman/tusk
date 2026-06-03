# Tusk — Agent Onboarding

Fast, native, lightweight **Postgres-first database client**. Goal: replace the clunk of pgAdmin and the resource weight of JetBrains DataGrip. Tauri (system WebView, not Electron) + Rust + SolidJS. Launches sub-second, low RAM, ~5 MB installer.

This file is the source of truth for working in this repo. Keep it, `CHANGELOG.md`, and the code in sync.

## Stack

- **Shell:** Tauri v2 (system WebView2 / WKWebView — no bundled browser).
- **Frontend:** SolidJS + TypeScript + Vite + CodeMirror 6.
- **Backend:** Rust + `tokio-postgres` (text/simple protocol), `native-tls`, `keyring`.

## Build / run / verify

```sh
npm install                 # once
npm run tauri dev           # run the app (needs Rust + Node 20)

# Validate after edits (ALWAYS do this before claiming done):
cargo build --manifest-path src-tauri/Cargo.toml      # backend
npm run build                                         # frontend bundle
npx tsc --noEmit -p tsconfig.json                     # frontend types
```

- **After Rust changes → tell the user to restart `npm run tauri dev`.** Frontend-only changes hot-reload.
- Installers are built in CI: push a `v*` tag → `.github/workflows/release.yml` builds mac (universal) + Windows (NSIS, per-user) and drafts a GitHub release. Don't cross-compile locally.

## Conventions

- Update `CHANGELOG.md` (`[Unreleased]`) on every change.
- Run the three validate commands above after edits.
- Surfacing errors: `db.rs`'s `From<tokio_postgres::Error>` unwraps the real Postgres message (don't regress to bare "db error").
- Caveman chat style seen in history is a *session* preference (the `/caveman` skill), **not** a code/docs convention — write code, commits, and docs normally.

## Architecture

### Backend — `src-tauri/src/`
- **`lib.rs`** — Tauri app. `AppState` = connection registry (`HashMap<id, Arc<Mutex<ConnState>>>`). Commands: `connect`, `connect_profile`, `disconnect`, `list_profiles`, `save_profile`, `delete_profile`, `run_query` (+ `run_single_stmt`), `fetch_more`, `list_schema` (legacy, registered-but-unused), `db_tree`, `export_to_file`, `import_rows`. Plugin init (opener, dialog). `is_cursorable` / `is_read_only_stmt` helpers.
- **`db.rs`** — `ConnectionConfig`, `ConnState {client, cursor_open, read_only}`, `AppError` (rich error surfacing). `open()` = connect with TLS (`native-tls`, sslmode) + sets `default_transaction_read_only` when read-only. `collect_rows()` turns `simple_query` messages into `(columns, rows)` where **every value is text or NULL** (no per-type mapping — intentional, handles any type). `ident`/`create_table_text`/`copy_rows` for import.
- **`profiles.rs`** — saved connections. Metadata → `connections.json` in the app config dir; **password → OS keychain** (`keyring`, per-OS features), never plaintext, never sent to the frontend. `upsert`/`delete`/`load_all`/`get_password`.
- **`script.rs`** — SQL **script runner**. `split()` is a byte-level lexer handling `--` / `/* */` comments, `'…'` / `"…"` quotes, **dollar-quotes** (`$tag$`, distinguishes `$1`), and `COPY … FROM stdin` + `\.` data blocks. `run()` executes items in one transaction (rolls back + reports the failing statement); COPY blocks go through `copy_in`. `effective_start()` skips leading comments (so a COPY preceded by a `--` block is still detected).
- **`export.rs`** — **streaming export**. Server-side cursor, 10k-row batches, format each batch (CSV/TSV/JSON/SQL/Markdown), write to a file. File created lazily on first row (empty result → no file). Constant memory.
- **`tree.rs`** — `db_tree` introspection. ~8 `pg_catalog` queries → `DbTree { database, databases, schemas[] }` where each schema has tables/views/sequences/functions and each table has columns (with `is_pk`/`is_fk`/nullable/default), indexes, constraints.
- **`main.rs`** — `tusk_lib::run()`.

### Frontend — `src/`
- **`App.tsx`** — everything UI. Connect screen (saved-profile list + form: host/port/user/password/db/**sslmode**/**read-only**/save-password). Workspace: topbar, **resizable** sidebar (`<Tree>`), **resizable** editor/results split, virtualized result grid (renders only visible rows — millions scroll smoothly via cursor + `fetch_more`), statusbar with **Export** menu, **Import** modal. `doRun()` runs selection-or-whole (from the editor's `getRunText`) and routes through `run_query` (which auto-detects multi-statement scripts). `schema` is a `createMemo` derived from `tree()` and feeds the editor's autocomplete.
- **`SqlEditor.tsx`** — CodeMirror 6. Dialect highlighting, **override autocomplete** (context-aware), live keyword auto-capitalization (`transactionFilter`), close-brackets, **lint** (Lezer parser error nodes → red squiggles), **Tab-only accept** (Enter = newline), exposes `getRunText()` via `onReady`.
- **`sql/dialects.ts`** — per-dialect keyword/function/type lists + CodeMirror dialect. Postgres complete; **MySQL/SQLite/MSSQL staged** for future drivers.
- **`sql/completion.ts`** — the context-aware completion source: clause detection (tables after FROM/JOIN, columns after SELECT/WHERE/…), alias resolution (`u.` → that table's columns), schema qualification, ranked in-scope cols > tables > functions > keywords. `$` deliberately excluded from completion tokens.
- **`Tree.tsx`** — recursive DB-explorer tree with icons (🔑 PK, 🔗 FK, 🔒 unique, ✓ check), per-node expand state, hover titles for index/constraint/function defs.
- **`formats.ts`** — CSV/JSON parsing for **import** (export formatting now lives in Rust/`export.rs`).

## Gotchas (read before debugging)

- **Values are text.** `simple_query` returns everything as strings; `NULL` = `None`/`null`. Don't assume typed values.
- **Single statement vs script.** A single read statement streams to the grid via a server-side cursor; multiple statements or a COPY block run as a transactional script (summary, no grid). Routing is in `run_query` via `script::split`.
- **COPY detection ignores leading comments** (`effective_start`). pg_dump prefixes every COPY with a `--` block; missing this sends COPY to `batch_execute` → `CopyInResponse` → "unexpected message from server".
- **Keychain in dev:** unsigned `tauri dev` builds re-prompt / invalidate saved passwords across rebuilds (macOS ties items to the code signature). Seamless in signed release builds. `keyring` features are per-OS in `Cargo.toml`.
- **TLS:** `native-tls` (SecureTransport on mac, SChannel on Windows; needs OpenSSL on Linux). `sslmode`: `disable` | `prefer` (default) | `require` (encrypt, no cert verify) | `verify-full` (verify).
- **Read-only mode:** server `SET default_transaction_read_only = on` **and** a client-side write/DDL guard.
- **Autocomplete corrupting dollar-quotes** was caused by Enter-accept + `$` tokens — fixed; keep accept Tab-only and `$` out of completion tokens.

## Current state

Working Postgres client: connect (TLS, read-only, saved/keychain profiles), stream large results, CodeMirror editor with context-aware autocomplete + error highlighting, run multi-statement SQL scripts / `pg_dump` files, streaming multi-format export, CSV/JSON import via COPY, and a rich object-explorer sidebar. Build is green. Committed on `master`.

## Roadmap / next

1. **Richer sidebar (the next requested task):** show **object & column comments** (`pg_description` / `obj_description` / `col_description`) on hover, plus other typically-relevant metadata not yet present — triggers, rules, row-count estimates, table/index sizes, column identity/defaults, FK target (references table.column), sequence ownership, view definitions, partition info.
2. **Lazy-load the tree** (fetch a table's columns/indexes/constraints on expand) for large DBs — currently the whole DB is introspected on connect (~8 queries).
3. **Browse other databases** (reconnect on click — currently listed but not browsable).
4. **Coverage:** MySQL / SQLite / MSSQL drivers behind a driver abstraction (autocomplete dialect specs already staged in `sql/dialects.ts`).
5. **AI:** text-to-SQL + explain/optimize.
6. **Distribution:** code signing (mac notarization, Windows cert) to drop SmartScreen/Gatekeeper warnings.
7. Nice-to-haves: in-grid data editing, query history, multi-tab/multi-connection.

## License

MIT.
