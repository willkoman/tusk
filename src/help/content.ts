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
        "md": "Tusk opens on the **connect screen**: saved connections left, connection form right. The driver mascot marks the card, topbar, and OS window title (🐘 PostgreSQL, 🦆 DuckDB, 🪶 SQLite, 🐬 MySQL, 🧱 SQL Server)."
      },
      {
        "k": "p",
        "md": "Up to **16 connections** open at once. **＋** at the end of the topbar connection strip, or [[kbd:Mod-Shift-n]], opens the connect screen as a panel — see [[topic:workspace|Workspace]]."
      },
      {
        "k": "list",
        "items": [
          "**Reopen last session** — relists the profiles open at last quit, in their order. One click; never automatic.",
          "Ad-hoc connections typed without saving are not listed.",
          "A *Connect on startup* profile still connects on launch."
        ]
      },
      {
        "k": "h",
        "text": "Saved profiles",
        "id": "profiles"
      },
      {
        "k": "p",
        "md": "Each profile shows mascot, name, and target — `user@host:port/dbname`, or the file path / `:memory:` for embedded drivers. A lock icon marks a stored password."
      },
      {
        "k": "list",
        "items": [
          "**Click** — connects when embedded or the password is saved; otherwise loads the form for the password.",
          "**Right-click** — Connect, Edit, Duplicate, Set as default / Unset default, Copy connection string, Delete….",
          "**Delete…** — confirms, then removes the profile and its keychain password. The database is untouched.",
          "**Set as default** — connects on launch. Exactly one profile holds the flag; setting it clears the others.",
          "**Try to continue** after a connect error offers the profile in the reopen list instead of connecting it."
        ]
      },
      {
        "k": "p",
        "md": "*Copy connection string* yields `postgresql://user@host:port/db` (or `mysql://…`), with `?sslmode=` appended when it differs from the default `prefer`. The password is excluded; embedded drivers copy the file path."
      },
      {
        "k": "h",
        "text": "Drivers and form fields",
        "id": "drivers"
      },
      {
        "k": "p",
        "md": "The **Driver** select switches the form fields."
      },
      {
        "k": "list",
        "items": [
          "**PostgreSQL / MySQL / SQL Server** — Host, Port, User, Password, Database, SSL Mode, and an optional **SSH tunnel** section.",
          "Switching driver moves the default port (5432 / 3306 / 1433). *Database* is optional away from PostgreSQL.",
          "SQL Server takes a SQL login; Windows integrated authentication isn't supported yet.",
          "**DuckDB / SQLite** — one **Database file** field with *Browse…*; blank means an in-memory database. No password or SSL, so *Save password* disappears."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A file-backed **DuckDB** database holds an exclusive OS file lock; Tusk drops the connection when idle and reopens it on the next query, while `:memory:` stays open."
      },
      {
        "k": "h",
        "text": "Passwords and SSL",
        "id": "passwords-ssl"
      },
      {
        "k": "list",
        "items": [
          "**Save password** stores it in the **OS keychain** (macOS Keychain, Windows Credential Manager, Secret Service on Linux), keyed by profile id.",
          "`connections.json` holds metadata only. The password is read server-side at connect time and never reaches the frontend.",
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
            "Encrypts without verifying the certificate or hostname. Self-signed certs work."
          ],
          [
            "`verify-full`",
            "Encrypts and verifies the certificate chain and hostname (libpq semantics)."
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
        "md": "**Host** and **Port** at the top of the form are the database as the SSH server sees it — usually `localhost` and `5432`/`3306`."
      },
      {
        "k": "list",
        "items": [
          "**Password** — the SSH login password.",
          "**Private key** — an OpenSSH or PEM key file via *Browse…*. Leave the passphrase blank for an unencrypted key.",
          "**SSH agent** — `$SSH_AUTH_SOCK` on macOS and Linux, the OpenSSH agent pipe on Windows. Nothing is stored."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Save … in the OS keychain** puts the SSH password or passphrase in its own entry, read server-side at connect time.",
          "Changing the SSH host, port, user, auth method, or key file requires entering the secret again.",
          "A tunnelled connection is marked **SSH** in the topbar and the Connections list.",
          "If the link drops, the next command re-establishes the tunnel before reconnecting."
        ]
      },
      {
        "k": "h",
        "text": "Host key verification",
        "id": "ssh-host-keys"
      },
      {
        "k": "p",
        "md": "Tusk checks the server's host key against `~/.ssh/known_hosts` and its own trust store in the app config directory. `known_hosts` is only read, never written."
      },
      {
        "k": "list",
        "items": [
          "Understood entries: plain, `[host]:port`, comma-lists, `*`/`?` wildcards, `!` negations, hashed (`ssh-keygen -H`) names.",
          "`@revoked` is honoured. `@cert-authority` lines are parsed then skipped, so a CA-covered bastion prompts as an unknown host."
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
            "Dialog shows key type and `SHA256:…` fingerprint; **Trust and connect** records it and retries. `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints the same value."
          ],
          [
            "Key changed",
            "Refused, with no accept button. Remove the old entry from `known_hosts` or `ssh_known_hosts.json`."
          ],
          [
            "Key revoked",
            "Refused and never offered for trust. Tusk's own trust store is checked first, and `known_hosts` is read in file order, so a plain entry above the `@revoked` line wins."
          ],
          [
            "Records unreadable",
            "Refused with the reason, including an entry for this host that cannot be parsed."
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "`verify-full` works through a tunnel: TLS runs end to end, so the certificate is checked against the **Host** entered, not the loopback address."
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
          "Engine enforcement: `SET default_transaction_read_only = on` (Postgres), `AccessMode::ReadOnly` (file-backed DuckDB), `SQLITE_OPEN_READ_ONLY` (SQLite), `SET SESSION TRANSACTION READ ONLY` (MySQL). SQL Server has no session equivalent.",
          "A uniform engine-aware client guard rejects writes and DDL before they are sent.",
          "Mutating sidebar items are disabled with a *Connection is read-only* tooltip.",
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
          "On Postgres the sidebar fetches the role's **effective privileges** and disables actions it cannot perform, with the reason in the tooltip.",
          "Other drivers report `enforced: false`; the server remains the authority.",
          "SQLite has no `EXPLAIN ANALYZE`, so that item carries a *Not supported by this engine* tooltip — see [[topic:plans|Plan visualization]] and [[topic:import-export|Import & export]]."
        ]
      },
      {
        "k": "h",
        "text": "Dropped idle connections heal themselves",
        "id": "resilience"
      },
      {
        "k": "list",
        "items": [
          "Query duration is never capped. A 10-second connect timeout plus TCP keepalives (5s idle, 2s interval, 3 retries, 15s user-timeout) surface a dead Postgres link in 10–15 seconds.",
          "An idle connection reopens before the next explicit action. A statement the server may have seen is never replayed.",
          "A dropped manual transaction is marked lost, not reconstructed. Reconnect and verify its outcome."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "A re-open drops any open streaming cursor: scrolling shows a *connection dropped mid-stream* error over the rows already loaded, and the query must be re-run."
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
          "**Close** — **×**, [[kbd:Mod-w]], or middle-click. A dirty tab (● dot) prompts **Save** / **Don't save** / **Cancel**; the transaction owner prompts **Resolve transaction first**.",
          "**Right-click** — Rename…, Close, Close others, Close tabs to the right. Bulk-close skips dirty tabs and reports how many were kept.",
          "**Reorder** — drag tabs. A vertical scroll wheel pans an overflowing strip.",
          "Closing the last tab leaves a fresh empty one."
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
          "**Open** ([[kbd:Mod-o]]) filters to `.sql`/`.txt`; **Save** ([[kbd:Mod-s]]) and **Save As** ([[kbd:Mod-Shift-s]]) use `.sql`. All three use native dialogs.",
          "Opening an already-open file switches to its tab. A saved tab takes the file's basename as its title; hover for the full path.",
          "In a narrow pane, Open/Save/Save As/Format/Find/Explain collapse into a **⋯** menu, and the font-size and wrap icons hide at the narrowest widths."
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
          "In flight the button becomes **✕ Cancel** with an elapsed counter. Where cancellation is impossible — SQLite, MySQL, SQL Server, DuckDB on Windows — it shows a disabled **Running 0:12** timer.",
          "PostgreSQL uses a server-side `CancelRequest`. A rejected cancel resets the button and reports why.",
          "Each statement gets a **▶ gutter marker**; click it to run that statement, and the marker becomes a spinner pinned to it.",
          "With several statements the one under the cursor is highlighted and the status bar shows *Stmt N/M*."
        ]
      },
      {
        "k": "p",
        "md": "Statement splitting is engine-aware and matches execution. Run selection, auto-fold, linting, parameter detection, and grid sort/filter all read the same lexer."
      },
      {
        "k": "list",
        "items": [
          "**MySQL** — `#` comments, `--` without trailing whitespace, backslash escapes inside quotes. Backtick identifiers are first-class on MySQL and SQLite.",
          "**SQL Server** — `[bracketed identifiers]` with `]]` escapes, `N'literals'`, and nested `/* … /* … */ … */` comments hold semicolons inertly.",
          "A line-only `GO` ends the batch without being sent to the server, with or without a trailing comment. `GO 5` is refused.",
          "A `;` inside `BEGIN … END`, `BEGIN TRY`/`BEGIN CATCH`, or `CASE … END` belongs to the statement, so a `CREATE PROCEDURE` body runs whole. `BEGIN TRAN[SACTION]` still opens a transaction."
        ]
      },
      {
        "k": "list",
        "items": [
          "With the cursor in a multi-statement buffer and nothing selected, a **Run…** popover asks **Current block** or **Entire file**: ↑↓ to choose, Enter to run, Esc to cancel.",
          "[[kbd:Mod-Shift-Enter]] skips the prompt and runs the exact non-blank selection, or the statement under the cursor.",
          "Every base run — success, error, or cancel — lands in [[topic:history|query history]] with its duration, and its row count on success."
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
          "An ordinary idle multi-statement run with no transaction control uses one app-owned transaction. A failure rolls back prior DML and names the failing statement.",
          "A trailing read stays inside that wrapper, so the result is a summary rather than a stream.",
          "MySQL DDL and nontransactional tables keep their engine-level rollback limits.",
          "Pasted `pg_dump` output works: `COPY … FROM stdin` blocks terminated by `\\.` are fed through `COPY`, even behind a leading `--` comment block."
        ]
      },
      {
        "k": "h",
        "text": "Manual transaction control",
        "id": "manual-transactions"
      },
      {
        "k": "p",
        "md": "Raw `BEGIN` / `START TRANSACTION`, `COMMIT` / `END`, and `ROLLBACK` / `ABORT` run directly. Transaction-control scripts are lifecycle-preflighted and run statement by statement on one owner session, self-contained or across separate runs."
      },
      {
        "k": "list",
        "items": [
          "Savepoint, rollback-to, and release work on PostgreSQL, SQLite, and MySQL.",
          "`SET TRANSACTION`: PostgreSQL while active and before work; MySQL before `START TRANSACTION`. DuckDB has neither savepoints nor `SET TRANSACTION`; SQLite has no `SET TRANSACTION`.",
          "SQL Server uses `BEGIN TRANSACTION`/`BEGIN TRAN`, `SAVE TRANSACTION name`, and `ROLLBACK TRANSACTION name`, while a bare `BEGIN`/`END` stays a statement block. It has no `RELEASE SAVEPOINT`, and `SET TRANSACTION ISOLATION LEVEL` / `SET IMPLICIT_TRANSACTIONS` are refused as session-wide."
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
          "MySQL `SET autocommit=0` keeps one physical connection pinned.",
          "**Commit unit** / **Rollback unit** ends only the current unit. **Commit & enable autocommit** runs `SET autocommit=1`, commits, and releases the owner session.",
          "Recognized implicit-commit DDL is blocked inside a tracked MySQL transaction. DDL outside it still auto-commits, and nontransactional tables cannot be rolled back."
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
          "A dropped or unexpectedly ended owner session becomes **Lost**. It is not reconnected or replayed: disconnect, reconnect, verify the outcome.",
          "Closing the owner tab, disconnecting, or closing Tusk requires resolving a healthy unit. Pending grid changes must be applied or discarded first.",
          "Results and pending edits carry transaction id and revision. Pre-`BEGIN` rows must be rerun before editing.",
          "Commit, rollback, rollback-to, autocommit-unit boundaries, and loss leave affected rows visible but stale until rerun.",
          "Query history records scoped transaction-control and grid-Apply markers."
        ]
      },
      {
        "k": "h",
        "text": "Parameters",
        "id": "parameters"
      },
      {
        "k": "p",
        "md": "`$1` positional or `:name` named placeholders open a **Query parameters** dialog before the run, with a live preview of the substituted SQL. Values are remembered per tab."
      },
      {
        "k": "list",
        "items": [
          "**NULL** checkbox — sends SQL `NULL`.",
          "**raw** checkbox — inserts the text verbatim, for numbers and expressions. Unchecked values become quoted literals.",
          "Detection is lexer-masked: placeholders inside strings, comments, and dollar-quoted bodies are ignored, and `::type` casts never match."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "Array slices with identifier bounds — `arr[i:j]` — detect `:j` as a parameter; use the **raw** toggle and enter `:j` verbatim."
      },
      {
        "k": "h",
        "text": "Active schema",
        "id": "active-schema"
      },
      {
        "k": "list",
        "items": [
          "The toolbar schema selector, default *(default schema)*, sets the tab's active schema. It hides on engines without a search path.",
          "`SET search_path TO <schema>, public` runs before every execution, server-side validation, and scope-all export from that tab.",
          "Autocomplete offers its tables unqualified, and the schema linter resolves bare names through the same active-schema-then-`public` resolver."
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
          "**Format** ([[kbd:Shift-Alt-f]] or the toolbar button) — pretty-prints the selection or buffer through `sql-formatter` with uppercased keywords. Dollar-quoted bodies are restored byte-for-byte and unparseable SQL is left untouched. Loads lazily on first use.",
          "**Find & replace** — the toolbar **Find** button or [[kbd:Mod-f]]; the `find` action is rebindable in [[topic:shortcuts|Shortcuts]].",
          "**Multi-cursor** — multiple selections, plus Alt-drag for rectangular selection.",
          "**Code folding** — a manual fold gutter plus auto-fold: bracketed lists of 100 or more items collapse to `…N items…`, single literals of 200 or more characters to a size placeholder. Display-only; click a placeholder or move the cursor into it to expand.",
          "**Keyword auto-UPPERCASE** — live at word boundaries, skipping qualified names (`t.select`), quoted identifiers, and open strings.",
          "**Font size & wrap** — the small and large **A** buttons step the font between 9 and 24 px; the wrap icon toggles word wrap.",
          "**Right-click menu** — Cut, Copy, Paste, Select all, Toggle comment ([[kbd:Mod-/]]), Run selection or Run all.",
          "**Explain ▾** — wraps one selected statement or the statement under the cursor for the [[topic:plans|plan visualizer]]. Multi-statement selections are refused; *Explain Analyze* is disabled on engines without it and warns before executing a write."
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
        "md": "One `list_schema` query plus a `list_functions` catalog feed both completion and lint. Both refresh whenever the schema reloads, such as after [[topic:sidebar|sidebar]] DDL."
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
          "Statement keywords at statement start.",
          "Columns from the current statement's `FROM`/`JOIN` rank first, labeled with type and source table (`integer · orders`). The list falls back to every column in the database only when no table resolves."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Alias resolution** — `u.` after `FROM users u` lists that table's columns; `schema.` lists its tables; `schema.table.` lists its columns.",
          "**Bare vs qualified** — tables in `public` or the tab's active schema complete bare; others complete as `schema.table`. Active-schema tables rank higher. Completion and schema lint share one resolver.",
          "**Live db functions** — functions and procedures appear alongside dialect builtins, tagged `db function`. After `CALL`, `EXEC`/`EXECUTE`, or `PERFORM` they jump to the top, tagged `procedure/function`.",
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
          "Right after `ON`, the top suggestion (tagged `foreign key`) is a complete join condition from the foreign-key catalog — `o.user_id = u.id`, using the statement's aliases, composite keys `AND`-ed into one entry.",
          "Hints connect the most recently joined table to the statement's other tables, so at least two are needed.",
          "FK edges load lazily per schema via `schema_relationships` for the active schema and `public` — the same data behind the [[topic:erd|ERD viewer]]."
        ]
      },
      {
        "k": "h",
        "text": "Three lint layers",
        "id": "lint-layers"
      },
      {
        "k": "p",
        "md": "Two client-side layers, heuristic and schema-aware, share one linter pass debounced at 300 ms. An async server linter runs at 600 ms. Squiggles merge in the gutter."
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
            "Unmatched `)`; unclosed `(`; trailing comma; `DELETE`/`UPDATE` without `WHERE`; unknown leading keyword (`SELCT` → \"did you mean SELECT?\"); a top-level comma between conditions in `WHERE`/`HAVING`; invisible paste artifacts in code — non-breaking and zero-width spaces, curly quotes — named with their code point and carrying a fix-all quick-fix",
            "error / warning"
          ],
          [
            "Schema (live catalog)",
            "Unknown `alias.col` refs; unknown tables after `FROM`/`JOIN`/`UPDATE`/`INTO`; unknown function calls against the live catalog; unknown bare identifiers; one-edit clause-keyword typos (`FORM` → `FROM`)",
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
          "`WHERE a = 1, b = 2` is squiggled as typed. Commas in `IN` lists, row constructors, function arguments, `SET` lists, and nested subqueries are untouched.",
          "Inside string literals, paste artifacts are data and stay untouched.",
          "**Bare identifiers** — checked only in DML (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH`) where every table reference resolved. Statements with CTEs or derived tables skip the check.",
          "**Grammatical `FROM`s** — `EXTRACT(YEAR FROM x)`, `SUBSTRING`, `POSITION`, `OVERLAY`, `TRIM` are masked before table scanning.",
          "**Empty function catalog** — the unknown-function check switches off. Neither MySQL nor SQL Server can enumerate builtins.",
          "**Half-typed keywords** — `SEL` under the cursor is a prefix of `SELECT` and is skipped."
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
          "It skips DDL, `COPY`, and `$1`/`:name` bind-parameter statements, and maps Postgres' 1-based error position onto the exact token.",
          "It goes silent when disconnected, while a query is running or streaming, and when *Server-side lint (PREPARE-only)* is off in Settings. The client layers keep working."
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
        "md": "Matching is Damerau-Levenshtein, and a candidate starting with the typed word counts as one edit, so `master` suggests `master_id`. See [[topic:shortcuts|Shortcuts]] and [[topic:editor|The editor]]."
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
          "Reads stream in pages of 1,000 rows: a server-side cursor on Postgres, a LIMIT/OFFSET pager on DuckDB/SQLite/MySQL, `OFFSET … FETCH NEXT` on SQL Server.",
          "On SQL Server the clause is appended, so an existing `ORDER BY` is preserved. A statement that cannot take it — `TOP`, its own `OFFSET`/`FETCH`, `FOR JSON`/`FOR XML`, `OPTION (…)`, an unordered `UNION` — is read once and labelled *read in one page*.",
          "**Auto-fetch** — scroll within ~1.5 viewport-heights of the bottom, or move the focused cell within 30 rows of the end.",
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
          "While running, Run becomes **✕ Cancel** with an elapsed counter. The final duration sits at the right of the result toolbar.",
          "One cursor per connection. Running in another tab, expanding a relation, refreshing the schema, sidebar DDL, an all-rows export, an import, or the ERD/DDL viewer closes the previous stream.",
          "The old tab keeps its rows under an **Incomplete result** badge and an `N rows loaded · …` status naming the cause. In-memory sort is off and Export lists its rows as incomplete; re-run for the full set.",
          "During a manual transaction other tabs and sidebar database actions are frozen, and an owner run closes only its prior stream.",
          "Dropped mid-stream: the grid keeps its rows and shows an error banner, a `streaming stopped — …` status, and the same badge."
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
          "**Resize** — drag the header edge, 48–900 px. Double-click the edge or *Autofit column* to size to visible content.",
          "**Reorder** — drag a header label sideways; a 4 px threshold separates a drag from a sort click.",
          "**Hide** — header right-click → *Hide column*, restored by *Show \"name\"* or *Show all columns*. Export is unaffected; grid copies follow what is displayed.",
          "A fresh query with a different column set resets this view state."
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
          "Local ordering compares numerically when every loaded value is a number, otherwise by display text, with each engine's default NULL placement. Use an explicit `ORDER BY` for native date or collation semantics.",
          "A header click that cannot sort — query running, transaction owned elsewhere, or a result neither re-runnable nor fully loaded — explains why in the status line."
        ]
      },
      {
        "k": "list",
        "items": [
          "**Sort** — click a header to cycle ascending → descending → none. [[kbd:Shift]]-click adds to a multi-sort, with priority numbers next to the arrows.",
          "**Quick filter** — *Show filter row* puts a box under each header. Each does a case-insensitive contains match, AND-combined, debounced 300 ms.",
          "The filter row edits the same filter as the builder: typing under an OR root re-roots it as an AND. A column carrying rules the one-line box cannot show is marked.",
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
          "Disabled on SQL Server for a statement containing `WITH` outside a literal or comment, table hints included, or an `ORDER BY` the wrap cannot hoist — window ordering inside `OVER (…)`, an ordered subquery, or `ORDER BY` paired with `OFFSET`/`FETCH`. A plain trailing `ORDER BY` moves onto the wrapper and a grid sort replaces it.",
          "Re-running the same unedited query text keeps active rules; edit the text first for a clean result.",
          "A sort or filter re-run resets scroll and selection."
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
          "A filter is a tree: one root group joined by AND or OR, holding conditions and nested groups, so `A and (B or C)` and `(A and B) or C` are both expressible.",
          "A condition is a column, an operator, and its values. The operator menu offers only what the column's class supports, and a badge names the inferred class (`text`, `num`, `bool`, `date`, `any`).",
          "Types come from the relation's detail. Without it every column is `any`, which offers every operator except `is true` / `is false` and casts to text for LIKE-family matching, while `=`, `<`, `between` and `in` compare the raw column."
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
          "**Operators** — `=` `≠` `<` `≤` `>` `≥`, `between` / `not between`, `in` / `not in` (comma-separated; quote a value containing a comma), `like` / `not like` / `ilike` (raw patterns), `starts with` / `ends with` / `contains` (case-insensitive, with `%` and `_` escaped), `is null` / `is not null`, `is true` / `is false`, `is empty`.",
          "**Groups** — AND or OR per group, *+ Condition* and *+ Group*, per-row duplicate and remove. A nested group is added with the opposite join. *+ Group* is offered four levels deep; the limit is eight levels and 200 conditions.",
          "**Buttons** — **Apply filter** re-streams the wrapped query, **Clear** empties the tree, **Copy WHERE** copies the clause, **Open as query** puts the wrapped `SELECT … WHERE …` into a new tab. [[kbd:Enter]] applies, [[kbd:Escape]] closes."
        ]
      },
      {
        "k": "list",
        "items": [
          "Identifiers are always quoted and values always literals. Only strictly numeric text is emitted unquoted, and only against a numeric column.",
          "`ILIKE` is native on Postgres and DuckDB, and becomes `LOWER(col) LIKE LOWER(pattern)` elsewhere, MySQL and SQLite included.",
          "Every LIKE-family comparison uses the text form of the column, so a `char(n)` never matches on blank padding.",
          "Booleans emit `TRUE`/`FALSE` on Postgres and DuckDB, `1`/`0` on MySQL, SQLite and SQL Server.",
          "Typed `%` and `_` are escaped with `!` under an explicit `ESCAPE '!'`."
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
          "An active filter shows one chip per condition above the grid, grouped as the filter is, each with an ✕, plus the loaded row count, **Edit…**, and **Clear all**.",
          "A condition whose column left the result is dropped on the next run.",
          "A column name appearing twice in the result is refused with `filter rejected: …` or `sort/filter rejected: …` in the status line.",
          "A filter is recorded only once the query it produces runs."
        ]
      },
      {
        "k": "h",
        "text": "Selection, keyboard, copy",
        "id": "selection-copy"
      },
      {
        "k": "p",
        "md": "Click a cell; drag with edge auto-scroll or [[kbd:Shift]]-click for a range. The gutter selects rows, a header a column, the corner or [[kbd:Mod-a]] everything."
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
        "caption": "Keyboard jumps ride the stream: moving within 30 rows of the loaded end fetches the next page."
      },
      {
        "k": "list",
        "items": [
          "[[kbd:Mod-c]] copies TSV. The cell context menu adds **Copy as CSV / JSON / Markdown**, *Copy cell value* (*Copy value (NULL→empty)* on a NULL cell), and *Copy column*.",
          "Column names are omitted unless **Copy w/ column names** is ticked in the result toolbar. With headers, JSON becomes an array of objects; without, arrays of values.",
          "Copies read through uncommitted edits and the boolean display mapping, so a Postgres `t` copies as `TRUE`.",
          "Copy as CSV/TSV/JSON/Markdown runs the same formatter as Export, so clipboard bytes match the file. An empty string stays quoted and distinct from `NULL`, and Markdown always carries its header row. For files, see [[topic:import-export|Import & export]]."
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
          "**View value…** — context menu, double-click on a non-editable grid, or [[kbd:Mod]]+double-click on an editable one — opens the full raw cell, never the boolean word.",
          "A recognized `EXPLAIN` result adds a **Plan / Grid** toggle at the left of the result toolbar — see [[topic:plans|Plan visualization]]."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "A single-table `SELECT` carrying its primary key is editable: double-click, [[kbd:Enter]]/[[kbd:F2]], `+ Row`, paste, Commit preview — see [[topic:grid-editing|Editing data in the grid]]."
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
        "md": "Results from a plain single-table `SELECT` are editable. Cell edits, delete marks, new rows, and pasted blocks stage as a pending overlay until the script is previewed."
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
          "**A single plain `SELECT`.** `WITH`, `TABLE`, and `VALUES` reject; scripts reject.",
          "**One table.** Any `JOIN`, `GROUP BY`, `DISTINCT`, `UNION`/`INTERSECT`/`EXCEPT`, `HAVING`, or `RETURNING` disqualifies.",
          "**Plain column references only** — `*`, `t.*`, `col`, `t.col`. No expressions, functions, `CASE`, literals, or aliases.",
          "**A table, not a view or matview**, with a primary key, every PK column present in the result.",
          "**No duplicate column names** in the result.",
          "**An unambiguous table identity.** A bare name in more than one schema is editable only when the tab's active schema resolves it. Comma joins, derived tables, table functions, mismatched qualifiers, and case-colliding metadata reject.",
          "**Connection not read-only.** On Postgres the role needs `UPDATE`, `INSERT`, `DELETE`, or ownership; partial privileges still allow editing and the server enforces per statement."
        ]
      },
      {
        "k": "p",
        "md": "With editing off, right-click a cell: the disabled **Edit cell** entry tooltips the exact reason, such as *multi-table queries aren't editable* or *table users has no primary key*. See [[topic:safety|Safety]]."
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
          "Boolean columns get a **TRUE / FALSE** dropdown, plus `<null>` when nullable, committing the driver's token — `true`/`false` on Postgres and DuckDB, `1`/`0` on SQLite, MySQL and SQL Server. Re-picking the original reverts the edit."
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
          "Dirty cells tint, delete-marked rows strike through, new rows highlight. Copy reads the same overlay."
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
          "Select rows in the gutter and press [[kbd:Delete]], or right-click → **Delete rows**, to mark them. The menu flips to **Undelete rows** when everything selected is marked.",
          "Delete acts only on a row selection. Marking a pending insert removes it outright.",
          "**+ Row** or right-click → **Insert row** adds a row pinned to the top of the grid, so [[topic:results|loading more rows]] cannot disturb it.",
          "Untouched cells show a faint *default* and are omitted from the INSERT. A fully untouched row commits as `INSERT INTO … DEFAULT VALUES`, or `INSERT INTO … () VALUES ()` on MySQL."
        ]
      },
      {
        "k": "h",
        "text": "Pasting from a spreadsheet",
        "id": "paste"
      },
      {
        "k": "p",
        "md": "[[kbd:Mod-V]] parses the clipboard as a table: tab-delimited when any tab is present, comma otherwise, with quoted fields honored. The shape is chosen automatically."
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
            "Each remaining row becomes a new insert row, values mapped by name; clipboard column order is irrelevant"
          ],
          [
            "**Positional**",
            "Anything else",
            "The block writes from the anchor cell across the visible columns, top-to-bottom; rows past the end overflow into new insert rows"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "Empty cell → SQL `NULL`. A cell absent because the row is short is omitted, so the column keeps its default on INSERT.",
          "Positional pastes write visible columns only. Header-mapped matches by name, so hidden columns can receive values. Non-table columns are never written.",
          "With no active cell the paste anchors at the append region.",
          "For files, use [[topic:import-export|Import]]."
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
          "**Outside a manual transaction** — Commit uses one app-owned transaction. Failure rolls it back wholesale, keeps pending edits, and shows the error in the dialog.",
          "**Inside the owner transaction** — Apply runs in the existing outer unit, clears the overlay on success, and leaves the transaction open. Pending edits must be applied or discarded before that unit can end.",
          "WHERE clauses use the original loaded values, so editing a primary-key cell still locates the old row. Composite PKs are AND-ed; a `NULL` original compares with `IS NULL`.",
          "Statements are fully qualified; the tab's active schema is ignored.",
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
          "Pending edits are per-tab and index into the loaded snapshot, so scrolling and streaming cannot shift them. They are never persisted.",
          "Anything that replaces the rows — re-running, a header sort, a column filter — asks *Discard pending changes?* with the change count. Toolbar **Discard** asks the same.",
          "Pre-`BEGIN` rows must be rerun before editing. Commit, rollback, rollback-to, autocommit-unit boundaries, and a lost session leave affected rows and pending edits stale until rerun."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "There is no optimistic-concurrency check: last write wins, so re-run the SELECT just before committing on hot tables, or write the UPDATE in the [[topic:editor|editor]]."
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
        "md": "The Explorer always shows the **connection the focused tab belongs to**. With several connections open, switching connection in the topbar strip (or clicking a tab that belongs to another one) swaps the whole tree, its cached table detail, the permission gating on this menu, and the Refresh state — each connection keeps its own. Refreshing one Explorer never disturbs another connection's tree or a result still streaming on it."
      },
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
        "md": "**Double-click** a table or view to stream all rows in a new tab (see [[topic:results|Results grid]]). The context menu adds **Select 100 rows** (tables only), **Select all rows**, and **Filter rows…** (runs the table and opens the [[topic:results|filter builder]] over it, pre-loaded with the relation's columns and types) — all open a *new* tab with active schema preset to the relation's, so the generated query stays unqualified and still resolves."
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
            "Select 100 rows · Select all rows · Filter rows… · Export table… · Import data into table… · **Modify table…** · Add column… · Add index… · Add constraint… · Rename… · Duplicate… · Edit comment… · Truncate… (*Delete all rows…* on SQLite) · Drop… · Backup table… · Generate SELECT/INSERT/UPDATE · DDL & relationships… · Copy DDL / Copy DDL → editor · Copy name / Copy qualified name"
          ],
          [
            "View / matview",
            "Select all rows · Filter rows… · Export… · (matview only: **Refresh** / **Refresh concurrently**) · Rename… · Edit comment… · Drop… · DDL & relationships… · Copy DDL / Copy DDL → editor · Copy name / qualified name"
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
            "Schema diagram… · Create table… · Import file as new table… · Export tables… · Rename… · Drop… (on MySQL a schema IS a database, so it reads **Drop database…**, confirms as one, and refuses the connected database) · Backup schema… · Copy name"
          ],
          [
            "Database",
            "Create schema… · Import file as new table… · Export tables… · Drop… (the connected database can't be dropped) · Backup database… · Restore from file… · Copy name"
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
        "md": "**Modify table…** is a DataGrip-style diff editor: edit a column's name, type, nullability, default, PK membership, or comment; reorder, add and drop columns; tick indexes and constraints for removal; add UNIQUE, CHECK and foreign-key constraints; rename, re-comment, and on Postgres move the table to another schema. The preview is the **minimal `ALTER` script** — type/null/default edits run against original column names, column renames follow those in-place edits so the earlier statements still resolve, the table rename runs last of all, and a PK change emits a key drop + `ADD PRIMARY KEY` only when the key actually changed. It refuses to run on an empty column name, a duplicate one (case-insensitively on DuckDB, MySQL and SQLite, which treat two spellings as one column — Postgres is left alone because Tusk always quotes, so `\"Id\"` and `\"id\"` are two legal columns), a nullable primary key (except on SQLite, which allows NULLs in a non-INTEGER key), or a generated column, whose expression no `ALTER` here can restate. Column reordering is offered on SQLite only, the one engine that can express it. When the script is more than one statement it says underneath how it runs — plainly, when it is not atomic, as on MySQL, where every DDL statement commits itself."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "**SQLite rebuilds instead of altering.** SQLite's `ALTER TABLE` only renames the table, renames a column, adds a column and drops one. Anything else — a type change, a NOT NULL or default change, a key change, a constraint edit, a column reorder, or dropping a column SQLite won't drop in place — makes Tusk generate the documented rebuild: `CREATE` the new shape, `INSERT … SELECT` the rows, `DROP` the original, `RENAME` the replacement into place, then recreate its indexes and triggers. The whole script runs as one transaction, the preview is labelled, and the primary button reads **Rebuild table**. The new shape is built from the table's stored `CREATE` text, so CHECK constraints (names included), column collations, generated columns and `WITHOUT ROWID` / `STRICT` are carried across; the swap runs under `PRAGMA legacy_alter_table` so a table a view or trigger refers to can be rebuilt at all. Triggers are replayed verbatim, semicolons in their bodies included. Because dropping the original deletes its rows out from under anything that references them, Tusk switches `PRAGMA foreign_keys` off for the rebuild and back on immediately after — SQLite ignores that pragma inside a transaction, so the two statements run around the rebuild's own transaction, and the dialog note says so. Tusk refuses a rebuild it cannot do safely and says why: a rename in the same pass (do the rename on its own first), dropping a column an index, constraint or trigger still uses (drop that too), and a stored definition it could not read."
      },
      {
        "k": "p",
        "md": "**Create table…** builds the whole common surface: per-column type (offered from the connected engine's type list), NOT NULL, default expression, primary key (single or composite), unique, check, and auto-numbering in that engine's form — Postgres `GENERATED BY DEFAULT AS IDENTITY`, MySQL `AUTO_INCREMENT`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`, DuckDB a sequence created alongside the table. Rows reorder with ↑/↓ and duplicate with ⧉. An expandable section adds per-column checks and comments, foreign keys, `IF NOT EXISTS`, `TEMPORARY`, and on MySQL the `ENGINE` / charset / collation options."
      },
      {
        "k": "p",
        "md": "**Foreign keys get a picker.** In Create table, Modify table and Add constraint, choosing *FOREIGN KEY* gives a searchable `schema.table` box fed by the loaded tree; picking a table fetches that table's columns so **key columns are listed first and marked** `pk` or `unique`. Add a row per column for a composite key, then set `ON DELETE` / `ON UPDATE`, and `DEFERRABLE` where the engine supports it. If the local and referenced column types look incompatible you get a warning, not a block — the engine has the final say."
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
          "**Manual transaction** — while one owns the session every Explorer database action is frozen, with *\"Explorer database actions are frozen during a manual transaction\"* as the tooltip. Commit or roll back first.",
          "**Read-only connection** — everything mutating disables with *\"Connection is read-only\"* (see [[topic:safety|Safety & read-only mode]]). **Drop database** passes the same gates as every other DDL action — manual-transaction freeze, read-only, engine support.",
          "**Engine limits** — sidebar DDL is live on **PostgreSQL, DuckDB, MySQL and SQLite**, and each action is offered only where that engine can express it; the tooltip names the engine, e.g. *\"DuckDB can't add constraints with ALTER TABLE — define them in CREATE TABLE\"*. DuckDB also has no constraint drops, index/sequence renames, `ALTER SEQUENCE RESTART`, `CREATE DATABASE` / `DROP DATABASE`, or `TRUNCATE` options, and splits multi-action ALTERs into one statement each. MySQL rewrites a column with `MODIFY COLUMN`, renames tables with `RENAME TABLE`, drops each constraint kind with its own action, and has no schema rename, sequences, index methods or partial indexes. SQLite has no comments, `CREATE SCHEMA`, `CREATE DATABASE`, `TRUNCATE` (*Delete all rows…* runs `DELETE FROM`), or constraint ALTERs. SQL Server has no sidebar DDL builders yet, so its mutating items disable with *\"DDL editing isn't supported for SQL Server yet\"*.",
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
        "md": "**Copy DDL** rebuilds a runnable `CREATE` from the system catalogs on every engine — Postgres pg_dump-style from `pg_catalog`, SQLite via `sqlite_master`, MySQL via `SHOW CREATE`, SQL Server reconstructed from `sys.*` (with `sys.sql_modules` text for views, procedures and functions), DuckDB best-effort. On Postgres it covers tables (identity/generated/serial defaults, inline PK/unique/check), views, matviews, functions (including overloads), and sequences; **foreign keys emit as trailing `ALTER TABLE … ADD CONSTRAINT`** (so copied tables replay in any order) and constraint-backed indexes are skipped."
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
    "blurb": "Export results in six formats, streamed or loaded; import CSV, JSON or xlsx transactionally on four engines.",
    "blocks": [
      {
        "k": "p",
        "md": "Data moves through four doors: **Export…** on the result toolbar (file or clipboard, six formats, streaming), the Explorer's right-click **Export table…** / **Export tables…**, the sidebar's **Import data** icon and the Explorer's **Import data into table…** / **Import file as new table…**, and the grid's copy commands ([[kbd:Mod-C]] + right-click — see [[topic:results|Results]]). Export works on every engine; import covers PostgreSQL, MySQL, SQLite and DuckDB — it isn't wired up for SQL Server yet, and the Explorer's import items say so. Moving a whole database rather than one result is a different job — see [[topic:backup|Backup & restore]]."
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
          "**Preview** — live, from the first 12 rows already in memory (the loaded rows, or the selection when that scope is chosen); skipped for xlsx, and empty for an Explorer table export, which has loaded no rows.",
          "**Defaults** — CSV, comma delimiter, quote *as needed*, header row on, NULL as empty, LF line endings, no BOM. Your last-used formatting options are remembered per format; the column selection, the table name and **Include CREATE TABLE** always come from the result being exported."
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
            "`INSERT` statements with a configurable table name; **Multi-row INSERT** batches 1,000 value tuples per statement; **Include CREATE TABLE** prepends the source table's reconstructed DDL (real types, keys and defaults) when the result is a plain table, and otherwise a generated all-`text` `CREATE` with a note saying so. Views and materialized views always use the generated form — their real DDL is a `CREATE VIEW`, which nothing can insert into — and renaming **Table** drops the reconstruction too, because that DDL names the original relation."
          ],
          [
            "**Markdown**",
            "A pipe table with a header separator row."
          ],
          [
            "**Excel (xlsx)**",
            "File-only. Sheet name (defaults to the table name detected in the query, trimmed to 26 chars, with the characters Excel forbids — `[ ] : * ? / \\` — replaced by `_`), **Bold header**, **Auto-filter**, **Freeze header**. Rows past **1,048,576** roll into additional sheets automatically."
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
          "**Selection (N rows)** — offered when rows are selected in the grid: the selected rows at full width, in memory. The dialog's own column checkboxes still apply. Like *Loaded rows* it exports the **stored** values, so unapplied edits and pinned new rows are left out and an exported file never holds rows the database does not have.",
          "**All rows (re-run query)** — re-executes server-side. Postgres streams via a dedicated cursor (`tusk_export_cur`) in **10,000-row batches** (constant memory); DuckDB, SQLite, and MySQL page via `LIMIT`/`OFFSET`, SQL Server via `OFFSET`/`FETCH`. This scope is frozen while a manual transaction owns the session; export Loaded rows instead."
        ]
      },
      {
        "k": "p",
        "md": "The re-run honors the producing tab's active schema (the frozen snapshot carries its `search_path`), so unqualified names resolve as they did in the editor. Empty results still atomically replace the destination with a valid configured artifact, such as headers, `[]`, SQL DDL, or an empty workbook."
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "On the paged engines (DuckDB, SQLite, MySQL, SQL Server) the all-rows export is **not snapshot-consistent** — concurrent writes between pages can skew it. Postgres streams inside one transaction."
      },
      {
        "k": "p",
        "md": "**To** switches between **File** and **Clipboard**; the clipboard uses a TypeScript formatter kept **byte-identical** to the Rust file writer (delimiter, quoting, NULL text, header, column projection, line endings). The clipboard formats in memory, so it takes *Loaded rows* or *Selection* but not *All rows*; xlsx forces the destination to *File*."
      },
      {
        "k": "h",
        "text": "Cancelling a long export",
        "id": "cancel-rollback"
      },
      {
        "k": "p",
        "md": "During an all-rows stream the dialog locks its controls and shows **Cancel export**. Postgres gets an immediate `CancelRequest` and DuckDB the equivalent interrupt (except on Windows, where DuckDB's interrupt is disabled because it corrupts the bundled connection); SQLite, MySQL, and SQL Server have no out-of-band cancel, so the current query finishes first."
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
        "md": "**Import data** opens a three-step dialog on PostgreSQL, MySQL, SQLite and DuckDB (SQL Server isn't supported yet). **1. File** — pick the file and its parsing options; Tusk parses the head of it in the backend and shows the detected columns, a sample of the parsed rows (50 parsed, 20 shown) and any warnings. **2. Columns** — choose the target table and map the file's columns onto it. **3. Run** — watch the load with live progress, **Cancel & roll back**, and a result summary. The file is read from disk by the backend in bounded batches: it is never loaded into the window, so size is limited by the format's budget rather than by memory."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Delimited text** — configurable delimiter (comma / tab / semicolon / pipe / custom), quote character (leave it blank to turn quoting off, for a file with a bare double quote inside an unquoted field), optional backslash-style escape character (which must differ from both the quote character and the delimiter), **UTF-8** (a BOM is accepted and stripped) or **Latin-1** encoding, **skip N rows** for a preamble above the header, and a **NULL text** placeholder such as `\\N`. Wholly blank lines are separators, not rows. The encoding choice applies to delimited text only — JSON is always read as UTF-8.",
          "**JSON** — either an array of objects or newline-delimited objects (NDJSON). Keys become columns in first-seen order, nested values are stringified, and a duplicate key is rejected rather than silently dropped. Columns come from the previewed sample: a key that first appears past it is reported in the run warnings (reopen the dialog to map it), and a file whose keys no longer overlap the preview at all is refused rather than imported as NULLs.",
          "**Excel (xlsx)** — the first sheet by default, with a sheet picker when the workbook has more than one. A workbook is read whole rather than streamed, so its progress bar tracks rows rather than bytes.",
          "**First row is the header** — unchecked gives `col1`, `col2`, … A row with more fields than the header is an error; a short row imports its missing fields as NULL and says so in the warnings, both in the preview and in the run summary."
        ]
      },
      {
        "k": "p",
        "md": "The `CREATE TABLE` (if any), the optional table clear, and every insert batch run in **one transaction**: **Cancel & roll back** (or any error, including a value that doesn't fit its column) undoes everything and names the offending row. PostgreSQL streams a plain load through `COPY … FROM STDIN`; a conflict mode falls back to batched multi-row `INSERT`s, because `COPY` has no `ON CONFLICT`. The other engines always use batched multi-row `INSERT`s. On success the sidebar schema refreshes so a new table appears in the tree and autocomplete ([[topic:sidebar|Sidebar]]), and the run lands in [[topic:history|history]] as `-- [Import] …`."
      },
      {
        "k": "h",
        "text": "Choosing the target and mapping columns",
        "id": "import-mapping"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Existing table** — pick any table Tusk knows (the Explorer's *Import data into table…* pre-selects one). File columns are auto-matched to target columns by name, case- and punctuation-insensitively; anything left over can be pointed at a column by hand or set to **— skip —**, which leaves that column at its database default.",
          "**New table** — the name is pre-filled from the file name (extension stripped, lower-cased, non-word characters → `_`), and an Explorer schema node pre-selects its own schema. Each column's type is **inferred from the sampled values** — integer, bigint, numeric, boolean, date, timestamp, or text — and each one can be overridden before the table is created. The dropdown shows the engine type each token creates as. Inference stays conservative: a value too wide for a 64-bit integer keeps the column `text`, and a column already near the 32-bit limit widens to `bigint`.",
          "**Empty the table first** — clears the table inside the same transaction, so a failure leaves the original rows intact.",
          "**Empty → NULL** — per column, imports an empty (or whitespace-only) string as NULL. On by default for every non-text column, because a blank is not a number, date or boolean."
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
            "PostgreSQL `ON CONFLICT (keys) DO UPDATE` — pick the conflict key columns; MySQL `ON DUPLICATE KEY UPDATE` (which fires on *any* unique key, not only the columns you mapped); SQLite and DuckDB `INSERT OR REPLACE`, where an unmapped column resets to its default."
          ]
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "MySQL DDL implicitly commits. A MySQL import that creates its table therefore runs the `CREATE TABLE` **before** the transaction, as a separately committed step, and says so in the summary. The rows still load in one transaction and still roll back on a failure or a cancel — but the empty table stays behind, and the error tells you to drop it. The other three engines create and load atomically."
      },
      {
        "k": "h",
        "text": "Exporting from the Explorer",
        "id": "explorer-export"
      },
      {
        "k": "p",
        "md": "Right-click a table for **Export table…** — the same configurator, aimed at that relation's full contents; on a view or materialized view the item reads **Export…**. Right-click a schema or the database for **Export tables…**: tick the tables, choose a format, pick a directory, and get one configured file per table named `schema_table.<ext>`, with per-table progress and a Cancel that works on every engine. That dialog exposes fewer options than the single-result one, and anything it does not show falls back to the default rather than to your last export — the exception being the Excel **Bold header** / **Auto-filter** / **Freeze header** flags, which are still remembered."
      },
      {
        "k": "p",
        "md": "Every file is written atomically. A table that fails is reported by name and the run continues with the rest; the files already written are kept, and nothing is rolled back on the filesystem. Cancelling stops the run and reports the remaining tables as cancelled."
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
    "id": "backup",
    "title": "Backup & restore",
    "blurb": "Native plain-SQL dumps and replays through the driver — no pg_dump, no mysqldump.",
    "blocks": [
      {
        "k": "p",
        "md": "Tusk writes and replays backups itself, through the same driver it queries with — there is **no external binary** to install or keep version-matched, and nothing shells out. It works on all five drivers. A dump is plain SQL: Tusk restores it, and so does the engine's own CLI client (`psql`, `mysql`, `sqlite3`, `duckdb`). SQL Server is the exception — its dumps carry no `GO` batch separators, so replay them with Tusk rather than with `sqlcmd`, which needs one before a `CREATE VIEW` or `CREATE PROCEDURE`."
      },
      {
        "k": "h",
        "text": "Starting one",
        "id": "starting"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Explorer right-click** — a database node offers **Backup database…** and **Restore from file…**, a schema node **Backup schema…**, a table node **Backup table…**. Each pre-fills the dialog's scope.",
          "**Toolbar ⋯ overflow** — **Backup…** (whole database) and **Restore from file…**. The ⋯ button only appears when the editor pane is narrow (880 px or less); at wider sizes use the Explorer right-click.",
          "Both need an idle session: they are blocked while a manual transaction owns the connection, and starting one releases the single result stream (the owning tab's result is marked incomplete, as with any other whole-connection command)."
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
            "**Whole database**, **Selected schemas**, or **Selected tables** — the last two show a searchable checklist built from the loaded tree. A table selection covers those tables and their rows, plus — on PostgreSQL — the sequences their `serial` and identity columns own, because a dump without them cannot restore at all; views, other sequences and routines need a schema or database backup."
          ],
          [
            "**Contents**",
            "**Schema + data**, **Schema only**, or **Data only**. Data-only carries no `CREATE`, so restore it onto a database that already has the tables."
          ],
          [
            "**Emit DROP … IF EXISTS**",
            "Adds a drop block ahead of the creates, in reverse dependency order, so the dump can replace what is already there instead of colliding with it. Disabled for a data-only dump."
          ],
          [
            "**Wrap in one transaction**",
            "One transaction around the dump. Offered on PostgreSQL, DuckDB, SQLite and SQL Server; **disabled on MySQL**, which commits DDL implicitly."
          ],
          [
            "**Destination**",
            "**Choose file…** opens the native save dialog. Nothing runs until a path is set. If the picker resolves without ever appearing, Tusk shows you the path it came back with and asks before using it — it never writes to a destination it cannot tell you chose."
          ]
        ]
      },
      {
        "k": "p",
        "md": "While it runs, the dialog shows the current object, tables done, rows and bytes written, and elapsed time, with a **Cancel backup** button. The finished view reports the totals plus any warnings (objects whose DDL the driver could not reconstruct — those are also written into the file as `-- warning:` lines)."
      },
      {
        "k": "h",
        "text": "What a dump contains",
        "id": "dump-layout"
      },
      {
        "k": "p",
        "md": "A header comment records the Tusk version, engine, database, UTC timestamp and the options used; the restore dialog reads it back. Then, in this order: drops, `CREATE SCHEMA IF NOT EXISTS`, sequences, tables (with their indexes and comments), **data**, views and materialized views, functions and triggers (PostgreSQL only), the deferred foreign keys, and finally the PostgreSQL sequence positions."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Foreign keys come last on PostgreSQL, MySQL and SQL Server.** They are lifted out of PostgreSQL's and SQL Server's reconstructed DDL and out of MySQL's `SHOW CREATE TABLE` into trailing `ALTER TABLE … ADD CONSTRAINT` statements, so a restore cannot break on table order — including a reference **cycle**, which no ordering can satisfy.",
          "**SQLite and DuckDB keep foreign keys inline**, because neither engine can add one with `ALTER TABLE`. A SQLite dump that contains schema writes `PRAGMA foreign_keys = OFF` ahead of everything else so the replay is not order-sensitive (a data-only dump has no pragma to write); on either engine a cycle that cannot be ordered around is reported as a `-- warning:` line in the dump and in the result, instead of being written out as if it were fine.",
          "**Functions, procedures and triggers are reconstructed on PostgreSQL only.** On the other engines the dump says so in a `-- warning:` line and in the result panel, with a count of the routines it could not carry, rather than looking complete.",
          "**PostgreSQL data streams through `COPY`.** The dump reads `COPY … TO STDOUT` and writes `COPY … FROM stdin;` blocks terminated by `\\.`, so no table is ever held in memory. A new block starts every 16 MiB.",
          "**Every other engine — DuckDB, SQLite, MySQL and SQL Server — emits batched multi-row `INSERT`s**, built with the same dialect-aware quoting and literal rules as SQL export, and paged so memory stays flat. Binary columns are written as native blob literals, not as text: `X'…'` on SQLite and MySQL, `from_hex('…')` on DuckDB, `0x…` on SQL Server. A SQL Server table with an identity column has its data block bracketed with `SET IDENTITY_INSERT … ON` / `OFF`, so the dumped key values restore unchanged.",
          "**PostgreSQL dumps are snapshot-consistent**: the whole read runs inside one read-only repeatable-read transaction. The other engines page a table at a time, so a dump taken during concurrent writes is not a single point in time — the same caveat as grid paging.",
          "**Generated columns are skipped** on PostgreSQL, which would otherwise reject the restore."
        ]
      },
      {
        "k": "h",
        "text": "The Restore dialog",
        "id": "restore-dialog"
      },
      {
        "k": "p",
        "md": "**Choose file…** picks the dump; Tusk reads its size and header first and shows what it is about to replay. A dump taken from a different engine is called out before you run it — its SQL is unlikely to replay cleanly. A file without a Tusk header is fine; it is simply replayed as plain SQL. If the header carries a `psql` directive such as `\\restrict` (recent `pg_dump` output begins with one), the dialog says so before you start: Tusk replays SQL, not `psql` commands. A byte-order mark left by a Windows editor is ignored."
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**Stop at the first error** (default) halts and reports; unchecking it keeps going and still records the first failure.",
          "**Run everything in one transaction** rolls the whole restore back on any failure. Same engine rule as backup — not available on MySQL — and it requires stop-on-error, since the first failure aborts the unit anyway.",
          "Progress shows statements run, rows copied and bytes read; the total is unknown until the file ends, because the file is parsed as it streams. **Rows copied** only advances for `COPY` blocks — that is, for PostgreSQL dumps; an `INSERT`-based dump moves the statement counter instead.",
          "The result panel reports statements run, failures, rows copied, and the **first error with its statement number and line**.",
          "When it finishes, the sidebar and autocomplete reload — the database changed underneath them."
        ]
      },
      {
        "k": "h",
        "text": "Safety and limits",
        "id": "safety"
      },
      {
        "k": "list",
        "ordered": false,
        "items": [
          "**A read-only connection can back up but never restore.** A backup is a read; a restore is blocked outright.",
          "**A failed or cancelled backup never touches the previous file.** The dump is written to a sibling temp file, fsynced, then atomically renamed — the same guarantee as export.",
          "**A restore statement is never replayed.** If the connection drops mid-restore the outcome is ambiguous, so Tusk stops and tells you to verify state rather than running it again.",
          "**Cancel works on every driver.** Backup and restore check for cancellation between units, so they stop even where the engine has no out-of-band query cancel (SQLite, MySQL, SQL Server, DuckDB on Windows).",
          "**Limits** — a restore reads at most **2 GiB**, and one statement (or one `COPY` data block) at most **256 MiB**. Tusk's own dumps stay well inside the second limit because it reopens `COPY` blocks as it writes."
        ]
      },
      {
        "k": "tip",
        "kind": "warn",
        "md": "DDL reconstruction is as complete as [[topic:sidebar|Copy DDL]] is, and no more: partitioning, inheritance, row-level security, grants, storage parameters and tablespaces are out of scope, DuckDB dumps carry no `CREATE INDEX` (its catalog stores only the table definition), MySQL's `CREATE TABLE` is unqualified, so it restores into the connected database, and SQL Server table reconstruction needs SQL Server 2017 or later — on an older server a table backup refuses rather than dropping the keys silently. Verify a restore before relying on a dump as your only copy."
      }
    ],
    "icon": "duplicate"
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
        "md": "**Explain ▾** in the [[topic:editor|editor toolbar]] offers **Explain** and **Explain Analyze (runs the query)** — registry actions (`explain` / `explainAnalyze`), unbound by default; bind them in [[topic:shortcuts|Settings → Shortcuts]] or fire them from the ⌘/Ctrl K command palette. Each takes exactly one selected statement, or the statement under the cursor, and wraps it in the engine's best structured form; a multi-statement selection is refused so trailing SQL can never run outside the `EXPLAIN` prefix:"
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
            "SQL Server",
            "— not supported; Explain reports that T-SQL has no `EXPLAIN` and Tusk can't render SHOWPLAN output yet",
            "— not supported"
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
        "md": "`EXPLAIN ANALYZE` **executes** the statement. If it isn't a read (`SELECT`/`TABLE`/`VALUES`, or a `WITH` that feeds one — `WITH … UPDATE` counts as a write), Tusk shows an *Explain Analyze* confirmation dialog — only the red **Run it** button proceeds."
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
          "**SQL Server** — `sys.foreign_keys` joined to `sys.foreign_key_columns`.",
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
        "md": "Keys are stored **per provider** in the **OS keychain** (service `tusk-ai`) and are used only by the Rust backend — never in localStorage, never echoed back to the UI. The panel only ever learns a boolean. Because each provider has its own keychain entry, you can set up several and switch between them mid-conversation without re-entering anything. Non-secret config (active provider, per-provider model and base URL, per-provider model allowlists, the sample-data toggle) lives in localStorage under `tusk.ai.config`."
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
        "k": "p",
        "md": "**Choose models in Settings → AI.** Each provider card has one **Models** list, and it answers both questions: the **checkbox** on a row means the model is *offered* in the header picker and to the Slack bot; the **★** marks the provider's *default* — the model a chat starts on when you switch to that provider. Nothing ticked means every listed model is offered. The list is the provider's **live** catalog, fetched with your key when you open the card (**Refresh** re-fetches; until a key is saved and its origin approved you see the shipped fallback ids). Search it, **Select all** / **Select matches** to tick the visible rows, **Clear** to go back to offering everything, or ✕ a chip. Type an id the catalog doesn't list and an **Add … as a model id** row lets you use it anyway (for custom endpoints). Because the choice is re-filtered against the live catalog each time, a model the provider retires drops out on its own and the card names any stale pick; hiding the model you were using moves the default to your first tick, and starring a model that isn't ticked ticks it. Tusk imposes no ranking — no \"flagship\" or \"fast\" tiers — the list is exactly what the provider serves, in its order."
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
        "md": "With the search box empty the picker lists each provider's models under a provider heading, in catalog order — no tiers. Model lists are fetched **live** from each provider using your saved key; the shipped fallback ids appear only when that fetch fails. Any id your endpoint takes can be added from the Models list in Settings."
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
          "**Dialect + version** — driver label, server version, and a quoting note (backticks on MySQL, brackets on SQL Server, double quotes elsewhere).",
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
        "md": "Teammates ask your database plain-language questions from Slack while Tusk runs on your desk — **desktop-hosted Socket Mode** (one outbound WebSocket, no server, no public endpoint, **bring-your-own Slack app**). The AI proposes SQL; **nothing runs without an Approve click**, and only single read-only SELECTs run — against the one Tusk connection the bot was bound to when it started, which switching tabs in Tusk never changes."
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
          "**Paste both under Slack app tokens in Settings → Slack** — stored in the OS keychain (service `tusk-slack`), never written to disk, never echoed back (a *saved* chip marks each stored token; the field says *type to replace*). **Save tokens** stores them; **Test connection** validates both and names the workspace.",
          "**The status card at the top** shows the bot's state (Bot off / Connecting… / Bot running, with the last error) and its **On/Off switch**, which is disabled until both tokens are present. Statusbar badge: `🟢 Slack` running, 🟡 connecting/reconnecting.",
          "**The rest is grouped**: *Who can ask* (channel and user allowlists), *Answers* (rows shown inline, row cap, query timeout, auto-chart, write/DDL reply policy), and *AI* (provider/model, reply max tokens, sample rows). Every one of these saves the moment you change it.",
          "**AI provider/model** is mirrored from **Settings → AI** whenever the Slack pane saves — the Rust bot can't read the web view's storage. The AI section shows the pair the bot is using; when Settings → AI has since changed, it says so and offers **Update bot** (any other Slack change also re-mirrors it)."
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
          "**Inline monospace table** — ≤ *Rows shown inline* (default **20**), ≤ **5** columns, and the text fits Slack's message block.",
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
          "**Hard row cap** — execution wraps the query as `SELECT * FROM (…) AS _tusk LIMIT cap+1` (*Row cap* under Answers, default **10,000**) with a \"(truncated at N rows)\" note.",
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
        "md": "Every proposal is pinned to the exact Tusk connection, server-reported database, workspace, channel, thread, source message, and requester that created it. The bot answers against exactly one Tusk connection, chosen when it starts and changeable in **Settings ▸ Slack** while several are open; switching tabs in Tusk never redirects it. Approving a proposal after its connection or database changed fails closed. Autostart is bound to a **saved** connection: the bot starts by itself only when that connection is open, otherwise it stays stopped and says which connection it is waiting for. It never binds to whichever connection happens to open first, and a connection you have not saved can be picked by hand but never autostarted. Disconnecting the bound connection stops the bot and says so in the statusbar; your settings are left alone, so reopening that connection brings the bot back. Execution uses a fresh read-only backend and does not join or roll back the UI cursor. SQL Server connections are refused outright, at the question and again at approval: it has no session read-only mode, so that backend could not be engine-enforced."
      },
      {
        "k": "list",
        "items": [
          "Config edits (allowlists, caps, timeout, policy, AI provider, sample consent) reload per-question. Replacing tokens validates them and restarts the running bot; restart failure stops and disables it.",
          "The timeout only preempts the async network drivers (Postgres/MySQL/SQL Server) — **DuckDB and SQLite run synchronously**, so a pathological embedded query holds the connection until it finishes (the timeout message notes the server may still be finishing it).",
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
    "blurb": "Per-connection run log — search it, re-run it, reopen with schema.",
    "id": "history",
    "title": "Query history",
    "blocks": [
      {
        "k": "p",
        "md": "Every run is logged per connection: statement text, outcome, duration, row count, and the schema it ran under. The topbar clock icon toggles the right-side **Query history** panel."
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
        "md": "An entry is written when a user-issued run finishes — success, error, or cancel. It stores the SQL, a timestamp, elapsed milliseconds, an `ok` / `error` / `cancelled` status, the row count when known, the first line of any error, and the tab's active schema."
      },
      {
        "k": "list",
        "items": [
          "**Recorded** — anything launched from the editor: Run, run-selection, panel re-runs, and multi-statement scripts as one entry.",
          "**Recorded** — [[topic:grid-editing|grid Commit/Apply]] scripts. Raw transaction controls and work inside a manual unit carry a leading transaction id, revision, and event marker.",
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
          "JSON per connection under `<app-config>/history/`, keyed `profile:<id>` for saved profiles or `adhoc:` from host, port, database and user — driver plus file path for DuckDB and SQLite.",
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
          "**Search** — `Search history…` filters SQL live, case-insensitive substring.",
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
          "Disconnecting closes the panel and clears the list. It reloads on the next connect, from disk on the first load after launch."
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
        "md": "Every action lives in one registry. The global key handler, the editor keymap, **Settings → Shortcuts**, and the [[kbd:Mod-k]] palette all read from it, so a rebind updates everywhere."
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
        "md": "The chips below show the live binding. Some actions ship unbound — Explain, Toggle AI, Load all rows, What's new — and stay reachable from the palette and toolbars."
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
          "**Run** — needs a connection.",
          "**Explain** / **Explain Analyze** — blocked while a query runs. Explain Analyze also needs engine support; SQLite has no `EXPLAIN ANALYZE`.",
          "**Cancel running query** — only while a query runs.",
          "**Load all rows** / **Export result…** — need a result in the grid.",
          "**Cancel query** and **Open manual** fire through the window handler even with a modal open or focus in the editor. Shortcuts-settings keys work on the connect screen; the palette is disabled there."
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
          "Conflicts share one flat namespace across both scopes. A chord another action owns shows *bound to \"<that action>\" — press again to replace*; a second press unbinds the other action.",
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
        "md": "[[kbd:Mod-k]] opens the palette. Matching is fuzzy subsequence over `category + title`, scoring consecutive characters and word-starts higher, so `rcs` finds *Run selection or current statement*."
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
          "Editor-scoped actions — Run, Run selection or current statement, Format SQL, Toggle comment, Find & replace — are also bound inside CodeMirror and win while typing. The window handler skips anything the editor consumed.",
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
        "md": "The [[topic:results|result grid]] handles its own keyboard; these are not registry actions and cannot be rebound. Editing keys apply only when the result is [[topic:grid-editing|editable]]."
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
          "Statement gutter ▶ runs a statement by mouse; the keyboard equivalents are the rebindable **Run** and **Run selection or current statement**. See [[topic:editor|the editor topic]]."
        ]
      }
    ],
    "icon": "bolt"
  },
  {
    "blurb": "Panels, topbar, Settings dialog, 8 themes, accent/font, built-in updater.",
    "id": "workspace",
    "title": "Workspace, themes & settings",
    "blocks": [
      {
        "k": "p",
        "md": "One window: a resizable **Explorer** sidebar, a tabbed editor over a results pane, and optional **AI** and **History** panels docked right. Preferences live in one flat localStorage object and apply live."
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
          "All four sizes persist under `tusk.layout`; stale values are clamped on load and on resize."
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
          "Editor tabs persist per connection in `tusk.tabs.*`: SQL buffer, file path, title, active schema, and which tab was active.",
          "Every open connection's tabs are saved, not only the focused one.",
          "Results are ephemeral — snapshots, cursors, and pending grid edits never persist. See [[topic:results|Results & streaming]]."
        ]
      },
      {
        "k": "h",
        "text": "Several connections at once",
        "id": "connections"
      },
      {
        "k": "p",
        "md": "Up to **16** databases can be open at once. The topbar carries one chip per connection — driver mascot, database name, state dot — and **＋** opens the connect screen as a panel."
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
            "the transaction failed; `ROLLBACK` is required before anything else"
          ],
          [
            "lost",
            "danger",
            "the transaction session was lost; disconnect, reconnect, verify the outcome"
          ]
        ]
      },
      {
        "k": "list",
        "items": [
          "Hover a chip to read its state in words.",
          "While a query runs the dot is a button: click it to cancel that connection's query, with a confirmation and without switching to it.",
          "**✕** disconnects one connection. A running query must be cancelled or finish, an open transaction committed or rolled back, and pending grid edits applied or discarded.",
          "Closing Tusk asks about each open transaction in turn."
        ]
      },
      {
        "k": "p",
        "md": "Each connection carries its own result cursor, manual transaction and bar, Explorer tree, autocomplete catalog, permissions, tab set, recovered buffers, and **Cancel**. Work on one connection never interrupts another's stream or metadata."
      },
      {
        "k": "list",
        "items": [
          "[[topic:history|Query history]] is scoped to the destination, so the same profile opened twice shows one combined history.",
          "Tabs belong to a connection. Above one connection each tab shows its mascot and colour rail, and clicking a tab switches to that connection.",
          "New tabs open on the connection in focus. Closing a connection's last tab opens a fresh one on it.",
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
        "md": "**Reopen last session** also appears in the **＋** panel, and anything that fails to reopen stays in the offer with its reason."
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
          "Driver label and server version.",
          "**🔒 Read-only** badge when the connection blocks writes and DDL.",
          "Right side: **✨ AI** toggle, history clock, **?** for this manual, Settings gear, **Disconnect**."
        ]
      },
      {
        "k": "list",
        "items": [
          "The footer shows status text and cursor info: line/column, `Stmt 2/5` in multi-statement buffers, selection character count.",
          "A **🟢/🟡 Slack** badge tracks the [[topic:slack|Slack bot]] connecting or connected; it turns **🔴** with the reason in the status text when the bot stops.",
          "**Copy w/ column names** lives in the result toolbar next to Export…, on the same `copyHeaders` pref as Settings → Grid."
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
            "Font size (9–24), word wrap, auto-fold large literals, server-side lint, SQL dialect. The dialect select is disabled while connected."
          ],
          [
            "**Appearance**",
            "Theme, editor/grid font (free text, presets, Reset), accent color (picker plus six swatches)."
          ],
          [
            "**Grid**",
            "Row density (Normal 28 px / Compact 22 px), zebra striping, NULL display (`NULL` / empty / —), default column width (48–900), copy with column names."
          ],
          [
            "**Plans**",
            "Tree orientation, heat coloring (Cost / Actual time / Rows / Off), node detail — see [[topic:plans|EXPLAIN plans]]."
          ],
          [
            "**AI**",
            "Provider cards — Connection (API key, base, origin approval, Test) and Models — then Assistant (share sample rows, reply max tokens 256–128,000) and Skills. See [[topic:ai|AI assistant]]."
          ],
          [
            "**Slack**",
            "Status card with On/Off, Slack app tokens, who can ask, answers, and mirrored AI settings — see [[topic:slack|Slack bot]]."
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
        "md": "Preferences store flat in `tusk.prefs` and are shallow-merged over defaults on load, so new prefs arrive with defaults."
      },
      {
        "k": "h",
        "text": "Themes, accent, and fonts",
        "id": "themes"
      },
      {
        "k": "list",
        "items": [
          "Dark themes: **One Dark** (default), **Catppuccin Mocha**, **Dracula**, **Tokyo Night**.",
          "Light themes: **One Light**, **Solarized Light**, **GitHub Light**, **Gruvbox Light**. Plus **Follow system**.",
          "A theme restyles the UI palette, editor, syntax highlighting in previews and AI code blocks, lint squiggles, and grid edit tints.",
          "**Accent color** tints buttons, selection, and focus states app-wide.",
          "**Editor / grid font** sets the monospace face in both editor and grid. Blank uses the built-in stack, JetBrains Mono first."
        ]
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
          "An **⬆ Update x.y.z** pill appears bottom-right on both the connect screen and the workspace.",
          "Click it for release notes and **Install & restart**: the signed artifact downloads with a progress bar, installs, relaunches.",
          "Failed checks — offline, dev build, no published release — are silent."
        ]
      },
      {
        "k": "list",
        "items": [
          "The **What's new** panel covers an update that already installed. It pops bottom-right on the first launch of a new version.",
          "It shows every section between the previous version and this build, read from the changelog bundled into the app.",
          "Dismiss it and it stays gone until the next update. A fresh install sees nothing.",
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
          "**Engine-level** — Postgres gets `SET default_transaction_read_only = on`; file-backed DuckDB opens with `AccessMode::ReadOnly`; SQLite with `SQLITE_OPEN_READ_ONLY`; MySQL applies `SET SESSION TRANSACTION READ ONLY` on every pooled connection; SQL Server has no session-level equivalent, so there the uniform client guard below is the whole enforcement — and that guard reads T-SQL's nested comments and `[bracket]` names the way the server does, so commented-out text can't disguise a write.",
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
        "md": "DuckDB, SQLite, MySQL, and SQL Server have no comparable permission catalog — Tusk reports them unenforced and adds no UI restrictions. The read-only layers above still apply."
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
        "md": "While a query runs, the Run button becomes **✕ Cancel** with a live elapsed counter. It sends a real **Postgres `CancelRequest`** over a fresh short-lived connection — the server actually stops the query; DuckDB fires its interrupt handle except on Windows, where unsafe interruption is disabled; SQLite, MySQL, and SQL Server have no out-of-band cancel, so their queries run to completion. Cancelling work inside a PostgreSQL manual transaction normally leaves it in **Recovery required** until `ROLLBACK` or `ROLLBACK TO`. Where no out-of-band cancel exists — SQLite, MySQL, SQL Server, DuckDB on Windows — the button doesn't pretend: it shows a disabled **Running** timer instead of a Cancel, and a cancel the backend rejects resets the button with the reason rather than hanging on *Cancelling…*. `Mod-F2` is the shipped shortcut (Ctrl+Esc is reserved by Windows) and works while typing and while dialogs are open."
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
        "md": "Streaming [[topic:import-export|exports and imports]] cancel the same way and clean up: a cancelled or failed export **deletes the partial file** (xlsx only writes at finish), and an import runs its `CREATE TABLE`, its optional clear and every insert batch in one transaction that **rolls back wholesale** — except on MySQL, where DDL commits itself, so a create-and-load import leaves the empty table behind and says so. (`COPY` is the PostgreSQL load path; the other engines batch multi-row `INSERT`s.) Ordinary multi-statement scripts get one transaction wrapper on every driver; MySQL DDL and nontransactional tables keep their native rollback limits."
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
    "blurb": "Recent release notes, newest first, plus how updates install themselves.",
    "id": "whats-new",
    "title": "What's new",
    "blocks": [
      {
        "k": "p",
        "md": "An **⬆ Update vX.Y.Z** pill appears bottom-right on both the connect screen and the workspace when a newer release is published."
      },
      {
        "k": "list",
        "items": [
          "**Check cadence** — the GitHub release manifest is checked ~3 seconds after launch, then every 5 minutes, plus once when the window regains focus after a full interval.",
          "**Install** — click the pill for release notes; **Install & restart** downloads the signed bundle with a progress bar and relaunches. On Windows the NSIS installer handles exit and restart.",
          "**Failed checks stay silent** — offline, dev build, or no published release.",
          "After the update, the first launch on the new version pops a **What's new** panel listing every release since the one previously installed, skipped versions included.",
          "It reads the changelog bundled into the build, so it needs no network. GitHub publishes its release notes from the same section.",
          "Dismiss it once and it stays gone until the next update. A fresh install stays quiet."
        ]
      },
      {
        "k": "tip",
        "kind": "tip",
        "md": "The updater shipped in v0.4.5, so an earlier install needs a fresh installer once before it can update itself."
      },
      {
        "k": "h",
        "text": "Unreleased — several databases at once, backups, SSH, SQL Server",
        "id": "v-unreleased"
      },
      {
        "k": "list",
        "items": [
          "**Open several databases at once.** Up to 16, one topbar chip each — driver mascot, database name, state dot (idle, running, transaction open, recovery required, session lost) — with **＋** to open the connect screen as a panel and **✕** to disconnect one. Each connection keeps its own result cursor, manual transaction, Explorer tree, autocomplete catalog, permissions, tabs and Cancel. Editor tabs are tagged with their connection and clicking one switches to it. [[kbd:Mod-Alt-ArrowRight]] / [[kbd:Mod-Alt-ArrowLeft]] move between them, [[kbd:Mod-Shift-n]] opens another. See [[topic:workspace|Workspace]].",
          "**Reopen last session.** The connect screen and the **＋** panel offer the saved connections open at last quit, in order. Anything that fails to reopen is named with its reason and stays in the offer. Ad-hoc connections are not remembered.",
          "**Backup and restore, built in.** Plain-SQL dumps written through the connected driver on all five engines, with no `pg_dump` or `mysqldump` to install. Right-click a database, schema or table for **Backup…**: scope, contents, optional `DROP … IF EXISTS`, single-transaction wrap, live object/row/byte counters, and Cancel. **Restore from file…** replays a dump statement by statement and names the first failure with its statement number and line. PostgreSQL streams `COPY` inside one repeatable-read snapshot; other engines emit batched `INSERT`s. See [[topic:backup|Backup & restore]].",
          "**Import is a guided flow, and export reaches the Explorer.** *Import data* runs **File → Columns → Run** on PostgreSQL, MySQL, SQLite and DuckDB: configurable delimiter, quote and escape, UTF-8 or Latin-1, skip-N-rows, a NULL placeholder, JSON arrays and NDJSON, xlsx with a sheet picker, name-matched column mapping, per-column *empty → NULL*, inferred types for a new table, and conflict handling (fail / skip / update). Parsing runs in Rust straight from disk. The Explorer gains **Export table…** / **Export tables…**; the export dialog gains a **Selection** scope, a reconstructed `CREATE TABLE` for plain-table SQL exports, and per-format option memory. See [[topic:import-export|Import & export]].",
          "**Build result filters visually.** A **Filter** button ([[kbd:Mod-Shift-f]]), *Filter by this column…* in the header menu, and the Explorer's *Filter rows…* open a tree of AND/OR groups. Twenty-one operators gated by the column's inferred class, up to eight levels and 200 conditions, with the `WHERE` shown live — then **Apply filter**, **Copy WHERE**, or **Open as query**. Active rules show as chips above the grid. See [[topic:results|Results grid]].",
          "**Reach a database through an SSH tunnel.** PostgreSQL, MySQL and SQL Server connections tunnel with Password, Private key, or SSH agent; the SSH client is built in and the secret goes to its own OS keychain entry. Host keys are checked against read-only `~/.ssh/known_hosts` and Tusk's own trust store: an unknown host shows its `SHA256:…` fingerprint before **Trust and connect**, a changed key is refused. See [[topic:getting-started|Connections & drivers]].",
          "**Microsoft SQL Server is a connectable driver.** Port 1433, SQL login, keychain password, the usual `sslmode` choices, results paged with `OFFSET`/`FETCH`. The Explorer shows schemas, tables and views with columns, indexes, constraints, triggers, sequences and routines; Copy DDL reconstructs tables from `sys.*` with foreign keys as trailing `ALTER`s. The editor lexes T-SQL — `[bracketed identifiers]`, `N'literals'`, nested block comments, `BEGIN … END`, `GO` batches — and manual transactions use `BEGIN TRANSACTION` / `SAVE TRANSACTION`, verified against `@@TRANCOUNT` and `XACT_STATE()`. ERD, in-grid editing, export, backup and restore work.",
          "**Not yet on SQL Server.** File import, the Explorer's DDL builders, the Slack bot and Explain are refused with the reason. Table Copy DDL needs SQL Server 2017 or later; stored view, procedure and function text still works on older servers.",
          "**Table editing on every engine that can express it.** *Create table…* covers types, NOT NULL, defaults, single or composite keys, unique, check, and each engine's auto-numbering, with a searchable picker for foreign keys. *Modify table…* reorders columns, adds UNIQUE/CHECK/FK constraints, drops each kind with that engine's own action, and refuses an empty or duplicate name, a nullable primary key, or a generated column. SQLite rebuilds the table — create, `INSERT … SELECT`, drop, rename, recreate indexes and triggers — in one transaction, under a **Rebuild table** button. See [[topic:sidebar|Schema explorer & DDL]].",
          "**Safer defaults.** Deleting a saved connection asks first and takes its keychain password with it. **Try to continue** after an error no longer connects the connect-on-startup profile. A file picker that resolves without appearing is confirmed rather than written to. Slack autostart binds to one saved connection and waits for it. On SQL Server, a query ending in `ORDER BY` can still be sorted and filtered, with the ordering moved onto the wrapper."
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
          "**Run selection or current statement honors the exact selection.** [[kbd:Mod-Shift-Enter]] and its palette action used to resolve the whole statement under the cursor, so selecting an inner `SELECT` inside `WITH … UPDATE` could run the update. A non-blank selection now wins, including a backwards one.",
          "**Explain and grid reruns fail closed on ambiguous SQL.** Explain refuses multi-statement selections, and the shared CTE classifier handles engine-specific forms and treats `SELECT … INTO` as a write. Explain Analyze confirmation, backend streaming, and grid sort/filter wrapping share that decision."
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
          "**`WITH … UPDATE` / `INSERT` / `DELETE` / `MERGE` execute correctly.** A `WITH` statement was classified by its first word and wrapped in a cursor, drawing `syntax error at or near \"UPDATE\"`. Tusk now classifies by the statement the CTEs feed: one ending in `SELECT`/`TABLE`/`VALUES` streams, one ending in a write reports rows affected, and a write CTE takes the plain path.",
          "**Explain Analyze on a `WITH … UPDATE` asks first**, like any other write — see [[topic:plans|EXPLAIN plans]]."
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
          "**Settings → AI has one model list per provider.** Each card is **Connection** (API key, API base, custom-origin approval, Test connection, Get a key / Remove key) and **Models**, a searchable list fetched live from the provider when the card opens. A row's checkbox decides whether the chat picker and the Slack bot offer that model; **★** marks the default. Tiers and the Default-model dropdown are gone; unlisted ids can be typed in. See [[topic:ai|AI assistant]].",
          "**Sample-row sharing and Reply max tokens** moved into an **Assistant** group.",
          "**Settings → Slack is reorganized:** a status card, then Slack app tokens, Who can ask, Answers, and AI. The AI group flags when the bot is behind Settings → AI and offers **Update bot**. See [[topic:slack|Slack bot]].",
          "**Panning the ERD or the plan canvas no longer selects text.** The DDL pane beside the graph stays selectable.",
          "**Dragging in the Schema Explorer no longer highlights text.**"
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
          "**Incomplete results are marked.** Expanding a table, refreshing the schema, sidebar DDL, an all-rows export, an import, the ERD/DDL viewer, or a run in another tab closes the one server cursor a streaming result depends on. That tab now shows an **Incomplete result** badge and a `N rows loaded · …` status naming the cause, in-memory sort is off for it, and Export labels its rows incomplete.",
          "Table info for in-grid editing is fetched **before** a query runs; fetching it afterwards truncated every editable result at the first page.",
          "**Numeric columns sort by value** in a fully loaded result — integers exactly at any size, decimals and scientific notation as numbers, `NaN` last. Any non-numeric value keeps text order. See [[topic:results|Results]].",
          "**A sort click that can't apply says why** in the status line."
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
          "SQL pasted from web pages carries **non-breaking spaces, zero-width characters, or curly quotes**, which the server reads as identifier characters. The offline linter squiggles each one with its code point, and one quick-fix ([[kbd:Tab]] / [[kbd:Alt-Enter]]) cleans the whole document. String literals are left alone."
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
          "Non-token [[topic:slack|Slack]] settings — sample-row sharing, allowlists, row caps, timeout, charts, write policy, reply max tokens — save on change. The Save button remains for tokens."
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
          "The **What's-new panel** appears on the first update that ships it, even for pre-0.9.1 installs, and is summonable from the command palette.",
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
        "items": [
          "Post-update **What's new** panel: bundled changelog, offline, dismiss-once, reopenable from the command palette.",
          "**AI reply max tokens** on the desktop (Settings → AI, 256–128,000), the same knob the Slack bot honors.",
          "Cancel is honest per engine: a **Running** timer where cancel is impossible (SQLite, MySQL, SQL Server, DuckDB on Windows), a rejected cancel reports why, default [[kbd:Mod-F2]].",
          "Engine-aware editor lexing — MySQL `#` comments and backslash escapes, backticks on MySQL/SQLite, T-SQL brackets, nested comments and `GO` — and one shared active-schema resolver for completion, lint, and grid editing.",
          "`WHERE a = 1, b = 2` squiggles instantly.",
          "Grid **Copy as X** is byte-identical to Export; empty strings stay distinct from NULL.",
          "Explorer DDL and full-query exports land in history as `-- [Explorer]` / `-- [Export]`.",
          "Slack: TSV and SQL-insert exports, attachments named after the queried table, 5 sample tables."
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
          "Manual transactions own one session across runs: owner bar, frozen non-owner tabs, per-engine savepoints and `SET TRANSACTION`, MySQL `SET autocommit=0` — see [[topic:editor|the editor topic]].",
          "Explicit **AI destination consent**: keys are origin-bound in the keychain, and unapproved custom bases fail closed everywhere, Slack included.",
          "Stricter read-only — writable CTEs, row locks, `SELECT … INTO`, `EXPLAIN ANALYZE` — and no automatic statement replay after a dropped connection.",
          "Explicit shape and byte budgets across queries, exports, plans, ERD, AI streams, Slack, history, and crash reports.",
          "Atomic file exports: the destination is replaced only on success, and zero rows still produce a valid file.",
          "Revision-safe tabs, files, and history; sample sharing fails closed when its preference cannot be stored.",
          "Slack approvals are single-use capabilities; result exports are requester-only.",
          "Fixed: window close, cross-tab runs after a multi-page result, and a cancel race that could brick the cancel registry."
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
          "**Ten AI providers, one key each.** Anthropic, OpenAI, Gemini, OpenCode Go, OpenCode Zen, OpenRouter, Groq, Ollama, LM Studio, and a generic OpenAI-compatible entry, each with its own OS-keychain entry. Managed in **Settings → AI**, with a **Test connection** button that calls the provider.",
          "**Skills.** Markdown instructions the assistant follows every time, scoped to the workspace or one database. Create, edit, import, export. The [[topic:slack|Slack bot]] follows them too. See [[topic:ai|Skills]].",
          "**Searchable model picker** — fuzzy and multi-term (`ant opus`).",
          "**The AI knows the foreign keys.** The join graph reaches the model as authoritative instead of guessing from naming convention.",
          "**Stop and Retry.** ⏹ Stop or [[kbd:Escape]] interrupts the live stream; a reply that dies mid-sentence restarts itself once.",
          "Fixed: provider errors arriving mid-stream were ignored, so a failed reply looked like a finished one.",
          "Fixed: native dropdown popups were unreadable in every dark theme.",
          "Fixed: DuckDB `TIMESTAMPTZ` casts failed on a fresh machine; the ICU extension is now installed on demand, not merely loaded."
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
          "**Collapsible panels** — hide the Explorer ([[kbd:Mod-b]]) or the results panel ([[kbd:Mod-j]]); running a query reopens the results, and panel sizes clamp to the window.",
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
        "md": "A **Slack bot hosted inside the desktop app** over Socket Mode: outbound WebSocket only, no server or public endpoint, and a Slack app of your own from the manifest in `docs/slack-setup.md`. Full walkthrough: [[topic:slack|Slack integration]]."
      },
      {
        "k": "list",
        "items": [
          "DM or `@mention` the bot with a question; the AI proposes SQL with **Approve / Reject** buttons. Only the requester can click, and proposals expire after 5 minutes.",
          "Approved queries are read-only by construction: one wrappable read, mutation/output/lock scans, executable-comment rejection, a conservative deterministic-function allowlist, a hard row cap, and a fresh engine-enforced read-only backend. SQL Server connections are refused for that reason. See [[topic:safety|Safety]].",
          "Results reply in-thread as an inline table, a CSV/XLSX attachment, or a chart rendered locally through plotters with an embedded font. Ask for a shape (\"as a bar chart, months on x\") and the AI's chart spec sets type, axes and series; date+numeric results auto-chart under a Settings toggle, default on.",
          "Every result carries **Export as… CSV / TSV / Excel / JSON / SQL / Markdown**; results cache for 15 minutes and are requester-only.",
          "Every approved run lands in [[topic:history|query history]] with a `-- [Slack] asked by <user>` marker.",
          "Configure in **Settings → Slack**; tokens go to the OS keychain and the statusbar shows a live 🟢 Slack badge.",
          "Fixed: DuckDB `CAST(timestamptz_col AS DATE)` failed with \"Unimplemented type for cast\"; the ICU extension now loads on every connection."
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
          "**0.6.2** — DuckDB `DATE`, `TIMESTAMP`, `TIME`, `DECIMAL`, `HUGEINT`, `INTERVAL`, and nested lists/structs render readably instead of raw internals like `Date32(19797)`.",
          "**0.6.1** — DuckDB `EXPLAIN` / `EXPLAIN ANALYZE` [[topic:plans|plan trees]] show rows, timing, and heat coloring; both JSON shapes parse and heat falls back cost → time → rows.",
          "**0.6.0** — [[topic:sidebar|Sidebar]] DDL editing on **DuckDB**: create/modify/rename/drop tables, column changes, indexes, comments, truncate, schemas, CTAS duplicate. Unsupported actions are disabled with a tooltip. Update checks moved from every 6 hours to every 5 minutes."
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
          "**0.5.1** — DuckDB pinned to the stable 1.4.x line. A file-backed DuckDB releases its exclusive OS lock while idle and re-acquires it on the next command; `:memory:` stays open.",
          "**0.5.0** — the updater re-checks periodically instead of only at startup, and the object tree builds faster on wide MySQL/DuckDB schemas."
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
          "**[[topic:grid-editing|In-grid data editing]]** — a single-table SELECT with the full primary key becomes editable on every driver. Edits, delete marks and new rows stage until **Commit…** previews the UPDATE/DELETE/INSERT script and runs it atomically, or **Apply…** joins an owner transaction. Later releases added clipboard paste, boolean pills, and insert rows pinned to the top.",
          "**Parameter prompts** — `$1` or `:name` open a per-parameter dialog (value, NULL, or raw splice) with live preview; values are remembered per tab.",
          "**FK-aware JOIN completion** — after `JOIN orders o ON `, the [[topic:editor-intel|editor]] proposes complete join conditions from the live foreign-key catalog.",
          "**Manual transactions** — raw BEGIN/START, COMMIT/END, ROLLBACK/ABORT, savepoints, supported SET TRANSACTION forms, and MySQL autocommit-off own one tab and session across runs, with a transaction bar, frozen non-owner work, grid Apply vs outer Commit, provenance invalidation, and failed/lost recovery.",
          "**Every-driver parity** — app-owned multi-statement wrappers on all four engines, per-dialect grid sort/filter SQL for MySQL/SQLite, streaming [[topic:import-export|export]] on every driver, saved profiles for DuckDB/SQLite/MySQL.",
          "**AI upgrades** — model pickers list each provider's live catalog, schema context is relevance-ranked instead of truncated, and the [[topic:ai|assistant]] can fetch sample rows after explicit opt-in, default off.",
          "**Appearance** — six new themes, a refreshed app icon, responsive toolbars, and resizable docked panels with persisted sizes ([[topic:workspace|Workspace]]).",
          "**Sidebar QoL** — row estimates and sizes on Postgres tables, trigger listings, *Filter rows…* opening a table with the filter row shown, and reliable double-click-to-run."
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
          "**[[topic:plans|EXPLAIN plan visualization]]** — a pan/zoomable plan tree with per-node cost, rows and time, heat coloring, per-engine parsers, and an **Explain ▾** toolbar action. Unparseable output falls back to styled text.",
          "**[[topic:erd|DDL & relationships viewer]]** — right-click a table for reconstructed DDL plus a Neighborhood FK graph, or a schema node for the whole-schema ERD with deterministic layout, colored edges, and drag-to-reposition.",
          "**[[topic:history|Query history]]** — every user-issued run recorded per connection, excluding grid sort/filter re-runs; search, re-run, open in tab; capped at 500 entries.",
          "**Command palette** ([[kbd:Mod-k]]) and **[[topic:shortcuts|rebindable shortcuts]]** — every action in one registry, with conflict warnings when capturing a chord.",
          "**Settings dialog, light theme, font and accent customization**, plus schema lint for unknown columns, tables, functions and clause-keyword typos, each with a did-you-mean quick-fix."
        ]
      },
      {
        "k": "h",
        "text": "Older releases",
        "id": "older"
      },
      {
        "k": "p",
        "md": "Everything back to the first Postgres-only builds is documented release-by-release in `CHANGELOG.md` at the repository root."
      }
    ],
    "icon": "star"
  }
];
