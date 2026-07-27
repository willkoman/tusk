# Setting up the Slack integration

Tusk's Slack bot runs **inside the desktop app** (Socket Mode — an outbound WebSocket,
no server, no public URL). It answers plain-language questions with a proposed SQL
query; nothing runs until the requester clicks **✅ Approve**, and only one wrappable
read (`SELECT` / `WITH` / `TABLE` / `VALUES`) using a conservative built-in-function
policy can run. The bot works while
Tusk is open and pins each proposal to the exact active connection and database that
supplied its context.

**You create your own Slack app** — Tusk never ships a shared one. This keeps your
tokens yours and (as an internal, customer-built app) keeps full Slack API access
under Slack's 2025 non-Marketplace rate-limit rules.

## 1. Create the app (from a manifest)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, paste this manifest (YAML), and create:

```yaml
display_information:
  name: Tusk
  description: Ask your database questions — SQL proposed by AI, approved by you.
  background_color: "#2b6cb0"
features:
  bot_user:
    display_name: tusk
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write        # post proposals + results
      - files:write       # CSV/XLSX/chart attachments
      - app_mentions:read # @tusk in channels
      - im:history        # DMs to the bot + thread follow-ups in DMs
      - im:write          # reply in DMs
      - channels:history  # thread follow-ups in public channels (optional)
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true      # required for the Approve/Reject buttons
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

## 2. Get the two tokens

1. **App-level token** (`xapp-…`): Basic Information → App-Level Tokens →
   Generate Token → add the **`connections:write`** scope. Copy it.
2. **Install** the app: OAuth & Permissions → **Install to Workspace**.
   Copy the **Bot User OAuth Token** (`xoxb-…`).

## 3. Configure Tusk

1. Settings (gear) → **Slack** tab.
2. Paste both tokens → **Test connection** (validates both and names the workspace).
3. Configure the AI provider/model in **Settings → AI** first if you haven't — the
   Slack bot uses the same provider/model/key (Save on the Slack tab mirrors it).
4. Decide whether to enable **Share sample rows with AI**. It is off by default; when
   enabled, up to five rows from each of up to five relevant tables are sent to the
   configured provider.
5. Toggle **Enable Slack bot**. The statusbar shows `🟢 Slack` when connected.

## 4. Use it

- **DM the bot**: "show all tables in the public schema"
- **In a channel**: invite the bot, then `@tusk top 10 products by revenue last month`
- The bot posts the proposed SQL with **Approve / Reject** buttons. Only the person
  who asked can click them. Proposals expire after 5 minutes and are single-use.
- Reply **in the thread** to refine: "now filter to Q3 only".
- Small results render inline; bigger ones attach as CSV/XLSX. Every result also
  gets **Export as… CSV / Excel / JSON / Markdown** buttons (requester-only and valid
  for 15 minutes from the exact result message).
- **Charts render locally inside Tusk** (no external chart service); the resulting PNG
  is uploaded to your Slack workspace like other results. Ask explicitly — "chart monthly revenue as a bar chart, months on the
  x-axis" — and the type/axes/labels you name are honored (line, bar, scatter, pie).
  Date+numeric results also auto-chart (toggle in Settings → Slack).

## Notes & limits

- The bot needs Tusk **running and connected**. A proposal records the connection id
  and server-reported database used to build it; switching/disconnecting before approval
  rejects the action and asks the user to submit the question again.
- **Destructive SQL cannot run from Slack, period.** Enforcement is layered and
  independent of the AI: single wrappable read only;
  a masked keyword scan rejects insert/update/delete/merge/replace/drop/alter/
  truncate/create/grant/revoke, output/lock forms, and row locks *anywhere* in the
  statement (including writable CTEs and smuggled DDL) — checked when the proposal
  is made AND again at execution. Unknown, quoted, user-defined, or schema-qualified
  routines and MySQL executable comments are also blocked; only a conservative set
  of common deterministic analytics functions is allowed. Execution adds a subquery
  LIMIT cap and a fresh engine-enforced read-only connection.
  Asking the bot to "drop X" gets — per the **"When asked for writes/DDL"**
  setting — either a read-only preview of the affected data (default) or a
  refusal, both pointing you to the Tusk editor for the real change.
- Every Slack-approved query lands in Tusk's query history with a
  `-- [Slack] asked by <user>` marker.
- Access control: optional channel/user allowlists in Settings → Slack (IDs,
  comma-separated).
- Approval/export values are random 128-bit capabilities but are never trusted alone:
  Tusk also checks the requester, current allowlists, workspace, channel, thread, and
  exact source message. Copying a button value to another message is inert.
- PostgreSQL timeouts request a real server-side cancellation. MySQL timeout stops
  waiting but the isolated read-only query may still finish server-side. DuckDB/SQLite
  calls are synchronous, so timeout cannot preempt work already inside the engine;
  in-memory embedded databases are refused because a second connection would not see
  the same database. An active DuckDB UI stream must finish first and is never closed
  by Slack.
- Settings ranges: inline rows `1..100`, file/hard-cap rows `100..100,000`, timeout
  `1..600` seconds, and AI output `256..128,000` tokens. Non-token changes apply on
  the next question. Saving replacement tokens validates and restarts a running bot;
  a failed restart stops and disables it.
