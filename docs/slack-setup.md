# Setting up the Slack integration

Tusk's Slack bot runs **inside the desktop app** (Socket Mode — an outbound WebSocket,
no server, no public URL). It answers plain-language questions with a proposed SQL
query; nothing runs until someone clicks **✅ Approve**, and only single read-only
SELECTs ever run. The bot works while Tusk is open, against the active connection.

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
3. Configure the AI provider/model in the **AI panel** first if you haven't — the
   Slack bot uses the same provider/model/key (Save on the Slack tab mirrors it).
4. Toggle **Enable Slack bot**. The statusbar shows `🟢 Slack` when connected.

## 4. Use it

- **DM the bot**: "show all tables in the public schema"
- **In a channel**: invite the bot, then `@tusk top 10 products by revenue last month`
- The bot posts the proposed SQL with **Approve / Reject** buttons. Only the person
  who asked can click them. Proposals expire after 5 minutes.
- Reply **in the thread** to refine: "now filter to Q3 only".
- Small results render inline; bigger ones attach as CSV/XLSX. Every result also
  gets **Export as… CSV / Excel / JSON / Markdown** buttons (valid 15 minutes).
- **Charts render locally inside Tusk** (no external service — nothing leaves your
  machine). Ask explicitly — "chart monthly revenue as a bar chart, months on the
  x-axis" — and the type/axes/labels you name are honored (line, bar, scatter, pie).
  Date+numeric results also auto-chart (toggle in Settings → Slack).

## Notes & limits

- The bot needs Tusk **running and connected**; it uses the active connection.
- **Destructive SQL cannot run from Slack, period.** Enforcement is layered and
  independent of the AI: single statement only; must start as a read statement;
  a masked keyword scan rejects insert/update/delete/merge/drop/alter/truncate/
  create/grant/revoke *anywhere* in the statement (writable CTEs, smuggled DDL,
  and `FOR UPDATE` row locks included) — checked when the proposal is made AND
  again at execution; plus a subquery LIMIT cap, a query timeout with real
  server-side cancel, and a server-enforced read-only transaction on Postgres.
  Asking the bot to "drop X" gets — per the **"When asked for writes/DDL"**
  setting — either a read-only preview of the affected data (default) or a
  refusal, both pointing you to the Tusk editor for the real change.
- Every Slack-approved query lands in Tusk's query history with a
  `-- [Slack] asked by <user>` marker.
- Access control: optional channel/user allowlists in Settings → Slack (IDs,
  comma-separated).
