<div align="center">

# 🐘 Tusk

**A fast, native, lightweight database client.**

Postgres-first — built to replace the clunk of pgAdmin and the resource weight of DataGrip.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Backend: Rust](https://img.shields.io/badge/Backend-Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Frontend: SolidJS](https://img.shields.io/badge/Frontend-SolidJS-2C4F7C?logo=solid&logoColor=white)](https://www.solidjs.com)
[![Databases](https://img.shields.io/badge/DBs-Postgres%20·%20DuckDB%20·%20SQLite%20·%20MySQL-336791)](#supported-databases)

</div>

Tusk launches in well under a second on near-native memory, streams million-row tables without choking, and ships as a small installer — **no bundled browser**.

> **Status:** actively developed, Postgres-first. DuckDB, SQLite, and MySQL also supported. Builds are currently unsigned.

---

## Why Tusk

- **Fast & light** — Rust + Tauri on the system WebView, not Electron or the JVM. Instant startup, low RAM, tiny installer.
- **Handles big results** — server-side cursor streaming plus a two-axis virtualized grid that renders only what's visible. Millions of rows scroll smoothly where pgAdmin/DBeaver stall.
- **A premium SQL editor** — CodeMirror 6 with context-aware, dialect-aware autocomplete, layered linting, auto-folding of large literals, and one-key formatting.
- **A real workbench** — lazy-loaded schema tree with right-click create/alter/drop/rename/duplicate, Copy-DDL, EXPLAIN visualization, an ERD viewer, query history, and a command palette.
- **Edit data inline** — tweak cells, insert and delete rows directly in the grid; Tusk builds the `UPDATE`/`INSERT`/`DELETE` for you and shows it before anything runs.
- **Secure by default** — connection passwords (and AI keys) live in the OS keychain, never in plaintext. An opt-in read-only mode is enforced on **both** the server and the client.

---

## Features

### ✍️ Editor

- **Context-aware autocomplete** — tables after `FROM`/`JOIN`, columns after `SELECT`/`WHERE`, alias resolution (`u.` → that table's columns), schema qualification, inline column types, and FK-aware `JOIN` hints.
- **Layered linting** — a fast client-side heuristic + schema checks, plus a server-side `PREPARE`-only validator (never executes) for parser-grade diagnostics.
- **Live keyword auto-capitalization**, SQL formatting, auto-fold of large inline literals, code folding, multi-cursor, and search.
- **Tabbed editor** with per-tab buffers and results; open & save `.sql` files; per-tab active-schema (`search_path`) selector.
- **Command palette** and fully **rebindable keyboard shortcuts** — a single action registry drives the editor keymap, global keys, and Settings.

| Action | Shortcut |
|---|---|
| Accept completion | `Tab` or `Enter` |
| Run (selection or whole buffer) | `⌘ / Ctrl` + `Enter` |
| Run current statement | `⌘ / Ctrl` + `Shift` + `Enter` |

### 📊 Results

- **Streaming, two-axis virtualized grid** (millions of rows) with a live "Load all" drain.
- **In-grid editing** — edit cells, insert rows, and mark deletes directly in the grid. Pending edits overlay the snapshot without mutating it; commit builds `UPDATE`/`DELETE`/`INSERT` from the original row values and confirms before running. (Plain select-lists only, gated on your actual write privileges.)
- **Server-side sort & filter** — re-runs the query wrapped, not just the loaded page.
- **Multi-format copy** — TSV / CSV / JSON / Markdown (column names off by default, toggle in the status bar); copy cell / column / value.
- **Cancel a running query** from the Run button — it turns into a red ✕ Cancel with a live timer (sends a real Postgres `CancelRequest`).
- **Query history** — per-connection, file-backed, so your recent runs survive restarts.

### 🗂️ Schema workbench

- **Lazy-loaded object tree** (tables, views, sequences, functions) with a filter box and on-expand detail: columns, PK/FK, indexes, constraints, comments, plus planner row-count & size estimates and triggers on Postgres.
- **Right-click / `＋`-menu DDL** — create/alter/drop/rename/duplicate tables, columns, indexes, constraints, schemas, databases; edit comments. Each is a form dialog with a **live SQL preview** and an "edit as SQL" escape hatch.
- **Copy DDL** — reconstructs runnable `CREATE` statements from `pg_catalog`, pg_dump-style.
- **EXPLAIN visualization** — renders query plans as a tidy, pan/zoom tree (per-engine parsers; unparseable plans fall back to clean monospace).
- **ERD / relationship viewer** — a deterministic, cluster-first diagram that groups related tables into families by shared name prefix and draws FK edges.
- DDL actions are gated on your **actual Postgres privileges** (ownership / `CREATE` / role attributes), with read-only winning.

### 🔁 Import / Export

- **Streaming export** to CSV / TSV / JSON / SQL (`INSERT`/`CREATE`) / **xlsx** — constant-memory (xlsx streams each sheet to a tempfile, and rolls past 1,048,576 rows into new sheets), with delimiter / quoting / null / header / line-ending / column-projection controls.
- **CSV / JSON import** via Postgres `COPY` (create-or-append, transactional).

### 🤖 AI assistant

- A context- & schema-aware chat panel — **Anthropic · OpenAI (and OpenAI-compatible / local) · Gemini** — that knows your dialect, a token-budgeted schema summary, your role's privileges, the active schema, and the current editor SQL / selection / last error.
- Quick **Explain** / **Fix error** actions. Generated SQL gets an "Open in editor" button — **nothing ever auto-runs**. The API key stays in the OS keychain, never in the WebView.

### 🔌 Connections

- **Saved profiles** with OS-keychain credentials (macOS Keychain · Windows Credential Manager · Linux Secret Service).
- **TLS** with `sslmode` (`disable` / `prefer` / `require` / `verify-full`), aggressive keepalives, and **automatic reconnect** on dropped connections.
- **Read-only mode** — server `default_transaction_read_only` plus a client-side write/DDL guard.

---

## Supported databases

| Engine | How | Notes |
|---|---|---|
| **PostgreSQL** 🐘 | `tokio-postgres` (text protocol) | Most complete — DDL builders, Copy-DDL, server-lint, import, in-grid editing, and streaming export are Postgres paths |
| **DuckDB** 🦆 | embedded (`duckdb`, bundled) | File or in-memory; query, stream, introspect |
| **SQLite** 🪶 | embedded (`rusqlite`, bundled) | File or in-memory; query, stream, introspect |
| **MySQL** 🐬 | network (`mysql_async`) | Connect, stream, introspect; newer and less battle-tested |

The connect screen has a driver picker; the brand mascot, window title, and editor dialect follow the connected engine. Postgres-only actions (import/export, Copy-DDL, sidebar DDL) are hidden on engines that don't support them.

---

## Tech stack

- **Shell:** Tauri v2 (system WebView2 / WKWebView — no bundled browser)
- **Frontend:** SolidJS · TypeScript · Vite · CodeMirror 6 · `sql-formatter`
- **Backend:** Rust · `tokio-postgres` · `duckdb` · `rusqlite` · `mysql_async` · `native-tls` · `keyring` · `reqwest` · `rust_xlsxwriter`

---

## Getting started (development)

**Prerequisites:** [Rust](https://rustup.rs) and Node 20+. A database is optional for a first run — you can connect to DuckDB or SQLite **in-memory** with no server.

```sh
npm install
npm run tauri dev
```

Pick a driver, then connect:
- **Postgres / MySQL:** host / port / user / password / database
- **DuckDB / SQLite:** a file path, or blank for in-memory

Save a profile to keep credentials in your OS keychain.

> **Note:** unsigned `tauri dev` builds re-prompt for keychain passwords across rebuilds (macOS binds keychain items to the code signature). This is seamless in signed release builds.

### Validating changes

```sh
cargo build --manifest-path src-tauri/Cargo.toml   # backend
npm run build                                       # frontend bundle (+ type-check)
npx tsc --noEmit -p tsconfig.json                   # frontend types
npx vitest run                                      # unit tests
```

Driver conformance:

```sh
# embedded drivers (DuckDB, SQLite)
cargo test --manifest-path src-tauri/Cargo.toml --lib driver_conformance

# full matrix (Postgres, MySQL, DuckDB, SQLite)
scripts/conformance.sh
```

---

## Building installers

Installers are produced in CI (cross-compiling locally is impractical). Push a `v*` tag:

```sh
git tag v0.4.0 && git push origin v0.4.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds **macOS** (separate Apple-Silicon `aarch64` and Intel `x64` DMGs) and **Windows** (NSIS per-user `.exe` + `.msi`) and drafts a GitHub release. The workflow also builds on `master` pushes (compile-only) to keep the Rust dependency cache warm so tagged releases skip the cold recompile.

Builds are currently **unsigned** (SmartScreen / Gatekeeper click-through) until a signing certificate is added.

---

## Project layout

```
src/                  SolidJS frontend
  App.tsx             workspace shell — connect screen, sidebar, editor tabs, grid, status bar
  SqlEditor.tsx       CodeMirror 6 composer
  editor/             editor extensions — lexer, linting, auto-fold, format, store, tabs
  ResultGrid.tsx      virtualized result grid (copy, sort/filter, selection, in-grid editing)
  Tree.tsx            schema sidebar
  forms/              DDL form dialogs + the export configurator
  sql/                dialects, context-aware completion, DDL builders, identifier quoting
  grid/               editable-target logic + server-side sort/filter query wrapping
  plan/               EXPLAIN plan parsing + tidy-tree visualization
  relviz/             relationship / ERD viewer
  history/            per-connection query history
  ai/                 AI assistant panel + schema-aware context builder
  actions.ts          single registry of user actions (keymap, palette, settings)
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

> A deeper architecture tour — query-execution model, the editor's lexer-parity guarantees, in-grid edit safety invariants, and per-driver notes — lives in [`CLAUDE.md`](CLAUDE.md).

---

## Roadmap

**Done**
- [x] Streaming, virtualized result grid with server-side sort/filter and multi-format copy
- [x] In-grid data editing (cell edit, insert, delete) with confirm-before-run
- [x] CodeMirror editor — context-aware autocomplete, layered lint, format, auto-fold, tabs, open/save `.sql`
- [x] Schema workbench — lazy tree + right-click DDL dialogs with live preview, Copy-DDL, comments
- [x] EXPLAIN plan visualization + ERD / relationship viewer
- [x] Query history, command palette, and rebindable shortcuts
- [x] Streaming export (CSV/TSV/JSON/SQL/xlsx) + CSV/JSON import
- [x] Four drivers — PostgreSQL, DuckDB, SQLite, MySQL
- [x] TLS + read-only mode, automatic reconnect
- [x] Postgres permission model gating sidebar DDL
- [x] AI assistant — schema-aware text-to-SQL / explain / fix
- [x] Cancel a running query
- [x] CI installer pipeline — macOS (arm64 + x64) and Windows (NSIS + MSI)

**Next**
- [ ] Browse other databases (reconnect on click)
- [ ] Richer sidebar metadata — rules, FK hints, inline view defs, partition info
- [ ] Unified diff-based "Modify Table" editor (multi-column alter)
- [ ] MSSQL driver (dialect already staged) + per-driver DDL builders
- [ ] Optimistic-concurrency edits · PG notices · multi-connection workspaces
- [ ] Code signing (mac notarization, Windows cert) + auto-update

See [CHANGELOG.md](CHANGELOG.md) for detail.

---

## License

[MIT](LICENSE)
