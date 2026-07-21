# Adversarial hardening ledger

This ledger records the guarantees and remaining limits of the input-hardening pass. It does not claim exhaustive coverage of every possible byte sequence or database/provider behavior. Tests use deterministic boundary matrices, malformed corpora, cross-engine conformance, compiler checks, and independent diff review.

## Enforced boundaries

- Query page sizes are `1..=50,000`; SQL, file, history, IPC table, import, clipboard, plan, AI, Slack, and ERD payloads have explicit byte/count/depth ceilings.
- Ragged tables, invalid projections, unknown drivers/TLS modes/wires/formats, malformed persistence, non-object JSON imports, invalid ports, and unterminated delimited fields return errors or bounded defaults.
- Writable or ambiguous queries are never replayed after a dropped connection. Read-only classification rejects writable CTEs, row locks, and MySQL file-output forms.
- Slack approvals are requester/channel/TTL/allowlist checked, pin a connection and database, and execute on a fresh read-only backend. Results page under cell/byte budgets and retained exports have count/byte caps.
- Keyed AI requests require HTTPS, do not follow redirects, and bound request, response, SSE-line, and generated-output sizes. Premature or provider-error streams cannot become silent success.
- Editor saves, exports, histories, profiles, and Slack settings use atomic sibling-file replacement. Existing destination permissions are copied before replacement.
- Async imports, clipboard reads, filters, metadata loads, dialogs, and timers verify their originating tab/result/connection before writing state.
- Completed base results may sort locally through canonical row indices. Pending edits, deletes, paste, copy, and loaded export map through those stable identities.

## Verified 2026-07-16

- `cargo build --manifest-path src-tauri/Cargo.toml`
- `npm run build`
- `npx tsc --noEmit -p tsconfig.json`
- `npx vitest run`: 267 tests passed
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 99 tests passed
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- Four-engine conformance with throwaway PostgreSQL 16 and MySQL 8 containers plus embedded DuckDB/SQLite: 14 tests passed

## Residual risks

- Result values do not carry portable type/collation metadata. Local grid sort is deterministic text ordering with engine-specific NULL placement, not guaranteed native numeric, date, locale, or collation ordering. Use SQL `ORDER BY` for server semantics.
- Tauri/WebView deserializes an IPC message before Rust command validators run. Normal UI paths reject oversized input before invoke, but a compromised renderer can still force one whole message allocation. Truly unbounded imports require a future file-streaming IPC design.
- Database drivers must allocate an individual returned cell before Tusk can inspect its length. Slack pages rows and applies live aggregate budgets, but a server expression returning one enormous value can still allocate inside the driver first.
- DuckDB/SQLite execution is synchronous. A pathological embedded query cannot be preempted by Tokio timeout; this is unchanged for UI and Slack. File-backed Slack reads are isolated read-only, while in-memory embedded Slack execution is refused because a second connection would target a different database.
- A user-configured custom HTTPS AI base intentionally receives that provider's saved key. HTTPS and redirect blocking prevent downgrade/cross-origin redirect leakage, but per-origin key grants are not yet modeled.
- `read_text_file` and `write_text_file` accept paths supplied over IPC because native Open/Save dialogs need arbitrary user-selected files. Tauri capability isolation remains the renderer-compromise boundary; there is no app-managed directory sandbox.
- MySQL DDL implicitly commits and cannot provide cross-statement atomicity even when Tusk wraps a script transaction.
- Component-level automation does not yet simulate every tab switch/disconnect during native dialogs and clipboard operations. Pure state cores and generation guards are covered; manual WebView smoke tests remain useful.
- LocalStorage text is returned by the WebView before JavaScript can check its length. Parsing and reserialization are bounded, but retrieval itself is controlled by the WebView storage quota rather than Tusk.
