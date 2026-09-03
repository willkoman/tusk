// Static knowledge-base content. Drafted per-topic against the real source and
// adversarially fact-checked (draft-help-content workflow); keep claims in sync
// with the code when behavior changes. Regenerate rather than hand-tweaking facts.

import type { Topic } from "./types";

export const TOPICS: Topic[] = [
  {
    "blurb": "Connect screen, profiles, keychain passwords, SSL modes, read-only, per-driver capabilities.",
    "id": "getting-started",
    "title": "Connections & drivers",
    "blocks": [
      {
        "k": "p",
        "md": "Tusk opens on the **connect screen**: saved connections on the left, a connection form on the right. Postgres is first-class, but the same form connects to DuckDB, SQLite, and MySQL — the mascot on the card, topbar, and OS window title adapts to the driver (🐘 PostgreSQL, 🦆 DuckDB, 🪶 SQLite, 🐬 MySQL)."
      },
      {
        "k": "h",
        "text": "Saved profiles",
        "id": "profiles"
      },
      {
        "k": "p",
        "md": "Each profile in the **Connections** panel shows its mascot, name, and target (`user@host:port/dbname`, or the file path / `:memory:` for embedded drivers), plus a lock icon when a password is stored."
      },
      {
        "k": "list",
        "items": [
          "**Click** — connects immediately if embedded or the password is saved; otherwise loads into the form so you can type the password.",
          "**Right-click** — **Connect**, **Edit**, **Duplicate**, **Set as default** / **Unset default**, **Copy connection string**, **Delete**."
        ]
      },
      {
        "k": "p",
        "md": "*Copy connection string* yields `postgresql://user@host:port/db` (or `mysql://…`) with `?sslmode=` appended when it differs from the default `prefer` — the password is never included. Embedded drivers copy the file path."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "**Connect on startup**: check the box in the form or right-click → *Set as default*. Exactly one profile holds the flag — setting it clears the others — and Tusk auto-connects on launch."
      },
      {
        "k": "h",
        "text": "Drivers and form fields",
        "id": "drivers"
      },
      {
        "k": "p",
        "md": "The **Driver** select switches the form."
      },
      {
        "k": "list",
        "items": [
          "**PostgreSQL / MySQL** — *Host / Port / User / Password / Database / SSL Mode*; picking MySQL flips the default port from 5432 to 3306 and makes *Database* optional.",
          "**DuckDB / SQLite** — a single **Database file** field with *Browse…*; **leave it blank for a scratch in-memory database**. No password or SSL — *Save password* disappears."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A file-backed **DuckDB** database holds an exclusive OS file lock — Tusk releases the connection when idle and reopens it lazily on your next query, so other processes can grab the file between runs. `:memory:` stays open (closing would lose your data)."
      },
      {
        "k": "h",
        "text": "Passwords and SSL",
        "id": "passwords-ssl"
      },
      {
        "k": "p",
        "md": "**Save password** puts the password in the **OS keychain** (macOS Keychain / Windows Credential Manager / Secret Service API on Linux), keyed by profile id — `connections.json` holds only metadata, and the password is fetched server-side at connect time, **never sent to the frontend**. Uncheck the box and save to delete the keychain entry."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "**macOS dev-build caveat:** unsigned `tauri dev` builds re-prompt for keychain access and can invalidate saved passwords across rebuilds (macOS ties keychain items to the code signature). Signed release builds are seamless."
      },
      {
        "k": "table",
        "head": [
          "SSL Mode",
          "What it does"
        ],
        "rows": [
          [
            "`disable`",
            "Plaintext TCP, no TLS attempted."
          ],
          [
            "`prefer` *(default)*",
            "TLS if the server offers it, plaintext otherwise."
          ],
          [
            "`require`",
            "Always encrypts, but does **not** verify the certificate or hostname (self-signed certs work)."
          ],
          [
            "`verify-full`",
            "Encrypts *and* verifies the certificate chain and hostname — libpq semantics."
          ]
        ]
      },
      {
        "k": "h",
        "text": "Read-only mode",
        "id": "read-only"
      },
      {
        "k": "p",
        "md": "The **Read-only (block writes & DDL)** checkbox is enforced in layers — the safest way to point Tusk at production (see [[topic:safety|Safety & guardrails]]):"
      },
      {
        "k": "list",
        "items": [
          "`SET default_transaction_read_only = on` server-side (Postgres)",
          "Client-side guard rejects writes and DDL before they're sent",
          "Mutating sidebar items disabled with a *\"Connection is read-only\"* tooltip",
          "[[topic:grid-editing|In-grid editing]] switches off with the same reason"
        ]
      },
      {
        "k": "h",
        "text": "What each driver supports",
        "id": "capabilities"
      },
      {
        "k": "p",
        "md": "On connect, the backend reports a capabilities set and the UI gates on it — the active-schema selector, Import, and Export only appear where they work."
      },
      {
        "k": "table",
        "head": [
          "Capability",
          "PostgreSQL",
          "DuckDB",
          "SQLite",
          "MySQL"
        ],
        "rows": [
          [
            "Streaming server cursor",
            "yes",
            "paged (LIMIT/OFFSET)",
            "paged (LIMIT/OFFSET)",
            "paged (LIMIT/OFFSET)"
          ],
          [
            "Active-schema selector (`search_path`)",
            "yes",
            "—",
            "—",
            "— (uses `USE db`)"
          ],
          [
            "CSV/JSON import (COPY)",
            "yes",
            "—",
            "—",
            "—"
          ],
          [
            "Export to file",
            "yes",
            "yes",
            "yes",
            "yes"
          ],
          [
            "Sidebar DDL editing",
            "yes",
            "yes (per-action gating)",
            "—",
            "—"
          ],
          [
            "Copy DDL / [[topic:erd|relationships & ERD]]",
            "yes",
            "best-effort",
            "yes",
            "yes"
          ],
          [
            "`EXPLAIN ANALYZE`",
            "yes",
            "yes",
            "—",
            "yes"
          ],
          [
            "Transactional DDL",
            "yes",
            "yes",
            "yes",
            "— (auto-commits)"
          ],
          [
            "Manual transactions",
            "yes",
            "yes",
            "yes",
            "yes (pinned session)"
          ],
          [
            "Savepoints",
            "yes",
            "—",
            "yes",
            "yes"
          ],
          [
            "`SET TRANSACTION`",
            "yes (active, before work)",
            "—",
            "—",
            "yes (before START)"
          ],
          [
            "Persistent autocommit-off mode",
            "—",
            "—",
            "—",
            "yes (pinned session)"
          ],
          [
            "Cancel a running query",
            "yes (`CancelRequest`)",
            "yes, except on Windows",
            "—",
            "—"
          ],
          [
            "TLS",
            "yes",
            "n/a",
            "n/a",
            "yes"
          ],
          [
            "Permission-aware UI",
            "yes",
            "—",
            "—",
            "—"
          ]
        ]
      },
      {
        "k": "p",
        "md": "On Postgres, the sidebar also fetches your role's **effective privileges** and disables actions you can't perform (reason in the tooltip); other drivers report `enforced: false` — the server is still the authority. SQLite has no `EXPLAIN ANALYZE`, so that menu item is disabled with a *\"Not supported by this engine\"* tooltip — see [[topic:plans|Plan visualization]] and [[topic:import-export|Import & export]]."
      },
      {
        "k": "h",
        "text": "Dropped idle connections heal themselves",
        "id": "resilience"
      },
      {
        "k": "p",
        "md": "Query duration is never capped, but dead-connection detection is: a **10-second connect timeout** plus aggressive TCP keepalives (5s idle, 2s interval, 3 retries, 15s user-timeout) surface a dead Postgres connection in roughly 10–15 seconds. An idle connection can reopen before your next explicit action, but Tusk **never replays** a statement after the server may have seen it. A dropped manual transaction is marked lost rather than reconstructed; reconnect and verify its outcome."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A re-open drops any open streaming cursor: scrolling for more rows shows an explicit *\"connection dropped mid-stream\"* error over the rows you already have — re-run the query for a complete result. Tusk never silently presents a truncated result as done."
      }
    ],
    "icon": "database"
  },
  {
    "id": "editor",
    "title": "SQL editor, tabs & files",
    "blurb": "Tabs, files, run controls, manual transactions, parameters, and per-tab active schema.",
    "blocks": [
      {
        "k": "p",
        "md": "Every tab owns its SQL buffer, undo history, cursor, fold state, result snapshot, and grid view — but one server cursor per connection means only the last-run tab keeps streaming (see [[topic:results|Results & streaming]]). The tab set (SQL text, dirty state, file bindings, titles, active schema) persists per connection and restores on reconnect; results and pending grid edits don't."
      },
      {
        "k": "h",
        "text": "Tabs",
        "id": "tabs"
      },
      {
        "k": "list",
        "items": [
          "**Open** — the **＋** button or [[kbd:Mod-t]].",
          "**Close** — **×**, [[kbd:Mod-w]], or **middle-click**. A dirty tab (● dot) prompts an *Unsaved changes* dialog: **Save** / **Don't save** / **Cancel**. Closing the transaction owner first opens **Resolve transaction first**.",
          "**Right-click** — **Rename…**, **Close**, **Close others**, **Close tabs to the right**; bulk-close skips dirty tabs and reports how many were kept.",
          "**Reorder** — drag tabs; a vertical scroll wheel pans an overflowing strip.",
          "Closing the last tab leaves a fresh empty one."
        ],
        "ordered": false
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Sidebar scaffolds (`SELECT`/`INSERT`/`UPDATE` generators, \"Edit as SQL\") open in a **new tab** with the relation's schema pre-selected — they never clobber what you're writing."
      },
      {
        "k": "h",
        "text": "Files",
        "id": "files"
      },
      {
        "k": "p",
        "md": "**Open** ([[kbd:Mod-o]]), **Save** ([[kbd:Mod-s]]), and **Save As** ([[kbd:Mod-Shift-s]]) use native dialogs — Open filters to `.sql`/`.txt`, Save As to `.sql`. Opening an already-open file switches to its tab; a saved tab takes the file's basename as its title (hover for the full path)."
      },
      {
        "k": "p",
        "md": "When the pane gets narrow, text actions (Open/Save/Save As/Format/Find/Explain) collapse into a **⋯** overflow menu; at the narrowest widths the font-size/wrap icons hide."
      },
      {
        "k": "h",
        "text": "Running queries",
        "id": "running"
      },
      {
        "k": "p",
        "md": "**Run ▶** ([[kbd:Mod-Enter]]) runs the selection — *exactly* the selected text — otherwise the buffer. In flight the button becomes **✕ Cancel** with a live elapsed counter on engines that can cancel; where cancellation is impossible (SQLite, MySQL, DuckDB on Windows) it shows a disabled **Running 0:12** timer instead of a Cancel that can't work. PostgreSQL uses a real server-side `CancelRequest`; a rejected cancel resets the button and reports why rather than sitting on *Cancelling…*."
      },
      {
        "k": "p",
        "md": "Each statement gets a **▶ gutter marker** — click it to run just that statement (the marker swaps to a spinner, pinned to that statement while it executes). With several statements, the one under your cursor is highlighted and the status bar shows *Stmt N/M*."
      },
      {
        "k": "p",
        "md": "Statement splitting is **engine-aware**, matching execution. On MySQL, `#` comments and `--` without trailing whitespace lex correctly and backslash escapes inside quotes are honored; backtick identifiers are first-class on MySQL and SQLite. Everything built on the lexer — Run current statement, auto-fold, linting, parameter detection, and grid sort/filter — reads MySQL and SQLite SQL the way the server does."
      },
      {
        "k": "p",
        "md": "Run with the cursor in a multi-statement buffer and nothing selected, and a **Run…** popover asks **Current block** or **Entire file** (↑↓ to choose, Enter to run, Esc to cancel); [[kbd:Mod-Shift-Enter]] skips the prompt and always runs the statement under the cursor. Every base run — success, error, or cancel — lands in [[topic:history|query history]] with its duration (row count on success)."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "run",
            "does": "Run the selection, or the whole buffer"
          },
          {
            "action": "runStatement",
            "does": "Run the statement under the cursor (no chooser)"
          },
          {
            "action": "cancelQuery",
            "does": "Cancel the running query"
          },
          {
            "action": "newTab",
            "does": "New tab"
          },
          {
            "action": "closeTab",
            "does": "Close tab (dirty tabs confirm)"
          },
          {
            "action": "openFile",
            "does": "Open a .sql file"
          },
          {
            "action": "saveFile",
            "does": "Save (falls back to Save As when unbound to a file)"
          },
          {
            "action": "saveFileAs",
            "does": "Save As…"
          },
          {
            "action": "format",
            "does": "Format the selection or buffer"
          },
          {
            "action": "toggleComment",
            "does": "Toggle line comment"
          }
        ]
      },
      {
        "k": "h",
        "text": "Scripts & transactions",
        "id": "scripts"
      },
      {
        "k": "p",
        "md": "An ordinary idle multi-statement run with no transaction control uses one **app-owned transaction**. Any failure rolls back prior DML and reports the failing statement. A trailing read stays inside that wrapper, so the UI returns a summary instead of splitting it out for streaming. MySQL DDL and nontransactional tables retain their engine-level rollback limits."
      },
      {
        "k": "p",
        "md": "Pasted `pg_dump` output works: `COPY … FROM stdin` data blocks (terminated by `\\.`) are fed through `COPY`, even behind a leading `--` comment block."
      },
      {
        "k": "h",
        "text": "Manual transaction control",
        "id": "manual-transactions"
      },
      {
        "k": "p",
        "md": "Run raw `BEGIN` or `START TRANSACTION`, `COMMIT` or `END`, and `ROLLBACK` or `ABORT` directly. Transaction-control scripts are lifecycle-preflighted and run statement by statement on one owner session — self-contained (`BEGIN; …; COMMIT`) or across separate runs. Savepoint / rollback-to / release work on PostgreSQL, SQLite, and MySQL. PostgreSQL supports `SET TRANSACTION` while active and before work; MySQL supports it before `START TRANSACTION`. DuckDB has neither savepoints nor `SET TRANSACTION`; SQLite has no `SET TRANSACTION`."
      },
      {
        "k": "p",
        "md": "The transaction bar shows mode, id, state, owner tab, and elapsed time. Only the owner can run database work; other tabs stay editable but their queries and session-backed metadata are frozen. The bar offers **Switch to owner**, Commit/Rollback, MySQL next-transaction Start/Clear, and lost-session reconnect actions."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "commitTransaction",
            "does": "Commit the current transaction unit"
          },
          {
            "action": "rollbackTransaction",
            "does": "Roll back the current transaction unit"
          }
        ]
      },
      {
        "k": "p",
        "md": "MySQL `SET autocommit=0` keeps one physical connection pinned. **Commit unit** or **Rollback unit** ends only the current unit; **Commit & enable autocommit** runs `SET autocommit=1`, commits the current unit, and releases the owner session. Recognized implicit-commit DDL is blocked inside a tracked MySQL transaction, but DDL outside it still auto-commits and nontransactional tables cannot be rolled back."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A PostgreSQL statement error or cancellation requires `ROLLBACK` or `ROLLBACK TO` before more work. A dropped or unexpectedly ended owner session becomes **Lost**: Tusk never reconnects or replays it. Disconnect, reconnect, and verify the outcome. Closing the owner tab, disconnecting, or closing Tusk requires resolving a healthy unit first; pending grid changes must be applied or discarded before its outer Commit/Rollback."
      },
      {
        "k": "p",
        "md": "Results and pending edits carry transaction id + revision provenance. Pre-BEGIN rows must be rerun before editing; commit, rollback, rollback-to, autocommit-unit boundaries, and loss leave affected rows visible but stale until rerun. Query history records scoped transaction-control and grid-Apply markers."
      },
      {
        "k": "h",
        "text": "Parameters",
        "id": "parameters"
      },
      {
        "k": "p",
        "md": "Queries with `$1` positional or `:name` named placeholders open a **Query parameters** dialog first: per-parameter value input, a **NULL** checkbox (sends SQL `NULL`), and a **raw** checkbox (inserts text verbatim, for numbers and expressions; unchecked values become safely-quoted literals). A live preview shows the substituted SQL, and values are remembered per tab."
      },
      {
        "k": "p",
        "md": "Detection is lexer-masked: placeholders inside strings, comments, and dollar-quoted bodies are ignored, and `::type` casts never match."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Known false positive: array slices with identifier bounds — `arr[i:j]` — can detect `:j` as a parameter. Use the **raw** toggle and enter `:j` verbatim."
      },
      {
        "k": "h",
        "text": "Active schema",
        "id": "active-schema"
      },
      {
        "k": "p",
        "md": "The toolbar schema selector (default *(default schema)*) sets the tab's **active schema** — per-tab, applied per run: `SET search_path TO <schema>, public` runs before every execution, server-side validation, and scope-all export from that tab. Autocomplete offers its tables unqualified and the schema linter resolves bare names through the same active-schema-then-`public` resolver, so it can never flag a table completion it just offered; the selector hides on engines without a search path."
      },
      {
        "k": "h",
        "text": "Editing comforts",
        "id": "editing"
      },
      {
        "k": "list",
        "items": [
          "**Format** ([[kbd:Shift-Alt-f]], or the toolbar button) — pretty-prints the selection or buffer via `sql-formatter` with uppercased keywords; dollar-quoted bodies (`$tag$ … $tag$`) are restored byte-for-byte, and unparseable SQL is left untouched. Loads lazily on first use.",
          "**Find & replace** — the toolbar **Find** button or [[kbd:Mod-f]]; the `find` action is rebindable in [[topic:shortcuts|Shortcuts]].",
          "**Multi-cursor** — multiple selections, plus **Alt-drag** for rectangular (column) selection.",
          "**Code folding** — a manual fold gutter, plus auto-fold: bracketed lists ≥ 100 items collapse to `…N items…`, single literals ≥ 200 chars to a size placeholder. Display-only — Run, Save, and export always see the full query; click a placeholder or move the cursor into it to expand.",
          "**Keyword auto-UPPERCASE** — live at word boundaries, skipping qualified names (`t.select`), quoted identifiers, and open strings.",
          "**Font size & wrap** — the small/large **A** buttons step the font between 9 and 24 px; the wrap icon toggles word wrap (also the `toggleWrap` action).",
          "**Right-click menu** — Cut / Copy / Paste / Select all / Toggle comment ([[kbd:Mod-/]]) / Run selection (or Run all).",
          "**Explain ▾** — wraps the selection or the statement under the cursor for the [[topic:plans|plan visualizer]]; *Explain Analyze* is disabled on engines without it and warns before executing a write."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "Autocomplete, lint layers, and FK-aware JOIN hints: [[topic:editor-intel|Editor intelligence]]."
      }
    ],
    "icon": "code"
  },
  {
    "id": "editor-intel",
    "title": "Autocomplete, JOIN hints & lint",
    "blurb": "Live-schema completion, FK JOIN hints, three lint layers, keyboard quick-fixes.",
    "blocks": [
      {
        "k": "p",
        "md": "The editor reads your **live database**: one `list_schema` query plus a `list_functions` catalog feed both completion and lint. Both refresh whenever the schema reloads, e.g. after [[topic:sidebar|sidebar]] DDL."
      },
      {
        "k": "h",
        "text": "Context-aware completion",
        "id": "completion"
      },
      {
        "k": "p",
        "md": "Completion offers only what fits the clause before your cursor: tables and schemas after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `USING`; columns after `SELECT`, `WHERE`, `ON`, `HAVING`, `SET`, `GROUP BY`, `ORDER BY`, `VALUES`, `RETURNING`, `AND`/`OR`; statement keywords at statement start. Columns from tables in the current statement's `FROM`/`JOIN` rank first, labeled with type and source table (`integer · orders`) — only when no table resolves does the list fall back to every column in the database."
      },
      {
        "k": "list",
        "items": [
          "**Alias resolution** — `u.` after `FROM users u` lists that table's columns; `schema.` lists its tables; `schema.table.` lists its columns.",
          "**Bare vs qualified** — tables in `public` or the tab's active schema complete bare (matching `search_path`); others complete as `schema.table`. Tables in the active schema rank above the rest. Completion and schema lint share one resolver, so a bare name that completes is a bare name the linter accepts.",
          "**Live db functions** — your functions and procedures appear alongside dialect builtins, tagged `db function`; after `CALL`, `EXEC`/`EXECUTE`, or `PERFORM` they jump to the top, tagged `procedure/function`.",
          "**Accepting** — [[kbd:Tab]] or [[kbd:Enter]] accepts the highlighted entry; with no popup open, Enter is a plain newline."
        ],
        "ordered": false
      },
      {
        "k": "demo",
        "id": "autocomplete",
        "caption": "Clause-aware completion: tables after FROM, in-scope columns after WHERE, alias.column resolution."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "`$` is deliberately not a completion token, so `$tag$` dollar-quote delimiters and `$1` parameters are never offered or clobbered."
      },
      {
        "k": "h",
        "text": "FK-aware JOIN hints",
        "id": "join-hints"
      },
      {
        "k": "p",
        "md": "Right after `ON`, the top suggestion (tagged `foreign key`) is a **complete join condition** from the foreign-key catalog — `o.user_id = u.id`, using your aliases, composite keys `AND`-ed into one entry. Hints connect the most recently joined table to the statement's other tables (so you need at least two); FK edges load lazily per schema via `schema_relationships` (active schema + `public`) — the same data behind the [[topic:erd|ERD viewer]]."
      },
      {
        "k": "h",
        "text": "Three lint layers",
        "id": "lint-layers"
      },
      {
        "k": "p",
        "md": "Two client-side layers — heuristic and schema-aware — share one linter pass debounced at **300 ms**; an async server linter runs at **600 ms**. Their squiggles merge in the gutter, but each has a distinct job:"
      },
      {
        "k": "table",
        "head": [
          "Layer",
          "Checks",
          "Severity"
        ],
        "rows": [
          [
            "Heuristic (offline)",
            "Unmatched `)`; unclosed `(`; trailing comma; `DELETE`/`UPDATE` without `WHERE` (\"affects every row\"); unknown **leading** keyword (`SELCT` → \"did you mean SELECT?\"); a top-level comma between conditions in `WHERE`/`HAVING` (*',' is not valid between conditions — join them with AND or OR*); invisible paste artifacts in code — non-breaking/zero-width spaces and curly quotes from web pages, named with their code point, with a fix-all quick-fix (inside string literals they're data and stay untouched)",
            "error / warning"
          ],
          [
            "Schema (live catalog)",
            "Unknown `alias.col` refs; unknown tables after `FROM`/`JOIN`/`UPDATE`/`INTO`; unknown function calls vs the live catalog; unknown bare identifiers and one-edit clause-keyword typos (`FORM` → `FROM`)",
            "warning"
          ],
          [
            "Server (`validate_sql`)",
            "Parser-grade Postgres diagnostics — the ground truth for syntax, types, and anything the client can't model",
            "error"
          ]
        ]
      },
      {
        "k": "p",
        "md": "`WHERE a = 1, b = 2` — an AND typo, invalid in every engine — is squiggled as you type by the offline layer. Legit commas in `IN` lists, row constructors, function arguments, `SET` lists, and nested subqueries are untouched. The offline check matters because the server linter is deliberately paused while a result stream is open, so this class of error had no other detector."
      },
      {
        "k": "list",
        "items": [
          "**Bare identifiers** — checked only in DML (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH`) where **every** table reference resolved; otherwise only one-edit clause-keyword typos are flagged. Statements with CTEs or derived tables skip the check entirely.",
          "**Grammatical `FROM`s** — `EXTRACT(YEAR FROM x)`, `SUBSTRING`, `POSITION`, `OVERLAY`, `TRIM` are masked before table scanning.",
          "**Empty function catalog** — the unknown-function check switches off (MySQL can't enumerate builtins; a partial list would flag every uncommon function).",
          "**Half-typed keywords** — `SEL` under the cursor is a prefix of `SELECT` and skipped until you move on."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Server validation never executes",
        "id": "server-lint"
      },
      {
        "k": "p",
        "md": "`validate_sql` only `PREPARE`s each statement (parse + plan) then deallocates — in autocommit, so one failing statement can't poison the next. It skips DDL, `COPY`, and `$1`/`:name` bind-parameter statements (PREPARE can't infer their types), maps Postgres' 1-based error position onto the exact token, and goes silent when disconnected, while a query is **running or streaming**, or when *Server-side lint (PREPARE-only)* is off in Settings — the client layers keep working."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The prepareability check is a **skip-list** (known DDL/utility starters skipped, everything else PREPAREd), so a misspelled first keyword like `SELCT …` still reaches the server parser and gets a real diagnostic."
      },
      {
        "k": "h",
        "text": "Quick-fixes from the keyboard",
        "id": "quick-fixes"
      },
      {
        "k": "p",
        "md": "Did-you-mean diagnostics carry a one-keystroke fix (*Replace with \"…\"*) — no mouse hover needed. With the cursor on the squiggle:"
      },
      {
        "k": "keys",
        "rows": [
          {
            "combo": "Tab",
            "does": "Accept an open completion; otherwise apply the quick-fix under the cursor; otherwise indent"
          },
          {
            "combo": "Alt-Enter",
            "does": "Apply the quick-fix under the cursor"
          },
          {
            "combo": "Mod-.",
            "does": "Apply the quick-fix under the cursor"
          }
        ]
      },
      {
        "k": "p",
        "md": "Matching is Damerau-Levenshtein, plus a candidate starting with what you typed counts as one edit — so `master` suggests `master_id`. See [[topic:shortcuts|Shortcuts]] for run/format/search chords and [[topic:editor|The editor]] for statement splitting."
      }
    ],
    "icon": "sparkle"
  },
  {
    "id": "results",
    "title": "The result grid",
    "blurb": "Streaming pages, virtualized rendering, server-side sort/filter, multi-format copy.",
    "blocks": [
      {
        "k": "p",
        "md": "The grid virtualizes both axes — only the visible window of rows *and* columns is in the DOM, so a million-row or 400-column result scrolls like ten rows. Values are text straight from the driver; column widths, order, hidden columns, sorts, and filters are per-tab view state, and a zero-row result still shows its headers."
      },
      {
        "k": "h",
        "text": "Streaming and the single cursor",
        "id": "streaming"
      },
      {
        "k": "p",
        "md": "Reads stream in pages of **1,000 rows** (`PAGE` in `App.tsx`) — a server-side cursor on Postgres, a LIMIT/OFFSET pager on DuckDB/SQLite/MySQL."
      },
      {
        "k": "list",
        "items": [
          "**Auto-fetch** — scroll within ~1.5 viewport-heights of the bottom, or move the focused cell within 30 rows of the end.",
          "**`1000+ rows`** — the `+` means the cursor is still open.",
          "**Load all** (result toolbar) — drains the cursor; the button flips to **Cancel** and yields between pages. Also the `loadAllRows` action: unbound by default, rebindable in Settings → Shortcuts."
        ]
      },
      {
        "k": "demo",
        "id": "grid-stream",
        "caption": "Pages of 1,000 rows stream from a server-side cursor as you approach the bottom; Load all drains the rest."
      },
      {
        "k": "list",
        "items": [
          "**While running** — Run becomes **✕ Cancel** with a live elapsed counter (updated every 200 ms); the final duration sits at the right of the result toolbar.",
          "**One cursor per connection** (`tusk_cur`) — while idle, running in another tab, expanding a relation in the Explorer, refreshing the schema, sidebar DDL, an all-rows export, an import, or the ERD/DDL viewer closes the previous stream. The old tab keeps its rows but is marked **Incomplete result** (toolbar badge + a `N rows loaded · …` status naming what closed it); in-memory sort is off for it and Export lists its loaded rows as incomplete — re-run for the full set. During a manual transaction, other tabs/sidebar database actions are frozen and an owner run closes only its prior stream, not the outer transaction.",
          "**Dropped mid-stream** — the grid keeps what it has, shows an error banner plus a `streaming stopped — …` status and the same Incomplete badge; re-run to resume."
        ]
      },
      {
        "k": "h",
        "text": "Columns: resize, reorder, hide",
        "id": "columns"
      },
      {
        "k": "list",
        "items": [
          "**Resize** — drag the header edge (48–900 px); double-click the edge or *Autofit column* to size to visible content.",
          "**Reorder** — drag a header label sideways (a 4 px threshold separates a drag from a sort click).",
          "**Hide** — header right-click → *Hide column*; restore via *Show \"name\"* or *Show all columns*. Display-only: **Export…** is unaffected, but grid copies follow what's displayed.",
          "All per-tab view state; a fresh query with a different column set resets it."
        ]
      },
      {
        "k": "h",
        "text": "Server-side sort and filter",
        "id": "sort-filter"
      },
      {
        "k": "p",
        "md": "Once a base result is **fully loaded**, sort gestures reorder rows in memory — no re-run. While rows are still streaming, or whenever a filter is active, the grid re-runs your query wrapped as `SELECT * FROM (<your query>) AS _tusk … ORDER BY <ordinal>` so ordering happens on the server across the whole result. Local ordering compares a column numerically when every loaded value is a number (integers compare exactly at any size), otherwise by display text, with each engine's default NULL placement; use an explicit `ORDER BY` when native date/collation semantics matter. A header click that can't sort (query running, transaction owned elsewhere, or a result that isn't re-runnable and isn't fully loaded) explains why in the status line."
      },
      {
        "k": "list",
        "items": [
          "**Sort** — click a header to cycle **ascending → descending → none**; [[kbd:Shift]]-click adds to a multi-sort (priority numbers next to the arrows).",
          "**Filter** — *Filter…* in the header menu, or the sidebar's *Filter rows…* (opens the table with the row visible). Each column does a case-insensitive contains match (`ILIKE '%text%'` on Postgres/DuckDB, `CAST … LIKE` on MySQL/SQLite), AND-combined, debounced 300 ms."
        ]
      },
      {
        "k": "code",
        "text": "SELECT * FROM (\n  SELECT * FROM film JOIN inventory USING (film_id)\n) AS _tusk\nWHERE \"title\"::text ILIKE '%dino%'\nORDER BY 3 DESC",
        "caption": "What a header sort + filter actually re-streams (ORDER BY uses the ordinal to dodge duplicate names)."
      },
      {
        "k": "demo",
        "id": "sort-filter",
        "caption": "Header clicks and the filter row re-run the query wrapped as a subquery, so ordering and matching happen on the server across the whole result."
      },
      {
        "k": "list",
        "items": [
          "**Disabled** for multi-statement runs, anything that isn't `SELECT`/`WITH`/`TABLE`/`VALUES`, and on **MySQL** when the result has duplicate column names (error 1060).",
          "Re-running the *same unedited* query text keeps active rules; edit the text first for a clean result.",
          "A sort/filter re-run resets scroll and selection — the rows underneath changed."
        ]
      },
      {
        "k": "h",
        "text": "Selection, keyboard, copy",
        "id": "selection-copy"
      },
      {
        "k": "p",
        "md": "Click a cell; drag (with edge auto-scroll) or [[kbd:Shift]]-click for a range; the row-number gutter selects rows, a header a whole column, the corner or [[kbd:Mod-a]] everything. Navigation loads more rows as you go:"
      },
      {
        "k": "keys",
        "rows": [
          {
            "combo": "Arrow keys",
            "does": "Move the focused cell (Shift extends the range)"
          },
          {
            "combo": "Home / End",
            "does": "First / last column of the row"
          },
          {
            "combo": "Mod-Home / Mod-End",
            "does": "Jump to the first / last loaded cell"
          },
          {
            "combo": "PageUp / PageDown",
            "does": "Move by one viewport of rows"
          },
          {
            "combo": "Escape",
            "does": "Collapse the selection to the focused cell"
          },
          {
            "combo": "Mod-a",
            "does": "Select all"
          },
          {
            "combo": "Mod-c",
            "does": "Copy the selection as TSV"
          }
        ]
      },
      {
        "k": "demo",
        "id": "jump-count",
        "caption": "Keyboard jumps ride the stream too — moving within 30 rows of the loaded end fetches the next 1,000-row page."
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Mod-c]] copies **TSV**; the cell context menu adds **Copy as CSV / JSON / Markdown**, *Copy cell value* (*Copy value (NULL→empty)* on a NULL cell), and *Copy column*.",
          "Column names are **omitted by default** — tick **Copy w/ column names** in the result toolbar. With headers, JSON becomes an array of objects keyed by column; without, arrays of values.",
          "Copies read through uncommitted edits and the boolean display mapping — a Postgres `t` or MySQL `1` copies as the displayed `TRUE`/`FALSE`. **Copy as CSV/TSV/JSON/Markdown runs the same formatter as Export**, so clipboard bytes match the file byte-for-byte: an empty string stays quoted (`\"\"`) and distinguishable from `NULL`, JSON keeps the exporter's shape, and Markdown always carries its header row. For files, see [[topic:import-export|Import & export]]."
        ]
      },
      {
        "k": "h",
        "text": "Inspecting values",
        "id": "values"
      },
      {
        "k": "p",
        "md": "NULLs render as a dimmed `NULL`, a dash, or empty, per the *NULL cells show* setting. **View value…** (context menu, double-click on a non-editable grid, or [[kbd:Mod]]+double-click on an editable one) opens the full untruncated cell — always the raw value, never the boolean word."
      },
      {
        "k": "p",
        "md": "On a recognized `EXPLAIN` result, a **Plan / Grid** toggle appears on the left of the result toolbar — see [[topic:plans|Plan visualization]]."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A single-table `SELECT` with its primary key in the result is editable — double-click, [[kbd:Enter]]/[[kbd:F2]], `+ Row`, paste, and a Commit preview. See [[topic:grid-editing|Editing data in the grid]]."
      }
    ],
    "icon": "table"
  },
  {
    "id": "grid-editing",
    "title": "Editing data in the grid",
    "blurb": "Edit cells, delete, insert, paste — apply or commit one reviewed script.",
    "blocks": [
      {
        "k": "p",
        "md": "Results from a plain single-table `SELECT` are editable: change cells, mark deletes, add rows, paste spreadsheet blocks — all as a **pending overlay** that touches nothing until you preview the script. The result toolbar holds **+ Row**, the pending counter (`✎ N changes`), **Commit…** (or **Apply…** in the transaction owner), and **Discard**."
      },
      {
        "k": "demo",
        "id": "grid-edit",
        "caption": "Edit cells, mark deletes, add rows — then preview and Apply or Commit."
      },
      {
        "k": "h",
        "text": "When a result is editable",
        "id": "when-editable"
      },
      {
        "k": "p",
        "md": "Tusk maps rows back to the table by primary key, so it offers editing only when that mapping is unambiguous. All must hold:"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Single plain `SELECT`** — `WITH`, `TABLE`, and `VALUES` reject (*\"only SELECT results are editable\"*); scripts reject (*\"results from a script — run a single SELECT to edit\"*).",
          "**One table** — any `JOIN`, `GROUP BY`, `DISTINCT`, `UNION`/`INTERSECT`/`EXCEPT`, `HAVING`, or `RETURNING` disqualifies.",
          "**Plain column references only** (`*`, `t.*`, `col`, `t.col`) — no expressions, functions, `CASE`, literals, or aliases. `SELECT id*2 AS id …` could point the commit's PK `WHERE` at the **wrong row**, so anything ambiguous rejects (*\"only plain column selects are editable (no expressions or aliases)\"*).",
          "**A table** (not a view or matview) with a **primary key**, every PK column present in the result — else *\"primary key column \\\"x\\\" isn't in the result\"*.",
          "No **duplicate column names** in the result.",
          "**An unambiguous table identity** — a bare name that exists in more than one schema is only editable when the tab's active schema resolves it (the same active-schema-then-`public` order the run uses); comma joins, derived tables, table functions, mismatched qualifiers, and case-colliding metadata all reject.",
          "Connection not **read-only**; on Postgres your role needs at least one of `UPDATE`/`INSERT`/`DELETE` (or ownership). Partial privileges still allow editing — the server enforces per statement at commit."
        ]
      },
      {
        "k": "p",
        "md": "When editing is off, right-click a cell: the disabled **Edit cell** entry tooltips the exact rejection (e.g. *\"multi-table queries aren't editable\"*, *\"table users has no primary key\"*, *\"no write privilege on orders\"*). See [[topic:safety|Safety]] for the wider write gates."
      },
      {
        "k": "h",
        "text": "Editing gestures",
        "id": "gestures"
      },
      {
        "k": "p",
        "md": "Double-click a cell to edit ([[kbd:Mod]]+double-click keeps *View value*); with a cell selected, [[kbd:Enter]] or [[kbd:F2]] also opens the editor. Boolean columns get a **TRUE / FALSE** dropdown (plus `<null>` when nullable) committing the driver's token — `true`/`false` on Postgres and DuckDB, `1`/`0` on SQLite and MySQL; re-picking the original value reverts the edit."
      },
      {
        "k": "table",
        "head": [
          "Keys",
          "Action"
        ],
        "rows": [
          [
            "Enter / F2",
            "Edit the selected cell; while editing, Enter commits and moves down"
          ],
          [
            "Tab",
            "Commit the edit and move right"
          ],
          [
            "Escape",
            "Cancel the edit"
          ],
          [
            "Alt-N",
            "Set the cell to SQL NULL (while editing)"
          ],
          [
            "Delete / Backspace",
            "Toggle delete-marks on a row selection"
          ],
          [
            "Mod-V",
            "Paste a TSV/CSV block from the clipboard"
          ]
        ]
      },
      {
        "k": "p",
        "md": "Blur commits like Enter; typing nothing over a `NULL` is **not** an edit, so tabbing through empty cells never turns `NULL` into `''`. Right-click adds **Set NULL** and, on dirty cells, **Revert cell**; dirty cells tint, delete-marked rows strike through, new rows highlight — copy reads the same overlay, so copied text matches what you see."
      },
      {
        "k": "h",
        "text": "Deleting and inserting rows",
        "id": "delete-insert"
      },
      {
        "k": "p",
        "md": "Select rows in the row-number gutter and press [[kbd:Delete]] (or right-click → **Delete rows**) to *mark* them; the menu flips to **Undelete rows** when everything selected is marked. Delete only acts on a **row** selection; marking a pending insert removes it outright."
      },
      {
        "k": "p",
        "md": "**+ Row** (toolbar) or right-click → **Insert row** adds a row, pinned to the **top** of the grid — [[topic:results|loading more rows]] can't disturb it. Untouched cells show a faint *default* and are **omitted from the INSERT**; a fully untouched row commits as `INSERT INTO … DEFAULT VALUES` (MySQL: `INSERT INTO … () VALUES ()`)."
      },
      {
        "k": "h",
        "text": "Pasting from a spreadsheet",
        "id": "paste"
      },
      {
        "k": "p",
        "md": "[[kbd:Mod-V]] parses the clipboard as a table — tab-delimited when any tab is present, comma otherwise, quoted fields (`\"…\"`, `\"\"` escaping, embedded newlines) honored. Two shapes, chosen automatically:"
      },
      {
        "k": "table",
        "head": [
          "Mode",
          "Trigger",
          "Behavior"
        ],
        "rows": [
          [
            "**Header-mapped**",
            "First clipboard row names editable table columns (every non-empty header matches) and at least one data row follows",
            "Each remaining row becomes a **new insert row**, values mapped **by name** — clipboard column order is irrelevant"
          ],
          [
            "**Positional**",
            "Anything else",
            "The block writes from the anchor cell, left-to-right across the *visible* columns, top-to-bottom; rows past the end overflow into new insert rows"
          ]
        ]
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "Empty cell → SQL `NULL`; a cell absent because the row is short → omitted (the column keeps its default on INSERT).",
          "Positional pastes write *visible* columns only; header-mapped matches by name, so hidden columns can receive values. Non-table columns are never written.",
          "No active cell → the paste anchors at the append region, never overwriting loaded rows.",
          "For files, use [[topic:import-export|Import]] instead."
        ]
      },
      {
        "k": "h",
        "text": "Apply or Commit: one reviewed script",
        "id": "commit"
      },
      {
        "k": "p",
        "md": "**Commit…** / **Apply…** shows the literal script in a preview dialog before anything runs — **UPDATEs, then DELETEs, then INSERTs** (a row both edited and delete-marked only deletes)."
      },
      {
        "k": "code",
        "text": "UPDATE \"public\".\"users\" SET \"email\" = 'a@b.co' WHERE \"id\" = '42';\nDELETE FROM \"public\".\"users\" WHERE \"id\" = '7';\nINSERT INTO \"public\".\"users\" (\"name\") VALUES ('New');",
        "caption": "A fully qualified script — app-owned or applied to the outer transaction"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Outside a manual transaction:** Commit uses one app-owned transaction; failure rolls it back wholesale, keeps pending edits, and shows the error in the dialog.",
          "**Inside the owner transaction:** Apply runs in the existing outer unit, clears the pending overlay on success, and leaves the outer transaction open. Use the transaction bar's Commit/Rollback separately. Pending edits must be applied or discarded before that outer unit can end.",
          "**WHERE clauses use the ORIGINAL loaded values** — edit a primary-key cell and the UPDATE still locates the old row. Composite PKs are AND-ed; a `NULL` original compares with `IS NULL`.",
          "Statements are fully qualified — the tab's active schema is ignored.",
          "On success the grid refreshes in place, keeping your [[topic:results|sort and filter]] view."
        ]
      },
      {
        "k": "h",
        "text": "Pending-edit lifecycle",
        "id": "lifecycle"
      },
      {
        "k": "p",
        "md": "Pending edits are per-tab and index into the loaded snapshot, so scrolling and streaming more rows can't shift them. Anything that **replaces** the rows — re-running the query, a header sort, a column filter — first asks *\"Discard pending changes?\"* with the change count; toolbar **Discard** asks the same, and pending edits are never persisted. Transaction id/revision provenance also matters: pre-BEGIN rows must be rerun before editing, and commit, rollback, rollback-to, autocommit-unit boundaries, or a lost session leave affected rows/pending edits stale until rerun."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "**No optimistic-concurrency check** — the commit doesn't verify rows still hold the values you loaded; **last write wins**. On hot tables, re-run the SELECT just before committing, or write the UPDATE by hand in the [[topic:editor|editor]]."
      }
    ],
    "icon": "edit"
  },
  {
    "id": "sidebar",
    "title": "Schema explorer & DDL",
    "blurb": "Browse the database tree; run SQL-previewed DDL from right-click menus.",
    "blocks": [
      {
        "k": "p",
        "md": "Every node in the **Explorer** tree carries a right-click menu of real actions, and DDL forms and drop/truncate confirms preview the **exact SQL** before running (two exceptions: matview *Refresh* runs immediately; sequence *Restart…* drops its statement into your editor). Mutating items are gated by connection mode, driver capability, and (on Postgres) your actual privileges — disabled items say *why* in their tooltip."
      },
      {
        "k": "h",
        "text": "What the tree shows",
        "id": "tree-structure"
      },
      {
        "k": "p",
        "md": "The hierarchy is **databases → schemas → Tables / Views / Sequences / Functions**; other databases on the server are listed but muted — browsing them means reconnecting (for now). The tree loads shallow at connect (names, kinds, comments, headline stats — no columns); expanding a table lazily fetches and caches **Columns, Indexes, Constraints, Triggers**, with a brief *loading…* row on first expand."
      },
      {
        "k": "list",
        "items": [
          "**Row estimates & sizes (Postgres)** — `≈1.2K · 64 MB` style metadata from the planner's `reltuples` and `pg_size_pretty(pg_total_relation_size)`. Never-analyzed tables show no estimate (not a wrong `0`); sizes appear on tables and matviews only.",
          "**Comments as tooltips** — hover a table for its comment; a column tooltip adds its `default:` plus any comment. Index/constraint/trigger tooltips show the full definition; functions show `name(args) → returns`.",
          "**Column badges** — key icon = primary key, link icon = foreign key, `·NN` after the type = `NOT NULL`. FK-internal triggers are hidden.",
          "**Filter box** (`Filter objects…`) — live substring match. Structural containers auto-expand to reveal matches, but relations don't (that would fetch detail per match); a matching schema keeps all its children."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "**Refresh** in the sidebar header re-introspects everything: shallow tree, autocomplete catalog, effective privileges, and already-expanded details. Every sidebar DDL action triggers the same refresh automatically."
      },
      {
        "k": "h",
        "text": "Browsing data from the tree",
        "id": "browse-data"
      },
      {
        "k": "p",
        "md": "**Double-click** a table or view to stream all rows in a new tab (see [[topic:results|Results grid]]). The context menu adds **Select 100 rows** (tables only), **Select all rows**, and **Filter rows…** (opens with the grid's per-column filter row visible) — all open a *new* tab with active schema preset to the relation's, so the generated query stays unqualified and still resolves."
      },
      {
        "k": "p",
        "md": "**Generate SELECT / INSERT / UPDATE** scaffold a full statement from the column list (UPDATE includes a primary-key `WHERE`) into a new tab — never clobbering your buffer. See [[topic:editor|the editor]]."
      },
      {
        "k": "h",
        "text": "Context menus, node by node",
        "id": "context-menus"
      },
      {
        "k": "table",
        "head": [
          "Node",
          "Actions"
        ],
        "rows": [
          [
            "Table",
            "Select 100 rows · Select all rows · Filter rows… · **Modify table…** · Add column… · Add index… · Add constraint… · Rename… · Duplicate… · Edit comment… · Truncate… · Drop… · Generate SELECT/INSERT/UPDATE · DDL & relationships… · Copy DDL / Copy DDL → editor · Copy name / Copy qualified name"
          ],
          [
            "View / matview",
            "Select all rows · Filter rows… · (matview only: **Refresh** / **Refresh concurrently**) · Rename… · Edit comment… · Drop… · DDL & relationships… · Copy DDL / Copy DDL → editor · Copy name / qualified name"
          ],
          [
            "Column",
            "Edit column… · Rename… · Edit comment… · Drop column… · Copy name"
          ],
          [
            "Index",
            "Rename… · Drop… · Copy name"
          ],
          [
            "Constraint",
            "Rename… · Drop… · Copy name"
          ],
          [
            "Sequence",
            "Restart… (edit value) · Rename… · Drop… · Copy DDL / Copy DDL → editor · Copy name"
          ],
          [
            "Function",
            "Drop… · Copy DDL / Copy DDL → editor · Copy name"
          ],
          [
            "Trigger",
            "Copy DDL / Copy DDL → editor (the definition rides on the node — no server roundtrip) · Drop… · Copy name"
          ],
          [
            "Schema",
            "Schema diagram… · Create table… · Rename… · Drop… · Copy name"
          ],
          [
            "Database",
            "Create schema… · Drop… (the connected database can't be dropped) · Copy name"
          ]
        ]
      },
      {
        "k": "p",
        "md": "**DDL & relationships…** opens the combined DDL + FK graph viewer; **Schema diagram…** opens the whole-schema ERD — both covered in [[topic:erd|the relationship viewer]]. **Truncate…** and **Drop…** are danger items and always confirm, with a `CASCADE` checkbox (truncate adds `RESTART IDENTITY`)."
      },
      {
        "k": "p",
        "md": "The **＋** button in the sidebar header is selection-aware: with a table (or its column/index/constraint) selected it offers *New column in X…*, *New index on X…*, *New constraint on X…*, then *New table in ‹schema›…*, *New schema…*, *New database…* — schema defaulting to your selection, else `public` (or the first schema)."
      },
      {
        "k": "h",
        "text": "Every dialog shows its SQL",
        "id": "dialogs"
      },
      {
        "k": "p",
        "md": "Every form derives a live SQL preview as you type. The footer always offers **Cancel**, **Edit as SQL** (drops the statement into your editor at the cursor instead of running it), and the primary action; failures show inline, success refreshes the tree."
      },
      {
        "k": "p",
        "md": "Every Explorer DDL statement lands in [[topic:history|query history]] with a leading `-- [Explorer]` marker, and its result or error surfaces even when the results panel is collapsed — the same audit convention as `-- [Slack]` and `-- [Export]`."
      },
      {
        "k": "p",
        "md": "**Modify table…** is a DataGrip-style diff editor: edit a column's name, type, nullability, default, PK membership, or comment; add and drop columns; tick indexes and constraints for removal; rename or re-comment the table. The preview is the **minimal `ALTER` script** — type/null/default edits run against original column names, renames run last, and a PK change emits `DROP CONSTRAINT` + `ADD PRIMARY KEY` only when the key actually changed."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Sidebar DDL shares your query connection: while idle, a sidebar action rolls back an open streaming cursor — a tab still paging a big result stops where it is (loaded rows stay) and is marked **Incomplete result**. Sidebar DDL is frozen while a manual transaction owns the session."
      },
      {
        "k": "h",
        "text": "What's enabled where (and why)",
        "id": "gating"
      },
      {
        "k": "p",
        "md": "Mutating items pass through four gates; the failing gate's reason becomes the disabled item's tooltip:"
      },
      {
        "k": "list",
        "items": [
          "**Read-only connection** — everything mutating disables with *\"Connection is read-only\"* (see [[topic:safety|Safety & read-only mode]]). **Drop database** passes the same gates as every other DDL action — manual-transaction freeze, read-only, driver support — and is blocked outright on DuckDB.",
          "**Driver support** — sidebar DDL is live on **Postgres and DuckDB**; MySQL/SQLite items disable with *\"DDL editing isn't supported for … yet\"*.",
          "**DuckDB engine limits** — individually disabled with a reason: add/drop/rename constraints (*\"define them in CREATE TABLE\"*), rename index or sequence, `ALTER SEQUENCE RESTART`, `CREATE DATABASE` (*\"DuckDB attaches database files rather than CREATE DATABASE\"*). Duplicate uses `CREATE TABLE … AS SELECT`; multi-action ALTERs split into one statement each.",
          "**Postgres effective privileges** — Tusk fetches your role's real privileges (membership, `PUBLIC`, ownership): *Modify/Add/Rename/Drop* need table ownership, *Duplicate* and *Create table* need `CREATE` on the schema, *Truncate* accepts the `TRUNCATE` grant or ownership, *New schema* needs `CREATE` on the database, *New database* needs `CREATEDB`. Tooltips state the missing right, e.g. *\"Requires ownership of orders\"*."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Copy DDL is reconstructed, not dumped",
        "id": "copy-ddl"
      },
      {
        "k": "p",
        "md": "**Copy DDL** rebuilds a runnable `CREATE` from the system catalogs on every engine — Postgres pg_dump-style from `pg_catalog`, SQLite via `sqlite_master`, MySQL via `SHOW CREATE`, DuckDB best-effort. On Postgres it covers tables (identity/generated/serial defaults, inline PK/unique/check), views, matviews, functions (including overloads), and sequences; **foreign keys emit as trailing `ALTER TABLE … ADD CONSTRAINT`** (so copied tables replay in any order) and constraint-backed indexes are skipped."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Omitted rather than guessed: partitioning, inheritance, row-level security, triggers (copy those from the trigger node), storage parameters, tablespaces, and collations."
      },
      {
        "k": "p",
        "md": "**Copy DDL → editor** pastes the reconstruction at your cursor instead of the clipboard — handy for duplicating a table across schemas or [[topic:import-export|exporting]] a structure alongside its data."
      }
    ],
    "icon": "folder"
  },
  {
    "id": "import-export",
    "title": "Import & export",
    "blurb": "Export results in six formats, streamed or loaded; import CSV/JSON transactionally.",
    "blocks": [
      {
        "k": "p",
        "md": "Data moves through three doors: **Export…** on the result toolbar (file or clipboard, six formats, streaming), the sidebar's **Import data** icon (CSV/JSON file → table via `COPY`), and the grid's copy commands ([[kbd:Mod-C]] + right-click — see [[topic:results|Results]]). Export works on every engine; import is Postgres-only (the button appears only when the driver reports `bulkCopy`)."
      },
      {
        "k": "h",
        "text": "The Export dialog",
        "id": "export-dialog"
      },
      {
        "k": "p",
        "md": "**Export…** freezes a snapshot of the current result — columns, loaded rows, query text, active schema — so switching tabs mid-dialog can't redirect the export."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Columns** — check/uncheck and reorder with the ↑/↓ buttons; keep at least one selected.",
          "**Preview** — live, from the first 12 loaded rows (skipped for xlsx).",
          "**Defaults** — CSV, comma delimiter, quote *as needed*, header row on, NULL as empty, LF line endings, no BOM."
        ]
      },
      {
        "k": "table",
        "head": [
          "Format",
          "What you get"
        ],
        "rows": [
          [
            "**CSV / TSV**",
            "Delimited text. Delimiter (comma / tab / semicolon / pipe / custom char), quoting (*As needed* / *Always* / *Never*), quote char, **NULL as** (empty / `NULL` / custom text), LF or CRLF line endings, optional **UTF-8 BOM**."
          ],
          [
            "**JSON**",
            "Array of objects keyed by column name, pretty-printed."
          ],
          [
            "**SQL inserts**",
            "`INSERT` statements with a configurable table name; **Multi-row INSERT** batches 1,000 value tuples per statement; **Include CREATE TABLE** prepends a `CREATE TABLE` (all columns `text` — results are untyped strings)."
          ],
          [
            "**Markdown**",
            "A pipe table with a header separator row."
          ],
          [
            "**Excel (xlsx)**",
            "File-only. Sheet name (defaults to the table name detected in the query, trimmed to 26 chars), **Bold header**, **Auto-filter**, **Freeze header**. Rows past **1,048,576** roll into additional sheets automatically."
          ]
        ]
      },
      {
        "k": "h",
        "text": "Scope: loaded rows vs. all rows",
        "id": "scope"
      },
      {
        "k": "p",
        "md": "The **Rows** selector decides what gets exported:"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Loaded rows (N)** — formats what the grid currently holds, in memory.",
          "**All rows (re-run query)** — re-executes server-side. Postgres streams via a dedicated cursor (`tusk_export_cur`) in **10,000-row batches** (constant memory); DuckDB, SQLite, and MySQL page via `LIMIT`/`OFFSET`. This scope is frozen while a manual transaction owns the session; export Loaded rows instead."
        ]
      },
      {
        "k": "p",
        "md": "The re-run honors the producing tab's active schema (the frozen snapshot carries its `search_path`), so unqualified names resolve as they did in the editor. Empty results still atomically replace the destination with a valid configured artifact, such as headers, `[]`, SQL DDL, or an empty workbook."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "On the paged engines (DuckDB, SQLite, MySQL) the all-rows export is **not snapshot-consistent** — concurrent writes between pages can skew it. Postgres streams inside one transaction."
      },
      {
        "k": "p",
        "md": "**To** switches between **File** and **Clipboard**; the clipboard uses a TypeScript formatter kept **byte-identical** to the Rust file writer (delimiter, quoting, NULL text, header, column projection, line endings). Clipboard forces the scope to *Loaded rows*; xlsx forces the destination to *File*."
      },
      {
        "k": "h",
        "text": "Cancelling a long export",
        "id": "cancel-rollback"
      },
      {
        "k": "p",
        "md": "During an all-rows stream the dialog locks its controls and shows **Cancel export**. Postgres gets an immediate `CancelRequest`, DuckDB the equivalent interrupt; SQLite and MySQL have no out-of-band cancel, so the current query finishes first."
      },
      {
        "k": "p",
        "md": "Cancel or error rolls back the read transaction and **deletes the partial file** (xlsx only writes the destination at the very end, so nothing half-written exists). Loaded-rows and clipboard exports run purely in memory — no query to cancel, but fast."
      },
      {
        "k": "h",
        "text": "Import (CSV / JSON → table)",
        "id": "import"
      },
      {
        "k": "p",
        "md": "**Import data** (sidebar toolbar, Postgres only) opens the import modal. **Choose file…** accepts `.csv`, `.tsv`, `.json`, and `.txt`. A `.json` file parses as an array of objects (union of keys → columns, nested values stringified); everything else uses the CSV parser, where **First row is header (CSV)** names the columns — unchecked gives `col1`, `col2`, …"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Existing table** — pick any `schema.table` Tusk knows; rows append.",
          "**New table** — name pre-filled from the file name (extension stripped, non-word chars → `_`); created with all-`text` columns in `public`."
        ]
      },
      {
        "k": "p",
        "md": "The `CREATE TABLE` (if any) plus the `COPY` run in **one transaction**: **Cancel & roll back** (or any error) undoes everything — status reads *\"Import cancelled — rolled back.\"* On success the sidebar schema refreshes so the table appears in the tree and autocomplete ([[topic:sidebar|Sidebar]])."
      },
      {
        "k": "h",
        "text": "Grid copy is its own thing",
        "id": "grid-copy"
      },
      {
        "k": "p",
        "md": "Grid copy skips the Export dialog. [[kbd:Mod-C]] copies the selection as TSV; the cell right-click menu adds **Copy as CSV**, **Copy as JSON**, **Copy as Markdown**, **Copy cell value**, and **Copy column**."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Headers** — omitted by default; flip **Copy w/ column names** next to Export… (the `copyHeaders` preference).",
          "**Values** — copies read through pending edits; booleans copy as the displayed `TRUE`/`FALSE`, not raw `t`/`f`/`0`/`1` (**View value…** stays raw). Copy runs the **export formatter**, so a copied CSV/TSV/JSON/Markdown block is byte-identical to the same export written to a file — empty strings stay quoted and distinct from `NULL`, and Markdown always includes its header row.",
          "**Pasting in** — see [[topic:grid-editing|Grid editing]]."
        ]
      }
    ],
    "icon": "download"
  },
  {
    "id": "plans",
    "title": "EXPLAIN plan visualization",
    "blurb": "EXPLAIN output rendered as a pan/zoomable, heat-colored tree on every engine.",
    "blocks": [
      {
        "k": "p",
        "md": "Any `EXPLAIN` result is auto-detected and rendered as a tree of node cards on a pan/zoom canvas — type `EXPLAIN` yourself or use the **Explain ▾** toolbar button. Detection is a cheap leading-keyword check, so a plain `SELECT` never pays for plan parsing."
      },
      {
        "k": "h",
        "text": "Running an explain",
        "id": "running"
      },
      {
        "k": "p",
        "md": "**Explain ▾** in the [[topic:editor|editor toolbar]] offers **Explain** and **Explain Analyze (runs the query)** — registry actions (`explain` / `explainAnalyze`), unbound by default; bind them in [[topic:shortcuts|Settings → Shortcuts]] or fire them from the ⌘/Ctrl K command palette. Each takes your selection, or the statement under the cursor, and wraps it in the engine's best structured form:"
      },
      {
        "k": "table",
        "head": [
          "Engine",
          "Explain",
          "Explain Analyze"
        ],
        "rows": [
          [
            "Postgres",
            "`EXPLAIN (FORMAT JSON) …`",
            "`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) …`"
          ],
          [
            "DuckDB",
            "`EXPLAIN (FORMAT json) …` when the build supports it, else plain `EXPLAIN`",
            "`EXPLAIN (ANALYZE, FORMAT json) …` or `EXPLAIN ANALYZE`"
          ],
          [
            "MySQL",
            "`EXPLAIN FORMAT=JSON …`",
            "`EXPLAIN ANALYZE …`"
          ],
          [
            "SQLite",
            "`EXPLAIN QUERY PLAN …`",
            "— not supported; the menu item is disabled (\"Not supported by this engine\")"
          ]
        ]
      },
      {
        "k": "p",
        "md": "DuckDB's parenthesized options are probed once at connect (`EXPLAIN (FORMAT json) SELECT 1`); the answer drives the wrapping for the whole session."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "`EXPLAIN ANALYZE` **executes** the statement. If it isn't a read (`SELECT`/`WITH`/`TABLE`/`VALUES`), Tusk shows an *Explain Analyze* confirmation dialog — only the red **Run it** button proceeds."
      },
      {
        "k": "h",
        "text": "Plan vs Grid",
        "id": "plan-grid"
      },
      {
        "k": "p",
        "md": "A parsed plan adds a **Plan / Grid** toggle to the [[topic:results|result toolbar]] — Plan is the default, Grid is the raw engine output; the choice is per-tab and **resets on every new run**. SQLite's bytecode `EXPLAIN` (opcode listing) and MySQL's tabular `EXPLAIN` (more than 2 columns) read better as tables, so they stay in the grid with no toggle."
      },
      {
        "k": "h",
        "text": "Reading the tree",
        "id": "tree"
      },
      {
        "k": "demo",
        "id": "plan-heat",
        "caption": "Heat coloring surfaces the expensive nodes at a glance."
      },
      {
        "k": "p",
        "md": "Each card shows the operator label, the object it touches, and — except in compact density — a stats line: actual time and rows when the plan ran (`EXPLAIN ANALYZE`), estimated cost and `~rows` otherwise. A header strip shows the engine badge, planning/execution totals when the engine reports them, and an **estimates only** marker for plans without actual measurements."
      },
      {
        "k": "list",
        "items": [
          "**Click a card** — dock a details panel: self cost, self time, every parsed property (filters, join conditions, buffers, …).",
          "**▾ / ▸ N** — collapse or expand a subtree; the badge counts hidden nodes. Collapsing doesn't re-fit the view.",
          "**Drag** to pan, **wheel** to zoom, **double-click the background** to fit the whole tree."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "Heat coloring paints each card's left border and background on a cold→hot ramp scaled by `sqrt(value / max)`, so mid-cost nodes stay visible next to one dominant node."
      },
      {
        "k": "list",
        "items": [
          "**Metric fallback** — cost → time → rows. DuckDB has no cost numbers (ANALYZE gives per-operator time, plain EXPLAIN only estimated cardinality), so it uses time or rows.",
          "**Timing semantics** — DuckDB reports *exclusive* per-operator time; Postgres *inclusive* per-loop time (Tusk multiplies by `loops` for the card)."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Settings → Plans",
        "id": "settings"
      },
      {
        "k": "table",
        "head": [
          "Setting",
          "Options"
        ],
        "rows": [
          [
            "Tree orientation",
            "Top-down · Left-to-right"
          ],
          [
            "Heat coloring by",
            "Cost · Actual time · Rows · Off"
          ],
          [
            "Node detail",
            "Normal (metrics on cards) · Compact (labels only)"
          ]
        ]
      },
      {
        "k": "p",
        "md": "All three live-apply from the gear-icon Settings dialog; an orientation change re-fits the view."
      },
      {
        "k": "h",
        "text": "When parsing fails",
        "id": "fallback"
      },
      {
        "k": "p",
        "md": "An unparseable plan is **never an error** — it falls back to a formatted monospace text block (Postgres text-mode `EXPLAIN` gets its own text parser first; DuckDB's box-art output and MySQL's `EXPLAIN ANALYZE` tree text render as styled text), and the raw rows are always one Grid-toggle away. Detection handles pretty-printed JSON split across multiple rows, and comments before the `EXPLAIN` keyword don't defeat it."
      }
    ],
    "icon": "eye"
  },
  {
    "id": "erd",
    "title": "Relationships & ERD",
    "blurb": "Foreign keys visually: neighborhood graphs, whole-schema ERD, reconstructed DDL.",
    "blocks": [
      {
        "k": "p",
        "md": "One dialog, two scopes: a **Neighborhood** view centered on one table, and a **Whole schema** ERD — both beside a syntax-highlighted pane of the relation's reconstructed `CREATE` DDL. Everything is read-only; SQL leaves only through the DDL pane's **Copy** and **Open in editor** buttons."
      },
      {
        "k": "h",
        "text": "Opening the viewer",
        "id": "opening"
      },
      {
        "k": "list",
        "items": [
          "**DDL & relationships…** — right-click a table, view, or materialized view in the [[topic:sidebar|sidebar]]; opens in Neighborhood scope, centered on it.",
          "**Schema diagram…** — right-click a schema node; jumps straight to the Whole schema ERD (DDL pane starts collapsed — click a table card to load its DDL)."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "The DDL pane auto-collapses to a thin `DDL` rail in schema scope and expands back in Neighborhood scope; the rail's chevron overrides either way. Postgres DDL is reconstructed pg_dump-style from the catalogs; other engines use native sources (SQLite `sqlite_master`, MySQL `SHOW CREATE`, DuckDB catalog, best-effort) — caveats in [[topic:sidebar|the sidebar topic]]."
      },
      {
        "k": "h",
        "text": "Neighborhood view",
        "id": "neighborhood"
      },
      {
        "k": "list",
        "items": [
          "**Center card** — the focused table's columns (up to **14**, then \"+N more columns\") with PK/FK marks; a self-referencing FK shows as a ↺ badge, not a loop.",
          "**Left stack** — tables that *reference* it (\"references this\"); **right stack** — tables it *references* (\"referenced\").",
          "**Edge labels** — the exact column mapping (`customer_id → id`; multi-column FKs comma-joined). The column gap sizes to the longest label."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "**Click** a neighbor card to re-center on it and walk the graph hop by hop; **drag** any card to reposition it, edges following live. A **5px pointer tolerance** separates click from drag; manual positions clear when you re-center."
      },
      {
        "k": "h",
        "text": "Whole-schema ERD",
        "id": "whole-schema"
      },
      {
        "k": "demo",
        "id": "erd-mini",
        "caption": "The schema ERD: family clusters, hue-coded edges, click a card to drill into its neighborhood."
      },
      {
        "k": "list",
        "items": [
          "**Cards** — key columns only (PK 🔑 and FK, up to 12 rows, then \"+N more keys\"); a table with no keys shows its column count.",
          "**Family blocks** — tables sharing a name prefix (`product_*`, `purchase_order_*` — the longest 1- or 2-token `_`-prefix shared by at least two tables) group into labeled dashed containers, each laid out as a small layered flow.",
          "**Placement** — a greedy proximity packer lands each cluster next to what it references; connected components shelf-pack toward a ~3:2 aspect.",
          "**FK-less tables** — a dense grid at the bottom behind a gutter, never mixed into the relationship story."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "The layout is **deterministic by construction** — no randomness, no convergence loops — so the same schema always produces bit-for-bit the same diagram."
      },
      {
        "k": "table",
        "head": [
          "Gesture",
          "Effect"
        ],
        "rows": [
          [
            "Click a card",
            "Drill into that table's Neighborhood view (loads its DDL)"
          ],
          [
            "Drag a card",
            "Reposition it (5px tolerance separates click from drag); edges follow"
          ],
          [
            "Drag a family label strip",
            "Move the whole container and every member table together"
          ],
          [
            "Hover a card",
            "Unrelated cards and edges dim; only its edges stay lit"
          ],
          [
            "Hover an edge",
            "Shows the column-mapping label"
          ],
          [
            "**Reset layout**",
            "Discards all manual repositioning, back to the computed layout (disabled when nothing was moved)"
          ],
          [
            "Wheel / drag background",
            "Zoom and pan the canvas"
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Manual nudges overlay the computed layout (zoom-aware) but are session-scoped: they clear when the schema graph reloads or you hit **Reset layout**. Past **300 tables** a \"large schema\" warning shows in the header — layout still completes (roughly 100ms at 200 tables)."
      },
      {
        "k": "h",
        "text": "Reading the edges",
        "id": "edges"
      },
      {
        "k": "list",
        "items": [
          "**Color** — each edge takes the hue of the table it **points at** (deterministic per-table hue, 14-step palette), so all FKs into `users` read as one stream; the matching chip sits on that card's header. In Neighborhood view, edges match the neighbor card's chip instead.",
          "**Fanning** — edges sharing an anchor point (several FKs into one PK) fan apart by a few pixels.",
          "**Hub damping** — a table whose incoming FK count reaches **35% of the schema's table count** (minimum 8), like audit-style `created_by` FKs, renders faint thin edges that light up only on hover."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Per-engine support",
        "id": "engines"
      },
      {
        "k": "p",
        "md": "FK introspection is **best-effort per driver** — an engine that can't answer returns an empty graph, never an error. A table genuinely without FKs shows \"No foreign-key relationships found for this relation.\" with its column card."
      },
      {
        "k": "list",
        "items": [
          "**Postgres** — `pg_constraint`, column lists in declared key order.",
          "**SQLite** — `pragma_foreign_key_list`; a FK that omits target columns resolves to the referenced table's PK.",
          "**MySQL** — `information_schema.KEY_COLUMN_USAGE`.",
          "**DuckDB** — `duckdb_constraints()` structured columns, falling back to parsing the constraint text."
        ],
        "ordered": false
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The same FK catalog powers autocomplete: right after `JOIN … ON` it proposes complete join conditions like `o.user_id = u.id` (multi-column FKs AND-ed), fetched lazily for the active schema plus `public`. See [[topic:editor-intel|Editor intelligence]]."
      }
    ],
    "icon": "link"
  },
  {
    "id": "ai",
    "title": "AI assistant",
    "blurb": "Schema-aware chat that proposes SQL. Keys in the OS keychain; nothing auto-runs.",
    "icon": "sparkle",
    "blocks": [
      {
        "k": "p",
        "md": "Toggle the docked right-side panel with the **✨ AI** topbar button (or bind `toggleAi` — it ships unbound). The assistant sees your dialect, schema, **foreign keys**, privileges, your [[topic:ai|skills]], editor SQL, and sample rows — but only *proposes* SQL. Nothing runs until you open it in a tab and press Run yourself."
      },
      {
        "k": "h",
        "text": "Providers and keys",
        "id": "providers"
      },
      {
        "k": "p",
        "md": "Everything to do with providers, keys and skills lives in **Settings → AI**. Each provider is a card: paste a key, pick a default model, override the API base, and press **Test connection** — which really does fetch that provider's model catalogue and shows you the actual error if it can't."
      },
      {
        "k": "p",
        "md": "**AI reply max tokens** sits in the same tab (256–128,000, snapped to 256). It caps the reply the panel asks for — the ceiling behind *✂️ Cut off at the token limit* — and shares one normalization with the [[topic:slack|Slack]] field, so both surfaces behave identically."
      },
      {
        "k": "table",
        "head": [
          "Provider",
          "What it is",
          "Key"
        ],
        "rows": [
          [
            "**Anthropic**, **OpenAI**, **Google Gemini**",
            "The frontier labs, direct",
            "Yours"
          ],
          [
            "**OpenCode Go**",
            "Flat-rate subscription, open-source coding models",
            "One key"
          ],
          [
            "**OpenCode Zen**",
            "Frontier *and* open models through one gateway",
            "One key"
          ],
          [
            "**OpenRouter**, **Groq**",
            "Routers / fast open-model hosting",
            "Yours"
          ],
          [
            "**Ollama**, **LM Studio**",
            "Local servers on this machine",
            "None needed"
          ],
          [
            "**OpenAI-compatible (custom)**",
            "Anything serving `/v1/chat/completions`",
            "Yours + a base URL"
          ]
        ]
      },
      {
        "k": "p",
        "md": "Keys are stored **per provider** in the **OS keychain** (service `tusk-ai`) and are used only by the Rust backend — never in localStorage, never echoed back to the UI. The panel only ever learns a boolean. Because each provider has its own keychain entry, you can set up several and switch between them mid-conversation without re-entering anything. Non-secret config (active provider, per-provider model and base URL, the sample-data toggle) lives in localStorage under `tusk.ai.config`."
      },
      {
        "k": "p",
        "md": "A **custom API base must be approved before anything is sent to it** — credentials, prompts, schema context, or sample rows. A saved key is bound in the keychain to the approved HTTPS origin; until you approve one, the provider card shows *Origin approval needed* and Test connection refuses. Legacy keys keep working at the provider's shipped origin until re-saved, and Slack fails closed when its configured origin doesn't match the binding."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Local providers need no key and no network: with **Ollama** or **LM Studio** selected, your schema, foreign keys and sample rows never leave the machine."
      },
      {
        "k": "h",
        "text": "Choosing a model",
        "id": "models"
      },
      {
        "k": "p",
        "md": "The picker in the panel header is a **searchable combobox**, not a dropdown — a router like OpenRouter serves several hundred models. Click it (or just start typing) to fuzzy-filter across every provider you've set up; ↑/↓ to move, Enter to pick, Esc to close. Matched characters are highlighted."
      },
      {
        "k": "table",
        "head": [
          "Type this",
          "To find"
        ],
        "rows": [
          [
            "`opus`",
            "every Opus model, from any provider"
          ],
          [
            "`ant opus`",
            "**both terms must match** — `anthropic/claude-opus-4.8`"
          ],
          [
            "`co48`",
            "`claude-opus-4-8` — an abbreviation across separators"
          ],
          [
            "`oss`",
            "`openai/gpt-oss-120b`, because `oss` starts a word"
          ]
        ]
      },
      {
        "k": "p",
        "md": "With the search box empty you get the curated grouping instead: **Flagship / Balanced / Fast & cheap / Older, still widely used**, per provider. Model lists are fetched **live** from each provider using your saved key; the curated list is only a fallback for when that fetch fails. **Custom…** in Settings accepts any model id your endpoint takes."
      },
      {
        "k": "h",
        "text": "Skills — instructions the assistant follows",
        "id": "skills"
      },
      {
        "k": "p",
        "md": "A **skill** is a piece of Markdown you write once and the assistant obeys on every question. It is for the things your schema *cannot* tell it: that money is stored in integer cents, that \"revenue\" excludes refunds, that `orders.buyer` is the customer link, that the `legacy_*` tables are never correct. Manage them in **Settings → AI → Skills**."
      },
      {
        "k": "table",
        "head": [
          "Scope",
          "Applies",
          "Use it for"
        ],
        "rows": [
          [
            "**Workspace**",
            "Every connection",
            "House style, SQL conventions, how you like answers formatted"
          ],
          [
            "**This database**",
            "Only the connected database",
            "Domain rules, table quirks, forbidden tables"
          ]
        ]
      },
      {
        "k": "p",
        "md": "A database skill adopts whichever database you're connected to — you never type the name. Open one written against a different database and Tusk says so, and offers **Retarget** in one click."
      },
      {
        "k": "code",
        "caption": "A skill is just Markdown with a little frontmatter. This IS the file on disk.",
        "text": "---\nname: shop house rules\ndescription: Revenue, money units and forbidden tables\nscope: database\ndatabase: tusk_demo\nenabled: true\n---\n## Money\nEvery monetary column is an integer number of **cents**. Divide by 100.0 and round to 2dp.\n\n## Revenue\nAn order counts only if `status = 'paid'` **and** it has no row in `shop.refunds`\n(partial refunds leave the status alone) **and** the customer is not soft-deleted.\nPrefer `analytics.v_orders_clean`, which already encodes all three.\n\n## Forbidden\nNever query `shop.legacy_orders_2019`. Its conventional column names look inviting\nand it is never part of a current report."
      },
      {
        "k": "list",
        "items": [
          "**Create / Edit / Delete** — the body is the part the model reads; name and description are for you and for the skill list.",
          "**Enable / disable** with the checkbox. A disabled skill is never sent.",
          "**Import…** any `.md` file. No frontmatter? The whole file becomes the body.",
          "**Export** writes exactly the file above — the on-disk format *is* the export format, so skills are diffable and can live in a repo.",
          "Skills are stored one file per skill under the app config directory (`skills/<id>.md`)."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "Skills reach the model **before** the schema — house rules are read before the data — and a database-scoped skill sorts ahead of a workspace one, so the specific instruction survives a context-budget cut ahead of the general one. If a skill *is* cut for budget, the prompt says so **by name**, because a silently dropped instruction is indistinguishable from a model that ignored it."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Skills shape *what* the model writes; they never widen *what can run*. The read-only guard, the [[topic:safety|permission gates]], and the Slack bot's single-read-only-SELECT rule are enforced in code and always outrank a skill."
      },
      {
        "k": "p",
        "md": "The [[topic:slack|Slack bot]] reads the same skills, scoped to the same database, and reloads them on every question — edit a skill and the next Slack question already follows it, no restart."
      },
      {
        "k": "h",
        "text": "What the model sees",
        "id": "context"
      },
      {
        "k": "p",
        "md": "Every send rebuilds a token-budgeted system prompt from the live connection:"
      },
      {
        "k": "list",
        "items": [
          "**Your skills** — the ones in scope, first, as above.",
          "**Dialect + version** — driver label, server version, and a quoting note (backticks on MySQL, double quotes elsewhere).",
          "**Your role** — user name, superuser flag, and (on Postgres) whether privileges are enforced; a limited role gets an explicit \"prefer reads, warn before writes/DDL\" instruction.",
          "**Active schema** — the tab's search-path schema, so bare table names resolve as your queries do.",
          "**Schema summary** — `schema.table(col type, …)` lines up to a **12,000-character budget**, relevance-ranked: tables named in the conversation get full columns first. Tables past the budget are still listed by name.",
          "**Foreign keys** — the real join graph (`orders.buyer -> customers.id`, composites as `a.(x, y) -> b.(p, q)`), told to the model as authoritative. Without it the model guesses join columns from naming convention and gets them wrong on any schema that doesn't follow `<table>_id`.",
          "**Your editor SQL** — the buffer, or just the selection (capped at 4,000 chars), plus the tab's last query error; the **Explain** and **Fix error** quick actions use exactly this.",
          "**Sample rows** — see below."
        ],
        "ordered": false
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "If Tusk hasn't been able to read the foreign keys, it stays **silent** about them rather than telling the model \"this schema has none\" — a wrong claim there is what produces confidently wrong joins."
      },
      {
        "k": "h",
        "text": "Sample data — real rows leave your machine",
        "id": "samples"
      },
      {
        "k": "p",
        "md": "When sample sharing is enabled, Tusk fetches **5 rows** from up to **5 conversation-relevant tables** via the backend `sample_rows` command — a read-only `SELECT * FROM rel LIMIT 5` that never touches the streaming cursor, so a mid-stream question won't truncate a [[topic:results|running result]]. Rows format into a budgeted pipe-table (4,000 chars total, 80 per cell), cached per table until schema reload — grounding the model in your real date formats, id styles, and enum spellings."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Sample sharing is **off by default** and fails closed if its preference cannot be saved. It is re-checked after sample loading, immediately before the request, so revoking it mid-flight discards the rows. Tick **Share sample data with the model** in the panel's ⚙ drawer to opt in. Slack has its own default-off sample setting; neither path sends real cell values without that explicit consent."
      },
      {
        "k": "h",
        "text": "Stop, Retry, and streams that die",
        "id": "stop-retry"
      },
      {
        "k": "p",
        "md": "While a reply streams, **Send** becomes **⏹ Stop** — pressing it (or [[kbd:Escape]]) interrupts the live HTTP stream at the provider, not just on screen. The partial reply stays; nothing is lost."
      },
      {
        "k": "list",
        "items": [
          "A **transient failure before the first word** (rate limit, overload, dropped socket) is retried up to three times automatically, with backoff. You never see it.",
          "A reply that **dies mid-sentence** can't be replayed — that would duplicate the text you're already reading — so Tusk **restarts the turn once**, then hands you a **↻ Retry** button.",
          "A reply cut short by the model's token ceiling is flagged **✂️ Cut off at the token limit** rather than pretending it finished.",
          "A provider error is shown as an error. Tusk never reports a failed reply as a finished one."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Replies, and why the model can't run anything",
        "id": "replies"
      },
      {
        "k": "p",
        "md": "Replies stream token-by-token (SSE parsed in Rust, relayed over a Tauri channel) and render as markdown with syntax-highlighted fenced ```sql blocks. Each SQL (or untagged) block gets **Copy** and **▶ Open in editor** — the latter opens a **new tab** titled *AI query* with your active schema attached; it never overwrites your buffer and never runs. Running is always your keystroke."
      },
      {
        "k": "h",
        "text": "Shortcuts",
        "id": "ai-keys"
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "toggleAi",
            "does": "Show / hide the AI panel (unbound by default — set it in [[topic:shortcuts|Settings → Shortcuts]])"
          },
          {
            "action": "openSettings",
            "does": "Open Settings — the **AI** tab holds providers, keys and skills"
          },
          {
            "combo": "Escape",
            "does": "Stop the reply that's currently streaming"
          },
          {
            "combo": "Shift-Enter",
            "does": "Newline in the chat composer (plain Enter sends)"
          }
        ]
      }
    ]
  },
  {
    "blocks": [
      {
        "k": "p",
        "md": "Teammates ask your database plain-language questions from Slack while Tusk runs on your desk — **desktop-hosted Socket Mode** (one outbound WebSocket, no server, no public endpoint, **bring-your-own Slack app**). The AI proposes SQL; **nothing runs without an Approve click**, and only single read-only SELECTs run — against whatever connection is active in Tusk."
      },
      {
        "k": "h",
        "text": "Setup",
        "id": "setup"
      },
      {
        "k": "list",
        "items": [
          "**Create your own app** from the YAML manifest in `docs/slack-setup.md` (scopes: `chat:write`, `files:write`, `app_mentions:read`, `im:history`, `im:write`, optional `channels:history`; Socket Mode + interactivity on).",
          "**Two tokens** — the Bot token (`xoxb-…`, from Install to Workspace) and an App-level token (`xapp-…`) with `connections:write`.",
          "**Paste both in Settings → Slack** — stored in the OS keychain (service `tusk-slack`), never written to disk, never echoed back (placeholder says *\"saved in keychain — type to replace\"*).",
          "**Test connection** validates both tokens and names the workspace; **Enable Slack bot** starts/stops it. Statusbar badge: `🟢 Slack` running, 🟡 connecting/reconnecting.",
          "**AI provider/model** is mirrored from **Settings → AI** whenever the Slack pane saves — the Rust bot can't read the web view's storage, so after changing provider or model, change any Slack setting or press Save here."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Ask, approve, run",
        "id": "flow"
      },
      {
        "k": "p",
        "md": "**DM the bot** (\"show all tables in the public schema\") or **@mention it** in a channel it's been invited to. It threads *\"Generating query…\"*, snapshots your schema, role permissions, and up to 5 sample rows from the 5 most relevant tables, then updates the message into a **proposal card** — explanation, exact SQL, **Approve / Reject** buttons (a requested chart is advertised with 📊)."
      },
      {
        "k": "demo",
        "id": "slack-approve",
        "caption": "A question becomes a SQL proposal — only the requester's Approve click runs it."
      },
      {
        "k": "list",
        "items": [
          "**Only the requester** can Approve or Reject — anyone else gets an ephemeral \"Only the requester can approve or reject this query.\"",
          "**Proposals expire after 5 minutes** — a stale click gets \"⏰ This proposal has expired — ask the question again.\"",
          "**Refine in the thread** (\"now filter to Q3 only\") — the last 10 thread replies feed back to the AI as context.",
          "Approve flips the card to ⏳ Running… then ✅ Complete or ❌ Failed; the result posts in the same thread."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "Every approved run lands in Tusk's [[topic:history|query history]] with a `-- [Slack] asked by <user>` marker, so you can audit what the bot executed."
      },
      {
        "k": "h",
        "text": "It follows your skills",
        "id": "slack-skills"
      },
      {
        "k": "p",
        "md": "The bot reads the same [[topic:ai|skills]] as the desktop assistant — workspace skills always, and database skills when they match the connected database. They are reloaded **on every question**, so editing a skill changes the next answer with no bot restart (unlike the Slack settings themselves, which need a toggle off/on)."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A skill can change the SQL the bot *writes*. It can never change what the bot is *allowed to run*: the single read-only `SELECT` gate is enforced in code, at proposal time and again at execution, and no instruction can widen it."
      },
      {
        "k": "h",
        "text": "Results: tables, files, local charts",
        "id": "results"
      },
      {
        "k": "list",
        "items": [
          "**Inline monospace table** — ≤ *Max rows (inline table)* (default **20**), ≤ **5** columns, and the text fits Slack's message block.",
          "**CSV attachment** — medium results; **XLSX** past **15** columns.",
          "**Auto-chart** — date+numeric results (2–4 columns, first column date-like, ≤ 50 rows) when *Auto-chart date/numeric results* is on (default). Rendering is fully local — nothing extra leaves the machine.",
          "**Explicit requests** (*\"chart monthly revenue as a bar chart\"*) — the type/axes/labels you name are honored over the heuristic.",
          "**Chart types**: line, grouped bar, scatter, pie — capped at **400 points** and **12 pie slices**; over the cap or unrenderable falls back to a note plus the data."
        ],
        "ordered": false
      },
      {
        "k": "p",
        "md": "Every result carries **Export as… CSV / TSV / Excel / JSON / SQL / Markdown** buttons — results stay exportable for **15 minutes** (8 most recent kept), a click uploads the file in-thread named after the queried table. Export clicks are requester-only, and channel/user allowlists still apply."
      },
      {
        "k": "h",
        "text": "What keeps it safe",
        "id": "safety"
      },
      {
        "k": "p",
        "md": "Write-blocking is **layered and independent of the AI** — the model's SQL is never trusted (see [[topic:safety|Safety]]). The same `validate_read_only` gate runs when the proposal is created **and again at execution**:"
      },
      {
        "k": "list",
        "items": [
          "**Single statement only** — scripts are rejected outright.",
          "**Wrappable reads only**: `SELECT` / `WITH` / `TABLE` / `VALUES`. `EXPLAIN` and `SHOW` are read-only but can't be a subquery, so they're rejected too.",
          "**Masked mutation scan** — strings, comments, dollar-quotes, and quoted identifiers are blanked, then `insert` / `update` / `delete` / `merge` / `drop` / `alter` / `truncate` / `create` / `grant` / `revoke` are word-boundary matched **anywhere** — catching writable CTEs like `WITH d AS (DELETE …) SELECT`, smuggled DDL, and `FOR UPDATE` / `FOR SHARE` row locks.",
          "**Hard row cap** — execution wraps the query as `SELECT * FROM (…) AS _tusk LIMIT cap+1` (*Max rows (file / hard cap)*, default **10,000**) with a \"(truncated at N rows)\" note.",
          "**Engine-aware timeout** — *Query timeout* (default **30 s**) uses a real server-side CancelRequest on Postgres; other engines report when a query may finish after Tusk stops waiting.",
          "**Fresh engine-enforced read-only connection** — plus a conservative allowlist of common deterministic functions; unknown, file/network, session, sleep, extension, and sequence routines are rejected.",
          "**Never the UI's streaming cursor** — Slack queries run buffered, never through the shared server cursor a grid stream owns."
        ],
        "ordered": false
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A false positive — a bare column literally named `delete` — degrades to \"run it in the Tusk editor.\" That's the intended trade: the scan is never loosened to fix one query."
      },
      {
        "k": "p",
        "md": "The **When asked for writes/DDL** setting only shapes the bot's *reply*: **Propose read-only preview** (default) proposes a SELECT of the affected data; **Refuse & point to editor** refuses outright. Neither gates anything — the scan does."
      },
      {
        "k": "h",
        "text": "Access control & limits",
        "id": "settings"
      },
      {
        "k": "p",
        "md": "These settings **save as you change them**, like the rest of the Settings dialog — no Save click needed. The **Save** button stores newly typed tokens (and still saves everything else)."
      },
      {
        "k": "table",
        "head": [
          "Setting",
          "Default",
          "Notes"
        ],
        "rows": [
          [
            "Allowed channels",
            "empty = all",
            "Channel IDs (`C…`/`D…`), comma-separated; empty means any channel the bot is in"
          ],
          [
            "Allowed users",
            "empty = all",
            "User IDs (`U…`), comma-separated; empty means anyone in an allowed channel"
          ],
          [
            "Max rows (inline table)",
            "20",
            "1–100; above this (or > 5 columns) results attach as files"
          ],
          [
            "Max rows (file / hard cap)",
            "10,000",
            "100–100,000; the subquery `LIMIT` cap on every run"
          ],
          [
            "Query timeout (seconds)",
            "30",
            "1–600; expiry requests a server-side cancel (a real CancelRequest on Postgres)"
          ],
          [
            "Auto-chart date/numeric results",
            "on",
            "Explicit chart requests are honored even when off"
          ],
          [
            "When asked for writes/DDL",
            "Propose read-only preview",
            "Reply shaping only — writes never run regardless"
          ],
          [
            "Share sample rows with AI",
            "off",
            "Real cell values only leave the machine after this explicit opt-in"
          ],
          [
            "AI reply max tokens",
            "2,048",
            "256–128,000, snapped to 256; the desktop AI pane has the same control"
          ]
        ]
      },
      {
        "k": "h",
        "text": "Caveats",
        "id": "caveats"
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Every proposal is pinned to the exact Tusk connection, server-reported database, workspace, channel, thread, source message, and requester that created it. Switching connection or database makes approval fail closed. Execution uses a fresh read-only backend and does not join or roll back the UI cursor."
      },
      {
        "k": "list",
        "items": [
          "Config edits (allowlists, caps, timeout, policy, AI provider, sample consent) reload per-question. Replacing tokens validates them and restarts the running bot; restart failure stops and disables it.",
          "The timeout only preempts the async network drivers (Postgres/MySQL) — **DuckDB and SQLite run synchronously**, so a pathological embedded query holds the connection until it finishes (the timeout message notes the server may still be finishing it).",
          "The bot lives inside the desktop app — Tusk must be **open and connected**.",
          "One Slack query at a time (events handled sequentially)."
        ],
        "ordered": false
      }
    ],
    "blurb": "Ask your database questions from Slack; approve AI-proposed read-only SQL.",
    "id": "slack",
    "title": "Slack bot",
    "icon": "comment"
  },
  {
    "id": "history",
    "title": "Query history",
    "blurb": "Per-connection run log — search it, re-run it, reopen with schema.",
    "blocks": [
      {
        "k": "p",
        "md": "Tusk logs every query you run, per connection — statement text, outcome, duration, row count, and the schema it ran under. Click the clock icon in the topbar (or hit the shortcut) to toggle the right-side **Query history** panel."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "openHistory",
            "does": "Toggle the history panel (only enabled while connected)"
          }
        ]
      },
      {
        "k": "h",
        "text": "What gets recorded (and what doesn't)",
        "id": "what-recorded"
      },
      {
        "k": "p",
        "md": "An entry is written when a **user-issued run** finishes — success, error, or cancel. Each stores the exact SQL, a timestamp, elapsed milliseconds, an `ok` / `error` / `cancelled` status, the row count when known (for a streamed read, the first fetched page — see [[topic:results|Results & streaming]]), the first line of any error, and the tab's **active schema** at run time."
      },
      {
        "k": "list",
        "items": [
          "**Recorded** — anything launched from the editor: Run, run-selection, panel re-runs, multi-statement scripts (one entry).",
          "**Recorded with a marker** — server work issued outside the editor carries an audit comment on its first line: `-- [Slack] asked by <user>` for approved bot runs, `-- [Explorer]` for sidebar DDL, and `-- [Export] <format> → <path>` for a full-query file export.",
          "**Not recorded** — grid sort/filter re-streams (internal `wrapped`-mode runs of `SELECT * FROM (…) _tusk`); only the original `base` query is kept.",
          "**Recorded** — [[topic:grid-editing|grid Commit/Apply]] scripts. Raw transaction controls and work inside a manual unit carry a leading transaction id/revision/event marker."
        ],
        "ordered": false
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Re-running the *identical* newest SQL refreshes the top entry in place (new timestamp, duration, status) — no duplicates."
      },
      {
        "k": "h",
        "text": "Where it lives",
        "id": "storage"
      },
      {
        "k": "p",
        "md": "History is **file-backed per connection**: JSON under `<app-config>/history/`, keyed `profile:<id>` for saved profiles or `adhoc:` from host/port/database/user (driver + file path, `:memory:` when blank, for DuckDB/SQLite). Saves are debounced **500 ms** and capped at the newest **500 entries** per connection."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Recording never blocks a query: if the history file can't be written, Tusk silently degrades to in-memory history for the session — queries still run, the log is lost on exit."
      },
      {
        "k": "h",
        "text": "Reading the panel",
        "id": "reading"
      },
      {
        "k": "p",
        "md": "Each row shows a status dot (green `ok`, red `error`, amber `cancelled`), the SQL's first line, the duration (`842ms` / `3.1s`), and a relative timestamp (`12s ago`, `5m ago`, `3h ago`, then a date). Click a row to expand: the full statement renders syntax-highlighted, with the first error line and row count when known."
      },
      {
        "k": "list",
        "items": [
          "**Search** — `Search history…` filters SQL live (case-insensitive substring).",
          "**Resize** — drag the splitter on the panel's left edge (**240–700 px**)."
        ],
        "ordered": false
      },
      {
        "k": "h",
        "text": "Acting on an entry",
        "id": "actions"
      },
      {
        "k": "p",
        "md": "An expanded entry offers three buttons:"
      },
      {
        "k": "table",
        "head": [
          "Button",
          "What it does"
        ],
        "rows": [
          [
            "**Insert**",
            "Inserts the SQL at the cursor in the active [[topic:editor|editor]] tab — nothing runs."
          ],
          [
            "**Open in tab**",
            "Opens a new tab titled *History* with the SQL, active schema set to what the query originally ran under."
          ],
          [
            "**Re-run**",
            "Runs the SQL through the normal run path immediately — parameter prompts apply; a multi-statement entry re-runs as one script."
          ]
        ]
      },
      {
        "k": "h",
        "text": "Clearing history",
        "id": "clearing"
      },
      {
        "k": "p",
        "md": "The trash icon in the panel header clears the **current connection's** history only — it flips to a `Clear all?` confirm first, so a stray click can't wipe the log. Disconnecting closes the panel and clears the list; it reloads on the next connect (from disk on first load after launch)."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "[[kbd:Mod-k]] opens the [[topic:shortcuts|command palette]] — find \"Toggle query history\" there; rebind the key in Settings → Shortcuts."
      }
    ],
    "icon": "clock"
  },
  {
    "id": "shortcuts",
    "title": "Keyboard shortcuts & command palette",
    "blurb": "One registry drives shortcuts, palette, and Settings — rebind once, everywhere.",
    "blocks": [
      {
        "k": "p",
        "md": "Every action — run, format, tabs, panel toggles — lives in one registry (`src/actions.ts`); the global key handler, the editor keymap, **Settings → Shortcuts**, and the [[kbd:Mod-k]] palette all read from it, so a rebind updates everywhere at once. Chords use CodeMirror syntax (`Mod-Shift-Enter`); **Mod** = Cmd on macOS, Ctrl elsewhere."
      },
      {
        "k": "h",
        "text": "Default bindings",
        "id": "defaults"
      },
      {
        "k": "p",
        "md": "The chips below are live — a rebound action shows your chord, not the shipped default. Some actions ship unbound on purpose (Explain, Toggle AI, Load all rows, What's new, …) but stay reachable from the palette and toolbars."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "run",
            "does": "Run the selection, or the whole buffer"
          },
          {
            "action": "runStatement",
            "does": "Run only the statement under the cursor"
          },
          {
            "action": "explain",
            "does": "EXPLAIN the current statement (plan view)"
          },
          {
            "action": "explainAnalyze",
            "does": "EXPLAIN ANALYZE — actually executes the statement"
          },
          {
            "action": "cancelQuery",
            "does": "Cancel the running query (enabled only while one runs)"
          },
          {
            "action": "commitTransaction",
            "does": "Commit the current transaction unit"
          },
          {
            "action": "rollbackTransaction",
            "does": "Roll back the current transaction unit"
          },
          {
            "action": "openHelp",
            "does": "Open the manual"
          },
          {
            "action": "showWhatsNew",
            "does": "Show what changed in this version"
          },
          {
            "action": "loadAllRows",
            "does": "Drain the streaming cursor to the end"
          },
          {
            "action": "exportResult",
            "does": "Open the Export dialog for the current result"
          },
          {
            "action": "format",
            "does": "Format the SQL buffer"
          },
          {
            "action": "find",
            "does": "Find & replace"
          },
          {
            "action": "toggleComment",
            "does": "Toggle line comment"
          },
          {
            "action": "toggleWrap",
            "does": "Toggle word wrap in the editor"
          },
          {
            "action": "newTab",
            "does": "New editor tab"
          },
          {
            "action": "closeTab",
            "does": "Close tab (confirms if dirty)"
          },
          {
            "action": "openFile",
            "does": "Open a .sql file into a tab"
          },
          {
            "action": "saveFile",
            "does": "Save the active tab"
          },
          {
            "action": "saveFileAs",
            "does": "Save the active tab to a new file"
          },
          {
            "action": "openSettings",
            "does": "Open Settings"
          },
          {
            "action": "openShortcuts",
            "does": "Jump straight to Settings → Shortcuts"
          },
          {
            "action": "openHistory",
            "does": "Toggle the query history panel"
          },
          {
            "action": "openPalette",
            "does": "Open the command palette"
          },
          {
            "action": "toggleAi",
            "does": "Toggle the AI assistant panel"
          },
          {
            "action": "toggleSidebar",
            "does": "Collapse / restore the Explorer sidebar"
          },
          {
            "action": "toggleResults",
            "does": "Collapse / restore the results panel (running a query reopens it automatically)"
          }
        ]
      },
      {
        "k": "p",
        "md": "Actions carry an *enabled* predicate the dispatcher checks before firing; a chord bound to a disabled action is silently ignored."
      },
      {
        "k": "list",
        "items": [
          "**Run** — needs a connection",
          "**Explain** / **Explain Analyze** — blocked while a query runs; Explain Analyze also needs engine support (SQLite has no `EXPLAIN ANALYZE`)",
          "**Cancel running query** — only while a query runs",
          "**Cancel query** and **Open manual** are allowlisted through the window handler, so they fire while a modal dialog is open and while focus is in the editor; Shortcuts-settings keys also work on the connect screen, where the command palette is honestly disabled.",
          "**Load all rows** / **Export result…** — need a result in the grid"
        ]
      },
      {
        "k": "h",
        "text": "Rebinding in Settings → Shortcuts",
        "id": "rebinding"
      },
      {
        "k": "p",
        "md": "Open **Settings → Shortcuts** (or run **Show keyboard shortcuts** from the palette) — a searchable table grouped by Query, Editor, Tabs, File, View that doubles as the cheat-sheet."
      },
      {
        "k": "list",
        "items": [
          "**Rebind** — click the binding chip (*press keys…*), then press the new chord",
          "[[kbd:Escape]] — cancel the capture",
          "[[kbd:Backspace]] / [[kbd:Delete]] — unbind the action entirely",
          "Bare modifiers and unmodified printable keys are rejected — a plain letter must stay typeable"
        ]
      },
      {
        "k": "p",
        "md": "Conflicts share one flat namespace across both scopes: press a chord another action owns and the row shows *bound to \"<that action>\" — press again to replace*; a second press steals it (the other action unbinds). Overridden rows get **⟲ Reset to default**, **Reset all** clears every override, and only diffs persist (localStorage `tusk.keys`, `null` = explicitly unbound) so future default changes flow through to anything untouched."
      },
      {
        "k": "p",
        "md": "A read-only **Built-in (not rebindable)** section lists the CodeMirror internals: [[kbd:Mod-f]] find/replace in the editor, [[kbd:Mod-z]] undo/redo, [[kbd:Mod-Shift-[]] fold, [[kbd:Tab]] accept-completion / indent."
      },
      {
        "k": "h",
        "text": "Command palette",
        "id": "palette"
      },
      {
        "k": "p",
        "md": "[[kbd:Mod-k]] opens the palette: fuzzy subsequence matching over `category + title` (consecutive characters and word-starts score higher, so `rst` finds *Run current statement*). Navigate with ↑/↓, [[kbd:Enter]] runs, [[kbd:Escape]] closes; every row shows the action's **live** binding chip."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Actions whose enabled-check fails are **filtered out of the palette**, not greyed. Can't find *Export result…*? Run a query first."
      },
      {
        "k": "h",
        "text": "Editor scope vs global scope",
        "id": "scopes"
      },
      {
        "k": "p",
        "md": "Editor-scoped actions (**Run**, **Run current statement**, **Format SQL**, **Toggle comment**, **Find & replace**) are also bound inside CodeMirror, so they win while you type; the window handler skips anything the editor consumed (`defaultPrevented`). Global actions (tabs, files, panels) dispatch at the window level regardless of focus — so [[kbd:Mod-w]] closes a Tusk tab, not the window."
      },
      {
        "k": "p",
        "md": "A binding **without Mod or Alt** (`F5`, bare `Enter`) never fires while focus is in an input, textarea, contenteditable, or the SQL editor. The global handler is also inert while the palette is open and before you connect."
      },
      {
        "k": "h",
        "text": "Fixed keys: the result grid",
        "id": "grid-keys"
      },
      {
        "k": "p",
        "md": "The [[topic:results|result grid]] handles its own keyboard — these aren't registry actions and can't be rebound. Editing keys apply only when the result is [[topic:grid-editing|editable]]."
      },
      {
        "k": "keys",
        "rows": [
          {
            "combo": "ArrowKeys",
            "does": "Move the active cell; Shift extends a range selection"
          },
          {
            "combo": "Home",
            "does": "First column ([[kbd:Mod-Home]] = top-left corner)"
          },
          {
            "combo": "End",
            "does": "Last column ([[kbd:Mod-End]] = bottom-right corner)"
          },
          {
            "combo": "PageDown",
            "does": "Jump one viewport of rows (PageUp likewise)"
          },
          {
            "combo": "Mod-a",
            "does": "Select all cells"
          },
          {
            "combo": "Mod-c",
            "does": "Copy the selection as TSV (headers gated by the *Copy w/ column names* checkbox)"
          },
          {
            "combo": "Mod-v",
            "does": "Paste TSV/CSV from the clipboard (editable grids only)"
          },
          {
            "combo": "Enter",
            "does": "Edit the focused cell (F2 works too)"
          },
          {
            "combo": "Delete / Backspace",
            "does": "Toggle delete-marks — only when whole rows are selected, so a stray Delete on a cell can't mark rows"
          },
          {
            "combo": "Escape",
            "does": "Collapse the selection back to a single cell"
          }
        ]
      },
      {
        "k": "p",
        "md": "In the inline cell editor: [[kbd:Enter]] commits and moves down, [[kbd:Tab]] commits and moves right, [[kbd:Escape]] cancels, [[kbd:Alt-n]] sets SQL `NULL`. Arrowing within 30 rows of the loaded end triggers the next streaming fetch."
      },
      {
        "k": "h",
        "text": "Fixed keys: inside the editor",
        "id": "editor-keys"
      },
      {
        "k": "p",
        "md": "CodeMirror owns a few keys the registry never touches; see [[topic:editor|the editor topic]] for the full editing surface."
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Tab]] — layered: accepts an open completion, else applies a [[topic:editor-intel|lint quick-fix]] under the cursor, else indents",
          "[[kbd:Enter]] — accepts a completion when the popup is open, otherwise a normal newline",
          "Quick-fixes — also on [[kbd:Alt-Enter]] and [[kbd:Mod-.]]",
          "Statement gutter ▶ — runs a statement by mouse; keyboard equivalents are the rebindable **Run** / **Run current statement**"
        ]
      }
    ],
    "icon": "bolt"
  },
  {
    "id": "workspace",
    "title": "Workspace, themes & settings",
    "blurb": "Panels, topbar, Settings dialog, 8 themes, accent/font, built-in updater.",
    "blocks": [
      {
        "k": "p",
        "md": "One window: a resizable **Explorer** sidebar on the left, a tabbed editor over a results pane, and optional **AI** and **History** panels docked right. Every theme, font, and behavior toggle lives in one flat preferences object in localStorage and applies live — no OK/Cancel anywhere."
      },
      {
        "k": "h",
        "text": "Panels and splits",
        "id": "panels"
      },
      {
        "k": "list",
        "items": [
          "**Explorer** — drag the sidebar/editor divider (**180–560 px**)",
          "**Editor height** — the horizontal splitter between editor and results",
          "**AI panel** ([[topic:ai|AI assistant]]) — **280–760 px**",
          "**History panel** ([[topic:history|query history]]) — **240–700 px**"
        ]
      },
      {
        "k": "p",
        "md": "All four sizes persist under `tusk.layout` and survive a restart; stale values are clamped (the split on load, panel widths by their resize handlers), so they're harmless."
      },
      {
        "k": "demo",
        "id": "panels",
        "caption": "Drag the dividers to resize the sidebar, editor/results split, and AI/History panels — sizes persist across restarts."
      },
      {
        "k": "p",
        "md": "Editor **tabs persist per connection** (`tusk.tabs.*`): each tab's SQL buffer, file path, title, active schema, and which tab was active return on reconnect. **Results are ephemeral** — snapshots, streaming cursors, and pending grid edits never persist; see [[topic:results|Results & streaming]]."
      },
      {
        "k": "h",
        "text": "Topbar and statusbar",
        "id": "topbar"
      },
      {
        "k": "list",
        "items": [
          "**Brand mark** — driver-adaptive mascot (🐘 Postgres, 🦆 DuckDB, 🪶 SQLite, 🐬 MySQL; same emoji in the OS window title)",
          "**Connection chip** — database name, or file basename / `:memory:` for embedded drivers",
          "Driver label + server version",
          "**🔒 Read-only** badge when the connection blocks writes and DDL",
          "Right side: **✨ AI** toggle, history clock, **?** (this manual), Settings gear, **Disconnect**"
        ]
      },
      {
        "k": "p",
        "md": "The footer statusbar shows status text, a **🟢/🟡 Slack** badge while the [[topic:slack|Slack bot]] is connecting or connected (hover for the error), and cursor info: line/column, `Stmt 2/5` in multi-statement buffers, selection character count. **Copy w/ column names** lives in the result toolbar next to Export…, not here — same `copyHeaders` pref as Settings → Grid."
      },
      {
        "k": "h",
        "text": "The Settings dialog",
        "id": "settings"
      },
      {
        "k": "p",
        "md": "Open with the topbar gear or [[kbd:Mod-,]] (the `openSettings` action). Eight tabs; every control applies immediately:"
      },
      {
        "k": "table",
        "head": [
          "Tab",
          "Controls"
        ],
        "rows": [
          [
            "**Editor**",
            "Font size (9–24), Word wrap, Auto-fold large literals, Server-side lint (PREPARE-only), SQL dialect — the dialect select is **disabled while connected** (it follows the driver)"
          ],
          [
            "**Appearance**",
            "Theme, Editor / grid font (free text with presets like JetBrains Mono, Fira Code, Consolas — plus a Reset), Accent color (picker + six swatches)"
          ],
          [
            "**Grid**",
            "Row density (Normal 28 px / Compact 22 px rows), Zebra striping, NULL cells show (`NULL` / empty / —), Default column width (48–900), Copy with column names"
          ],
          [
            "**Plans**",
            "Tree orientation (Top-down / Left-to-right), Heat coloring by (Cost / Actual time / Rows / Off), Node detail (Normal / Compact) — see [[topic:plans|EXPLAIN plans]]"
          ],
          [
            "**AI**",
            "Provider cards (key, default model, API base, origin approval, Test connection), **AI reply max tokens** (256–128,000), and Skills — see [[topic:ai|AI assistant]]"
          ],
          [
            "**Slack**",
            "Bot tokens, enable toggle, Test connection, limits and allowlists — see [[topic:slack|Slack bot]]"
          ],
          [
            "**Shortcuts**",
            "Rebind every registered action, with conflict detection — see [[topic:shortcuts|Shortcuts & palette]]"
          ],
          [
            "**Privacy**",
            "Crash-report consent — nothing is ever transmitted automatically"
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Preferences store flat in `tusk.prefs`, shallow-merged over defaults on load — updates never wipe your settings, and new prefs arrive with sane defaults."
      },
      {
        "k": "h",
        "text": "Themes, accent, and fonts",
        "id": "themes"
      },
      {
        "k": "p",
        "md": "Eight built-in themes — dark: **One Dark** (default), **Catppuccin Mocha**, **Dracula**, **Tokyo Night**; light: **One Light**, **Solarized Light**, **GitHub Light**, **Gruvbox Light** — plus **Follow system**. A theme restyles everything at once: UI palette, editor, syntax highlighting in previews and AI code blocks, lint squiggle colors, grid edit tints."
      },
      {
        "k": "p",
        "md": "**Accent color** tints buttons, selection, and focus states app-wide; **Editor / grid font** sets the monospace face in both editor and grid — applied live as CSS variables. Blank font uses the built-in stack (JetBrains Mono first)."
      },
      {
        "k": "h",
        "text": "Updates",
        "id": "updates"
      },
      {
        "k": "list",
        "items": [
          "Checks GitHub releases ~3 seconds after launch, then every **5 minutes** (and on window focus if an interval was missed)",
          "**⬆ Update x.y.z** pill appears bottom-right — on both the connect screen and the workspace",
          "Click it for release notes + **Install & restart**: the signed artifact downloads with a progress bar, installs, relaunches",
          "Failed checks (offline, dev build, no published release) are completely silent"
        ]
      },
      {
        "k": "p",
        "md": "The pill is about an update that's **available**; the **What's new** panel is about one that already **installed**. The first launch on a new version pops it bottom-right with every section between the version you were on and this build, read from the changelog bundled into the app — exact for the running build and fully offline. Dismiss it once and it stays gone until the next update; a fresh install sees nothing. *What's new in this version* in the [[topic:shortcuts|command palette]] reopens it any time."
      },
      {
        "k": "h",
        "text": "Keyboard access",
        "id": "keys"
      },
      {
        "k": "p",
        "md": "Everything above works without the mouse; rebind any of these in Settings → Shortcuts ([[topic:shortcuts|Shortcuts & palette]])."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "openSettings",
            "does": "Open the Settings dialog"
          },
          {
            "action": "openPalette",
            "does": "Command palette — search and run any registered action"
          },
          {
            "action": "openHistory",
            "does": "Toggle the query history panel"
          },
          {
            "action": "openHelp",
            "does": "Open this manual"
          },
          {
            "action": "toggleAi",
            "does": "Toggle the AI assistant panel (unbound by default)"
          },
          {
            "action": "toggleSidebar",
            "does": "Collapse / restore the Explorer sidebar (the topbar panel buttons do the same)"
          },
          {
            "action": "toggleResults",
            "does": "Collapse / restore the results panel — collapsed, the editor takes the full column; running a query reopens it"
          }
        ]
      }
    ],
    "icon": "columns"
  },
  {
    "id": "safety",
    "title": "Read-only, permissions & cancellation",
    "blurb": "Read-only layers, permission gating, real query cancellation, secret storage.",
    "blocks": [
      {
        "k": "p",
        "md": "Read-only is enforced at independent application and engine layers, the sidebar only offers actions your role can perform, and PostgreSQL long-running work supports a real server-side cancel. This page covers what's blocked, what's disabled, and what leaves your machine."
      },
      {
        "k": "h",
        "text": "Read-only connections: three layers",
        "id": "read-only"
      },
      {
        "k": "p",
        "md": "Check **Read-only (block writes & DDL)** on the connect form to engage three guards:"
      },
      {
        "k": "list",
        "ordered": true,
        "items": [
          "**Engine-level** — Postgres gets `SET default_transaction_read_only = on`; file-backed DuckDB opens with `AccessMode::ReadOnly`; SQLite with `SQLITE_OPEN_READ_ONLY`; MySQL applies `SET SESSION TRANSACTION READ ONLY` on every pooled connection.",
          "**Statement classification** — read forms and non-writable manual transaction control pass; writes, writable transaction modes, DDL, and `COPY` reject before execution with *\"connection is read-only — writes and DDL are blocked\"*.",
          "**UI gating** — mutating sidebar items disable with a *\"Connection is read-only\"* tooltip; [[topic:grid-editing|in-grid editing]] refuses to start (the grid menu shows *\"connection is read-only\"*); imports are blocked by the backend (*\"connection is read-only — import blocked\"*)."
        ]
      },
      {
        "k": "p",
        "md": "The redundancy is deliberate: a bug in one layer still leaves two between a stray `DROP` and your data."
      },
      {
        "k": "h",
        "text": "Permission-aware UI on Postgres",
        "id": "permissions"
      },
      {
        "k": "p",
        "md": "On connect and every schema reload, Tusk computes your role's **effective** privileges via `has_*_privilege()` — role membership, `PUBLIC` grants, and ownership included. It gathers:"
      },
      {
        "k": "list",
        "items": [
          "Role attributes — superuser, `CREATEDB`, `CREATEROLE`",
          "`CREATE` on the current database",
          "Per-schema `CREATE`/`USAGE` + ownership",
          "Per-relation `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` + ownership (one `pg_class` scan)"
        ]
      },
      {
        "k": "p",
        "md": "The [[topic:sidebar|sidebar]] disables what you can't do, with a tooltip saying why (e.g. **Drop…** on a database shows *\"Requires database ownership (or superuser)\"*). Grid editing refuses up front when your role lacks `UPDATE`/`INSERT`/`DELETE` on the target table, instead of failing at commit."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "DuckDB, SQLite, and MySQL have no comparable permission catalog — Tusk reports them unenforced and adds no UI restrictions. The read-only layers above still apply."
      },
      {
        "k": "h",
        "text": "The server lint never executes",
        "id": "server-lint"
      },
      {
        "k": "p",
        "md": "As-you-type server validation ([[topic:editor-intel|editor intelligence]]) only `PREPARE`s your statement — parse and plan — then `DEALLOCATE`s it, in autocommit so a failure can't poison the next statement. It skips DDL, `COPY`, and `$1`/`:name`-param statements, and pauses while a query runs or any streaming cursor is open (validating would roll back the cursor and truncate your live stream)."
      },
      {
        "k": "h",
        "text": "Cancelling work",
        "id": "cancellation"
      },
      {
        "k": "p",
        "md": "While a query runs, the Run button becomes **✕ Cancel** with a live elapsed counter. It sends a real **Postgres `CancelRequest`** over a fresh short-lived connection — the server actually stops the query; DuckDB fires its interrupt handle except on Windows, where unsafe interruption is disabled; SQLite and MySQL have no out-of-band cancel, so their queries run to completion. Cancelling work inside a PostgreSQL manual transaction normally leaves it in **Recovery required** until `ROLLBACK` or `ROLLBACK TO`. Where no out-of-band cancel exists — SQLite, MySQL, DuckDB on Windows — the button doesn't pretend: it shows a disabled **Running** timer instead of a Cancel, and a cancel the backend rejects resets the button with the reason rather than hanging on *Cancelling…*. `Mod-F2` is the shipped shortcut (Ctrl+Esc is reserved by Windows) and works while typing and while dialogs are open."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "run",
            "does": "Run the selection or buffer (re-click the button to cancel while running)"
          },
          {
            "action": "cancelQuery",
            "does": "Cancel the running query — default [[kbd:Mod-F2]]; fires while typing and while a dialog is open"
          }
        ]
      },
      {
        "k": "p",
        "md": "Streaming [[topic:import-export|exports and imports]] cancel the same way and clean up: a cancelled or failed export **deletes the partial file** (xlsx only writes at finish), and an import runs `CREATE` + `COPY` in one transaction that **rolls back wholesale**. Ordinary multi-statement scripts get one transaction wrapper on every driver; MySQL DDL and nontransactional tables keep their native rollback limits."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "An ordinary idle multi-statement batch with no transaction control stays inside one app-owned transaction and returns a summary; a trailing read is not split out for streaming. Explicit-control scripts use the owner session instead. Cancel can't abort the fast in-memory formatting of already-loaded rows."
      },
      {
        "k": "h",
        "text": "Dropped idle connections heal themselves",
        "id": "resilience"
      },
      {
        "k": "p",
        "md": "Query duration is never capped — no client-side timeout. Postgres connections distinguish slow from dead — **10s connect timeout**, TCP keepalives every **2s after 5s idle** with **3 retries**, **15s TCP user timeout** — so a dead connection surfaces in roughly 10–15 seconds while a slow live query runs as long as it needs."
      },
      {
        "k": "list",
        "items": [
          "Every idle command checks liveness first and reconnects transparently before the next explicit action after a drop (idle timeout, server restart, network blip). An owned manual transaction is never reconnected; it becomes Lost.",
          "A query is **never replayed automatically** after it may have reached the server; even a SELECT can call volatile or external functions. Tusk reports that the outcome may be unknown and asks you to verify state before retrying.",
          "A drop **mid-stream** shows an explicit error banner (*\"connection dropped mid-stream — the result is incomplete. Re-run the query to load the rest.\"*) over the rows fetched so far — never a silently truncated result presented as complete."
        ]
      },
      {
        "k": "h",
        "text": "Secrets and what leaves your machine",
        "id": "secrets"
      },
      {
        "k": "p",
        "md": "Every credential lives in the **OS keychain** (macOS Keychain, Windows Credential Manager), never in a config file and never sent to the frontend: database passwords per saved profile, [[topic:ai|AI provider keys]] (service `tusk-ai`), and [[topic:slack|Slack tokens]] (service `tusk-slack`). AI keys are additionally **bound to the approved HTTPS origin**, so a changed API base can't quietly receive them. Profile metadata — host, port, user — is plain JSON without the password."
      },
      {
        "k": "p",
        "md": "By default **nothing leaves your machine**. Two opt-ins change that: the AI assistant sends your provider a token-budgeted context (schema summary capped at 12,000 characters, role privileges, current editor SQL and last error, plus sample rows per relevant table — samples have their own toggle); the Slack bot posts approved query results to your workspace (charts render locally as PNGs, and mutations can never run from Slack)."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Unsigned macOS dev builds tie keychain items to the code signature, so saved passwords may re-prompt across rebuilds. Signed release builds are seamless."
      }
    ],
    "icon": "lock"
  },
  {
    "id": "whats-new",
    "title": "What's new",
    "blurb": "Recent release notes, newest first, plus how updates install themselves.",
    "blocks": [
      {
        "k": "p",
        "md": "When a newer release is published, an **⬆ Update vX.Y.Z** pill appears bottom-right on both the connect screen and the workspace."
      },
      {
        "k": "p",
        "md": "After the update installs, the first launch on the new version pops a **What's new** panel in that same bottom-right corner, listing every release between the version you were running and this one — skipped versions included. It reads the changelog bundled into the build, so it is exact and needs no network; dismiss it once and it's gone until the next update, and a fresh install stays quiet. The GitHub release notes are published from the same section, so the story is identical in-app and on the releases page."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Check cadence** — the GitHub release manifest is checked ~3 seconds after launch, then every **5 minutes**, plus once when the window regains focus after a full interval.",
          "**Install** — click the pill for release notes; **Install & restart** downloads the signed bundle with a progress bar and relaunches (Windows: the NSIS installer handles exit/restart).",
          "**Failed checks stay silent** — offline, dev build, or no published release."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The updater shipped in v0.4.5 — earlier installs can't auto-update. Grab a fresh installer once; every version after keeps itself current."
      },
      {
        "k": "h",
        "text": "v0.9.5 — incomplete results say so; numeric sort sorts numbers",
        "id": "v0-9-5"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Incomplete results are marked.** Expanding a table in the Explorer, refreshing the schema, sidebar DDL, an all-rows export, an import, the ERD/DDL viewer, or running in another tab closes the one server cursor a streaming result depends on. The affected tab used to report the rows loaded so far as the full result on the next scroll; it now shows an **Incomplete result** badge and a `N rows loaded · …` status naming what closed the stream, in-memory sort is off for it (a header click re-runs with `ORDER BY`), and Export labels its loaded rows as incomplete. The table info needed for in-grid editing is fetched **before** a query runs — fetching it afterwards used to truncate every editable result at the first page.",
          "**Numeric columns sort by value** in a fully loaded result (integers exactly at any size, decimals and scientific notation as numbers, `NaN` last); a column with any non-numeric value keeps text order. See [[topic:results|Results]].",
          "**A sort click that can't apply says why** in the status line instead of doing nothing."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.4 — invisible paste artifacts get squiggles",
        "id": "v0-9-4"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "SQL pasted from web pages often carries **non-breaking spaces, zero-width characters, or curly quotes** — invisible in the editor, but the server reads a non-breaking space as an *identifier* character (`syntax error at or near \".\"` on a query that looks perfect). The offline linter now squiggles each one with its code point, and one quick-fix ([[kbd:Tab]] / [[kbd:Alt-Enter]] on the squiggle) cleans the whole document. String literals are left alone — there they're data."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.3 — Slack settings save as you change them",
        "id": "v0-9-3"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "Non-token [[topic:slack|Slack]] settings (sample-row sharing, allowlists, row caps, timeout, charts, write policy, reply max tokens) now **save the moment you change them** — switching Settings tabs no longer silently reverts an edit that hadn't been Saved. The Save button remains for tokens."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.2 — the manual caught up",
        "id": "v0-9-2"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "The **What's-new panel** now appears on the first update that ships it, even for pre-0.9.1 installs, and is summonable from the command palette.",
          "**Manual corrections** — twenty-seven fixes across twelve topics, including six factual errors."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.1 — what's new after an update, honest cancel, engine-aware lexing",
        "id": "v0-9-1"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "Post-update **What's new** panel — bundled changelog, offline, dismiss-once; reopen any time from the command palette.",
          "**AI reply max tokens** on the desktop (Settings → AI, 256–128,000) — same knob the Slack bot honors.",
          "Cancel is honest per engine: a **Running** timer where cancel is impossible (SQLite, MySQL, DuckDB on Windows), a rejected cancel reports why, default [[kbd:Mod-F2]].",
          "Engine-aware editor lexing (MySQL `#` comments and backslash escapes; backticks on MySQL/SQLite) and one shared active-schema resolver for completion, lint, and grid editing.",
          "`WHERE a = 1, b = 2` squiggles instantly — the comma-for-AND typo is caught offline.",
          "Grid **Copy as X** is byte-identical to Export; empty strings stay distinct from NULL.",
          "Explorer DDL and full-query exports land in history as `-- [Explorer]` / `-- [Export]`.",
          "Slack: TSV and SQL-insert exports, attachments named after the queried table, 5 sample tables (desktop parity)."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.0 — enterprise manual transactions, AI destination consent, bounded everything",
        "id": "v0-9-0"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "Manual transactions own one session across runs: owner bar, frozen non-owner tabs, per-engine savepoints/`SET TRANSACTION`, MySQL `SET autocommit=0` — see [[topic:editor|the editor topic]].",
          "Explicit **AI destination consent**: keys are origin-bound in the keychain; unapproved custom bases fail closed everywhere, including Slack.",
          "Stricter read-only (writable CTEs, row locks, `SELECT … INTO`, `EXPLAIN ANALYZE`) and no automatic statement replay after a dropped connection.",
          "Explicit shape/byte budgets across queries, exports, plans, ERD, AI streams, Slack, history, and crash reports.",
          "Atomic file exports — the destination is replaced only on success; zero rows still produce a valid file.",
          "Revision-safe tabs, files, and history; sample sharing fails closed when its preference can't be stored.",
          "Slack approvals are exact single-use capabilities; result exports are requester-only.",
          "Fixed: window close, cross-tab runs after a multi-page result, a cancel race that could brick the cancel registry."
        ]
      },
      {
        "k": "h",
        "text": "v0.8.3 — AI providers, skills, and a lot of honesty about failure",
        "id": "v0-8-3"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Ten AI providers, one key each.** Anthropic, OpenAI, Gemini, OpenCode Go, OpenCode Zen, OpenRouter, Groq, Ollama, LM Studio, and a generic OpenAI-compatible entry — each with its own OS-keychain entry. Managed in the new **Settings → AI** tab, with a **Test connection** button that really calls the provider.",
          "**Skills.** Markdown instructions the assistant follows every time, scoped to your workspace or to one database. Create, edit, import, export. The [[topic:slack|Slack bot]] follows them too. See [[topic:ai|Skills]].",
          "**Searchable model picker.** Fuzzy, multi-term (`ant opus`), because a router catalogue is hundreds of models.",
          "**The AI knows your foreign keys.** The join graph now reaches the model as authoritative, instead of it guessing join columns from naming convention.",
          "**Stop and Retry.** ⏹ Stop (or [[kbd:Escape]]) interrupts the live stream; a reply that dies mid-sentence restarts itself once.",
          "**Fixed: a failed reply used to look like a finished one.** Provider errors arriving mid-stream were ignored, so the chat went quiet and Slack blamed your question (\"try the desktop app\") for what was really a provider outage.",
          "**Fixed: dropdown popups were unreadable in every dark theme** — white text on a white native popup. Affected every dropdown in the app, not just the AI panel.",
          "**Fixed: DuckDB `TIMESTAMPTZ` casts failed on a fresh machine.** The ICU extension is now installed on demand, not merely loaded."
        ]
      },
      {
        "k": "h",
        "text": "v0.8.0 — this manual, collapsible panels, connect-screen refresh",
        "id": "v0-8-0"
      },
      {
        "k": "list",
        "items": [
          "**This manual** — topbar `?` or [[kbd:F1]], on both screens: full-text search, grouped topics, collapsible sections, live shortcut chips.",
          "**Collapsible panels** — hide the Explorer ([[kbd:Mod-b]]) or the results panel ([[kbd:Mod-j]]); running a query reopens the results automatically, and panel sizes clamp to the window so nothing can cover the editor.",
          "**Connect screen refresh** — driver mascot tiles, paired Host+Port and Database+SSL rows, profile badges (⭐ startup default, `RO` read-only), scrollable profile list."
        ]
      },
      {
        "k": "h",
        "text": "v0.7.0 — ask your database questions from Slack",
        "id": "v0-7-0"
      },
      {
        "k": "p",
        "md": "A **Slack bot hosted inside the desktop app** (Socket Mode — outbound WebSocket only, no server, no public endpoint; bring your own Slack app via the manifest in `docs/slack-setup.md`). Full walkthrough: [[topic:slack|Slack integration]]."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "DM or `@mention` the bot with a question → the AI proposes SQL with **Approve / Reject** buttons. Only the requester can click; proposals expire after 5 minutes.",
          "Approved queries are **read-only by construction**: one wrappable read, mutation/output/lock scans, executable-comment rejection, a conservative deterministic-function allowlist, a hard row cap, and a fresh engine-enforced read-only backend — layered guards, never prompt-only (see [[topic:safety|Safety]]).",
          "Results reply in-thread as an inline table, CSV/XLSX attachment, or a **chart rendered fully locally** (plotters → PNG, embedded font — nothing leaves your machine). Ask explicitly (\"as a bar chart, months on x\") and the AI's chart spec controls type, axes, and series; date+numeric results auto-chart too (Settings toggle, default on).",
          "Every result carries **Export as… CSV / TSV / Excel / JSON / SQL / Markdown** buttons (results cached 15 minutes; requester-only).",
          "Every approved run lands in [[topic:history|query history]] with a `-- [Slack] asked by <user>` marker.",
          "Configure in **Settings → Slack** — tokens go to the OS keychain; the statusbar shows a live 🟢 Slack badge.",
          "Fixed: DuckDB `CAST(timestamptz_col AS DATE)` no longer fails with \"Unimplemented type for cast\" — the ICU extension now loads on every connection."
        ]
      },
      {
        "k": "h",
        "text": "v0.6.x — DuckDB polish",
        "id": "v0-6-x"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**0.6.2** — DuckDB date/time/decimal values render correctly on every path: `DATE`, `TIMESTAMP`, `TIME`, `DECIMAL`, `HUGEINT`, `INTERVAL`, and nested lists/structs format readably instead of raw internals like `Date32(19797)`.",
          "**0.6.1** — DuckDB `EXPLAIN` / `EXPLAIN ANALYZE` [[topic:plans|plan trees]] show rows, timing, and heat coloring (both JSON shapes parsed; heat falls back cost → time → rows).",
          "**0.6.0** — [[topic:sidebar|Sidebar]] DDL editing works on **DuckDB**: create/modify/rename/drop tables, column changes, indexes, comments, truncate, schemas, and CTAS duplicate. Actions DuckDB can't do (constraint `ALTER`s, renaming an index/sequence/constraint, `CREATE DATABASE`) are disabled with a tooltip. Update checks moved from every 6 hours to every 5 minutes."
        ]
      },
      {
        "k": "h",
        "text": "v0.5.x — DuckDB stability and a livelier updater",
        "id": "v0-5-x"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**0.5.1** — DuckDB pinned to the stable **1.4.x** line (registry 1.5 *preview* builds broke even `CURRENT_DATE - INTERVAL`). A file-backed DuckDB releases its exclusive OS lock while idle and re-acquires it on the next command, so other tools can open the file between your queries (`:memory:` stays open — closing would discard its data).",
          "**0.5.0** — the updater re-checks periodically instead of only at startup; the object tree builds faster on wide MySQL/DuckDB schemas."
        ]
      },
      {
        "k": "h",
        "text": "v0.4.x — editable grids, parameters, and a correctness sweep",
        "id": "v0-4-x"
      },
      {
        "k": "p",
        "md": "The 0.4 series (0.4.0 → 0.4.14) turned the result grid into a data editor and hardened multi-driver behavior."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**[[topic:grid-editing|In-grid data editing]]** — single-table SELECTs with the full primary key become editable on every driver; cell edits, delete marks, and new rows stage until **Commit…** previews the UPDATE/DELETE/INSERT script and runs it atomically, or **Apply…** joins an existing owner transaction without committing it. Later releases added **clipboard paste** (TSV/CSV, header-mapped or positional), boolean TRUE/FALSE pills with a dropdown editor, and insert rows pinned to the **top**.",
          "**Parameter prompts** — `$1` or `:name` parameters open a per-parameter dialog (value, NULL, or raw splice) with live preview; values remembered per tab.",
          "**FK-aware JOIN completion** — after `JOIN orders o ON `, the [[topic:editor-intel|editor]] proposes complete join conditions from the live foreign-key catalog.",
          "**Enterprise manual transactions** — raw BEGIN/START, COMMIT/END, ROLLBACK/ABORT, savepoints, supported SET TRANSACTION forms, and MySQL autocommit-off mode can own one tab/session across runs, with a transaction bar, frozen non-owner work, grid Apply vs outer Commit, provenance invalidation, and failed/lost recovery.",
          "**Every-driver parity** — app-owned multi-statement wrappers on all four engines (subject to MySQL DDL/nontransactional-table semantics), per-dialect grid sort/filter SQL for MySQL/SQLite, streaming [[topic:import-export|export]] on every driver, saved profiles for DuckDB/SQLite/MySQL (file path or `:memory:`).",
          "**AI upgrades** — model pickers list each provider's **live model catalog**, schema context is relevance-ranked instead of silently truncated, and the [[topic:ai|assistant]] can fetch **sample rows** from relevant tables after explicit opt-in (default off).",
          "**Appearance** — six new themes (Catppuccin Mocha, Dracula, Tokyo Night, Solarized Light, GitHub Light, Gruvbox Light), a refreshed app icon, responsive toolbars, and resizable docked panels with sizes persisted across sessions ([[topic:workspace|Workspace]]).",
          "**Sidebar QoL** — row estimates and sizes on Postgres tables, trigger listings, *Filter rows…* opens a table with the filter row pre-shown, and reliable double-click-to-run."
        ]
      },
      {
        "k": "h",
        "text": "v0.3.0 — plans, ERD, history, palette",
        "id": "v0-3-0"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**[[topic:plans|EXPLAIN plan visualization]]** — pan/zoomable plan tree with per-node cost/rows/time and heat coloring, per-engine parsers, an **Explain ▾** toolbar action; unparseable output falls back to styled text, never a broken tree.",
          "**[[topic:erd|DDL & relationships viewer]]** — right-click a table for its reconstructed DDL plus a Neighborhood FK graph, or a schema node for the whole-schema ERD (deterministic layout, colored edges, drag-to-reposition).",
          "**[[topic:history|Query history]]** — every user-issued run (grid sort/filter re-runs excluded) recorded per connection; search, re-run, open in tab; capped at 500 entries.",
          "**Command palette** ([[kbd:Mod-k]]) and **[[topic:shortcuts|rebindable shortcuts]]** — every action in one registry; Settings → Shortcuts captures new chords with conflict warnings.",
          "**Settings dialog, light theme, font & accent customization**, and production-grade schema lint (unknown columns, tables, functions, clause-keyword typos — all with did-you-mean quick-fixes)."
        ]
      },
      {
        "k": "h",
        "text": "Older releases",
        "id": "older"
      },
      {
        "k": "p",
        "md": "Everything back to the first Postgres-only builds — run chooser, streaming results, script runner, import/export, connection layer — is documented release-by-release in `CHANGELOG.md` at the repository root."
      }
    ],
    "icon": "star"
  }
];
