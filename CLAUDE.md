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
- **`lib.rs`** — Tauri app. `AppState` = connection registry (`HashMap<id, Arc<Mutex<ConnState>>>`). Commands: `connect`, `connect_profile`, `disconnect`, `list_profiles`, `save_profile`, `delete_profile`, `run_query` (+ `run_single_stmt`), `fetch_more`, `list_schema` (now feeds **frontend autocomplete**, decoupled from the lazy tree), `db_tree` (shallow), `table_detail` (per-relation detail on expand), `object_ddl` (Copy DDL), `export_to_file`, `import_rows`. `ConnectResult` carries `read_only` so the UI gates mutating menu items. Plugin init (opener, dialog). `is_cursorable` / `is_read_only_stmt` helpers. **All sidebar mutations reuse `run_query`** — no dedicated DDL-exec commands.
- **`db.rs`** — `ConnectionConfig`, `ConnState {client, cursor_open, read_only}`, `AppError` (rich error surfacing). `open()` = connect with TLS (`native-tls`, sslmode) + sets `default_transaction_read_only` when read-only. `collect_rows()` turns `simple_query` messages into `(columns, rows)` where **every value is text or NULL** (no per-type mapping — intentional, handles any type). `ident`/`create_table_text`/`copy_rows` for import.
- **`profiles.rs`** — saved connections. Metadata → `connections.json` in the app config dir; **password → OS keychain** (`keyring`, per-OS features), never plaintext, never sent to the frontend. `upsert`/`delete`/`load_all`/`get_password`.
- **`script.rs`** — SQL **script runner**. `split()` is a byte-level lexer handling `--` / `/* */` comments, `'…'` / `"…"` quotes, **dollar-quotes** (`$tag$`, distinguishes `$1`), and `COPY … FROM stdin` + `\.` data blocks. `run()` executes items in one transaction (rolls back + reports the failing statement); COPY blocks go through `copy_in`. `effective_start()` skips leading comments (so a COPY preceded by a `--` block is still detected).
- **`export.rs`** — **streaming export**. Server-side cursor, 10k-row batches, format each batch (CSV/TSV/JSON/SQL/Markdown), write to a file. File created lazily on first row (empty result → no file). Constant memory.
- **`tree.rs`** — introspection. `build_shallow()` = fast connect-time tree (`DbTree { database, databases, schemas[] }`, each schema's tables/views/sequences/functions as **name+kind stubs** + table comment; includes empty schemas). `table_detail(schema, name)` = lazy per-relation columns (with `is_pk`/`is_fk`/nullable/default/**comment**), indexes, constraints — resolves the relation's OID via a **parameterized** query, then drives detail queries by that trusted integer.
- **`ddl.rs`** — `object_ddl(kind, schema, name)` reconstructs runnable `CREATE` DDL from `pg_catalog` (pg_dump-style): tables (identity/generated/serial defaults; PK/unique/check inline; **FKs as trailing ALTERs**; plain indexes only — constraint-backed skipped; table+column comments), views/matviews (`pg_get_viewdef`), functions (`pg_get_functiondef`, overloads; aggregates/window flagged via `prokind`), sequences (`pg_sequences`). User input bound as params, then by OID. Out of scope: partitions, inheritance, RLS, triggers, storage params, tablespaces, collations.
- **`main.rs`** — `tusk_lib::run()`.

### Frontend — `src/`
- **`App.tsx`** — everything UI. Connect screen (saved-profile list + form). Workspace: topbar, **resizable** sidebar (`<Tree>` + **object filter** box), **resizable** editor/results split, virtualized result grid, statusbar with **Export** menu, **Import** modal. `doRun()` runs selection-or-whole through `run_query`. Owns the sidebar action layer: `menuItems(node)` (per-kind context menu), `runDDL()` (run a built statement → refresh tree/autocomplete/open details), `copyDDL()`, `editAsSql()`/`scaffoldEditor()` (insert into editor at cursor), the `tableDetail` cache + `loadDetail()`, and `activeDialog`/`menu` signals. `schema` (autocomplete list) + `details` come from `list_schema`/`table_detail`, not the tree.
- **`Tree.tsx`** — recursive explorer. Per-row right-click → `onContext(e, NodeDescriptor)`; click/right-click select (`onSelect` + `selectedKey`/`nodeKey`, drives the context-aware **＋** menu); lazy detail via `onExpandTable`; client-side `filter`. Relation expand keys are kind-prefixed (`tbl:`/`view:`) to avoid table/view collisions.
- **`ContextMenu.tsx`** / **`Dialog.tsx`** / **`WorkbenchDialogs.tsx`** — generic right-click menu; modal shell + `SqlPreview` + `DialogFooter` (live SQL + Cancel/Edit-as-SQL/primary); dispatcher rendering the form for the active `DialogState` (union with per-form payloads + closures).
- **`forms/*`** — one component per action (CreateTable, Column add/edit, **ModifyTable** = DataGrip-style diff editor, Index, Constraint, Schema, Database, Rename, Duplicate, Comment, generic Confirm for drop/truncate). Each owns local state, derives a live `createMemo` SQL preview, and calls back `onRun`/`onEditAsSql`. `ModifyTableForm` diffs an edited column list (+ index/constraint drops + table rename/comment) into the minimal `ALTER` script.
- **`SqlField.tsx`** — single-line CodeMirror with Postgres highlighting + autocomplete (types / functions / passed columns); used for type/default/expression fields in the create & modify dialogs.
- **`sql/ddl.ts`** — pure single-statement SQL builders (the heart of "build SQL in TS"). **`sql/ident.ts`** — `ident`/`qualify`/`lit` quoting, mirrors Rust `db::ident`.
- **`SqlEditor.tsx`** — CodeMirror 6. Dialect highlighting, **override autocomplete** (context-aware), live keyword auto-capitalization, **lint**, **Tab-only accept**. `EditorApi` exposes `getRunText`, **`insertAtCursor`**, `focus` (the value effect replaces the whole doc, so scaffolding uses `insertAtCursor` to avoid clobbering).
- **`sql/dialects.ts`** — per-dialect keyword/function/type lists + CodeMirror dialect. Postgres complete; **MySQL/SQLite/MSSQL staged** for future drivers.
- **`sql/completion.ts`** — the context-aware completion source: clause detection (tables after FROM/JOIN, columns after SELECT/WHERE/…), alias resolution (`u.` → that table's columns), schema qualification, ranked in-scope cols > tables > functions > keywords. `$` deliberately excluded from completion tokens.
- **`formats.ts`** — CSV/JSON parsing for **import** (export formatting now lives in Rust/`export.rs`).

## Gotchas (read before debugging)

- **Values are text.** `simple_query` returns everything as strings; `NULL` = `None`/`null`. Don't assume typed values.
- **Single statement vs script.** A single read statement streams to the grid via a server-side cursor; multiple statements or a COPY block run as a transactional script (summary, no grid). Routing is in `run_query` via `script::split`.
- **COPY detection ignores leading comments** (`effective_start`). pg_dump prefixes every COPY with a `--` block; missing this sends COPY to `batch_execute` → `CopyInResponse` → "unexpected message from server".
- **Keychain in dev:** unsigned `tauri dev` builds re-prompt / invalidate saved passwords across rebuilds (macOS ties items to the code signature). Seamless in signed release builds. `keyring` features are per-OS in `Cargo.toml`.
- **TLS:** `native-tls` (SecureTransport on mac, SChannel on Windows; needs OpenSSL on Linux). `sslmode`: `disable` | `prefer` (default) | `require` (encrypt, no cert verify) | `verify-full` (verify).
- **Read-only mode:** server `SET default_transaction_read_only = on` **and** a client-side write/DDL guard. The sidebar additionally disables mutating menu items (defense-in-depth) via `ConnectResult.read_only`.
- **Dropped connections auto-recover; query duration is never capped.** `ConnState` keeps the `ConnectionConfig` (incl. password — server-side only, never sent to the frontend); every query command calls `ensure_alive` (re-opens when `client.is_closed()`), and `run_query` retries once if a query dies mid-flight. So idle-timeout / server-restart heals on the next action. `db::open` sets a **10s `connect_timeout`** + **aggressive TCP keepalives** (`keepalives_idle` 5s, `keepalives_interval` 2s, `keepalives_retries` 3, `tcp_user_timeout` 15s) so a genuinely dead connection surfaces as `is_closed` in ~10-15s and the in-flight query errors — but a slow live query keeps getting ACKs and runs unbounded (no `tokio::time::timeout`). A re-open silently drops any open streaming cursor (`cursor_open` reset). The Run button shows a live elapsed counter (`runMs` + `fmtDur`).
- **Autocomplete corrupting dollar-quotes** was caused by Enter-accept + `$` tokens — fixed; keep accept Tab-only and `$` out of completion tokens.
- **Lazy tree ⇒ autocomplete uses `list_schema`, not the tree.** The shallow `db_tree` no longer carries columns, so autocomplete is fed by `list_schema` (one query). Expanding a node fetches `table_detail` (cached); after DDL, `runDDL`→`loadSchema` refetches the shallow tree + `list_schema` and re-fetches already-open details.
- **Sidebar DDL must stay single-statement where it matters.** `CREATE/DROP DATABASE` can't run in a transaction — keep them one statement (multi-statement input routes to `script::run`, which wraps in `BEGIN`). Builders in `sql/ddl.ts` emit one statement each (comma-separated ALTER actions, not `;`-joined); multi-statement cases (duplicate-with-data, column edit + rename) are intentionally table-only.
- **Copy DDL is reconstructed, not pg_dump.** Driven by OID; constraint-backed indexes are skipped and FKs deferred to trailing ALTERs so replay doesn't error. Partitions/inheritance/RLS/triggers/storage are out of scope (see `ddl.rs`).
- **Quoting parity.** `sql/ident.ts` must match Rust `db::ident` exactly (double `"`; literals double `'`). Always quote identifiers in generated SQL.
- **Never `::text`-cast a boolean in catalog queries.** `collect_rows` reads the text protocol: a *bare* bool comes back `"t"`/`"f"`, but `bool::text` (e.g. `i.indisunique::text`, `(con.oid IS NOT NULL)::text`) comes back `"true"`/`"false"`. The code compares against `"t"`, so a cast silently makes every check false. Select the bare bool (`i.indisunique`, `(NOT a.attnotnull)`). Char columns (`relkind`, `attidentity`, `contype`) DO need `::text`.

## Current state

Working Postgres client: connect (TLS, read-only, saved/keychain profiles), stream large results, CodeMirror editor with context-aware autocomplete + error highlighting, run multi-statement SQL scripts / `pg_dump` files, streaming multi-format export, CSV/JSON import via COPY, and a **full workbench sidebar** (lazy-loaded object tree + filter; right-click create/drop/rename/duplicate/alter/copy-DDL via form dialogs with live SQL preview; comments on hover/edit). Build is green. Committed on `master`. **After Rust changes, restart `npm run tauri dev`** then smoke-test the sidebar against a real DB (e.g. pagila).

## Roadmap / next

1. **Browse other databases** (reconnect on click — listed but not browsable).
2. **Richer sidebar metadata:** triggers, rules, row-count estimates, table/index sizes, FK target hints, view defs inline, partition info.
3. **Unified "Modify Table" editor** (diff-based multi-column alter in one dialog), and a referenced-table picker UX for FKs.
4. **Coverage:** MySQL / SQLite / MSSQL drivers behind a driver abstraction (autocomplete dialect specs already staged in `sql/dialects.ts`); `ddl.rs`/`sql/ddl.ts` are Postgres-specific and will need per-driver variants.
5. **AI:** text-to-SQL + explain/optimize.
6. **Distribution:** code signing (mac notarization, Windows cert).
7. Nice-to-haves: in-grid data editing, query history, multi-tab/multi-connection.

## License

MIT.
