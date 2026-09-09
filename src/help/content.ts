// Static knowledge-base content. Drafted per-topic against the real source and
// adversarially fact-checked (draft-help-content workflow); keep claims in sync
// with the code when behavior changes. Regenerate rather than hand-tweaking facts.

import type { Topic } from "./types";

export const TOPICS: Topic[] = [
  {
    "blurb": "Connect screen, profiles, keychain passwords, SSL modes, SSH tunnels, read-only, per-driver capabilities.",
    "id": "getting-started",
    "title": "Connections & drivers",
    "blocks": [
      {
        "k": "p",
        "md": "Tusk opens on the **connect screen**: saved connections left, connection form right. The driver mascot marks the card, topbar, and OS window title."
      },
      {
        "k": "p",
        "md": "Up to **16 connections** open at once. **＋** on the topbar strip, or [[kbd:Mod-Shift-n]], opens the connect screen as a panel — see [[topic:workspace|Workspace]]."
      },
      {
        "k": "list",
        "items": [
          "**Reopen last session** relists the profiles open at last quit, in order. One click; never automatic.",
          "Ad-hoc connections typed without saving are not listed.",
          "A *Connect on startup* profile connects once per launch. After an error recovery or a window reload it is offered here instead."
        ]
      },
      {
        "k": "h",
        "text": "Saved profiles",
        "id": "profiles"
      },
      {
        "k": "p",
        "md": "Each profile shows mascot, name, and target — `user@host:port/dbname`, or the file path / `:memory:`. A lock icon marks a stored password."
      },
      {
        "k": "list",
        "items": [
          "**Click** — connects when embedded or the password is saved; otherwise loads the form for the password.",
          "**Right-click** — Connect, Edit, Duplicate, Set as default / Unset default, Copy connection string, Delete….",
          "**Delete…** confirms, then removes the profile and its keychain password. The database is untouched.",
          "**Set as default** connects on launch. Exactly one profile holds the flag.",
          "**Try to continue** after a connect error offers the profile in the reopen list instead of connecting it.",
          "*Copy connection string* yields `postgresql://user@host:port/db`, with `?sslmode=` when it differs from `prefer`. The password is excluded."
        ]
      },
      {
        "k": "h",
        "text": "Drivers and form fields",
        "id": "drivers"
      },
      {
        "k": "list",
        "items": [
          "**PostgreSQL / MySQL / SQL Server** — Host, Port, User, Password, Database, SSL Mode, and an optional **SSH tunnel** section.",
          "Switching driver moves the default port (5432 / 3306 / 1433). *Database* is optional away from PostgreSQL.",
          "SQL Server takes a SQL login; Windows integrated authentication isn't supported yet.",
          "**DuckDB / SQLite** — one **Database file** field with *Browse…*; blank means an in-memory database. No password or SSL."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A file-backed **DuckDB** database holds an exclusive OS file lock, so Tusk drops the connection when idle and reopens it on the next query."
      },
      {
        "k": "h",
        "text": "Passwords and SSL",
        "id": "passwords-ssl"
      },
      {
        "k": "list",
        "items": [
          "**Save password** stores it in the OS keychain, keyed by profile id. `connections.json` holds metadata only.",
          "Uncheck the box and save to delete the keychain entry."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Unsigned `tauri dev` builds on macOS re-prompt for keychain access and can invalidate saved passwords across rebuilds."
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
            "Encrypts without verifying the certificate or hostname."
          ],
          [
            "`verify-full`",
            "Encrypts and verifies the certificate chain and hostname."
          ]
        ]
      },
      {
        "k": "h",
        "text": "SSH tunnels",
        "id": "ssh-tunnel"
      },
      {
        "k": "p",
        "md": "**PostgreSQL, MySQL, and SQL Server** can tunnel over SSH. Tick **Connect through an SSH tunnel**, then fill in the SSH host, port (22 by default), and user."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "**Host** and **Port** at the top of the form are the database as the SSH server sees it — usually `localhost`."
      },
      {
        "k": "list",
        "items": [
          "**Password** — the SSH login password.",
          "**Private key** — an OpenSSH or PEM key file. Leave the passphrase blank for an unencrypted key.",
          "**SSH agent** — the agent already running on this machine.",
          "**Save … in the OS keychain** puts the SSH secret in its own entry, read server-side at connect time.",
          "Changing the SSH host, port, user, auth method, or key file requires entering the secret again.",
          "A tunnelled connection is marked **SSH** in the topbar and the Connections list, and the next command re-establishes a dropped tunnel."
        ]
      },
      {
        "k": "h",
        "text": "Host key verification",
        "id": "ssh-host-keys"
      },
      {
        "k": "p",
        "md": "Host keys are checked against `~/.ssh/known_hosts` and Tusk's own trust store in the app config directory. `known_hosts` is only read, never written."
      },
      {
        "k": "list",
        "items": [
          "`@revoked` is honoured; `@cert-authority` lines are skipped, so a CA-covered bastion prompts as unknown."
        ]
      },
      {
        "k": "table",
        "head": [
          "Outcome",
          "Behaviour"
        ],
        "rows": [
          [
            "Unknown host",
            "A dialog shows the key type and `SHA256:…` fingerprint; **Trust and connect** records it and retries."
          ],
          [
            "Key changed",
            "Refused, with no accept button. Remove the old entry from `known_hosts` or `ssh_known_hosts.json`."
          ],
          [
            "Key revoked",
            "Refused and never offered. Tusk's trust store is checked first, and `known_hosts` is read in file order."
          ],
          [
            "Records unreadable",
            "Refused with the reason, including an entry that cannot be parsed."
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "`verify-full` works through a tunnel: the certificate is checked against the **Host** entered, not the loopback address."
      },
      {
        "k": "h",
        "text": "Read-only mode",
        "id": "read-only"
      },
      {
        "k": "p",
        "md": "**Read-only (block writes & DDL)** is enforced in layers — see [[topic:safety|Safety & guardrails]]."
      },
      {
        "k": "list",
        "items": [
          "Engine enforcement on Postgres, file-backed DuckDB, SQLite and MySQL. SQL Server has no session equivalent.",
          "A uniform engine-aware client guard rejects writes and DDL before they are sent.",
          "[[topic:grid-editing|In-grid editing]] switches off and file import is blocked in the backend."
        ]
      },
      {
        "k": "h",
        "text": "What each driver supports",
        "id": "capabilities"
      },
      {
        "k": "p",
        "md": "The backend reports a capabilities set on connect. The active-schema selector, Import, and Export appear only where they work."
      },
      {
        "k": "table",
        "head": [
          "Capability",
          "PostgreSQL",
          "DuckDB",
          "SQLite",
          "MySQL",
          "SQL Server"
        ],
        "rows": [
          [
            "Streaming server cursor",
            "yes",
            "paged (LIMIT/OFFSET)",
            "paged (LIMIT/OFFSET)",
            "paged (LIMIT/OFFSET)",
            "paged (OFFSET/FETCH)"
          ],
          [
            "Active-schema selector (`search_path`)",
            "yes",
            "—",
            "—",
            "— (uses `USE db`)",
            "—"
          ],
          [
            "File import (CSV / JSON / xlsx)",
            "yes (`COPY`)",
            "yes",
            "yes",
            "yes",
            "—"
          ],
          [
            "Export to file",
            "yes",
            "yes",
            "yes",
            "yes",
            "yes"
          ],
          [
            "Sidebar DDL editing",
            "yes",
            "yes (per-action gating)",
            "yes (per-action gating)",
            "yes (per-action gating)",
            "—"
          ],
          [
            "Copy DDL / [[topic:erd|relationships & ERD]]",
            "yes",
            "best-effort",
            "yes",
            "yes",
            "yes"
          ],
          [
            "`EXPLAIN ANALYZE`",
            "yes",
            "yes",
            "—",
            "yes",
            "— (no T-SQL EXPLAIN)"
          ],
          [
            "Transactional DDL",
            "yes",
            "yes",
            "yes",
            "— (auto-commits)",
            "yes"
          ],
          [
            "Manual transactions",
            "yes",
            "yes",
            "yes",
            "yes (pinned session)",
            "yes (`BEGIN TRANSACTION`)"
          ],
          [
            "Savepoints",
            "yes",
            "—",
            "yes",
            "yes",
            "yes (`SAVE TRANSACTION`, no RELEASE)"
          ],
          [
            "`SET TRANSACTION`",
            "yes (active, before work)",
            "—",
            "—",
            "yes (before START)",
            "— (session-wide in T-SQL)"
          ],
          [
            "Persistent autocommit-off mode",
            "—",
            "—",
            "—",
            "yes (pinned session)",
            "—"
          ],
          [
            "Cancel a running query",
            "yes (`CancelRequest`)",
            "yes, except on Windows",
            "—",
            "—",
            "—"
          ],
          [
            "TLS",
            "yes",
            "n/a",
            "n/a",
            "yes",
            "yes"
          ],
          [
            "Permission-aware UI",
            "yes",
            "—",
            "—",
            "—",
            "—"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "On Postgres the sidebar fetches the role's effective privileges and disables actions it cannot perform, with the reason in the tooltip.",
          "SQLite has no `EXPLAIN ANALYZE` — see [[topic:plans|Plan visualization]] and [[topic:import-export|Import & export]]."
        ]
      },
      {
        "k": "h",
        "text": "Dropped idle connections reopen",
        "id": "resilience"
      },
      {
        "k": "list",
        "items": [
          "Query duration is never capped. A connect timeout plus TCP keepalives surface a dead Postgres link in 10–15 seconds.",
          "An idle connection reopens before the next explicit action. A statement the server may have seen is never replayed.",
          "A dropped manual transaction is marked lost, not reconstructed. Reconnect and verify its outcome."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A re-open drops any open streaming cursor, so the query must be re-run to complete the result."
      }
    ],
    "icon": "database"
  },
  {
    "blurb": "Tabs, files, run controls, manual transactions, parameters, and per-tab active schema.",
    "id": "editor",
    "title": "SQL editor, tabs & files",
    "blocks": [
      {
        "k": "list",
        "items": [
          "Each tab owns its SQL buffer, undo history, cursor, fold state, result snapshot, and grid view.",
          "One server cursor per connection, so only the last-run tab keeps streaming — see [[topic:results|Results & streaming]].",
          "The tab set persists per connection: SQL text, dirty state, file bindings, titles, active schema. Results and pending grid edits do not."
        ]
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
          "**Close** — **×**, [[kbd:Mod-w]], or middle-click. A dirty tab (● dot) prompts **Save** / **Don't save** / **Cancel**.",
          "**Right-click** — Rename…, Close, Close others, Close tabs to the right. Bulk-close skips dirty tabs.",
          "**Reorder** — drag a tab; [[kbd:Alt-Shift-ArrowLeft]] / [[kbd:Alt-Shift-ArrowRight]] moves the active one. Escape cancels."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Sidebar scaffolds and *Edit as SQL* open in a new tab with the relation's schema pre-selected."
      },
      {
        "k": "h",
        "text": "Files",
        "id": "files"
      },
      {
        "k": "list",
        "items": [
          "**Open** ([[kbd:Mod-o]]) filters to `.sql`/`.txt`; **Save** ([[kbd:Mod-s]]) and **Save As** ([[kbd:Mod-Shift-s]]) use `.sql`.",
          "Opening an already-open file switches to its tab. A saved tab takes the file's basename as its title; hover for the full path."
        ]
      },
      {
        "k": "h",
        "text": "Running queries",
        "id": "running"
      },
      {
        "k": "list",
        "items": [
          "**Run ▶** ([[kbd:Mod-Enter]]) runs exactly the selected text, or the whole buffer.",
          "In flight the button becomes **✕ Cancel** with an elapsed counter, or a disabled **Running 0:12** timer where the engine cannot cancel.",
          "Each statement gets a **▶ gutter marker**; click it to run that statement, and the marker becomes a spinner pinned to it.",
          "With several statements the one under the cursor is highlighted and the status bar shows *Stmt N/M*."
        ]
      },
      {
        "k": "p",
        "md": "Statement splitting is engine-aware and matches execution. Auto-fold, linting, parameter detection and grid sort/filter share the lexer."
      },
      {
        "k": "list",
        "items": [
          "**MySQL** — `#` comments, `--` without trailing whitespace, backslash escapes inside quotes. Backtick identifiers are first-class on MySQL and SQLite.",
          "**SQL Server** — `[bracketed identifiers]`, `N'literals'`, and nested block comments hold semicolons inertly.",
          "A line-only `GO` ends the batch without being sent to the server. `GO 5` is refused.",
          "A `;` inside `BEGIN … END`, `BEGIN TRY` or `CASE … END` belongs to the statement, so a `CREATE PROCEDURE` body runs whole."
        ]
      },
      {
        "k": "list",
        "items": [
          "With the cursor in a multi-statement buffer and nothing selected, a **Run…** popover asks **Current block** or **Entire file**.",
          "[[kbd:Mod-Shift-Enter]] skips the prompt and runs the exact non-blank selection, or the statement under the cursor.",
          "Every base run — success, error, or cancel — lands in [[topic:history|query history]] with its duration and row count."
        ]
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
            "does": "Run the selection, or the statement under the cursor (no chooser)"
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
            "action": "moveTabLeft",
            "does": "Move the active tab one slot left"
          },
          {
            "action": "moveTabRight",
            "does": "Move the active tab one slot right"
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
        "k": "list",
        "items": [
          "An ordinary multi-statement run with no transaction control uses one app-owned transaction; a failure rolls back prior DML.",
          "A trailing read stays inside that wrapper, so the result is a summary rather than a stream.",
          "Pasted `pg_dump` output works: `COPY … FROM stdin` blocks terminated by `\\.` are fed through `COPY`, even behind a leading comment block."
        ]
      },
      {
        "k": "h",
        "text": "Manual transaction control",
        "id": "manual-transactions"
      },
      {
        "k": "p",
        "md": "Raw `BEGIN` / `START TRANSACTION`, `COMMIT` / `END`, and `ROLLBACK` / `ABORT` run directly, on one owner session, self-contained or across separate runs."
      },
      {
        "k": "list",
        "items": [
          "Savepoint, rollback-to, and release work on PostgreSQL, SQLite, and MySQL.",
          "`SET TRANSACTION` works on PostgreSQL while active and on MySQL before `START TRANSACTION`. DuckDB and SQLite have none.",
          "SQL Server uses `BEGIN TRANSACTION`, `SAVE TRANSACTION` and `ROLLBACK TRANSACTION name`; a bare `BEGIN`/`END` is a statement block. Session-wide `SET` forms are refused."
        ]
      },
      {
        "k": "list",
        "items": [
          "The transaction bar shows mode, id, state, owner tab, and elapsed time.",
          "Only the owner runs database work. Other tabs stay editable, but their queries and session-backed metadata freeze.",
          "The bar offers **Switch to owner**, Commit/Rollback, MySQL next-transaction Start/Clear, and lost-session reconnect actions."
        ]
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
        "k": "list",
        "items": [
          "MySQL `SET autocommit=0` keeps one physical connection pinned. **Commit unit** and **Rollback unit** end only the current unit.",
          "**Commit & enable autocommit** runs `SET autocommit=1`, commits, and releases the owner session.",
          "Recognized implicit-commit DDL is blocked inside a tracked MySQL transaction. DDL outside it still auto-commits."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A PostgreSQL statement error or cancellation requires `ROLLBACK` or `ROLLBACK TO` before further work."
      },
      {
        "k": "list",
        "items": [
          "A dropped or unexpectedly ended owner session becomes **Lost**. Disconnect, reconnect, and verify the outcome.",
          "Closing the owner tab, disconnecting or quitting requires resolving a healthy unit, pending grid changes first.",
          "Results and pending edits carry transaction id and revision. Pre-`BEGIN` rows must be rerun before editing.",
          "Commit, rollback, rollback-to, autocommit-unit boundaries, and loss leave affected rows visible but stale until rerun."
        ]
      },
      {
        "k": "h",
        "text": "Parameters",
        "id": "parameters"
      },
      {
        "k": "p",
        "md": "`$1` positional or `:name` named placeholders open a **Query parameters** dialog before the run, with a live preview. Values are remembered per tab."
      },
      {
        "k": "list",
        "items": [
          "One row per parameter: name, value box, then the **NULL** and **raw** toggles.",
          "**NULL** — sends SQL `NULL`.",
          "**raw** — inserts the text verbatim, for numbers and expressions. Unchecked values become quoted literals.",
          "**Run** stays disabled until every parameter has a value, NULL, or raw.",
          "Detection is lexer-masked: placeholders inside strings, comments and dollar-quoted bodies are ignored, and `::type` casts never match."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Array slices with identifier bounds — `arr[i:j]` — detect `:j` as a parameter; use the **raw** toggle."
      },
      {
        "k": "h",
        "text": "Active schema",
        "id": "active-schema"
      },
      {
        "k": "list",
        "items": [
          "The toolbar schema selector sets the tab's active schema. It hides on engines without a search path.",
          "`SET search_path TO <schema>, public` runs before every execution, validation, and scope-all export from that tab.",
          "Autocomplete offers its tables unqualified, and the schema linter resolves bare names through the same resolver."
        ]
      },
      {
        "k": "h",
        "text": "Editing comforts",
        "id": "editing"
      },
      {
        "k": "list",
        "items": [
          "**Format** ([[kbd:Shift-Alt-f]]) pretty-prints the selection or buffer with uppercased keywords. Unparseable SQL is left untouched.",
          "**Find & replace** — the toolbar **Find** button or [[kbd:Mod-f]]; the `find` action is rebindable in [[topic:shortcuts|Shortcuts]].",
          "**Multi-cursor** — multiple selections, plus Alt-drag for rectangular selection.",
          "**Code folding** — a manual fold gutter plus auto-fold of long lists and literals. Display-only; click a placeholder or move the cursor in to expand.",
          "**Keyword auto-UPPERCASE** — live at word boundaries, skipping qualified and quoted names.",
          "**Font size & wrap** — the **A** buttons step the font between 9 and 24 px; the wrap icon toggles word wrap.",
          "**Right-click menu** — Cut, Copy, Paste, Select all, Toggle comment ([[kbd:Mod-/]]), Run selection or Run all.",
          "**Explain ▾** sends one statement to the [[topic:plans|plan visualizer]]. Multi-statement selections are refused, and *Explain Analyze* warns before a write."
        ]
      },
      {
        "k": "p",
        "md": "Autocomplete, lint layers, and FK-aware JOIN hints: [[topic:editor-intel|Editor intelligence]]."
      }
    ],
    "icon": "code"
  },
  {
    "blurb": "Live-schema completion, FK JOIN hints, three lint layers, keyboard quick-fixes.",
    "id": "editor-intel",
    "title": "Autocomplete, JOIN hints & lint",
    "blocks": [
      {
        "k": "p",
        "md": "Completion and lint read the live catalog, refreshed whenever the schema reloads — after [[topic:sidebar|sidebar]] DDL, for instance."
      },
      {
        "k": "h",
        "text": "Context-aware completion",
        "id": "completion"
      },
      {
        "k": "list",
        "items": [
          "Tables and schemas after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `USING`.",
          "Columns after `SELECT`, `WHERE`, `ON`, `HAVING`, `SET`, `GROUP BY`, `ORDER BY`, `VALUES`, `RETURNING`, `AND`/`OR`.",
          "Columns from the statement's `FROM`/`JOIN` rank first, labeled with type and source table (`integer · orders`)."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Alias resolution** — `u.` after `FROM users u` lists that table's columns; `schema.` lists its tables; `schema.table.` lists its columns.",
          "**Bare vs qualified** — tables in `public` or the active schema complete bare, others as `schema.table`, with active-schema tables ranked higher.",
          "**Live db functions** — appear alongside dialect builtins, tagged `db function`, and jump to the top after `CALL`, `EXEC` or `PERFORM`.",
          "**Accepting** — [[kbd:Tab]] or [[kbd:Enter]] accepts the highlighted entry. With no popup open, Enter is a plain newline."
        ]
      },
      {
        "k": "demo",
        "id": "autocomplete",
        "caption": "Clause-aware completion: tables after FROM, in-scope columns after WHERE, alias.column resolution."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "`$` is not a completion token, so `$tag$` delimiters and `$1` parameters are never offered or clobbered."
      },
      {
        "k": "h",
        "text": "FK-aware JOIN hints",
        "id": "join-hints"
      },
      {
        "k": "list",
        "items": [
          "Right after `ON`, the top suggestion is a complete join condition from the foreign-key catalog — `o.user_id = u.id`, with composite keys `AND`-ed.",
          "Hints connect the most recently joined table to the statement's other tables, so at least two are needed.",
          "FK edges load lazily per schema — the same data behind the [[topic:erd|ERD viewer]]."
        ]
      },
      {
        "k": "h",
        "text": "Three lint layers",
        "id": "lint-layers"
      },
      {
        "k": "p",
        "md": "Two client-side layers, heuristic and schema-aware, run as you type; an async server linter follows. Squiggles merge in the gutter."
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
            "Unmatched `)`; unclosed `(`; trailing comma; `DELETE`/`UPDATE` without `WHERE`; unknown leading keyword (`SELCT` → SELECT); a top-level comma between conditions; invisible paste artifacts, with a fix-all quick-fix",
            "error / warning"
          ],
          [
            "Schema (live catalog)",
            "Unknown `alias.col` refs; unknown tables after `FROM`/`JOIN`/`UPDATE`; unknown function calls; unknown bare identifiers; one-edit clause-keyword typos (`FORM` → `FROM`)",
            "warning"
          ],
          [
            "Server (`validate_sql`)",
            "Parser-grade Postgres diagnostics for syntax, types, and anything the client cannot model",
            "error"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "`WHERE a = 1, b = 2` is squiggled as typed. Legitimate commas in `IN` lists, arguments and `SET` lists are untouched.",
          "**Bare identifiers** — checked only in DML where every table reference resolved. Statements with CTEs or derived tables skip the check.",
          "**Empty function catalog** — the unknown-function check switches off. Neither MySQL nor SQL Server can enumerate builtins."
        ]
      },
      {
        "k": "h",
        "text": "Server validation never executes",
        "id": "server-lint"
      },
      {
        "k": "list",
        "items": [
          "`validate_sql` only `PREPARE`s each statement, then deallocates, in autocommit.",
          "It skips DDL, `COPY`, and bind-parameter statements, and maps the server's error position onto the exact token.",
          "It goes silent when disconnected, while a query is running, and when *Server-side lint* is off. The client layers keep working."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The prepareability check is a skip-list, so a misspelled first keyword like `SELCT …` still reaches the server parser for a real diagnostic."
      },
      {
        "k": "h",
        "text": "Quick-fixes from the keyboard",
        "id": "quick-fixes"
      },
      {
        "k": "p",
        "md": "Did-you-mean diagnostics carry a one-keystroke fix, *Replace with \"…\"*. Put the cursor on the squiggle."
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
        "md": "A candidate starting with the typed word counts as one edit, so `master` suggests `master_id`. See [[topic:shortcuts|Shortcuts]] and [[topic:editor|The editor]]."
      }
    ],
    "icon": "sparkle"
  },
  {
    "blurb": "Streaming pages, virtualized rendering, server-side sort/filter, multi-format copy.",
    "id": "results",
    "title": "The result grid",
    "blocks": [
      {
        "k": "list",
        "items": [
          "Both axes virtualize: only the visible rows and columns are in the DOM.",
          "Values are text straight from the driver. A zero-row result still shows its headers.",
          "Column widths, order, hidden columns, sorts, and filters are per-tab view state."
        ]
      },
      {
        "k": "h",
        "text": "Streaming and the single cursor",
        "id": "streaming"
      },
      {
        "k": "list",
        "items": [
          "Reads stream in pages of 1,000 rows: a server-side cursor on Postgres, `LIMIT`/`OFFSET` paging on DuckDB, SQLite and MySQL, `OFFSET`/`FETCH` on SQL Server.",
          "On SQL Server the clause is appended, so an existing `ORDER BY` survives. A statement that cannot take it — `TOP`, its own `OFFSET`/`FETCH`, `FOR JSON`, an unordered `UNION` — is read in one page.",
          "**Auto-fetch** — scroll near the bottom, or move the focused cell within 30 rows of the end.",
          "**`1000+ rows`** — the `+` means the cursor is still open.",
          "**Load all** drains the cursor and flips to **Cancel**. The `loadAllRows` action is unbound by default."
        ]
      },
      {
        "k": "demo",
        "id": "grid-stream",
        "caption": "Pages of 1,000 rows stream from a server-side cursor near the bottom; Load all drains the rest."
      },
      {
        "k": "list",
        "items": [
          "While running, Run becomes **✕ Cancel** with an elapsed counter, and the final duration sits at the right of the result toolbar.",
          "One cursor per connection: a run in another tab, an Explorer expand or refresh, sidebar DDL, an export or an import closes the previous stream.",
          "The old tab keeps its rows under an **Incomplete result** badge naming the cause. In-memory sort is off and Export labels the rows incomplete.",
          "Dropped mid-stream, the grid keeps its rows and shows an error banner with the same badge."
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
          "**Resize** — drag the header edge, 48–900 px. Double-click it or use *Autofit column* to size to visible content.",
          "**Reorder** — drag a header label; a bar marks the slot, Escape cancels. Display-only.",
          "**Hide** — header right-click → *Hide column*; restore with *Show all columns*. Export is unaffected; grid copies follow the display.",
          "**Freeze first column** — header right-click. The first displayed column stays at the left edge while the rest scroll.",
          "**Show / hide row numbers** — header right-click. The gutter still selects rows when the numbers are off."
        ]
      },
      {
        "k": "h",
        "text": "Column types and cell rendering",
        "id": "types"
      },
      {
        "k": "list",
        "items": [
          "Each header carries a small type badge. A solid badge is the driver's type; a dotted one is guessed from the loaded values.",
          "Numeric columns align right on tabular figures. Booleans render as a glyph plus TRUE/FALSE. NULL follows the *NULL cells show* setting.",
          "Values over 300 characters are cut in the cell with `…`; hover for the head of the value, or open **View value…** for all of it.",
          "Rendering never changes the data: copy, export and the value viewer use the raw driver text."
        ]
      },
      {
        "k": "h",
        "text": "Server-side sort and filter",
        "id": "sort-filter"
      },
      {
        "k": "list",
        "items": [
          "Once a base result is fully loaded, sort gestures reorder rows in memory.",
          "While rows stream, or whenever a filter is active, the query re-runs wrapped as `SELECT * FROM (<your query>) AS _tusk … ORDER BY <ordinal>`.",
          "Local ordering compares numerically when every value is a number, otherwise by display text. Use `ORDER BY` for native date or collation semantics.",
          "A header click that cannot sort explains why in the status line.",
          "**Sort** — click a header to cycle ascending → descending → none. [[kbd:Shift]]-click adds to a multi-sort.",
          "**Quick filter** — *Show filter row* puts a case-insensitive contains box under each header, AND-combined into the same filter the builder edits.",
          "**Filter builder** — the toolbar **Filter** button, [[kbd:Mod-Shift-f]], *Filter by this column…*, or the Explorer's *Filter rows…*."
        ]
      },
      {
        "k": "code",
        "caption": "A header sort plus filter re-streams this. ORDER BY uses the ordinal to dodge duplicate names.",
        "text": "SELECT * FROM (\n  SELECT * FROM film JOIN inventory USING (film_id)\n) AS _tusk\nWHERE \"title\"::text ILIKE '%dino%' ESCAPE '!'\nORDER BY 3 DESC"
      },
      {
        "k": "demo",
        "id": "sort-filter",
        "caption": "Header clicks and the filter row re-run the query wrapped as a subquery, so the server does the work."
      },
      {
        "k": "list",
        "items": [
          "Disabled for multi-statement runs and anything that is not `SELECT`/`WITH`/`TABLE`/`VALUES`, plus DuckDB's `FROM`-first and `PIVOT` reads.",
          "Disabled on MySQL and SQL Server when the result has duplicate column names.",
          "Disabled on SQL Server for a statement containing `WITH`, or an `ORDER BY` the wrap cannot hoist. A plain trailing `ORDER BY` moves onto the wrapper.",
          "Re-running the same unedited query text keeps active rules. A sort or filter re-run resets scroll and selection."
        ]
      },
      {
        "k": "h",
        "text": "The filter builder",
        "id": "filter-builder"
      },
      {
        "k": "list",
        "items": [
          "A filter is a tree: one root group joined by AND or OR, holding conditions and nested groups.",
          "A condition is a column, an operator and its values. The operator menu offers only what the column's class supports, shown as a badge.",
          "Types come from the relation's detail. Without it every column is `any`, which offers every operator except `is true` / `is false`."
        ]
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "openFilterBuilder",
            "does": "Open the filter builder for the active result"
          }
        ]
      },
      {
        "k": "list",
        "items": [
          "**Operators** — `=` `≠` `<` `≤` `>` `≥`, `between`, `in`, `like` / `ilike` with raw patterns, `starts with` / `ends with` / `contains` with `%` and `_` escaped, `is null`, `is true` / `is false`, `is empty`, and their negations.",
          "**Groups** — AND or OR per group, *+ Condition* and *+ Group*, per-row duplicate and remove. The limit is eight levels and 200 conditions.",
          "**Buttons** — **Apply filter**, **Clear**, **Copy WHERE**, and **Open as query** into a new tab. [[kbd:Enter]] applies, [[kbd:Escape]] closes."
        ]
      },
      {
        "k": "list",
        "items": [
          "`ILIKE` is native on Postgres and DuckDB and becomes `LOWER(col) LIKE LOWER(pattern)` elsewhere, so *contains* means the same everywhere.",
          "Every LIKE-family comparison uses the text form of the column, so a `char(n)` never matches on blank padding.",
          "Booleans emit `TRUE`/`FALSE` on Postgres and DuckDB, `1`/`0` elsewhere. Typed `%` and `_` are escaped under an explicit `ESCAPE '!'`."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "`≠` and `not in` exclude NULL rows; add an `is null` condition on the same column inside an OR group to keep them."
      },
      {
        "k": "list",
        "items": [
          "An active filter shows one chip per condition above the grid, each with an ✕, plus the loaded row count, **Edit…**, and **Clear all**."
        ]
      },
      {
        "k": "h",
        "text": "Selection, keyboard, copy",
        "id": "selection-copy"
      },
      {
        "k": "p",
        "md": "Click a cell; drag or [[kbd:Shift]]-click for a range. The gutter selects rows, a header a column, the corner or [[kbd:Mod-a]] everything."
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
            "combo": "Enter",
            "does": "Edit the focused cell, or open its value"
          },
          {
            "combo": "Escape",
            "does": "Close the find bar, else collapse the selection to the focused cell"
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
        "caption": "Keyboard jumps ride the stream: moving within 30 rows of the loaded end fetches the next page."
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Mod-c]] copies TSV. The cell menu's **Copy as…** offers TSV, CSV, JSON, Markdown, SQL INSERT, and column names; it also has *Copy cell value* and *Copy column*.",
          "SQL INSERT names the edit target table when the result has one, `exported` otherwise, and uses the connected engine's identifier and literal syntax.",
          "Copy runs the same formatter as Export, so clipboard bytes match the file. See [[topic:import-export|Import & export]].",
          "Copy caps at 1,000,000 cells and 8,388,608 characters; past that the status line points to Export."
        ]
      },
      {
        "k": "h",
        "text": "Find in loaded rows",
        "id": "find"
      },
      {
        "k": "list",
        "items": [
          "**Find** in the result toolbar, or [[kbd:Mod-f]] with the grid focused, opens a bar above the header labelled *Find (loaded rows)*.",
          "It matches text case-insensitively across the rows already in memory. It never re-runs the query — for a server-side match use the filter builder.",
          "Matches are highlighted, the current one framed. [[kbd:Enter]] is the next match, [[kbd:Shift-Enter]] the previous, [[kbd:Escape]] closes.",
          "The counter reads `3 of 128`. A `+` means the scan stopped at its ceiling of 5,000 matches or 2,000,000 cells."
        ]
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "findInResults",
            "does": "Find text in the loaded rows"
          }
        ]
      },
      {
        "k": "h",
        "text": "Record view",
        "id": "record-view"
      },
      {
        "k": "list",
        "items": [
          "**Record** in the result toolbar docks a panel showing the focused row as a name/value list, one field per line with its type badge.",
          "**‹** and **›**, or [[kbd:Alt-ArrowUp]] / [[kbd:Alt-ArrowDown]], step rows. Moving the focused cell in the grid updates the panel.",
          "Where the grid is editable the fields are editable: [[kbd:Enter]] commits into the same pending-change overlay, [[kbd:Escape]] restores the value. See [[topic:grid-editing|Editing data in the grid]].",
          "The panel lists the first 200 displayed columns."
        ]
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "toggleRecordView",
            "does": "Show or hide the record view"
          }
        ]
      },
      {
        "k": "h",
        "text": "Status bar",
        "id": "status-bar"
      },
      {
        "k": "list",
        "items": [
          "The right of the status bar shows the focused cell as `R n, C n`, and the size of a multi-cell selection.",
          "When every non-NULL value in the selection is a number it adds Sum, Avg, Min, Max and Count, computed over loaded rows only.",
          "Aggregates cover up to 1,000,000 cells and are computed after a short pause, so dragging a large range stays smooth.",
          "The last run's duration sits at the right of the result toolbar, and moves to the status bar while the results panel is collapsed."
        ]
      },
      {
        "k": "h",
        "text": "Inspecting values",
        "id": "values"
      },
      {
        "k": "list",
        "items": [
          "NULLs render as a dimmed `NULL`, a dash, or empty, per the *NULL cells show* setting.",
          "**View value…** — the context menu, double-click on a non-editable grid, [[kbd:Enter]] on the focused cell, or [[kbd:Mod]]+double-click on an editable one — opens the full raw cell.",
          "A value that parses as a JSON object or array is shown pretty-printed under a `JSON` label. **Copy** still writes the raw value.",
          "A recognized `EXPLAIN` result adds a **Plan / Grid** toggle — see [[topic:plans|Plan visualization]]."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A single-table `SELECT` carrying its primary key is editable — double-click, or [[kbd:Enter]]/[[kbd:F2]]. See [[topic:grid-editing|Editing data in the grid]]."
      }
    ],
    "icon": "table"
  },
  {
    "blurb": "Edit cells, delete, insert, paste — apply or commit one reviewed script.",
    "id": "grid-editing",
    "title": "Editing data in the grid",
    "blocks": [
      {
        "k": "p",
        "md": "Results from a plain single-table `SELECT` are editable. Edits, delete marks, new rows and pastes stage as a pending overlay."
      },
      {
        "k": "p",
        "md": "The result toolbar holds **+ Row**, the pending counter (`✎ N changes`), **Commit…** (or **Apply…** in the transaction owner), and **Discard**."
      },
      {
        "k": "demo",
        "id": "grid-edit",
        "caption": "Edit cells, mark deletes, add rows, then preview and Apply or Commit."
      },
      {
        "k": "h",
        "text": "When a result is editable",
        "id": "when-editable"
      },
      {
        "k": "p",
        "md": "Rows map back to the table by primary key. Editing is offered only when all of these hold."
      },
      {
        "k": "list",
        "items": [
          "**A single plain `SELECT`.** `WITH`, `TABLE`, `VALUES` and scripts reject.",
          "**One table.** Any `JOIN`, `GROUP BY`, `DISTINCT`, `UNION`/`INTERSECT`/`EXCEPT`, `HAVING`, or `RETURNING` disqualifies.",
          "**Plain column references only** — `*`, `t.*`, `col`, `t.col`. No expressions, functions, `CASE`, literals, or aliases.",
          "**A table, not a view or matview**, with a primary key, every PK column present in the result.",
          "**No duplicate column names** in the result.",
          "**An unambiguous table identity.** A bare name in two schemas needs the active schema to resolve it. Derived tables, table functions and mismatched qualifiers reject.",
          "**Connection not read-only.** On Postgres the role needs `UPDATE`, `INSERT`, `DELETE`, or ownership."
        ]
      },
      {
        "k": "p",
        "md": "With editing off, right-click a cell: the disabled **Edit cell** entry tooltips the exact reason. See [[topic:safety|Safety]]."
      },
      {
        "k": "h",
        "text": "Editing gestures",
        "id": "gestures"
      },
      {
        "k": "list",
        "items": [
          "Double-click a cell to edit; [[kbd:Mod]]+double-click keeps *View value*. With a cell selected, [[kbd:Enter]] or [[kbd:F2]] opens the editor.",
          "Boolean columns get a **TRUE / FALSE** dropdown, plus `<null>` when nullable. Re-picking the original reverts the edit.",
          "The [[topic:results|record view]] edits the same row field by field, through the same pending overlay and the same column rules."
        ]
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
            "Set the cell to SQL NULL"
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
        "k": "list",
        "items": [
          "Blur commits like Enter. Typing nothing over a `NULL` is not an edit.",
          "Right-click adds **Set NULL**, and **Revert cell** on dirty cells.",
          "Dirty cells tint, delete-marked rows strike through, new rows highlight, and copy reads the same overlay."
        ]
      },
      {
        "k": "h",
        "text": "Deleting and inserting rows",
        "id": "delete-insert"
      },
      {
        "k": "list",
        "items": [
          "Select rows in the gutter and press [[kbd:Delete]], or right-click → **Delete rows**, to mark them. The menu flips to **Undelete rows**.",
          "Delete acts only on a row selection. Marking a pending insert removes it outright.",
          "**+ Row** or right-click → **Insert row** adds a row pinned to the top, so [[topic:results|loading more rows]] cannot disturb it.",
          "Untouched cells show a faint *default* and are omitted from the INSERT. A fully untouched row commits as `DEFAULT VALUES`."
        ]
      },
      {
        "k": "h",
        "text": "Pasting from a spreadsheet",
        "id": "paste"
      },
      {
        "k": "p",
        "md": "[[kbd:Mod-V]] parses the clipboard as a table: tab-delimited when any tab is present, comma otherwise, with quoted fields honored."
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
            "First clipboard row names editable table columns and at least one data row follows",
            "Each remaining row becomes a new insert row, mapped by name; clipboard column order is irrelevant"
          ],
          [
            "**Positional**",
            "Anything else",
            "The block writes from the anchor cell across the visible columns; rows past the end overflow into new insert rows"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "Empty cell → SQL `NULL`. A cell absent because the row is short is omitted, so the column keeps its default.",
          "Positional pastes write visible columns only; header-mapped can reach hidden ones. Non-table columns are never written.",
          "With no active cell the paste anchors at the append region. For files, use [[topic:import-export|Import]]."
        ]
      },
      {
        "k": "h",
        "text": "Apply or Commit: one reviewed script",
        "id": "commit"
      },
      {
        "k": "p",
        "md": "**Commit…** / **Apply…** shows the literal script before anything runs: UPDATEs, then DELETEs, then INSERTs. A row both edited and delete-marked only deletes."
      },
      {
        "k": "code",
        "caption": "A fully qualified script — app-owned, or applied to the outer transaction",
        "text": "UPDATE \"public\".\"users\" SET \"email\" = 'a@b.co' WHERE \"id\" = '42';\nDELETE FROM \"public\".\"users\" WHERE \"id\" = '7';\nINSERT INTO \"public\".\"users\" (\"name\") VALUES ('New');"
      },
      {
        "k": "list",
        "items": [
          "**Outside a manual transaction** — Commit uses one app-owned transaction. Failure rolls it back, keeps pending edits, and shows the error.",
          "**Inside the owner transaction** — Apply runs in the existing unit and leaves it open. Pending edits must be resolved before that unit can end.",
          "WHERE clauses use the original loaded values, so editing a primary-key cell still locates the old row. Composite PKs are AND-ed.",
          "Statements are fully qualified, ignoring the tab's active schema.",
          "On success the grid refreshes in place, keeping the [[topic:results|sort and filter]] view."
        ]
      },
      {
        "k": "h",
        "text": "Pending-edit lifecycle",
        "id": "lifecycle"
      },
      {
        "k": "list",
        "items": [
          "Pending edits are per-tab and index into the loaded snapshot, so scrolling cannot shift them. They are never persisted.",
          "Anything that replaces the rows asks *Discard pending changes?* with the change count, as does toolbar **Discard**.",
          "Pre-`BEGIN` rows must be rerun before editing, and transaction boundaries or a lost session leave affected edits stale until rerun."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "There is no concurrency check — last write wins — so re-run the SELECT before committing on hot tables. See the [[topic:editor|editor]]."
      }
    ],
    "icon": "edit"
  },
  {
    "blurb": "Browse the database tree; run SQL-previewed DDL from right-click menus.",
    "id": "sidebar",
    "title": "Schema explorer & DDL",
    "blocks": [
      {
        "k": "list",
        "items": [
          "The Explorer shows the connection the focused tab belongs to. Switching connection swaps the tree and its permission gating.",
          "Every node has a right-click menu. DDL forms and drop/truncate confirms preview the exact SQL first.",
          "Two exceptions run without a preview: matview *Refresh*, and sequence *Restart…*, which drops its statement into the editor.",
          "Mutating items are gated by connection mode, driver capability, and on Postgres by role privileges. Disabled items name the reason in their tooltip."
        ]
      },
      {
        "k": "h",
        "text": "What the tree shows",
        "id": "tree-structure"
      },
      {
        "k": "list",
        "items": [
          "Hierarchy: databases → schemas → Tables / Views / Sequences / Functions. Other databases are listed but muted.",
          "The tree loads shallow at connect. Expanding a table lazily fetches and caches Columns, Indexes, Constraints, Triggers.",
          "**Row estimates and sizes (Postgres)** — `≈1.2K · 64 MB`, from the planner. A never-analyzed table shows no estimate.",
          "**Tooltips** carry comments, a column's `default:`, and full index, constraint, trigger and function definitions.",
          "**Column badges** — key icon for primary key, link icon for foreign key, `·NN` for `NOT NULL`.",
          "**Filter box** — live substring match; containers auto-expand to reveal matches.",
          "**Refresh** re-introspects the tree, autocomplete catalog, privileges and expanded details. Sidebar DDL refreshes automatically."
        ]
      },
      {
        "k": "h",
        "text": "Browsing data from the tree",
        "id": "browse-data"
      },
      {
        "k": "list",
        "items": [
          "**Double-click** a table or view to stream all rows in a new tab — see [[topic:results|Results grid]].",
          "The context menu adds **Select 100 rows**, **Select all rows**, and **Filter rows…**, which opens the [[topic:results|filter builder]] over the relation.",
          "All open a new tab with active schema preset to the relation's.",
          "**Generate SELECT / INSERT / UPDATE** scaffold a statement into a new tab; UPDATE includes a primary-key `WHERE`. See [[topic:editor|the editor]]."
        ]
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
            "Select 100 rows · Select all rows · **Generate** (SELECT / INSERT / UPDATE) · **Copy** (name / qualified name / DDL / DDL to editor) · **Data** (Export table… / Import data into table… / Backup table… / Filter rows…) · **Modify table…** · Add column… · Add index… · Add constraint… · Rename… · Duplicate… · Edit comment… · DDL & relationships… · Truncate… · Drop…"
          ],
          [
            "View / matview",
            "Select all rows · **Copy** · **Data** (Export… / Filter rows…) · matview **Refresh** / **Refresh concurrently** · Rename… · Edit comment… · DDL & relationships… · Drop…"
          ],
          [
            "Column",
            "Edit column… · Rename… · Edit comment… · Copy name · Drop column…"
          ],
          [
            "Index",
            "Rename… · Copy name · Drop…"
          ],
          [
            "Constraint",
            "Rename… · Copy name · Drop…"
          ],
          [
            "Sequence",
            "Restart… · Rename… · Copy DDL / Copy DDL to editor · Copy name · Drop…"
          ],
          [
            "Function",
            "Copy DDL / Copy DDL to editor · Copy name · Drop…"
          ],
          [
            "Trigger",
            "Copy DDL / Copy DDL to editor · Copy name · Drop…"
          ],
          [
            "Schema",
            "Schema diagram… · Create table… · Rename… · **Data** (Import file as new table… / Export tables… / Backup schema…) · Copy name · Drop… (on MySQL this reads **Drop database…** and refuses the connected one)"
          ],
          [
            "Database",
            "Create schema… · **Data** (Import file as new table… / Export tables… / Backup database… / Restore from file…) · Copy name · Drop database… (not the connected one)"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "**DDL & relationships…** opens the DDL and FK graph viewer; **Schema diagram…** opens the whole-schema ERD. See [[topic:erd|the relationship viewer]].",
          "**Truncate…** and **Drop…** always confirm, with a `CASCADE` checkbox. Truncate adds `RESTART IDENTITY`. They sit last in every menu, behind a wider rule.",
          "A bold entry opens a submenu: hover it, or press [[kbd:ArrowRight]]; [[kbd:ArrowLeft]] or [[kbd:Escape]] closes it.",
          "The header **＋** is selection-aware, offering *New column / index / constraint on X…* before *New table*, *New schema* and *New database*."
        ]
      },
      {
        "k": "h",
        "text": "Every dialog shows its SQL",
        "id": "dialogs"
      },
      {
        "k": "list",
        "items": [
          "Every form derives a live SQL preview. The footer offers **Cancel**, **Edit as SQL**, and the primary action.",
          "Every Explorer DDL statement lands in [[topic:history|query history]] marked `-- [Explorer]`, and its result surfaces even when the results panel is collapsed."
        ]
      },
      {
        "k": "p",
        "md": "**Modify table…** is a diff editor: edit a column's name, type, nullability, default, PK membership or comment; reorder, add and drop columns; drop and add constraints; rename and re-comment the table."
      },
      {
        "k": "list",
        "items": [
          "The preview is the minimal `ALTER` script, ordered so every statement resolves, with the table rename last.",
          "It refuses an empty or duplicate column name, a nullable primary key, or a generated column.",
          "**Drop** on a column, index or constraint row marks it (struck through, **Keep** undoes); the footer counts pending drops and Apply confirms them by name.",
          "Column reordering is offered on SQLite only.",
          "A multi-statement script says underneath how it runs, including when it is not atomic, as on MySQL."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "On SQLite anything beyond a rename, an add or a plain drop generates a full table rebuild, and the primary button reads **Rebuild table**."
      },
      {
        "k": "list",
        "items": [
          "The rebuild copies the table into its new shape in one labelled transaction, recreating indexes and triggers.",
          "A rebuild is refused with a reason for a rename in the same pass, dropping a column something still uses, or an unreadable stored definition."
        ]
      },
      {
        "k": "p",
        "md": "**Create table…** covers per-column type, NOT NULL, default expression, primary key, unique, check, and that engine's auto-numbering."
      },
      {
        "k": "list",
        "items": [
          "Auto-numbering: Postgres identity, MySQL `AUTO_INCREMENT`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`, DuckDB a sequence alongside the table.",
          "An expandable section adds per-column checks and comments, foreign keys, `IF NOT EXISTS`, `TEMPORARY`, and MySQL's engine and charset options."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Foreign keys get a picker** in Create table, Modify table and Add constraint: a searchable `schema.table` box fed by the loaded tree.",
          "Picking a table lists its columns, key columns first. Add a row per column for a composite key.",
          "Set `ON DELETE` / `ON UPDATE`, and `DEFERRABLE` where supported. Incompatible types warn rather than block."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "An idle sidebar action rolls back an open streaming cursor, so a tab paging a big result stops and is marked **Incomplete result**."
      },
      {
        "k": "h",
        "text": "What's enabled where",
        "id": "gating"
      },
      {
        "k": "p",
        "md": "Mutating items pass four gates. The failing gate's reason becomes the disabled item's tooltip."
      },
      {
        "k": "list",
        "items": [
          "**Manual transaction** — every Explorer database action is frozen while one owns the session.",
          "**Read-only connection** — everything mutating disables. See [[topic:safety|Safety & read-only mode]].",
          "**Engine limits** — sidebar DDL is live on PostgreSQL, DuckDB, MySQL and SQLite, each action offered only where the engine supports it.",
          "**Postgres effective privileges** — Modify, Add, Rename and Drop need table ownership; Duplicate and Create table need `CREATE` on the schema; New database needs `CREATEDB`."
        ]
      },
      {
        "k": "list",
        "items": [
          "**DuckDB** — no constraint `ALTER`s, index or sequence renames, `ALTER SEQUENCE RESTART`, `CREATE`/`DROP DATABASE`, or `TRUNCATE` options.",
          "**MySQL** — no schema rename, sequences, index methods or partial indexes.",
          "**SQLite** — no comments, `CREATE SCHEMA`, `CREATE DATABASE`, or constraint ALTERs. *Delete all rows…* runs `DELETE FROM`."
        ]
      },
      {
        "k": "h",
        "text": "Copy DDL is reconstructed, not dumped",
        "id": "copy-ddl"
      },
      {
        "k": "list",
        "items": [
          "**Copy DDL** rebuilds a runnable `CREATE` from the system catalogs on every engine, best-effort on DuckDB.",
          "On Postgres it covers tables, views, matviews, functions including overloads, and sequences.",
          "Foreign keys emit as trailing `ALTER TABLE … ADD CONSTRAINT`, so copied tables replay in any order. Constraint-backed indexes are skipped.",
          "**Copy DDL to editor** pastes the reconstruction at the cursor — useful for [[topic:import-export|exporting]] a structure alongside its data."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Omitted rather than guessed: partitioning, inheritance, row-level security, triggers, storage parameters, tablespaces, and collations."
      }
    ],
    "icon": "folder"
  },
  {
    "blurb": "Export results in six formats, streamed or loaded; import CSV, JSON or xlsx transactionally on four engines.",
    "id": "import-export",
    "title": "Import & export",
    "blocks": [
      {
        "k": "list",
        "items": [
          "**Export…** on the result toolbar — file or clipboard, six formats, streaming.",
          "The Explorer's **Export table…** / **Export tables…**.",
          "The sidebar's **Import data** icon, plus **Import data into table…** and **Import file as new table…**.",
          "Grid copy: [[kbd:Mod-C]] and the cell right-click menu — see [[topic:results|Results]].",
          "Export works on every engine. Import covers PostgreSQL, MySQL, SQLite and DuckDB.",
          "For a whole database, see [[topic:backup|Backup & restore]]."
        ]
      },
      {
        "k": "h",
        "text": "The Export dialog",
        "id": "export-dialog"
      },
      {
        "k": "list",
        "items": [
          "**Export…** freezes a snapshot of the result, so switching tabs mid-dialog cannot redirect it.",
          "**Columns** — check, uncheck and reorder with ↑/↓. At least one must stay selected.",
          "**Preview** — live, from the first 12 rows in memory. Skipped for xlsx.",
          "**Defaults** — CSV, comma delimiter, quote *as needed*, header row on, NULL as empty, LF line endings, no BOM.",
          "Formatting options are remembered per format. Column selection, table name and **Include CREATE TABLE** come from the result being exported."
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
            "Delimiter, quoting (*As needed* / *Always* / *Never*), quote char, **NULL as** (empty / `NULL` / custom), LF or CRLF endings, optional UTF-8 BOM."
          ],
          [
            "**JSON**",
            "Array of objects keyed by column name, pretty-printed."
          ],
          [
            "**SQL inserts**",
            "`INSERT` statements with a configurable table name. **Multi-row INSERT** batches 1,000 tuples per statement, and **Include CREATE TABLE** prepends the table's reconstructed DDL."
          ],
          [
            "**Markdown**",
            "A pipe table with a header separator row."
          ],
          [
            "**Excel (xlsx)**",
            "File-only. Sheet name defaults to the detected table name. **Bold header**, **Auto-filter**, **Freeze header**. Rows past 1,048,576 roll into more sheets."
          ]
        ]
      },
      {
        "k": "h",
        "text": "Scope: loaded rows vs. all rows",
        "id": "scope"
      },
      {
        "k": "list",
        "items": [
          "**Loaded rows (N)** — formats what the grid holds, in memory.",
          "**Selection (N rows)** — offered when rows are selected: those rows at full width. The dialog's column checkboxes still apply.",
          "**All rows (re-run query)** — re-executes server-side, streaming on Postgres and paging elsewhere. Frozen while a manual transaction owns the session.",
          "The re-run honors the producing tab's active schema, so unqualified names resolve as they did in the editor."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "On DuckDB, SQLite, MySQL and SQL Server an all-rows export is not snapshot-consistent."
      },
      {
        "k": "list",
        "items": [
          "**To** switches between **File** and **Clipboard**.",
          "Clipboard formats in memory, so it takes *Loaded rows* or *Selection*, not *All rows*. xlsx forces **File**."
        ]
      },
      {
        "k": "h",
        "text": "Cancelling a long export",
        "id": "cancel-rollback"
      },
      {
        "k": "list",
        "items": [
          "During an all-rows stream the dialog locks its controls and shows **Cancel export**.",
          "Postgres and DuckDB cancel immediately, except DuckDB on Windows. SQLite, MySQL and SQL Server finish the current query first.",
          "Cancel or error rolls back the read transaction and deletes the partial file. xlsx writes the destination only at the end.",
          "Loaded-rows and clipboard exports run in memory, with no query to cancel."
        ]
      },
      {
        "k": "h",
        "text": "Import (CSV / JSON → table)",
        "id": "import"
      },
      {
        "k": "p",
        "md": "**Import data** opens a three-step dialog on PostgreSQL, MySQL, SQLite and DuckDB. The file is read from disk in bounded batches."
      },
      {
        "k": "list",
        "items": [
          "**1. File** — pick the file and its parsing options. A parsed sample shows detected columns and any warnings.",
          "**2. Columns** — choose the target table and map the file's columns onto it.",
          "**3. Run** — live progress, **Cancel & roll back**, and a result summary."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Delimited text** — delimiter, quote character (blank turns quoting off), optional escape character, UTF-8 or Latin-1, **skip N rows**, and a **NULL text** placeholder.",
          "**JSON** — an array of objects or NDJSON. Keys become columns in first-seen order, nested values stringify, and a duplicate key is rejected.",
          "**Excel (xlsx)** — the first sheet by default, with a picker for multi-sheet workbooks.",
          "**First row is the header** — unchecked gives `col1`, `col2`, …. A row longer than the header is an error; a short row fills the rest with NULL and warns."
        ]
      },
      {
        "k": "list",
        "items": [
          "The `CREATE TABLE`, the optional clear, and every insert batch run in one transaction. Any error undoes everything and names the offending row.",
          "PostgreSQL streams a plain load through `COPY … FROM STDIN`; a conflict mode falls back to batched `INSERT`s, as other engines always use.",
          "On success the sidebar and autocomplete refresh ([[topic:sidebar|Sidebar]]), and the run lands in [[topic:history|history]] as `-- [Import] …`."
        ]
      },
      {
        "k": "h",
        "text": "Choosing the target and mapping columns",
        "id": "import-mapping"
      },
      {
        "k": "list",
        "items": [
          "**Existing table** — file columns auto-match by name. Leftovers can be pointed at a column or set to **— skip —**, leaving it at its default.",
          "**New table** — the name is pre-filled from the file name, and an Explorer schema node pre-selects its schema.",
          "Each new column's type is inferred from the sample — integer, bigint, numeric, boolean, date, timestamp, or text — and can be overridden.",
          "**Empty the table first** — clears the table inside the same transaction.",
          "**Empty → NULL** — per column, imports an empty or whitespace-only string as NULL. On by default for every non-text column."
        ]
      },
      {
        "k": "table",
        "head": [
          "On conflict",
          "What each engine runs"
        ],
        "rows": [
          [
            "**Fail**",
            "A plain `INSERT`. A key collision fails the import and rolls it back."
          ],
          [
            "**Skip conflicting rows**",
            "PostgreSQL `ON CONFLICT DO NOTHING`, MySQL `INSERT IGNORE`, SQLite and DuckDB `INSERT OR IGNORE`."
          ],
          [
            "**Update / replace conflicting rows**",
            "PostgreSQL `ON CONFLICT (keys) DO UPDATE`; MySQL `ON DUPLICATE KEY UPDATE`, which fires on any unique key; SQLite and DuckDB `INSERT OR REPLACE`, which resets unmapped columns."
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A MySQL import that creates its table commits the `CREATE TABLE` separately, so a rollback leaves the empty table behind."
      },
      {
        "k": "h",
        "text": "Exporting from the Explorer",
        "id": "explorer-export"
      },
      {
        "k": "list",
        "items": [
          "**Export table…** opens the same configurator aimed at that relation's full contents. On a view or matview it reads **Export…**.",
          "**Export tables…** on a schema or database: tick tables, choose a format and a directory, and get one file per table named `schema_table.<ext>`.",
          "Every file is written atomically. A failing table is reported by name and the run continues."
        ]
      },
      {
        "k": "h",
        "text": "Grid copy is its own thing",
        "id": "grid-copy"
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Mod-C]] copies the selection as TSV. The right-click menu adds **Copy as CSV**, **Copy as JSON**, **Copy as Markdown**, **Copy cell value**, and **Copy column**.",
          "**Headers** — omitted unless **Copy w/ column names** is ticked next to Export….",
          "Copies read through pending edits, and booleans copy as the displayed `TRUE`/`FALSE`. **View value…** stays raw.",
          "Copy runs the export formatter, so a copied block is byte-identical to the same export written to a file.",
          "**Pasting in** — see [[topic:grid-editing|Grid editing]]."
        ]
      }
    ],
    "icon": "download"
  },
  {
    "blurb": "Native plain-SQL dumps and replays through the driver — no pg_dump, no mysqldump.",
    "id": "backup",
    "title": "Backup & restore",
    "blocks": [
      {
        "k": "list",
        "items": [
          "Backups are written and replayed through the connected driver on all five engines. No external binary is involved.",
          "A dump is plain SQL, replayable by Tusk or by the engine's own CLI client.",
          "SQL Server dumps carry no `GO` separators, so replay them with Tusk rather than `sqlcmd`."
        ]
      },
      {
        "k": "h",
        "text": "Starting one",
        "id": "starting"
      },
      {
        "k": "list",
        "items": [
          "**Explorer right-click** — **Backup database…** / **Restore from file…**, **Backup schema…**, **Backup table…**. Each pre-fills the scope.",
          "**Toolbar ⋯ overflow** — **Backup…** and **Restore from file…**, shown only when the editor pane is 880 px or narrower.",
          "Both need an idle session. They are blocked during a manual transaction, and starting one releases the single result stream."
        ]
      },
      {
        "k": "h",
        "text": "The Backup dialog",
        "id": "backup-dialog"
      },
      {
        "k": "table",
        "head": [
          "Option",
          "What it does"
        ],
        "rows": [
          [
            "**Scope**",
            "**Whole database**, **Selected schemas**, or **Selected tables**. On PostgreSQL a table selection also carries the sequences its identity columns own."
          ],
          [
            "**Contents**",
            "**Schema + data**, **Schema only**, or **Data only**. Data-only carries no `CREATE`."
          ],
          [
            "**Emit DROP … IF EXISTS**",
            "Adds a drop block ahead of the creates, in reverse dependency order. Disabled for a data-only dump."
          ],
          [
            "**Wrap in one transaction**",
            "Offered on PostgreSQL, DuckDB, SQLite and SQL Server; disabled on MySQL, which commits DDL implicitly."
          ],
          [
            "**Destination**",
            "**Choose file…** opens the native save dialog. Nothing runs until a path is set."
          ]
        ]
      },
      {
        "k": "p",
        "md": "While it runs the dialog shows the current object, tables done, rows and bytes written, and elapsed time, with **Cancel backup**."
      },
      {
        "k": "h",
        "text": "What a dump contains",
        "id": "dump-layout"
      },
      {
        "k": "p",
        "md": "A header comment records the Tusk version, engine, database, timestamp and options. Then: drops, schemas, sequences, tables, data, views, PostgreSQL routines, and deferred foreign keys."
      },
      {
        "k": "list",
        "items": [
          "**Foreign keys come last on PostgreSQL, MySQL and SQL Server**, as trailing `ALTER TABLE … ADD CONSTRAINT`, so a restore cannot break on table order.",
          "**SQLite and DuckDB keep foreign keys inline**, since neither can add one with `ALTER TABLE`. A SQLite schema dump writes `PRAGMA foreign_keys = OFF` first.",
          "**Functions, procedures and triggers are reconstructed on PostgreSQL only**; elsewhere the dump counts the routines it could not carry.",
          "**PostgreSQL data streams through `COPY`**, in blocks terminated by `\\.`, so no table is held in memory.",
          "**Other engines emit batched multi-row `INSERT`s**, paged so memory stays flat, with binary columns as native blob literals.",
          "**PostgreSQL dumps are snapshot-consistent**; other engines page a table at a time."
        ]
      },
      {
        "k": "h",
        "text": "The Restore dialog",
        "id": "restore-dialog"
      },
      {
        "k": "list",
        "items": [
          "**Choose file…** picks the dump. Tusk reads its size and header and shows what it is about to replay.",
          "A dump from a different engine is called out first. A file without a Tusk header is replayed as plain SQL.",
          "A header carrying a `psql` directive such as `\\restrict` is flagged: Tusk replays SQL, not `psql` commands.",
          "**Stop at the first error** (default) halts and reports; unchecked, it continues and still records the first failure.",
          "**Run everything in one transaction** rolls the whole restore back on any failure. Not available on MySQL, and it requires stop-on-error.",
          "Progress shows statements run, rows copied and bytes read. **Rows copied** advances only for `COPY` blocks.",
          "The result panel reports statements run, failures, rows copied, and the first error with its statement number and line.",
          "On finish the sidebar and autocomplete reload."
        ]
      },
      {
        "k": "h",
        "text": "Safety and limits",
        "id": "safety"
      },
      {
        "k": "list",
        "items": [
          "A read-only connection can back up but not restore.",
          "A failed or cancelled backup leaves the previous file untouched: the dump is written to a temp file, fsynced, then atomically renamed.",
          "A restore statement is never replayed. If the connection drops mid-restore, Tusk stops and asks you to verify state.",
          "**Limits** — a restore reads at most 2 GiB, and one statement or `COPY` block at most 256 MiB."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Verify a restore before relying on a dump as your only copy."
      },
      {
        "k": "list",
        "items": [
          "DDL reconstruction matches [[topic:sidebar|Copy DDL]]: partitioning, inheritance, row-level security, grants, storage parameters and tablespaces are out of scope.",
          "DuckDB dumps carry no `CREATE INDEX`.",
          "MySQL's `CREATE TABLE` is unqualified, so it restores into the connected database.",
          "SQL Server table reconstruction needs SQL Server 2017 or later."
        ]
      }
    ],
    "icon": "duplicate"
  },
  {
    "blurb": "EXPLAIN output rendered as a pan/zoomable, heat-colored tree on every engine.",
    "id": "plans",
    "title": "EXPLAIN plan visualization",
    "blocks": [
      {
        "k": "p",
        "md": "Any `EXPLAIN` result renders as a tree of node cards on a pan/zoom canvas. Type `EXPLAIN` directly or use the **Explain ▾** toolbar button."
      },
      {
        "k": "h",
        "text": "Running an explain",
        "id": "running"
      },
      {
        "k": "list",
        "items": [
          "**Explain ▾** in the [[topic:editor|editor toolbar]] offers **Explain** and **Explain Analyze (runs the query)**.",
          "Both are registry actions, unbound by default; bind them in [[topic:shortcuts|Settings → Shortcuts]] or run them from the command palette.",
          "Each takes one selected statement, or the statement under the cursor, and wraps it in the engine's best structured form."
        ]
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
            "`EXPLAIN (FORMAT json) …` where supported, else plain `EXPLAIN`",
            "`EXPLAIN (ANALYZE, FORMAT json) …` or `EXPLAIN ANALYZE`"
          ],
          [
            "MySQL",
            "`EXPLAIN FORMAT=JSON …`",
            "`EXPLAIN ANALYZE …`"
          ],
          [
            "SQL Server",
            "— T-SQL has no `EXPLAIN`; SHOWPLAN output is not rendered yet",
            "— not supported"
          ],
          [
            "SQLite",
            "`EXPLAIN QUERY PLAN …`",
            "— disabled, *Not supported by this engine*"
          ]
        ]
      },
      {
        "k": "p",
        "md": "DuckDB's parenthesized options are probed once at connect, and the answer drives wrapping for the session."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "`EXPLAIN ANALYZE` executes the statement, so a non-read — including `WITH … UPDATE` — raises a confirmation whose **Modify data and explain** button is the only way through."
      },
      {
        "k": "h",
        "text": "Plan vs Grid",
        "id": "plan-grid"
      },
      {
        "k": "list",
        "items": [
          "A parsed plan adds a **Plan / Grid** toggle to the [[topic:results|result toolbar]]. Plan is the default, Grid is the raw engine output.",
          "In Plan view the grid-only toolbar controls are hidden and the status bar reads the plan — `7 nodes, total cost 174`.",
          "SQLite's bytecode `EXPLAIN` and MySQL's tabular `EXPLAIN` stay in the grid with no toggle."
        ]
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
        "k": "list",
        "items": [
          "Each card shows the operator, the object it touches, and a stats line: actual time and rows after `EXPLAIN ANALYZE`, estimated cost otherwise.",
          "The header strip shows the engine badge, planning and execution totals, and an **estimates only** marker where there are no measurements.",
          "**Click a card** — dock a details panel with self cost, self time, and every parsed property.",
          "**▾ / ▸ N** — collapse or expand a subtree; the badge counts hidden nodes.",
          "**Drag** to pan, **wheel** to zoom, **double-click the background** to fit the tree. Fit never shrinks cards below full size — a large plan pans instead."
        ]
      },
      {
        "k": "list",
        "items": [
          "Heat is a node's **share of the plan total**: self cost over the root's total cost, self time over total execution time. Rows compare against the widest node.",
          "The header states the metric in use. The ramp runs slate → amber; red is reserved for destructive actions.",
          "Metric fallback is cost → time → rows. DuckDB has no cost numbers, so it uses time or rows."
        ]
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
        "md": "All three apply live."
      },
      {
        "k": "h",
        "text": "When parsing fails",
        "id": "fallback"
      },
      {
        "k": "list",
        "items": [
          "An unparseable plan falls back to a formatted monospace text block, and the raw rows stay one Grid-toggle away.",
          "Postgres text-mode `EXPLAIN` gets its own text parser first. DuckDB box-art output and MySQL `EXPLAIN ANALYZE` tree text render as styled text.",
          "Detection handles pretty-printed JSON split across rows, and comments before the `EXPLAIN` keyword."
        ]
      }
    ],
    "icon": "eye"
  },
  {
    "blurb": "Foreign keys visually: neighborhood graphs, whole-schema ERD, reconstructed DDL.",
    "id": "erd",
    "title": "Relationships & ERD",
    "blocks": [
      {
        "k": "p",
        "md": "One dialog, two scopes: a **Neighborhood** view centered on one table, and a **Whole schema** ERD, both beside the relation's reconstructed `CREATE` DDL."
      },
      {
        "k": "p",
        "md": "The viewer is read-only. SQL leaves only through the DDL pane's **Copy** and **Open in editor** buttons."
      },
      {
        "k": "h",
        "text": "Opening the viewer",
        "id": "opening"
      },
      {
        "k": "list",
        "items": [
          "**DDL & relationships…** — right-click a table, view, or matview in the [[topic:sidebar|sidebar]]. Opens in Neighborhood scope, centered on it.",
          "**Schema diagram…** — right-click a schema node for the Whole schema ERD. The DDL pane starts collapsed; click a table card to load its DDL.",
          "The DDL pane auto-collapses to a thin `DDL` rail in schema scope and expands in Neighborhood scope; the rail's chevron overrides either way. Long lines wrap.",
          "Fit stops at full size in Neighborhood scope, so card text stays readable; Whole schema keeps fitting to the canvas.",
          "Postgres DDL is reconstructed from the catalogs; other engines use native sources. Caveats in [[topic:sidebar|the sidebar topic]]."
        ]
      },
      {
        "k": "h",
        "text": "Neighborhood view",
        "id": "neighborhood"
      },
      {
        "k": "list",
        "items": [
          "**Center card** — the focused table's columns, up to 14 then \"+N more columns\", with PK and FK marks. A self-referencing FK shows as a ↺ badge.",
          "**Left stack** — tables that reference it. **Right stack** — tables it references.",
          "**Edge labels** — the exact column mapping (`customer_id → id`), multi-column FKs comma-joined. The column gap sizes to the longest label.",
          "**Click** a neighbor card to re-center; **drag** any card to reposition it. Manual positions clear on re-center."
        ]
      },
      {
        "k": "h",
        "text": "Whole-schema ERD",
        "id": "whole-schema"
      },
      {
        "k": "demo",
        "id": "erd-mini",
        "caption": "Family clusters, hue-coded edges, and click-to-drill into a table's neighborhood."
      },
      {
        "k": "list",
        "items": [
          "**Cards** — key columns only, up to 12 rows then \"+N more keys\". A table with no keys shows its column count.",
          "**Family blocks** — tables sharing a name prefix group into labeled dashed containers, each a small layered flow."
        ]
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
            "Drill into that table's Neighborhood view and load its DDL"
          ],
          [
            "Drag a card",
            "Reposition it; edges follow"
          ],
          [
            "Drag a family label strip",
            "Move the container and every member table"
          ],
          [
            "Hover a card",
            "Unrelated cards and edges dim"
          ],
          [
            "Hover an edge",
            "Show the column-mapping label"
          ],
          [
            "**Reset layout**",
            "Discard manual repositioning; disabled when nothing moved"
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
        "md": "Manual nudges are session-scoped: they clear when the schema graph reloads or on **Reset layout**."
      },
      {
        "k": "p",
        "md": "Past 300 tables a *large schema* warning shows in the header; layout still completes."
      },
      {
        "k": "h",
        "text": "Reading the edges",
        "id": "edges"
      },
      {
        "k": "list",
        "items": [
          "**Color** — each edge takes the hue of the table it points at, so all FKs into `users` read as one stream. The matching chip sits on that card's header.",
          "**Hub damping** — a table whose incoming FK count reaches 35% of the schema's table count, minimum 8, renders faint thin edges that light up on hover."
        ]
      },
      {
        "k": "h",
        "text": "Per-engine support",
        "id": "engines"
      },
      {
        "k": "p",
        "md": "FK introspection is best-effort per driver; an engine that cannot answer returns an empty graph rather than an error."
      },
      {
        "k": "list",
        "items": [
          "**Postgres** — `pg_constraint`, column lists in declared key order.",
          "**SQLite** — `pragma_foreign_key_list`; a FK omitting target columns resolves to the referenced table's PK.",
          "**MySQL** — `information_schema.KEY_COLUMN_USAGE`.",
          "**SQL Server** — `sys.foreign_keys` joined to `sys.foreign_key_columns`.",
          "**DuckDB** — `duckdb_constraints()`, falling back to parsing the constraint text."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The same FK catalog powers autocomplete's `JOIN … ON` conditions — see [[topic:editor-intel|Editor intelligence]]."
      }
    ],
    "icon": "link"
  },
  {
    "blurb": "Schema-aware chat that proposes SQL. Keys in the OS keychain; nothing auto-runs.",
    "id": "ai",
    "title": "AI assistant",
    "blocks": [
      {
        "k": "p",
        "md": "The **✨ AI** topbar button toggles the docked panel. The assistant sees the dialect, schema, foreign keys, privileges, [[topic:ai|skills]], editor SQL, and sample rows."
      },
      {
        "k": "p",
        "md": "It only proposes SQL. Nothing runs until it is opened in a tab and run by hand."
      },
      {
        "k": "h",
        "text": "Providers and keys",
        "id": "providers"
      },
      {
        "k": "list",
        "items": [
          "Providers, keys and skills live in **Settings → AI**. Each card holds a key, a default model, an API base override, and **Test connection**.",
          "**AI reply max tokens** (256–128,000) caps the reply the panel asks for, sharing one normalization with the [[topic:slack|Slack]] field."
        ]
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
            "Frontier and open models through one gateway",
            "One key"
          ],
          [
            "**OpenRouter**, **Groq**",
            "Routers and fast open-model hosting",
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
            "Yours plus a base URL"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "Keys are stored per provider in the OS keychain under `tusk-ai` and used only by the Rust backend. Several can be set up and switched between mid-conversation.",
          "A custom API base must be approved before anything is sent to it, and a saved key is bound in the keychain to that HTTPS origin.",
          "Until approval the card shows *Origin approval needed* and Test connection refuses. Slack fails closed on an origin mismatch."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "**Ollama** and **LM Studio** need no key and no network, so schema, foreign keys and sample rows stay on the machine."
      },
      {
        "k": "h",
        "text": "Choosing a model",
        "id": "models"
      },
      {
        "k": "list",
        "items": [
          "The picker in the panel header is a searchable combobox: type to fuzzy-filter across every configured provider, ↑/↓ to move, Enter to pick."
        ]
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
            "both terms must match — `anthropic/claude-opus-4.8`"
          ],
          [
            "`co48`",
            "`claude-opus-4-8`, an abbreviation across separators"
          ],
          [
            "`oss`",
            "`openai/gpt-oss-120b`, because `oss` starts a word"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "Each provider card has one **Models** list. A row's checkbox offers that model in the header picker and to the Slack bot; **★** marks the default.",
          "The list is the provider's live catalog, fetched when the card opens; **Refresh** re-fetches.",
          "**Select all** and **Clear** work on the visible rows, and an unlisted id can be added with **Add … as a model id**.",
          "Starring an unticked model ticks it, and a retired model drops out on its own."
        ]
      },
      {
        "k": "h",
        "text": "Skills — instructions the assistant follows",
        "id": "skills"
      },
      {
        "k": "p",
        "md": "A skill is Markdown the assistant obeys on every question, for what the schema cannot say: money stored in cents, or `legacy_*` tables that are never correct."
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
            "House style, SQL conventions, answer formatting"
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
        "md": "Manage them in **Settings → AI → Skills**. A database skill adopts the connected database; opening one written against another offers **Retarget**."
      },
      {
        "k": "code",
        "caption": "A skill is Markdown with frontmatter. This is the file on disk.",
        "text": "---\nname: shop house rules\ndescription: Revenue, money units and forbidden tables\nscope: database\ndatabase: tusk_demo\nenabled: true\n---\n## Money\nEvery monetary column is an integer number of **cents**. Divide by 100.0 and round to 2dp.\n\n## Revenue\nAn order counts only if `status = 'paid'` **and** it has no row in `shop.refunds`\n(partial refunds leave the status alone) **and** the customer is not soft-deleted.\nPrefer `analytics.v_orders_clean`, which already encodes all three.\n\n## Forbidden\nNever query `shop.legacy_orders_2019`. Its conventional column names look inviting\nand it is never part of a current report."
      },
      {
        "k": "list",
        "items": [
          "**Create / Edit / Delete** — the body is what the model reads; name and description are for the list.",
          "**Import…** any `.md` file; without frontmatter the whole file becomes the body.",
          "**Export** writes exactly the file above, so skills are diffable and can live in a repo.",
          "Skills reach the model before the schema, and a database skill sorts ahead of a workspace one. A skill cut for budget is named in the prompt."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Skills shape what the model writes, never what can run: the read-only guard and [[topic:safety|permission gates]] outrank them."
      },
      {
        "k": "p",
        "md": "The [[topic:slack|Slack bot]] reads the same skills, scoped to the same database, reloaded on every question."
      },
      {
        "k": "h",
        "text": "What the model sees",
        "id": "context"
      },
      {
        "k": "p",
        "md": "Every send rebuilds a token-budgeted system prompt from the live connection."
      },
      {
        "k": "list",
        "items": [
          "**Skills** in scope, first.",
          "**Dialect and version** — driver label, server version, and a quoting note.",
          "**Role** — user name, superuser flag, and whether privileges are enforced. A limited role gets an explicit prefer-reads instruction.",
          "**Active schema** — the tab's search-path schema.",
          "**Schema summary** — `schema.table(col type, …)` lines under a 12,000-character budget, relevance-ranked. Tables past the budget are still listed by name.",
          "**Foreign keys** — the real join graph, given as authoritative.",
          "**Editor SQL** — the buffer or selection, capped at 4,000 characters, plus the tab's last error. The **Explain** and **Fix error** actions use exactly this.",
          "**Sample rows** — see below."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "When the foreign keys could not be read, the prompt stays silent about them rather than claiming the schema has none."
      },
      {
        "k": "h",
        "text": "Sample data — real rows leave your machine",
        "id": "samples"
      },
      {
        "k": "list",
        "items": [
          "With sample sharing on, Tusk fetches 5 rows from up to 5 conversation-relevant tables.",
          "It is a read-only `SELECT … LIMIT 5` that never touches the streaming cursor, so a mid-stream question cannot truncate a [[topic:results|running result]].",
          "Rows format into a budgeted pipe-table, cached per table until schema reload."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Sample sharing is off by default, fails closed when its preference cannot be saved, and is re-checked immediately before the request."
      },
      {
        "k": "p",
        "md": "Tick **Share sample data with the model** in the panel's ⚙ drawer to opt in."
      },
      {
        "k": "h",
        "text": "Stop, Retry, and streams that die",
        "id": "stop-retry"
      },
      {
        "k": "list",
        "items": [
          "While a reply streams, **Send** becomes **⏹ Stop**. Stop, or [[kbd:Escape]], interrupts the stream at the provider and the partial reply stays.",
          "A transient failure before the first word is retried up to three times with backoff.",
          "A reply that dies mid-sentence is not replayed: Tusk restarts the turn once, then offers **↻ Retry**.",
          "A reply cut short by the token ceiling is flagged **✂️ Cut off at the token limit**.",
          "A provider error is shown as an error, never as a finished reply."
        ]
      },
      {
        "k": "h",
        "text": "Replies",
        "id": "replies"
      },
      {
        "k": "list",
        "items": [
          "Replies stream in and render as markdown with syntax-highlighted ```sql blocks.",
          "Each SQL or untagged block gets **Copy** and **▶ Open in editor**.",
          "**Open in editor** opens a new tab titled *AI query* with the active schema attached. It never overwrites the buffer and never runs."
        ]
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
            "does": "Show / hide the AI panel (unbound by default; set it in [[topic:shortcuts|Settings → Shortcuts]])"
          },
          {
            "action": "openSettings",
            "does": "Open Settings — the **AI** tab holds providers, keys and skills"
          },
          {
            "combo": "Escape",
            "does": "Stop the streaming reply"
          },
          {
            "combo": "Shift-Enter",
            "does": "Newline in the chat composer (plain Enter sends)"
          }
        ]
      }
    ],
    "icon": "sparkle"
  },
  {
    "blurb": "Ask your database questions from Slack; approve AI-proposed read-only SQL.",
    "id": "slack",
    "title": "Slack bot",
    "blocks": [
      {
        "k": "p",
        "md": "A desktop-hosted Socket Mode bot: one outbound WebSocket, no server, no public endpoint, and a Slack app of your own."
      },
      {
        "k": "p",
        "md": "The AI proposes SQL and nothing runs without an Approve click. Only single read-only SELECTs run, against the one connection the bot was bound to."
      },
      {
        "k": "h",
        "text": "Setup",
        "id": "setup"
      },
      {
        "k": "list",
        "items": [
          "**Create the app** from the manifest in `docs/slack-setup.md`, with Socket Mode and interactivity on.",
          "**Two tokens** — a Bot token (`xoxb-…`) and an App-level token (`xapp-…`) with `connections:write`.",
          "**Paste both under Slack app tokens in Settings → Slack.** They go to the OS keychain, never to disk and never echoed back.",
          "**Save tokens** stores them; **Test connection** validates both and names the workspace.",
          "**The status card** shows Bot off / Connecting… / Bot running with the last error, and an On/Off switch disabled until both tokens exist.",
          "**The rest is grouped** into *Who can ask*, *Answers*, and *AI*. Each saves on change.",
          "**AI provider and model** mirror from **Settings → AI** whenever the Slack pane saves; when that has since changed, the section offers **Update bot**."
        ]
      },
      {
        "k": "h",
        "text": "Ask, approve, run",
        "id": "flow"
      },
      {
        "k": "p",
        "md": "DM the bot, or @mention it in a channel it has joined. It snapshots schema and permissions, then posts a proposal card."
      },
      {
        "k": "demo",
        "id": "slack-approve",
        "caption": "A question becomes a SQL proposal; only the requester's Approve click runs it."
      },
      {
        "k": "list",
        "items": [
          "The card carries an explanation, the exact SQL, and **Approve / Reject**. A requested chart is advertised with 📊.",
          "Only the requester can Approve or Reject, and proposals expire after 5 minutes.",
          "Refine in the thread; the last 10 replies feed back to the AI as context.",
          "Approve flips the card to ⏳ Running…, then ✅ Complete or ❌ Failed, with the result in the same thread.",
          "Every approved run lands in Tusk's [[topic:history|query history]] marked `-- [Slack] asked by <user>`."
        ]
      },
      {
        "k": "h",
        "text": "It follows your skills",
        "id": "slack-skills"
      },
      {
        "k": "p",
        "md": "The bot reads the same [[topic:ai|skills]] as the desktop assistant: workspace skills always, database skills when they match. They reload on every question."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A skill changes the SQL the bot writes, never what it may run: the read-only gate is enforced at proposal and again at execution."
      },
      {
        "k": "h",
        "text": "Results: tables, files, local charts",
        "id": "results"
      },
      {
        "k": "list",
        "items": [
          "**Inline monospace table** — up to *Rows shown inline* (default 20), 5 columns, and whatever fits Slack's message block.",
          "**CSV attachment** for medium results; **XLSX** past 15 columns.",
          "**Auto-chart** — date and numeric results with 2–4 columns and 50 rows or fewer, rendered fully locally.",
          "**Explicit requests** honor the type, axes and labels named in the question.",
          "**Chart types** — line, grouped bar, scatter, pie, capped at 400 points and 12 slices.",
          "Every result carries **Export as… CSV / TSV / Excel / JSON / SQL / Markdown** for 15 minutes, requester-only, uploaded in-thread named after the queried table."
        ]
      },
      {
        "k": "h",
        "text": "What keeps it safe",
        "id": "safety"
      },
      {
        "k": "p",
        "md": "The model's SQL is never trusted — see [[topic:safety|Safety]]. The same gate runs when the proposal is created and again at execution."
      },
      {
        "k": "list",
        "items": [
          "**Single statement only.** Scripts are rejected.",
          "**Wrappable reads only** — `SELECT` / `WITH` / `TABLE` / `VALUES`. `EXPLAIN` and `SHOW` cannot be a subquery, so they are rejected.",
          "**Masked mutation scan** — mutation keywords are matched outside strings and comments, catching writable CTEs, smuggled DDL, and row locks.",
          "**Hard row cap** — the query is wrapped with a `LIMIT`, default 10,000, with a truncation note.",
          "**Engine-aware timeout**, default 30 s, using a server-side cancel on Postgres.",
          "**Fresh engine-enforced read-only connection**, plus a conservative allowlist of deterministic functions.",
          "**Never the UI's streaming cursor.** Slack queries run buffered."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A false positive, such as a column named `delete`, degrades to \"run it in the Tusk editor\" rather than loosening the scan."
      },
      {
        "k": "p",
        "md": "**When asked for writes/DDL** shapes only the reply: propose a read-only preview, or refuse and point to the editor. Neither gates anything."
      },
      {
        "k": "h",
        "text": "Access control & limits",
        "id": "settings"
      },
      {
        "k": "p",
        "md": "These settings save as you change them. The **Save** button stores newly typed tokens."
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
            "Channel IDs (`C…`/`D…`), comma-separated"
          ],
          [
            "Allowed users",
            "empty = all",
            "User IDs (`U…`), comma-separated"
          ],
          [
            "Max rows (inline table)",
            "20",
            "1–100; above this, or past 5 columns, results attach as files"
          ],
          [
            "Max rows (file / hard cap)",
            "10,000",
            "100–100,000; the `LIMIT` cap on every run"
          ],
          [
            "Query timeout (seconds)",
            "30",
            "1–600; expiry requests a server-side cancel"
          ],
          [
            "Auto-chart date/numeric results",
            "on",
            "Explicit chart requests are honored even when off"
          ],
          [
            "When asked for writes/DDL",
            "Propose read-only preview",
            "Reply shaping only"
          ],
          [
            "Share sample rows with AI",
            "off",
            "Real cell values leave the machine only after this opt-in"
          ],
          [
            "AI reply max tokens",
            "2,048",
            "256–128,000"
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
        "md": "Approving a proposal after its connection or database changed fails closed."
      },
      {
        "k": "list",
        "items": [
          "Every proposal is pinned to the exact connection, database, workspace, channel, thread, source message and requester that created it.",
          "The bot answers against one connection, chosen when it starts and changeable in **Settings ▸ Slack**. Switching tabs never redirects it.",
          "Autostart binds to a saved connection and names the one it is waiting for. An unsaved connection can be picked by hand but never autostarted.",
          "Disconnecting the bound connection stops the bot and says so in the statusbar; reopening it brings the bot back.",
          "SQL Server connections are refused, at the question and again at approval, for lack of a session read-only mode.",
          "Config edits reload per question. Replacing tokens restarts the running bot; restart failure stops and disables it.",
          "DuckDB and SQLite run synchronously, so the timeout cannot preempt a pathological embedded query.",
          "Tusk must be open and connected, and handles one Slack query at a time."
        ]
      }
    ],
    "icon": "comment"
  },
  {
    "blurb": "Per-connection run log — search it, re-run it, reopen with schema.",
    "id": "history",
    "title": "Query history",
    "blocks": [
      {
        "k": "p",
        "md": "The topbar clock icon toggles the right-side **Query history** panel, which logs every run per connection."
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "openHistory",
            "does": "Toggle the history panel (enabled while connected)"
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
        "md": "An entry is written when a user-issued run finishes. It stores the SQL, timestamp, duration, `ok` / `error` / `cancelled` status, row count, the first error line, and the active schema."
      },
      {
        "k": "list",
        "items": [
          "**Recorded** — anything launched from the editor: Run, run-selection, panel re-runs, and multi-statement scripts as one entry.",
          "**Recorded** — [[topic:grid-editing|grid Commit/Apply]] scripts, with transaction work carrying a leading id and event marker.",
          "**Recorded with a marker** — `-- [Slack] asked by <user>` for approved bot runs, `-- [Explorer]` for sidebar DDL, `-- [Export] <format> → <path>` for a full-query file export.",
          "**Not recorded** — grid sort/filter re-streams. Only the original base query is kept.",
          "For a streamed read the row count is the first fetched page — see [[topic:results|Results & streaming]]."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Re-running identical newest SQL refreshes the top entry in place rather than adding a duplicate."
      },
      {
        "k": "h",
        "text": "Where it lives",
        "id": "storage"
      },
      {
        "k": "list",
        "items": [
          "JSON per connection under `<app-config>/history/`, keyed by saved profile or by the ad-hoc destination.",
          "Saves are debounced 500 ms and capped at the newest 500 entries per connection."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "If the history file cannot be written, Tusk degrades to in-memory history for the session and the log is lost on exit."
      },
      {
        "k": "h",
        "text": "Reading the panel",
        "id": "reading"
      },
      {
        "k": "list",
        "items": [
          "Each row shows a status dot (green `ok`, red `error`, amber `cancelled`), the SQL's first line, the duration, and a relative timestamp.",
          "Click a row to expand the full statement, syntax-highlighted, with the first error line and row count when known.",
          "**Search** — filters the SQL live, case-insensitive.",
          "**Resize** — drag the splitter on the panel's left edge, 240–700 px."
        ]
      },
      {
        "k": "h",
        "text": "Acting on an entry",
        "id": "actions"
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
            "Inserts the SQL at the cursor in the active [[topic:editor|editor]] tab. Nothing runs."
          ],
          [
            "**Open in tab**",
            "Opens a new tab titled *History* with the SQL, active schema set to what the query ran under."
          ],
          [
            "**Re-run**",
            "Runs the SQL through the normal run path. Parameter prompts apply; a multi-statement entry re-runs as one script."
          ]
        ]
      },
      {
        "k": "h",
        "text": "Clearing history",
        "id": "clearing"
      },
      {
        "k": "list",
        "items": [
          "The trash icon clears the current connection's history only, behind a `Clear all?` confirm.",
          "Disconnecting closes the panel and clears the list; it reloads on the next connect."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "[[kbd:Mod-k]] opens the [[topic:shortcuts|command palette]], where *Toggle query history* is searchable."
      }
    ],
    "icon": "clock"
  },
  {
    "blurb": "One registry drives shortcuts, palette, and Settings — rebind once, everywhere.",
    "id": "shortcuts",
    "title": "Keyboard shortcuts & command palette",
    "blocks": [
      {
        "k": "p",
        "md": "Every action lives in one registry, read by the global key handler, the editor keymap, **Settings → Shortcuts**, and the [[kbd:Mod-k]] palette."
      },
      {
        "k": "p",
        "md": "Chords use CodeMirror syntax (`Mod-Shift-Enter`). **Mod** is Cmd on macOS, Ctrl elsewhere."
      },
      {
        "k": "h",
        "text": "Default bindings",
        "id": "defaults"
      },
      {
        "k": "p",
        "md": "The chips show the live binding. Some actions ship unbound and stay reachable from the palette and toolbars."
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
            "does": "Run the selection, or the statement under the cursor"
          },
          {
            "action": "explain",
            "does": "EXPLAIN the selection or current statement (plan view)"
          },
          {
            "action": "explainAnalyze",
            "does": "EXPLAIN ANALYZE — executes the statement"
          },
          {
            "action": "cancelQuery",
            "does": "Cancel the running query"
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
            "action": "openFilterBuilder",
            "does": "Open the filter builder for the current result"
          },
          {
            "action": "findInResults",
            "does": "Find text in the loaded rows"
          },
          {
            "action": "toggleRecordView",
            "does": "Show or hide the record view beside the grid"
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
            "action": "moveTabLeft",
            "does": "Move the active tab one slot left"
          },
          {
            "action": "moveTabRight",
            "does": "Move the active tab one slot right"
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
            "does": "Jump to Settings → Shortcuts"
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
            "does": "Collapse / restore the results panel"
          },
          {
            "action": "nextConnection",
            "does": "Focus the next open connection"
          },
          {
            "action": "prevConnection",
            "does": "Focus the previous open connection"
          },
          {
            "action": "newConnection",
            "does": "Open another connection over the workspace"
          }
        ]
      },
      {
        "k": "p",
        "md": "Every action carries an *enabled* predicate the dispatcher checks first. A chord bound to a disabled action is ignored."
      },
      {
        "k": "list",
        "items": [
          "**Explain** / **Explain Analyze** — blocked while a query runs. Explain Analyze also needs engine support; SQLite has no `EXPLAIN ANALYZE`.",
          "**Cancel running query** — only while a query runs.",
          "**Load all rows** / **Export result…** — need a result in the grid.",
          "**Cancel query** and **Open manual** fire even with a modal open or focus in the editor."
        ]
      },
      {
        "k": "h",
        "text": "Rebinding in Settings → Shortcuts",
        "id": "rebinding"
      },
      {
        "k": "p",
        "md": "Open **Settings → Shortcuts**, or run **Show keyboard shortcuts** from the palette. It is a searchable table grouped by Query, Editor, Tabs, File, and View."
      },
      {
        "k": "list",
        "items": [
          "**Rebind** — click the binding chip (*press keys…*), then press the new chord.",
          "[[kbd:Escape]] — cancel the capture.",
          "[[kbd:Backspace]] / [[kbd:Delete]] — unbind the action.",
          "Bare modifiers and unmodified printable keys are rejected.",
          "A chord another action owns shows *press again to replace*; a second press unbinds the other action.",
          "Overridden rows get **⟲ Reset to default**; **Reset all** clears every override. Only diffs persist in `tusk.keys`, with `null` meaning explicitly unbound."
        ]
      },
      {
        "k": "p",
        "md": "A read-only **Built-in (not rebindable)** section lists the CodeMirror internals: [[kbd:Mod-f]] find/replace, [[kbd:Mod-z]] undo/redo, [[kbd:Mod-Shift-[]] fold, [[kbd:Tab]] accept-completion / indent."
      },
      {
        "k": "h",
        "text": "Command palette",
        "id": "palette"
      },
      {
        "k": "p",
        "md": "[[kbd:Mod-k]] opens the palette. Matching is fuzzy over category and title, so `rcs` finds *Run selection or current statement*."
      },
      {
        "k": "p",
        "md": "Navigate with ↑/↓, [[kbd:Enter]] runs, [[kbd:Escape]] closes. Every row shows the action's live binding chip."
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Actions whose enabled-check fails are filtered out of the palette rather than greyed, so *Export result…* appears only after a query."
      },
      {
        "k": "h",
        "text": "Editor scope vs global scope",
        "id": "scopes"
      },
      {
        "k": "list",
        "items": [
          "Editor-scoped actions — Run, Format SQL, Toggle comment, Find & replace — are also bound inside CodeMirror and win while typing.",
          "Global actions (tabs, files, panels) dispatch at the window level regardless of focus, so [[kbd:Mod-w]] closes a Tusk tab, not the window.",
          "A binding without Mod or Alt (`F5`, bare `Enter`) never fires while focus is in an input, textarea, contenteditable, or the SQL editor.",
          "The global handler is inert while the palette is open and before connecting."
        ]
      },
      {
        "k": "h",
        "text": "Fixed keys: the result grid",
        "id": "grid-keys"
      },
      {
        "k": "p",
        "md": "The [[topic:results|result grid]] handles its own keyboard; these cannot be rebound. Editing keys need an [[topic:grid-editing|editable]] result."
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
            "does": "Copy the selection as TSV (headers gated by *Copy w/ column names*)"
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
            "does": "Toggle delete-marks; only when whole rows are selected"
          },
          {
            "combo": "Escape",
            "does": "Collapse the selection back to a single cell"
          }
        ]
      },
      {
        "k": "list",
        "items": [
          "In the inline cell editor: [[kbd:Enter]] commits and moves down, [[kbd:Tab]] commits and moves right, [[kbd:Escape]] cancels, [[kbd:Alt-n]] sets SQL `NULL`.",
          "Arrowing within 30 rows of the loaded end triggers the next streaming fetch."
        ]
      },
      {
        "k": "h",
        "text": "Fixed keys: inside the editor",
        "id": "editor-keys"
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Tab]] — accepts an open completion, else applies a [[topic:editor-intel|lint quick-fix]] under the cursor, else indents.",
          "[[kbd:Enter]] — accepts a completion when the popup is open, otherwise a newline.",
          "Quick-fixes also on [[kbd:Alt-Enter]] and [[kbd:Mod-.]].",
          "Statement gutter ▶ runs a statement by mouse; the keyboard equivalents are **Run** and **Run selection or current statement**. See [[topic:editor|the editor topic]]."
        ]
      }
    ],
    "icon": "bolt"
  },
  {
    "id": "workspace",
    "title": "Workspace, themes & settings",
    "blurb": "Panels, tab organisation, topbar, Settings dialog, 8 themes, density and scale, built-in updater.",
    "blocks": [
      {
        "k": "p",
        "md": "One window: a resizable **Explorer** sidebar, a tabbed editor over a results pane, and optional **AI** and **History** panels docked right. Preferences apply live."
      },
      {
        "k": "h",
        "text": "Panels and splits",
        "id": "panels"
      },
      {
        "k": "list",
        "items": [
          "**Explorer** — drag the sidebar/editor divider, 180–560 px.",
          "**Editor height** — the horizontal splitter between editor and results.",
          "**AI panel** ([[topic:ai|AI assistant]]) — 280–760 px.",
          "**History panel** ([[topic:history|query history]]) — 240–700 px.",
          "All four sizes persist under `tusk.layout` and are clamped to the window on load and resize."
        ]
      },
      {
        "k": "demo",
        "id": "panels",
        "caption": "Drag the dividers to resize the sidebar, the editor/results split, and the AI and History panels."
      },
      {
        "k": "list",
        "items": [
          "Editor tabs persist per connection: SQL buffer, file path, title, active schema, and which tab was active.",
          "Every open connection's tabs are saved, not only the focused one.",
          "Results are ephemeral — snapshots, cursors, and pending grid edits never persist. See [[topic:results|Results & streaming]]."
        ]
      },
      {
        "k": "p",
        "md": "Drag a tab to reorder the strip, or move the active tab with the chords below. The order persists with the tab set; a tab keeps its connection, its buffer, and any running query."
      },
      {
        "k": "p",
        "md": "**Rename** a tab by double-clicking its title, or right-click → *Rename…*. Enter keeps the name, Escape cancels, an empty box restores the automatic title (`Untitled N`, or the file basename). A custom title survives a Save as."
      },
      {
        "k": "p",
        "md": "**Pin** a tab to hold it in a fixed group at the left of the strip. A pinned tab shows its driver mascot and the first few characters of its name, has no ×, cannot be dragged past an unpinned tab, and is never closed by a close-many action. **Colour ›** tags a tab with one of six theme-aware swatches, drawn as a dot — distinct from the accent top rule that marks a transaction owner and the bottom rule that tints a tab by connection. Titles, pins and colours persist with the tab set."
      },
      {
        "k": "p",
        "md": "The rest of the tab context menu: **Close**, **Close others**, **Close tabs to the right**, **Close saved tabs** (every tab with no unsaved buffer), **Copy path** on a file tab, and **Show all tabs…**. With several connections open, the close-many items act only on the tabs of that tab's connection. Each one applies the same guards a single close does — an unsaved buffer, pending grid edits, a running query, or ownership of a manual transaction skips that tab — and the statusbar reports how many closed and how many were kept."
      },
      {
        "k": "p",
        "md": "**All tabs** ([[kbd:Mod-Shift-o]], or the **⌄** beside the strip) lists every open tab grouped by connection, with pin and unsaved markers and a filter box matching title, file path and connection name. ↑/↓ move, Enter switches, Escape closes. The strip scrolls and hides tabs; this list does not."
      },
      {
        "k": "keys",
        "rows": [
          { "action": "moveTabLeft", "does": "Move the active tab one slot left" },
          { "action": "moveTabRight", "does": "Move the active tab one slot right" },
          { "action": "renameTab", "does": "Rename the active tab" },
          { "action": "pinTab", "does": "Pin or unpin the active tab" },
          { "action": "showAllTabs", "does": "List every open tab, grouped by connection" }
        ]
      },
      {
        "k": "h",
        "text": "Several connections at once",
        "id": "connections"
      },
      {
        "k": "p",
        "md": "Up to **16** databases can be open at once. The topbar carries one chip per connection — mascot, database name, state dot, colour rail — and **+** adds one."
      },
      {
        "k": "p",
        "md": "Two connections reporting the same database name are named by where they connect (`db.internal/postgres`)."
      },
      {
        "k": "h",
        "text": "Environment tags",
        "id": "environment"
      },
      {
        "k": "p",
        "md": "A saved connection can be tagged **Development**, **Staging** or **Production** on the connect form. The tag is metadata: it never reaches the driver."
      },
      {
        "k": "list",
        "items": [
          "A tagged connection takes its environment's colour for the rail on its chip and its editor tabs.",
          "The badge repeats on the connection chip, the saved-connections list, the statusbar, and the title of every confirmation dialog.",
          "**Production** uses the red family. Untagged connections keep their cycled colour and show no badge."
        ]
      },
      {
        "k": "table",
        "head": [
          "State",
          "Dot",
          "Means"
        ],
        "rows": [
          [
            "idle",
            "filled",
            "nothing running, no manual transaction open"
          ],
          [
            "running",
            "pulsing",
            "a query, page fetch, or *Load all* is running"
          ],
          [
            "transaction",
            "hollow ring",
            "a manual transaction is open"
          ],
          [
            "failed",
            "warning",
            "the transaction failed; `ROLLBACK` is required"
          ],
          [
            "lost",
            "danger",
            "the session was lost; reconnect and verify the outcome"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "While a query runs the dot is a button: click it to cancel that connection's query, with a confirmation and without switching to it.",
          "**✕** disconnects one connection. A running query must be cancelled or finish, an open transaction resolved, and pending grid edits applied or discarded."
        ]
      },
      {
        "k": "p",
        "md": "Each connection carries its own result cursor, manual transaction, Explorer tree, autocomplete catalog, permissions, tabs, and **Cancel**."
      },
      {
        "k": "list",
        "items": [
          "[[topic:history|Query history]] is scoped to the destination, so the same profile opened twice shows one combined history.",
          "Tabs belong to a connection. Above one connection each tab shows its mascot and colour rail, and clicking a tab switches connection.",
          "New tabs open on the connection in focus, and closing a connection's last tab opens a fresh one on it.",
          "The same saved connection opened twice gives each session its own tabs."
        ]
      },
      {
        "k": "keys",
        "rows": [
          {
            "action": "nextConnection",
            "does": "Focus the next open connection"
          },
          {
            "action": "prevConnection",
            "does": "Focus the previous open connection"
          },
          {
            "action": "newConnection",
            "does": "Open the connect screen over the workspace"
          }
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "**Reopen last session** also appears in the **＋** panel."
      },
      {
        "k": "h",
        "text": "Topbar and statusbar",
        "id": "topbar"
      },
      {
        "k": "list",
        "items": [
          "**Brand mark** — driver mascot, matching the OS window title.",
          "**Connection chip** — database name, or file basename / `:memory:` for embedded drivers.",
          "Driver label and server version, plus a **🔒 Read-only** badge when the connection blocks writes.",
          "Right side: **✨ AI** toggle, history clock, **?** for this manual, Settings gear, **Disconnect**.",
          "The footer shows status text and cursor info: line/column, `Stmt 2/5`, selection character count.",
          "A **🟢/🟡 Slack** badge tracks the [[topic:slack|Slack bot]], turning **🔴** with the reason when it stops.",
          "**Copy w/ column names** lives in the result toolbar, on the same pref as Settings → Grid."
        ]
      },
      {
        "k": "h",
        "text": "The Settings dialog",
        "id": "settings"
      },
      {
        "k": "p",
        "md": "Open with the topbar gear or [[kbd:Mod-,]]. Eight tabs; every control applies immediately."
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
            "Word wrap, auto-fold large literals, server-side lint, SQL dialect (disabled while connected)."
          ],
          [
            "**Appearance**",
            "Theme, accent, density (Comfortable / Compact), UI scale (90–125 %), Explorer side, editor and grid font, editor font size and line height, Reset to defaults."
          ],
          [
            "**Grid**",
            "Row density (Normal / Compact, combined with the Appearance density: 28/22 px or 24/18 px), zebra striping, NULL display, default column width (48–900), copy with column names."
          ],
          [
            "**Plans**",
            "Tree orientation, heat coloring, node detail — see [[topic:plans|EXPLAIN plans]]."
          ],
          [
            "**AI**",
            "Provider cards, then Assistant settings and Skills. See [[topic:ai|AI assistant]]."
          ],
          [
            "**Slack**",
            "Status card, tokens, who can ask, answers, and mirrored AI settings — see [[topic:slack|Slack bot]]."
          ],
          [
            "**Shortcuts**",
            "Rebind every registered action, with conflict detection — see [[topic:shortcuts|Shortcuts & palette]]."
          ],
          [
            "**Privacy**",
            "Crash-report consent. Nothing is transmitted automatically."
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Preferences store flat in `tusk.prefs` and are shallow-merged over defaults, so new prefs arrive with defaults."
      },
      {
        "k": "h",
        "text": "Themes, accent, and fonts",
        "id": "themes"
      },
      {
        "k": "list",
        "items": [
          "Dark: **One Dark** (default), **Catppuccin Mocha**, **Dracula**, **Tokyo Night**.",
          "Light: **One Light**, **Solarized Light**, **GitHub Light**, **Gruvbox Light**. Plus **Follow system**.",
          "**Accent color** tints buttons, selection, and focus states app-wide.",
          "**Editor / grid font** sets the monospace face in editor and grid."
        ]
      },
      {
        "k": "p",
        "md": "**Density** and **UI scale** are separate axes. Density switches the row, tab, tree and control height token set (Comfortable is the shipped size); UI scale multiplies the root font size from 90 % to 125 %, and does not touch the editor's own font size. **Explorer side** docks the sidebar left or right; panel widths are unchanged by the swap. **Reset to defaults** at the foot of the pane restores theme, accent, fonts, density, scale and Explorer side."
      },
      {
        "k": "h",
        "text": "Updates",
        "id": "updates"
      },
      {
        "k": "list",
        "items": [
          "Checks GitHub releases ~3 seconds after launch, then every 5 minutes, and on window focus if an interval was missed.",
          "An **⬆ Update x.y.z** pill appears bottom-right on both screens.",
          "Click it for release notes and **Install & restart**: the signed artifact downloads, installs, relaunches.",
          "Failed checks — offline, dev build, no published release — are silent.",
          "The **What's new** panel covers an update that already installed, popping on the first launch of a new version.",
          "*What's new in this version* in the [[topic:shortcuts|command palette]] reopens it."
        ]
      },
      {
        "k": "h",
        "text": "Keyboard access",
        "id": "keys"
      },
      {
        "k": "p",
        "md": "Rebind any of these in Settings → Shortcuts ([[topic:shortcuts|Shortcuts & palette]])."
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
            "does": "Collapse or restore the Explorer sidebar"
          },
          {
            "action": "toggleResults",
            "does": "Collapse or restore the results panel; running a query reopens it"
          },
          {
            "action": "nextConnection",
            "does": "Next open connection"
          },
          {
            "action": "prevConnection",
            "does": "Previous open connection"
          },
          {
            "action": "newConnection",
            "does": "Open another connection"
          }
        ]
      }
    ],
    "icon": "columns"
  },
  {
    "blurb": "Read-only layers, permission gating, real query cancellation, secret storage.",
    "id": "safety",
    "title": "Read-only, permissions & cancellation",
    "blocks": [
      {
        "k": "p",
        "md": "Read-only is enforced at independent application and engine layers, and the sidebar offers only actions the role can perform."
      },
      {
        "k": "h",
        "text": "Read-only connections: three layers",
        "id": "read-only"
      },
      {
        "k": "p",
        "md": "**Read-only (block writes & DDL)** on the connect form engages three guards."
      },
      {
        "k": "list",
        "ordered": true,
        "items": [
          "**Engine-level** — a read-only session or open mode on Postgres, file-backed DuckDB, SQLite and MySQL. SQL Server has none, so the client guard is the whole enforcement.",
          "**Statement classification** — read forms and non-writable transaction control pass. Writes, writable transaction modes, DDL and `COPY` reject before execution.",
          "**UI gating** — mutating sidebar items disable, [[topic:grid-editing|in-grid editing]] refuses to start, and imports are blocked in the backend."
        ]
      },
      {
        "k": "h",
        "text": "Destructive confirmations",
        "id": "confirmations"
      },
      {
        "k": "list",
        "items": [
          "Drop and Truncate name the object, its kind, and its row estimate and size when the Explorer knows them.",
          "Dropping a table, schema or database needs its name typed into the dialog first.",
          "`CASCADE` is stated as what it widens; leave it off to fail on a dependency instead.",
          "The red button is the only destructive control in the footer, and the destructive group sits last in every context menu.",
          "A connection tagged **Production** shows its badge in the title of every confirmation."
        ]
      },
      {
        "k": "h",
        "text": "Permission-aware UI on Postgres",
        "id": "permissions"
      },
      {
        "k": "p",
        "md": "On connect and every schema reload, Tusk computes the role's effective privileges, including role membership, `PUBLIC` grants, and ownership."
      },
      {
        "k": "list",
        "items": [
          "Role attributes — superuser, `CREATEDB`, `CREATEROLE`.",
          "`CREATE` on the current database, and per-schema `CREATE`/`USAGE` and ownership.",
          "Per-relation `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` and ownership.",
          "The [[topic:sidebar|sidebar]] disables what the role cannot do, with the reason in the tooltip.",
          "Grid editing refuses up front when the role lacks write privileges, rather than failing at commit."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "DuckDB, SQLite, MySQL and SQL Server have no comparable permission catalog, so Tusk adds no UI restrictions there."
      },
      {
        "k": "h",
        "text": "The server lint never executes",
        "id": "server-lint"
      },
      {
        "k": "list",
        "items": [
          "As-you-type validation ([[topic:editor-intel|editor intelligence]]) only `PREPARE`s the statement, then deallocates it, in autocommit.",
          "It skips DDL, `COPY`, and `$1`/`:name`-param statements.",
          "It pauses while a query runs or a streaming cursor is open."
        ]
      },
      {
        "k": "h",
        "text": "Cancelling work",
        "id": "cancellation"
      },
      {
        "k": "list",
        "items": [
          "While a query runs, the Run button becomes **✕ Cancel** with an elapsed counter.",
          "Postgres gets a real `CancelRequest`; DuckDB fires its interrupt handle, except on Windows.",
          "SQLite, MySQL and SQL Server have no out-of-band cancel, so the button shows a disabled **Running** timer instead.",
          "A cancel the backend rejects resets the button with the reason.",
          "Cancelling inside a PostgreSQL manual transaction leaves it in **Recovery required** until `ROLLBACK` or `ROLLBACK TO`.",
          "`Mod-F2` is the shipped shortcut, since Ctrl+Esc is reserved by Windows."
        ]
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
        "k": "list",
        "items": [
          "Streaming [[topic:import-export|exports and imports]] cancel the same way: a partial export file is deleted, and an import rolls back wholesale."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Cancel cannot abort the in-memory formatting of already-loaded rows."
      },
      {
        "k": "h",
        "text": "Dropped idle connections reopen",
        "id": "resilience"
      },
      {
        "k": "list",
        "items": [
          "Query duration is never capped; there is no client-side timeout.",
          "Every idle command checks liveness and reconnects transparently. An owned manual transaction is never reconnected; it becomes Lost.",
          "A query is never replayed automatically after it may have reached the server. Tusk reports the outcome as unknown and asks you to verify state."
        ]
      },
      {
        "k": "h",
        "text": "Secrets and what leaves your machine",
        "id": "secrets"
      },
      {
        "k": "list",
        "items": [
          "Every credential lives in the OS keychain, never in a config file and never sent to the frontend: database passwords, [[topic:ai|AI keys]], [[topic:slack|Slack tokens]].",
          "AI keys are bound to the approved HTTPS origin, so a changed API base cannot receive them.",
          "Profile metadata — host, port, user — is plain JSON without the password.",
          "Nothing leaves the machine by default. The AI assistant sends a token-budgeted context, with sample rows behind their own toggle.",
          "The Slack bot posts approved query results to the workspace. Charts render locally, and mutations cannot run from Slack."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "Unsigned macOS dev builds tie keychain items to the code signature, so saved passwords may re-prompt across rebuilds."
      }
    ],
    "icon": "lock"
  },
  {
    "blurb": "Recent release notes, newest first, plus how updates install themselves.",
    "id": "whats-new",
    "title": "What's new",
    "blocks": [
      {
        "k": "p",
        "md": "An **⬆ Update vX.Y.Z** pill appears bottom-right on both screens when a newer release is published."
      },
      {
        "k": "list",
        "items": [
          "**Check cadence** — ~3 seconds after launch, then every 5 minutes, plus once on window focus after a missed interval.",
          "**Install** — click the pill for release notes; **Install & restart** downloads the signed bundle and relaunches.",
          "**Failed checks stay silent** — offline, dev build, or no published release.",
          "The **What's new** panel pops on the first launch of a new version, listing every release since the last installed. It works offline."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The updater shipped in v0.4.5, so an earlier install needs a fresh installer once."
      },
      {
        "k": "h",
        "text": "v0.10.0 — several databases at once, backups, SSH, SQL Server",
        "id": "v0-10-0"
      },
      {
        "k": "list",
        "items": [
          "**Visible keyboard focus** on every control, in every theme.",
          "**A running query dims and labels the previous result**, disables the toolbar acting on it, and shows a live timer.",
          "**Drop and Truncate state what goes** — kind, name, rows, size — and a table, schema or database needs its name typed.",
          "**Environment tags** mark a saved connection Development, Staging or Production on its chip, tabs, statusbar and confirmations.",
          "**Long Explorer menus group into submenus** — Generate, Copy, Data — with the destructive actions last. See [[topic:sidebar|Schema explorer]].",
          "**Plan heat is a node's share of the plan total**, on a slate-to-amber ramp, and the status bar reads the plan. See [[topic:plans|EXPLAIN plans]].",
          "**The parameter prompt lays out two columns**, and Run waits until every parameter has a value, NULL, or raw.",
          "**Connect on startup opens once per launch**, never again on an error recovery or a window reload."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Open several databases at once** — up to 16, one topbar chip each. [[kbd:Mod-Alt-ArrowRight]] / [[kbd:Mod-Alt-ArrowLeft]] switch, [[kbd:Mod-Shift-n]] adds. See [[topic:workspace|Workspace]].",
          "**Reopen last session** — the connect screen offers the connections open at last quit.",
          "**Backup and restore, built in** — plain-SQL dumps and replays through the connected driver on all five engines. See [[topic:backup|Backup & restore]].",
          "**Import is a guided File → Columns → Run flow** on four engines, and the Explorer gains **Export table…** / **Export tables…**. See [[topic:import-export|Import & export]].",
          "**Build result filters visually** — a **Filter** button ([[kbd:Mod-Shift-f]]) opens a tree of AND/OR groups with 21 operators. See [[topic:results|Results grid]].",
          "**Reach a database through an SSH tunnel** on PostgreSQL, MySQL and SQL Server, with host-key verification. See [[topic:getting-started|Connections & drivers]].",
          "**Microsoft SQL Server is a connectable driver**: `OFFSET`/`FETCH` paging, a full Explorer tree, Copy DDL from `sys.*`, and T-SQL lexing.",
          "**Not yet on SQL Server** — file import, Explorer DDL builders, the Slack bot, and Explain.",
          "**Table editing on every engine that can express it**, with a searchable FK picker and a SQLite table rebuild. See [[topic:sidebar|Schema explorer & DDL]].",
          "**Safer defaults** — deleting a saved connection asks first, and Slack autostart binds to one saved connection."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.8 — selected SQL stays selected",
        "id": "v0-9-8"
      },
      {
        "k": "list",
        "items": [
          "**[[kbd:Mod-Shift-Enter]] honors the exact selection**, so an inner `SELECT` inside `WITH … UPDATE` no longer runs the update.",
          "**Explain and grid reruns fail closed on ambiguous SQL**, and `SELECT … INTO` counts as a write."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.7 — WITH-led writes run as writes",
        "id": "v0-9-7"
      },
      {
        "k": "list",
        "items": [
          "**`WITH … UPDATE` / `INSERT` / `DELETE` / `MERGE` execute correctly**, classified by the statement the CTEs feed.",
          "**Explain Analyze on a `WITH … UPDATE` asks first** — see [[topic:plans|EXPLAIN plans]]."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.6 — one model list per provider; Slack settings reorganized",
        "id": "v0-9-6"
      },
      {
        "k": "list",
        "items": [
          "**Settings → AI has one live model list per provider**: a checkbox offers a model, **★** marks the default. See [[topic:ai|AI assistant]].",
          "**Settings → Slack is reorganized** into a status card, tokens, Who can ask, Answers, and AI. See [[topic:slack|Slack bot]].",
          "**Panning the ERD, the plan canvas, or the Schema Explorer no longer selects text.**"
        ]
      },
      {
        "k": "h",
        "text": "v0.9.5 — incomplete results say so; numeric sort sorts numbers",
        "id": "v0-9-5"
      },
      {
        "k": "list",
        "items": [
          "**Incomplete results are marked** with a badge and a status naming what closed the stream.",
          "Table info for in-grid editing is fetched before a query runs, which used to truncate every editable result.",
          "**Numeric columns sort by value** in a fully loaded result, and a sort click that can't apply says why. See [[topic:results|Results]]."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.4 — invisible paste artifacts get squiggles",
        "id": "v0-9-4"
      },
      {
        "k": "list",
        "items": [
          "Non-breaking spaces, zero-width characters and curly quotes get squiggled with their code point, and one quick-fix ([[kbd:Tab]] / [[kbd:Alt-Enter]]) cleans the document."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.3 — Slack settings save as you change them",
        "id": "v0-9-3"
      },
      {
        "k": "list",
        "items": [
          "Non-token [[topic:slack|Slack]] settings save on change. The Save button remains for tokens."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.2 — the manual caught up",
        "id": "v0-9-2"
      },
      {
        "k": "list",
        "items": [
          "The **What's-new panel** appears on the first update that ships it, even for pre-0.9.1 installs."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.1 — what's new after an update, honest cancel, engine-aware lexing",
        "id": "v0-9-1"
      },
      {
        "k": "list",
        "items": [
          "Post-update **What's new** panel, offline and reopenable from the command palette.",
          "**AI reply max tokens** on the desktop, 256–128,000.",
          "Cancel is honest per engine, with a **Running** timer where cancel is impossible; default [[kbd:Mod-F2]].",
          "Engine-aware editor lexing for MySQL, SQLite and T-SQL, and grid **Copy as X** byte-identical to Export."
        ]
      },
      {
        "k": "h",
        "text": "v0.9.0 — enterprise manual transactions, AI destination consent, bounded everything",
        "id": "v0-9-0"
      },
      {
        "k": "list",
        "items": [
          "Manual transactions own one session across runs — see [[topic:editor|the editor topic]].",
          "**AI destination consent**: keys are origin-bound in the keychain and unapproved bases fail closed.",
          "Stricter read-only, no automatic replay after a dropped connection, explicit budgets everywhere, and atomic file exports."
        ]
      },
      {
        "k": "h",
        "text": "v0.8.3 — AI providers, skills, and a lot of honesty about failure",
        "id": "v0-8-3"
      },
      {
        "k": "list",
        "items": [
          "**Ten AI providers, one key each**, with a real **Test connection** and a searchable model picker.",
          "**Skills** — Markdown instructions scoped to the workspace or one database, followed by the [[topic:slack|Slack bot]] too. See [[topic:ai|Skills]].",
          "**Stop and Retry** — ⏹ Stop or [[kbd:Escape]] interrupts the stream. Mid-stream provider errors no longer look like a finished reply."
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
          "**This manual** — topbar `?` or [[kbd:F1]], with full-text search and live shortcut chips.",
          "**Collapsible panels** — the Explorer ([[kbd:Mod-b]]) and the results panel ([[kbd:Mod-j]]).",
          "**Connect screen refresh** — mascot tiles, paired form rows, profile badges."
        ]
      },
      {
        "k": "h",
        "text": "v0.7.0 — ask your database questions from Slack",
        "id": "v0-7-0"
      },
      {
        "k": "p",
        "md": "A Slack bot hosted inside the desktop app over Socket Mode. See [[topic:slack|Slack integration]]."
      },
      {
        "k": "list",
        "items": [
          "DM or `@mention` it; the AI proposes SQL with requester-only **Approve / Reject**, read-only by construction. See [[topic:safety|Safety]].",
          "Results reply as a table, an attachment, or a locally rendered chart, and every run lands in [[topic:history|query history]]."
        ]
      },
      {
        "k": "h",
        "text": "v0.6.x — DuckDB polish",
        "id": "v0-6-x"
      },
      {
        "k": "list",
        "items": [
          "**0.6.2** — DuckDB date, time, decimal and nested values render readably.",
          "**0.6.1** — DuckDB `EXPLAIN` [[topic:plans|plan trees]] show rows, timing and heat coloring.",
          "**0.6.0** — [[topic:sidebar|Sidebar]] DDL editing on DuckDB, and update checks every 5 minutes."
        ]
      },
      {
        "k": "h",
        "text": "v0.5.x — DuckDB stability and a livelier updater",
        "id": "v0-5-x"
      },
      {
        "k": "list",
        "items": [
          "**0.5.1** — DuckDB pinned to 1.4.x, and a file-backed database releases its OS lock while idle.",
          "**0.5.0** — the updater re-checks periodically, and the object tree builds faster."
        ]
      },
      {
        "k": "h",
        "text": "v0.4.x — editable grids, parameters, and a correctness sweep",
        "id": "v0-4-x"
      },
      {
        "k": "list",
        "items": [
          "**[[topic:grid-editing|In-grid data editing]]** — staged edits, a **Commit…** preview, clipboard paste and boolean pills.",
          "**Parameter prompts** for `$1` and `:name`, and FK-aware JOIN completion in the [[topic:editor-intel|editor]].",
          "**Manual transactions**, app-owned multi-statement wrappers, and streaming [[topic:import-export|export]] on every driver.",
          "**AI upgrades** — live model catalogs and opt-in [[topic:ai|sample rows]].",
          "**Appearance** — six new themes and resizable docked panels ([[topic:workspace|Workspace]]).",
          "**Sidebar QoL** — row estimates and sizes on Postgres, and trigger listings."
        ]
      },
      {
        "k": "h",
        "text": "v0.3.0 — plans, ERD, history, palette",
        "id": "v0-3-0"
      },
      {
        "k": "list",
        "items": [
          "**[[topic:plans|EXPLAIN plan visualization]]** — a pan/zoomable heat-colored tree with per-engine parsers.",
          "**[[topic:erd|DDL & relationships viewer]]** — a neighborhood FK graph and a whole-schema ERD.",
          "**[[topic:history|Query history]]** — every user-issued run, searchable and re-runnable.",
          "**Command palette** ([[kbd:Mod-k]]) and **[[topic:shortcuts|rebindable shortcuts]]**, plus the Settings dialog, light theme and schema lint."
        ]
      },
      {
        "k": "h",
        "text": "Older releases",
        "id": "older"
      },
      {
        "k": "p",
        "md": "Earlier releases are documented in `CHANGELOG.md` at the repository root."
      }
    ],
    "icon": "star"
  }
];
