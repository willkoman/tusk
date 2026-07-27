# Adversarial hardening ledger

This ledger records the guarantees and remaining limits of the input-hardening pass. It does not claim exhaustive coverage of every possible byte sequence or database/provider behavior. Tests use deterministic boundary matrices, malformed corpora, cross-engine conformance, compiler checks, and independent diff review.

## Enforced boundaries

- Query page sizes are `1..=50,000`; SQL and editor text files cap at 20 MiB. A query page caps at 50,000 rows, 10,000 columns, 2,000,000 cells, 1 MiB per value, and 64 MiB total. Inline IPC tables cap at 200,000 rows under the same column/cell/value/aggregate limits.
- Catalog reads cap at 100,000 rows; normal metadata keeps the 1 MiB cell/64 MiB aggregate budgets. DDL metadata permits 8 MiB cells but caps at 32 MiB, and reconstructed DDL caps at 20 MiB.
- Clipboard formatting caps at 200,000 rows, 10,000 columns, 2,000,000 cells, 1,000,000 characters per field, and 64 MiB output. Grid copy adds a stricter 1,000,000-cell/8,388,608-character source gate. One edit action may target at most 100,000 rows.
- Export validates columns, projections, row shape, and options before replacement: 10,000 columns, 1 MiB per name/value, 8 MiB total column metadata, and 64 MiB for buffered attachments. JSON object exports require unique column names. Empty results still create a valid configured artifact.
- Plans cap at 2,000 nodes, depth 256, 5,000,000 JSON characters, 256 properties per node, and bounded labels/properties. Whole-schema ERDs cap at 600 tables, 4,000 edges, 50,000 total columns (2,048 per table); neighborhood graphs cap at 500 edges.
- Skills cap at 256 regular Markdown files of 256 KiB each (plus field/id limits). Frontend/native crash reports cap at 96,000 bytes/128 KiB. Skill and crash storage rejects symlinks/reparse points and writes atomically with restrictive Unix permissions.
- AI input and generated output each cap at 4 MiB, SSE lines at 1 MiB, and model-list bodies at 5 MiB. Keyed requests require HTTPS, never follow redirects, and keys are bound to an explicitly approved origin; legacy keys are accepted only at the shipped provider origin. Premature/error streams cannot become silent success.
- Slack pending proposals cap at 64 entries, 512 KiB each, and 4 MiB total. Live results cap at 2,000,000 cells, 1 MiB per value, and 48 MiB; retained results cap at eight entries/64 MiB and 15 minutes. User-configured file results cap at 100,000 rows.
- Ragged tables, invalid projections, duplicate JSON keys/columns, malformed quoted fields, unknown drivers/TLS modes/wires/formats, malformed persistence, invalid ports, psql meta-commands, and unterminated `COPY FROM stdin` data fail with bounded errors.
- No statement is replayed after a dropped connection: read syntax may call volatile or external functions. Read-only classification rejects writable CTEs, row locks, file/table output, `set_config`, and `EXPLAIN ANALYZE`.
- Manual transaction scripts are engine-lexed and lifecycle-preflighted before their first statement. One bounded owner id controls the physical session across runs; non-owner queries and session-backed metadata fail closed. Every response carries authoritative transaction state, and result/pending-edit provenance is bound to transaction id plus revision so a commit, rollback, rollback-to, or lost session cannot leave an editable stale snapshot.
- Slack approvals use random opaque IDs and verify requester, allowlists, TTL, workspace, channel, thread, exact message, connection, and database. Approved SQL executes on a fresh read-only backend and passes a conservative deterministic-function allowlist at proposal and execution time.
- Editor saves, exports, histories, profiles, Slack settings, skills, and crash reports use atomic sibling-file replacement. Existing destination permissions are copied where appropriate; export destinations are replaced only after file sync and successful query/format completion.
- Async imports, clipboard reads, filters, metadata loads, saves, dialogs, queries, exports, histories, and timers verify their originating connection/tab/result generation before writing state. Recovery writes are read-back verified, and dirty tabs remain open if persistence fails.
- Completed base results may sort locally through canonical row indices. Pending edits, deletes, paste, copy, and loaded export map through those stable identities.

## Editor degradation

- Above 1,000,000 document characters, run/open/save remain available, but live lint, server lint, statement decorations, keyword capitalization, and fold discovery stop; Format returns the document unchanged.
- Below that threshold, live work still caps at 200 diagnostics, 2,000 statements, 1,000 fold candidates, 2,000 active-statement lines, 5,000 schema tables, 50,000 schema columns, and bounded suggestion pools/runs.

## Verification gates

- Frontend: `npm run check:versions`, `npm run build`, `npm run typecheck`, `npx vitest run`.
- Rust: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, locked build/test, and clippy with correctness/suspicious warnings denied.
- Drivers: locked embedded conformance plus `scripts/conformance.sh` against digest-pinned PostgreSQL 16/MySQL 8 containers with bounded startup waits.
- Dependencies: `npm audit --audit-level=high`, production JS license checks, and `cargo deny` advisories/licenses/sources.
- CI runs these gates with read-only permissions on default-branch pushes, pull requests, manual dispatch, and weekly schedule. Do not copy historical pass counts into this ledger; use the workflow run for the audited revision.

## Residual risks

- Result values do not carry portable type/collation metadata. Local grid sort is deterministic text ordering with engine-specific NULL placement, not guaranteed native numeric, date, locale, or collation ordering. Use SQL `ORDER BY` for server semantics.
- Tauri/WebView deserializes an IPC message before Rust command validators run. Normal UI paths reject oversized input before invoke, but a compromised renderer can still force one whole message allocation. Truly unbounded imports require a future file-streaming IPC design.
- Database drivers must allocate an individual returned cell before Tusk can inspect its length. Slack pages rows and applies live aggregate budgets, but a server expression returning one enormous value can still allocate inside the driver first.
- DuckDB/SQLite execution is synchronous. A pathological embedded query cannot be preempted by Tokio timeout; this is unchanged for UI and Slack. File-backed Slack reads are isolated read-only, while in-memory embedded Slack execution is refused because a second connection would target a different database.
- A deliberately approved custom HTTPS origin receives that provider's key and database context. Origin approval is per provider and exact origin, not per path; every path on an approved origin is inside that trust boundary. DNS rebinding, a compromised approved host, or a malicious same-origin reverse proxy remain outside Tusk's control.
- `read_text_file` and `write_text_file` accept paths supplied over IPC because native Open/Save dialogs need arbitrary user-selected files. Tauri capability isolation remains the renderer-compromise boundary; there is no app-managed directory sandbox.
- MySQL DDL implicitly commits and nontransactional tables cannot provide rollback guarantees even when Tusk wraps an ordinary script transaction. Tusk blocks recognized implicit-commit DDL and indirect transaction controls inside a tracked manual transaction, but it cannot make a nontransactional storage engine atomic.
- DuckDB has no savepoints or `SET TRANSACTION`; SQLite has no `SET TRANSACTION`. Those forms are rejected during transaction preflight before earlier statements in the same script can run.
- A dropped or unexpectedly ended manual transaction is marked lost and never reconnected or replayed. Its commit state may be unknowable; only disconnect/reconnect plus database verification can recover.
- Component-level automation does not yet simulate every tab switch/disconnect during native dialogs and clipboard operations. Pure state cores and generation guards are covered; manual WebView smoke tests remain useful.
- LocalStorage text is returned by the WebView before JavaScript can check its length. Parsing and reserialization are bounded, but retrieval itself is controlled by the WebView storage quota rather than Tusk.
