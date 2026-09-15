# Contributing to Tusk

Thanks for your interest in Tusk! This document covers how to get a development
environment running, how the codebase is organized, and what a change needs
before it can merge.

## Development setup

**Prerequisites:** [Rust](https://rustup.rs) (stable) and Node 20+.

```sh
npm install
npm run tauri dev
```

That's it — no database server is required for a first run. Pick **DuckDB** or
**SQLite** on the connect screen and leave the path blank to get an in-memory
database.

Frontend changes hot-reload. **After any Rust change, restart
`npm run tauri dev`** — the backend does not hot-reload.

Platform notes:

- **Windows / macOS:** the system WebView (WebView2 / WKWebView) is already
  present; no extra setup.
- **Linux:** the Tauri v2 prerequisites plus OpenSSL and D-Bus headers. On
  Ubuntu/Debian: `sudo apt install build-essential curl pkg-config libssl-dev
  libdbus-1-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev patchelf file desktop-file-utils xdg-utils`; other distributions
  per the [Tauri docs](https://tauri.app/start/prerequisites/). Saved passwords
  need a running Secret Service (GNOME Keyring, KWallet, KeePassXC).
- **Keychain in dev:** unsigned dev builds may re-prompt for saved connection
  passwords across rebuilds on macOS (keychain items are bound to the code
  signature). This is expected and disappears in signed release builds.

## Where things live

| Area | Path |
|---|---|
| Frontend (SolidJS + CodeMirror 6) | `src/` |
| Backend (Rust, Tauri commands, drivers) | `src-tauri/src/` |
| In-app manual content | `src/help/content.ts` |
| User-facing release notes | `CHANGELOG.md` |
| Architecture deep-dive & invariants | `CLAUDE.md` |
| Longer-form docs (transactions, Slack, hardening) | `docs/` |

`CLAUDE.md` is the source of truth for architecture, invariants, and the
gotchas that will actually bite you (DuckDB parser-error poisoning, text-protocol
boolean casts, lexer parity between `script.rs` and `src/editor/lexer.ts`, …).
Read the relevant section before touching a subsystem.

## Validating a change

Run the gates that apply to what you touched — all of them must pass before a
change is considered done:

```sh
# Rust / backend changes
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo build --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D clippy::correctness -D clippy::suspicious
cargo test --locked --manifest-path src-tauri/Cargo.toml

# Frontend changes
npm run build
npm run typecheck
npx vitest run

# Version bumps
npm run check:versions
```

Driver or `driver.rs` changes additionally require the cross-engine
conformance suite:

```sh
# Embedded engines (DuckDB + SQLite) — no external services needed
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance

# Full four-engine matrix — spins up throwaway Postgres & MySQL Docker containers
scripts/conformance.sh
```

CI (`.github/workflows/validate.yml`) runs the full matrix on every PR:
frontend build/types/tests, Rust fmt/build/clippy/tests, four-engine
conformance, and dependency advisory/license/source checks.

## Conventions

- **Update `CHANGELOG.md` (`[Unreleased]`) with every change.** Entries are
  user-facing release notes, not commit summaries — each release section is
  published verbatim as the GitHub release body and shown in-app by the
  What's-new panel. Write *what changed and why* as
  `- **Lead sentence.** detail` bullets under `### Added` / `### Changed` /
  `### Fixed`.
- **The manual ships with the feature.** Any user-facing change also updates
  the affected facts in `src/help/content.ts` in the same change. Stale help is
  treated as a bug.
- **Never regress error surfacing.** Database errors must carry the real
  server message, not a generic "db error".
- Keep generated SQL identifier-quoted, and keep the TS/Rust parity pairs in
  sync when you touch either side (`src/editor/lexer.ts` ↔ `script.rs`,
  `src/formats.ts` ↔ `export.rs`, `src/ai/context.ts` ↔ `slack/context.rs`).

## Releases

Releases are built only by CI from a `v*` tag. Version numbers in
`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
`packaging/arch/PKGBUILD` and the first `<release>` of
`packaging/flatpak/com.willko.tusk.metainfo.xml` must match exactly
(`npm run check:versions`), and the tagged release's `CHANGELOG.md` section
becomes the GitHub release body — an empty section fails the release. CI builds
macOS (arm64, x64), Windows, and Linux x64 + arm64 (AppImage, `.deb`, `.rpm`,
built in an Ubuntu 22.04 container so they run on glibc 2.35+, plus a Flatpak
bundle on the GNOME 50 runtime), signs the updater artifacts, and drafts the
release. Every push to `master` also builds the unsigned Linux bundles and the
Flatpaks and keeps them as workflow artifacts for a week, so a Linux change can
be tried before it is tagged.

After the draft is **published**:

- `.github/workflows/aur.yml` pushes `packaging/arch/PKGBUILD` (checksums
  filled in) and a fresh `.SRCINFO` to the `tusk-bin` AUR package. It needs the
  `AUR_SSH_PRIVATE_KEY`, `AUR_USERNAME` and `AUR_EMAIL` repository secrets — an
  AUR account whose SSH key is registered at aur.archlinux.org — and skips
  itself, with a note in the log, until they exist.
- Flathub is manual: `node scripts/flathub-manifest.mjs vX.Y.Z` prints the
  manifest with the release's `.deb` URLs and checksums; submit it to
  [flathub/flathub](https://github.com/flathub/flathub) per the
  [submission guide](https://docs.flathub.org/docs/for-app-authors/submission)
  the first time, then update the app's Flathub repository each release.

## Questions / bugs

Open a [GitHub issue](https://github.com/willkoman/tusk/issues). For crashes,
Tusk offers an opt-in crash report on the next launch you can paste in —
nothing is ever transmitted automatically.
