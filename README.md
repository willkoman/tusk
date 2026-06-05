# 🐘 Tusk

A fast, native, lightweight **database client** — Postgres-first, built to replace the clunk of pgAdmin and the resource weight of DataGrip.

Tusk launches in well under a second on near-native memory, streams million-row tables without choking, and ships as a small installer (no bundled browser).

> **Status:** actively developed, Postgres-first. DuckDB, SQLite, and MySQL also supported. Builds are currently unsigned.

## Why

- **Fast & light** — Rust + Tauri on the system WebView, not Electron or the JVM. Instant startup, low RAM, tiny installer.
- **Handles big results** — server-side cursor streaming plus a virtualized grid that renders only what's visible; millions of rows scroll smoothly where pgAdmin/DBeaver stall.
- **Premium SQL editor** — CodeMirror 6 with context-aware, dialect-aware autocomplete, layered linting, auto-folding of large literals, and formatting.
- **A real workbench** — lazy-loaded schema tree with right-click create/alter/drop/rename/duplicate, Copy-DDL, and comments, all via form dialogs with a live SQL preview.
- **Secure by default** — connection passwords (and AI keys) live in the OS keychain, never in plaintext; an opt-in read-only mode is enforced on both the server and the client.

## Features

**Editor**
- Context-aware autocomplete — tables after `FROM`/`JOIN`, columns after `SELECT`/`WHERE`, alias resolution (`u.` → that table's columns), schema qualification, inline column types
- Layered linting — fast client-side heuristic + schema checks, plus a server-side `PREPARE`-only validator (never executes) for parser-grade diagnostics
- Live keyword auto-capitalization, SQL formatting, auto-fold of large inline literals, code folding, multi-cursor, search
- **Tab or Enter** to accept a completion · **⌘/Ctrl+Enter** to run (selection or whole buffer) · **⌘/Ctrl+Shift+Enter** runs the current statement
- Tabbed editor with per-tab buffers and results; open & save `.sql` files; per-tab active-schema (`search_path`) selector

**Results**
- Streaming, two-axis virtualized grid (millions of rows) with a live "Load all" drain
- Server-side sort & filter (re-runs the query wrapped, not just the loaded page)
- Multi-format copy — TSV / CSV / JSON / Markdown (column names off by default, with a status-bar toggle); copy cell / column / value
- Cancel a running query from the Run button (it turns into a red ✕ Cancel with a live timer)

**Schema workbench**
- Lazy-loaded object tree (tables, views, sequences, functions) with a filter box and on-expand detail (columns, PK/FK, indexes, constraints, comments)
- Right-click / `＋`-menu DDL — create/alter/drop/rename/duplicate tables, columns, indexes, constraints, schemas, databases; edit comments — each a form dialog with a live SQL preview and "edit as SQL" escape hatch
- **Copy DDL** — reconstructs runnable `CREATE` statements from `pg_catalog` (pg_dump-style)
- DDL actions are gated on your actual Postgres privileges (ownership / `CREATE` / role attributes), with read-only winning

**Import / Export**
- Streaming, options-driven export to CSV / TSV / JSON / SQL (`INSERT`/`CREATE`) / **xlsx** — constant-memory (including xlsx, which streams each sheet to a tempfile), with delimiter / quoting / null / header / line-ending / column-projection controls
- CSV / JSON import via Postgres `COPY` (create-or-append, transactional)

**AI assistant**
- A context- & schema-aware chat panel (Anthropic · OpenAI & OpenAI-compatible/local · Gemini) that knows your dialect, a token-budgeted schema summary, your role's privileges, the active schema, and the current editor SQL / selection / last error
- Quick **Explain** / **Fix error** actions; generated SQL gets an "Open in editor" button — nothing ever auto-runs. The API key stays in the OS keychain, never in the WebView

**Connections**
- Saved profiles with OS-keychain credentials (macOS Keychain · Windows Credential Manager · Linux Secret Service)
- TLS with `sslmode` (`disable` / `prefer` / `require` / `verify-full`), aggressive keepalives, and automatic reconnect on dropped connections
- Read-only mode (server `default_transaction_read_only` + a client-side write/DDL guard)

## Supported databases

| Engine | How | Notes |
|---|---|---|
| **PostgreSQL** 🐘 | `tokio-postgres` (text protocol) | Most complete — DDL builders, Copy-DDL, server-lint, import, and streaming export are Postgres paths |
| **DuckDB** 🦆 | embedded (`duckdb`, bundled) | File or in-memory; query, stream, introspect |
| **SQLite** 🪶 | embedded (`rusqlite`, bundled) | File or in-memory; query, stream, introspect |
| **MySQL** 🐬 | network (`mysql_async`) | Connect, stream, introspect; newer and less battle-tested |

The connect screen has a driver picker; the brand mascot, window title, and editor dialect follow the connected engine. Postgres-only actions (import/export, Copy-DDL) are hidden on engines that don't support them.

## Tech stack

- **Shell:** Tauri v2 (system WebView2 / WKWebView — no bundled browser)
- **Frontend:** SolidJS · TypeScript · Vite · CodeMirror 6
- **Backend:** Rust · `tokio-postgres` · `duckdb` · `rusqlite` · `mysql_async` · `native-tls` · `keyring` · `reqwest`

## Getting started (development)

Prerequisites: [Rust](https://rustup.rs) and Node 20+. A database is optional for a first run — you can connect to DuckDB or SQLite **in-memory** with no server.

```sh
npm install
npm run tauri dev
```

Pick a driver, then connect (Postgres/MySQL: host / port / user / password / database; DuckDB/SQLite: a file path, or blank for in-memory). Save a profile to keep credentials in your OS keychain.

Validate after changes:

```sh
cargo build --manifest-path src-tauri/Cargo.toml   # backend
npm run build                                       # frontend bundle (+ type-check)
npx tsc --noEmit -p tsconfig.json                   # frontend types
```

## Building installers

Installers are produced in CI (cross-compiling locally is impractical). Push a `v*` tag:

```sh
git tag v0.2.4 && git push origin v0.2.4
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds **macOS** (separate Apple-Silicon `aarch64` and Intel `x64` DMGs) and **Windows** (NSIS per-user `.exe` + `.msi`) and drafts a GitHub release. The workflow also builds on `master` pushes (compile-only) to keep the Rust dependency cache warm so tagged releases skip the cold recompile. Builds are currently **unsigned** (SmartScreen / Gatekeeper click-through) until a signing certificate is added.

## Project layout

```
src/                  SolidJS frontend
  App.tsx             workspace shell — connect screen, sidebar, editor tabs, grid, status bar
  SqlEditor.tsx       CodeMirror 6 composer
  editor/             editor extensions — lexer, linting, auto-fold, format, store, tabs
  ResultGrid.tsx      virtualized result grid (copy, sort/filter, selection)
  Tree.tsx            schema sidebar
  forms/              DDL form dialogs + the export configurator
  sql/                dialects, context-aware completion, DDL builders, identifier quoting
  ai/                 AI assistant panel + schema-aware context builder
  formats.ts          clipboard + import formatting
src-tauri/src/
  lib.rs              Tauri commands + connection registry
  driver.rs           driver abstraction (Postgres / DuckDB / SQLite / MySQL)
  db.rs               Postgres connect / TLS / text-protocol row collection
  tree.rs             schema introspection
  ddl.rs              Copy-DDL reconstruction from pg_catalog
  export.rs           streaming, options-driven multi-format export
  script.rs           SQL script splitter / transactional runner
  perms.rs            Postgres effective-privilege model
  ai.rs               AI provider proxy (streaming SSE)
  profiles.rs         saved connections + OS keychain
```

## Roadmap

**Done**
- [x] Streaming, virtualized result grid with server-side sort/filter and multi-format copy
- [x] CodeMirror editor — context-aware autocomplete, layered lint, format, auto-fold, tabs, open/save `.sql`
- [x] Schema workbench — lazy tree + right-click DDL dialogs with live preview, Copy-DDL, comments
- [x] Streaming export (CSV/TSV/JSON/SQL/xlsx) + CSV/JSON import
- [x] Four drivers — PostgreSQL, DuckDB, SQLite, MySQL
- [x] TLS + read-only mode, automatic reconnect
- [x] Postgres permission model gating sidebar DDL
- [x] AI assistant — schema-aware text-to-SQL / explain / fix
- [x] Cancel a running query
- [x] CI installer pipeline — macOS (arm64 + x64) and Windows (NSIS + MSI)

**Next**
- [ ] Browse other databases (reconnect on click)
- [ ] Richer sidebar metadata — triggers, row-count/size estimates, partitions, inline view defs
- [ ] Unified diff-based "Modify Table" editor
- [ ] MSSQL driver (dialect already staged)
- [ ] In-grid data editing · query history
- [ ] Code signing (mac notarization, Windows cert) + auto-update

See [CHANGELOG.md](CHANGELOG.md) for detail.

## License

MIT
