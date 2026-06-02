# 🐘 Tusk

A fast, native, lightweight **database client** — Postgres-first, built to replace the clunk of pgAdmin and the resource weight of DataGrip.

Tusk launches in well under a second on near-native memory, streams million-row tables without choking, and ships as a ~5 MB installer (no bundled browser).

> **Status:** early development, Postgres-first. Actively built.

## Why

- **Fast & light** — Rust + Tauri on the system WebView, not Electron or the JVM. Instant startup, low RAM, tiny installer.
- **Handles big results** — server-side cursor streaming plus a virtualized grid that renders only what's visible; millions of rows scroll smoothly where pgAdmin/DBeaver stall.
- **Premium SQL editor** — CodeMirror 6 with a context-aware, dialect-aware autocomplete engine.
- **Secure by default** — connection passwords live in the OS keychain, never in plaintext.

## Features

- Streaming, virtualized result grid (millions of rows)
- Context-aware SQL autocomplete — tables after `FROM`/`JOIN`, columns after `SELECT`/`WHERE`, alias resolution (`u.` → that table's columns), schema qualification, inline column types
- Multi-dialect engine (Postgres complete; MySQL / SQLite / MSSQL staged)
- Live keyword auto-capitalization, **Tab** to accept, **⌘/Ctrl+Enter** to run
- Saved connections with OS-keychain credentials (macOS Keychain · Windows Credential Manager · Linux Secret Service)
- Schema sidebar — click a table to query it

## Tech stack

- **Shell:** Tauri v2 (system WebView2 / WKWebView — no bundled browser)
- **Frontend:** SolidJS · TypeScript · CodeMirror 6
- **Backend:** Rust · tokio-postgres (text-protocol streaming)

## Getting started (development)

Prerequisites: [Rust](https://rustup.rs), Node 20+, and a reachable PostgreSQL instance.

```sh
npm install
npm run tauri dev
```

Connect with host / port / user / password / database, or save a profile (password optional, stored in your OS keychain).

## Building installers

Installers are produced in CI (cross-compiling from macOS is impractical). Push a tag:

```sh
git tag v0.1.0 && git push --tags
```

GitHub Actions builds macOS (universal) and Windows (NSIS, per-user, no admin) installers and opens a **draft** release. See [`.github/workflows/release.yml`](.github/workflows/release.yml). Builds are currently **unsigned** (SmartScreen / Gatekeeper click-through) until a signing certificate is added.

## Project layout

```
src/                  SolidJS frontend
  App.tsx             workspace — connections, grid, schema sidebar
  SqlEditor.tsx       CodeMirror editor — keymaps, keyword auto-caps
  sql/
    dialects.ts       per-dialect keywords / functions / types
    completion.ts     context-aware completion engine
src-tauri/src/
  lib.rs              Tauri commands + connection registry
  db.rs               connect / query / cursor streaming
  profiles.rs         saved connections + OS keychain
```

## Roadmap

**Done**
- [x] Streaming, virtualized result grid
- [x] CodeMirror editor + context-aware, multi-dialect autocomplete
- [x] Saved connections + OS-keychain credentials
- [x] Windows + macOS installer pipeline (CI)

**Next**
- [ ] Schema refresh + table previews (expandable sidebar, auto-refresh after DDL)
- [ ] Editor QoL — open `.sql` files, run selection vs whole statement, auto-close brackets/quotes
- [ ] Coverage — MySQL / SQLite / MSSQL drivers behind a `Driver` trait (autocomplete dialects already staged)
- [ ] TLS for remote servers + read-only safety mode
- [ ] AI — text-to-SQL + explain / optimize
- [ ] Auto-update + code signing

See [CHANGELOG.md](CHANGELOG.md) for detail.

## License

MIT
