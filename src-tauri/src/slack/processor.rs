//! Slack event processing: question → AI proposal → approval → execution → result.
//! Events are handled sequentially (the plan's "one query at a time" invariant), and
//! every DB touch goes through the same `lock_conn`/`ensure_alive` path as the UI.

use super::api::SlackApi;
use super::approval::PendingProposal;
use super::blocks;
use super::chart::{self, ChartSpec};
use super::config::SlackConfig;
use super::context::{self, SampleTable, SlackAiCtx};
use super::format::{self, ResultFormat};
use super::socket::SlackEvent;
use super::SlackRuntime;
use crate::db::{AppError, QueryOutcome};
use crate::{ai, script};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

pub async fn handle_event(app: &AppHandle, api: &SlackApi, cfg: &SlackConfig, ev: SlackEvent) {
    let runtime = app.state::<SlackRuntime>();
    match ev {
        SlackEvent::Connected => {
            runtime.set_status("connected", None);
            let _ = app.emit("slack:status", runtime.status_info());
        }
        SlackEvent::Disconnected(err) => {
            runtime.set_status("connecting", Some(err));
            let _ = app.emit("slack:status", runtime.status_info());
        }
        SlackEvent::Message { channel, user, text, thread_ts, ts } => {
            if !allowed(cfg, &channel, &user) {
                return;
            }
            handle_question(app, api, cfg, channel, user, text, thread_ts, ts).await;
        }
        SlackEvent::Interaction { payload } => {
            handle_interaction(app, api, cfg, payload).await;
        }
    }
}

fn allowed(cfg: &SlackConfig, channel: &str, user: &str) -> bool {
    if !cfg.allowlist_channels.is_empty() && !cfg.allowlist_channels.iter().any(|c| c == channel) {
        return false;
    }
    if !cfg.allowlist_users.is_empty() && !cfg.allowlist_users.iter().any(|u| u == user) {
        return false;
    }
    true
}

#[allow(clippy::too_many_arguments)]
async fn handle_question(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    channel: String,
    user: String,
    text: String,
    thread_ts: Option<String>,
    ts: String,
) {
    // Always answer in a thread: the incoming message's thread, or start one on it.
    let thread = thread_ts.clone().unwrap_or_else(|| ts.clone());
    let thinking_ts = match api
        .post_message(&channel, "Generating query…", Some(blocks::thinking_card()), Some(&thread))
        .await
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tusk-slack] post failed: {}", e.message);
            return;
        }
    };

    match generate_proposal(app, api, cfg, &channel, &text, thread_ts.as_deref()).await {
        // The AI answered without SQL (destructive ask refused, clarification, …) —
        // that's a normal reply, not an error.
        Ok(Proposal::Reply(reply)) => {
            let _ = api
                .update_message(&channel, &thinking_ts, &reply, blocks::status_card(&reply))
                .await;
        }
        Ok(Proposal::Sql { explanation, sql, chart: chart_spec }) => {
            let runtime = app.state::<SlackRuntime>();
            let id = runtime.approvals.new_id();
            // The proposal card advertises the chart request so the approver
            // knows a chart (with these particulars) will be rendered.
            let shown = match &chart_spec {
                Some(spec) => format!("{explanation}\n📊 {}", spec.describe()),
                None => explanation.clone(),
            };
            runtime.approvals.insert(PendingProposal {
                id: id.clone(),
                sql: sql.clone(),
                explanation: shown.clone(),
                chart: chart_spec,
                channel: channel.clone(),
                user,
                thread_ts: thread,
                message_ts: thinking_ts.clone(),
                created: std::time::Instant::now(),
            });
            // Fallback text carries the SQL so thread-history reads see the proposal.
            let _ = api
                .update_message(
                    &channel,
                    &thinking_ts,
                    &format!("Proposed query: {sql}"),
                    blocks::proposal_card(&shown, &sql, &id),
                )
                .await;
        }
        Err(e) => {
            let _ = api
                .update_message(&channel, &thinking_ts, &e.message, blocks::error_card(&e.message))
                .await;
        }
    }
}

/// What the AI produced for a question.
enum Proposal {
    /// A runnable (validated read-only) query + optional chart request.
    Sql { explanation: String, sql: String, chart: Option<ChartSpec> },
    /// A plain reply with no SQL — e.g. a refusal of a destructive ask.
    Reply(String),
}

/// Build context from the live connection, call the AI once, extract + validate the
/// SQL (and any explicitly requested chart spec).
async fn generate_proposal(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    channel: &str,
    question: &str,
    thread_ts: Option<&str>,
) -> Result<Proposal, AppError> {
    if cfg.ai_provider.is_empty() || cfg.ai_model.is_empty() {
        return Err(AppError::new(
            "no AI provider configured for Slack — open Tusk Settings → Slack and save (it mirrors the AI panel's provider/model)",
        ));
    }

    // Conversation context from the thread (internal apps keep Tier-3 access).
    let mut messages: Vec<ai::Msg> = Vec::new();
    let mut focus = question.to_string();
    if let Some(t) = thread_ts {
        if let Ok(replies) = api.thread_replies(channel, t, 10).await {
            for m in &replies {
                let text = m["text"].as_str().unwrap_or_default();
                if text.is_empty() || text.starts_with("Generating query") {
                    continue;
                }
                let from_bot = m["bot_id"].as_str().is_some();
                if !from_bot {
                    focus.push(' ');
                    focus.push_str(text);
                }
                messages.push(ai::Msg {
                    role: if from_bot { "assistant".into() } else { "user".into() },
                    content: text.to_string(),
                });
            }
        }
    }
    // Guarantee the question is the final user turn (thread fetch may race or fail).
    let ends_with_question = matches!(messages.last(), Some(m) if m.role == "user" && m.content == question);
    if !ends_with_question {
        messages.push(ai::Msg { role: "user".into(), content: question.to_string() });
    }

    // Snapshot schema/permissions/samples under the connection lock, then RELEASE it
    // before the (slow) AI call so the UI is never blocked on a Slack question.
    let system = {
        let state = app.state::<crate::AppState>();
        let (_id, conn) = state.active()?;
        let mut c = crate::lock_conn(&conn).await;
        crate::ensure_alive(&mut c).await?;
        let caps = c.backend.capabilities();
        let perms = c.backend.permissions().await.unwrap_or_else(|_| crate::perms::Permissions::unrestricted());
        let tables = c.backend.list_tables().await?;
        let mut samples: Vec<SampleTable> = Vec::new();
        for t in context::relevant_tables(&tables, &focus, 3) {
            // Best-effort grounding rows; sample_rows never touches the streaming cursor.
            if let Ok((columns, rows)) = c.backend.sample_rows(&t.schema, &t.name, 5).await {
                samples.push(SampleTable { schema: t.schema.clone(), name: t.name.clone(), columns, rows });
            }
        }
        // The join graph, for the schemas the question actually touches (plus `public`).
        // Without it the model guesses join columns — the same reason the editor's
        // autocomplete feeds these edges to its JOIN hints.
        //
        // Order matters: keep RELEVANCE order and dedupe in place, then truncate. Sorting
        // alphabetically before `take(3)` would drop the focus table's own schema (`sales`)
        // in favour of whatever sorts first (`analytics`), and `fks_known` would then be
        // true for a schema we never looked at — the model is told "no foreign keys" and
        // silently invents a join condition.
        let relevant = context::relevant_tables(&tables, &focus, 3);
        let mut fk_schemas: Vec<String> = Vec::new();
        for t in &relevant {
            if !fk_schemas.contains(&t.schema) {
                fk_schemas.push(t.schema.clone());
            }
        }
        if !fk_schemas.iter().any(|s| s == "public") {
            fk_schemas.push("public".to_string());
        }
        fk_schemas.truncate(3);

        let mut fks: Vec<crate::relgraph::FkEdge> = Vec::new();
        let mut fetched: Vec<&String> = Vec::new();
        for s in &fk_schemas {
            if let Ok(g) = c.backend.schema_relationships(s).await {
                fetched.push(s);
                fks.extend(g.edges);
            }
        }
        // A cross-schema FK is returned by BOTH endpoints of the relationship, so the
        // concatenation above can list the same edge twice.
        fks.sort_by(|a, b| {
            (&a.src_schema, &a.src_table, &a.constraint).cmp(&(&b.src_schema, &b.src_table, &b.constraint))
        });
        fks.dedup_by(|a, b| a.constraint == b.constraint && a.src_schema == b.src_schema && a.src_table == b.src_table);

        // Only claim knowledge of the graph when EVERY schema the question touches was
        // actually read. Anything less and the prompt must stay silent about foreign keys.
        let fks_known = !relevant.is_empty()
            && relevant.iter().all(|t| fetched.iter().any(|s| **s == t.schema));
        let ctx = SlackAiCtx {
            dialect: caps.kind.to_string(),
            user: perms.current_user.clone(),
            is_superuser: perms.is_superuser,
            permissions_enforced: perms.enforced,
            destructive_policy: cfg.destructive_policy.clone(),
        };
        context::build_system_prompt(&ctx, &tables, &focus, &samples, &fks, fks_known)
    };

    let req = ai::AiRequest {
        provider: cfg.ai_provider.clone(),
        // Empty on pre-registry configs — `AiRequest::wire()` then derives it from the
        // provider name, preserving the old behaviour for anthropic/openai/gemini.
        wire: (!cfg.ai_wire.is_empty()).then(|| cfg.ai_wire.clone()),
        model: cfg.ai_model.clone(),
        base_url: cfg.ai_base_url.clone(),
        system: Some(system),
        messages,
        max_tokens: Some(cfg.ai_max_tokens),
        request_id: None, // nothing on the Slack side can cancel a completion
        allow_no_key: cfg.ai_allow_no_key,
    };
    // Transient provider failures are replayed inside `complete_one_shot`; a real error
    // (or an empty response) bubbles up here and reaches the user as an error card. It
    // must NEVER be quietly re-labelled as "I can't help with that" — that told a user
    // the bot couldn't write their query when the provider had actually fallen over.
    let ai::Completion { text: response, truncated } = ai::complete_one_shot(&req).await?;

    let sql_blocks = context::extract_sql_blocks(&response);
    let Some(first) = sql_blocks.first() else {
        // A `max_tokens` stop cuts the reply mid-sentence, leaving the ```sql fence
        // unclosed — block extraction then finds nothing. That's a truncation, not a
        // refusal, and it needs a fix the user can act on.
        if truncated {
            return Err(AppError::new(format!(
                "the AI's answer was cut off at the {} token limit before it finished the query — raise “Max tokens” in Settings → Slack, or ask something narrower",
                cfg.ai_max_tokens
            )));
        }
        // No SQL and a complete reply — the model refused (destructive ask) or
        // answered in prose. Relay its own words.
        return Ok(Proposal::Reply(response.trim().to_string()));
    };
    let sql = first.trim_end_matches(';').trim().to_string();
    let explanation = response
        .split("```")
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let explanation = if explanation.is_empty() { "Proposed query:".to_string() } else { explanation };

    // An explicit chart request rides along as a tagged ```chart block.
    let chart_spec = context::extract_chart_block(&response).and_then(|b| ChartSpec::parse(&b));

    // Safety gate: exactly one read-only statement, no mutation keywords anywhere
    // (masked scan — catches writable CTEs / smuggled DDL / row locks). The same
    // gate re-runs at execution time; the AI's SQL is never trusted.
    validate_read_only(&sql)?;
    Ok(Proposal::Sql { explanation, sql, chart: chart_spec })
}

/// Mutation keywords that must never appear ANYWHERE in a Slack-run statement —
/// not just at the start. Catches writable CTEs (`WITH x AS (DELETE …) SELECT`),
/// smuggled DDL, and `FOR UPDATE` row locks. Scanned over MASKED sql (strings,
/// comments, dollar-quotes, quoted identifiers blanked), word-boundary matched.
/// A false positive (a bare column literally named `delete`) safely degrades to
/// "run it in the Tusk editor".
const MUTATION_WORDS: [&str; 10] =
    ["insert", "update", "delete", "merge", "drop", "alter", "truncate", "create", "grant", "revoke"];

/// Blank out string literals, quoted identifiers, comments, and dollar-quoted
/// bodies so keyword scanning can't be fooled by values like 'DROP TABLE…'.
fn mask_sql(sql: &str) -> String {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = vec![b' '; n];
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        // line comment
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // block comment
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        // quoted string / identifier (with doubled-quote escapes)
        if c == b'\'' || c == b'"' || c == b'`' {
            let q = c;
            i += 1;
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // dollar-quoted body ($tag$ … $tag$; $1 is a param, not a tag)
        if c == b'$' {
            if let Some(tag_end) = dollar_tag_end(b, i) {
                let tag = &b[i..tag_end];
                let mut j = tag_end;
                while j + tag.len() <= n && &b[j..j + tag.len()] != tag {
                    j += 1;
                }
                i = (j + tag.len()).min(n);
                continue;
            }
        }
        out[i] = c.to_ascii_lowercase();
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    let mut j = i + 1;
    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    (j < n && b[j] == b'$' && (j == i + 1 || !b[i + 1].is_ascii_digit())).then_some(j + 1)
}

/// The first mutation keyword found anywhere in the (masked) statement, if any.
/// (`FOR UPDATE` row locks are caught by "update"; `FOR SHARE` checked separately.)
fn find_mutation_word(sql: &str) -> Option<&'static str> {
    let masked = mask_sql(sql);
    for token in masked.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if let Some(w) = MUTATION_WORDS.iter().find(|w| **w == token) {
            return Some(w);
        }
    }
    masked.contains(" for share").then_some("share")
}

/// A statement that can be wrapped as a derived table `SELECT * FROM (<it>) …`.
/// `is_read_only_stmt` also admits SHOW/EXPLAIN, which are read-only but CANNOT be a
/// subquery — Slack wraps every query in a LIMIT subselect, so those must be rejected
/// at the gate (else execution fails with a confusing parser error).
fn is_wrappable_read(sql: &str) -> bool {
    let t = script::effective_start(sql).to_ascii_lowercase();
    let first: String = t.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    matches!(first.as_str(), "select" | "with" | "table" | "values")
}

fn validate_read_only(sql: &str) -> Result<(), AppError> {
    let items = script::split(sql);
    let single = match items.as_slice() {
        [script::Item::Sql(s)] => s.trim().to_string(),
        _ => {
            return Err(AppError::new(
                "I can only run a single read-only SELECT from Slack. Open the query in Tusk to run it.",
            ))
        }
    };
    if !crate::is_read_only_stmt(&single) || !is_wrappable_read(&single) {
        return Err(AppError::new(
            "I can only run read-only SELECT queries from Slack (no EXPLAIN/SHOW/DDL). Open the query in Tusk to run it.",
        ));
    }
    if let Some(w) = find_mutation_word(&single) {
        return Err(AppError::new(format!(
            "blocked: the statement contains `{w}` — Slack only runs read-only SELECTs (no DML/DDL, no writable CTEs, no row locks). Run it in the Tusk editor instead.",
        )));
    }
    Ok(())
}

async fn handle_interaction(app: &AppHandle, api: &SlackApi, cfg: &SlackConfig, payload: serde_json::Value) {
    if payload["type"].as_str() != Some("block_actions") {
        return;
    }
    let action = &payload["actions"][0];
    let value = action["value"].as_str().unwrap_or_default();
    let user = payload["user"]["id"].as_str().unwrap_or_default().to_string();
    let channel = payload["channel"]["id"].as_str().unwrap_or_default().to_string();
    let (verb, id) = match value.split_once(':') {
        Some(x) => x,
        None => return,
    };

    // Export buttons: "export:{fmt}:{result_id}". Not requester-gated — the result is
    // already visible in the channel; a click just reformats it. Allowlist still applies.
    if verb == "export" {
        if !allowed(cfg, &channel, &user) {
            return;
        }
        let Some((fmt, result_id)) = id.split_once(':') else { return };
        let thread_ts = payload["message"]["thread_ts"]
            .as_str()
            .or(payload["message"]["ts"].as_str())
            .map(str::to_string);
        handle_export(app, api, &channel, &user, fmt, result_id, thread_ts.as_deref()).await;
        return;
    }

    let runtime = app.state::<SlackRuntime>();
    match runtime.approvals.owner(id) {
        None => {
            let _ = api
                .post_ephemeral(&channel, &user, "⏰ This proposal has expired — ask the question again.")
                .await;
            return;
        }
        Some(owner) if owner != user => {
            let _ = api
                .post_ephemeral(&channel, &user, "Only the requester can approve or reject this query.")
                .await;
            return;
        }
        Some(_) => {}
    }
    let Some(prop) = runtime.approvals.take(id) else { return };

    if verb == "reject" {
        let _ = api
            .update_message(
                &prop.channel,
                &prop.message_ts,
                "Query rejected",
                blocks::resolved_proposal_card(&prop.explanation, &prop.sql, "❌ Rejected"),
            )
            .await;
        return;
    }
    if verb != "approve" {
        return;
    }

    let _ = api
        .update_message(
            &prop.channel,
            &prop.message_ts,
            "Running query…",
            blocks::resolved_proposal_card(&prop.explanation, &prop.sql, "⏳ Running…"),
        )
        .await;

    let started = std::time::Instant::now();
    match run_proposal(app, cfg, &prop.sql).await {
        Ok((columns, rows, truncated)) => {
            let ms = started.elapsed().as_millis();
            let _ = app.emit(
                "slack:executed",
                json!({ "sql": prop.sql, "durationMs": ms as u64, "status": "ok", "rows": rows.len(), "slackUser": prop.user }),
            );
            post_result(app, api, cfg, &prop, columns, rows, ms, truncated).await;
            let _ = api
                .update_message(
                    &prop.channel,
                    &prop.message_ts,
                    "Query complete",
                    blocks::resolved_proposal_card(&prop.explanation, &prop.sql, "✅ Complete"),
                )
                .await;
        }
        Err(e) => {
            let ms = started.elapsed().as_millis();
            let _ = app.emit(
                "slack:executed",
                json!({ "sql": prop.sql, "durationMs": ms as u64, "status": "error", "error": e.message, "slackUser": prop.user }),
            );
            let _ = api
                .post_message(&prop.channel, &format!("Query failed: {}", e.message), Some(blocks::error_card(&e.message)), Some(&prop.thread_ts))
                .await;
            let _ = api
                .update_message(
                    &prop.channel,
                    &prop.message_ts,
                    "Query failed",
                    blocks::resolved_proposal_card(&prop.explanation, &prop.sql, "❌ Failed"),
                )
                .await;
        }
    }
}

/// Roll back the PG read-only transaction if one was opened (ends it after the query,
/// win or lose — so a Slack-side error can't leave the shared session in an aborted txn).
async fn rollback_pg(c: &mut crate::driver::ConnState, pg_txn: bool) {
    if pg_txn {
        if let Ok(client) = c.backend.pg() {
            let _ = client.batch_execute("ROLLBACK").await;
        }
    }
}

/// Execute an approved query on the active connection: LIMIT-capped, buffered
/// (NEVER the shared server cursor), timeout-enforced with a real server-side
/// cancel, and wrapped in a read-only transaction on Postgres when possible.
async fn run_proposal(
    app: &AppHandle,
    cfg: &SlackConfig,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, bool), AppError> {
    validate_read_only(sql)?;
    let cap = cfg.max_rows_file;
    // Newlines around the inner SQL so a trailing `-- line comment` in the query can't
    // swallow the closing paren / LIMIT. `sql` is already `;`-trimmed by the caller.
    let wrapped = format!("SELECT * FROM (\n{sql}\n) AS _tusk LIMIT {}", cap + 1);

    let state = app.state::<crate::AppState>();
    let (conn_id, conn) = state.active()?;
    let mut c = crate::lock_conn(&conn).await;
    crate::ensure_alive(&mut c).await?;

    // Roll back any UI streaming cursor FIRST — same contract every sidebar command
    // honors (the owner tab's stream just stops, snapshot frozen). This means the Slack
    // query never runs inside the UI's open cursor transaction, so a Slack-side error or
    // timeout can't leave that transaction aborted and poison the UI's session.
    c.backend.rollback_cursor().await;

    // Server-enforced read-only on PG (defense-in-depth over the keyword gate): a
    // side-effecting function in an otherwise-SELECT statement can't write. Best-effort;
    // embedded/MySQL have no equivalent and rely on the gate + open-mode.
    let pg_txn = match c.backend.pg() {
        Ok(client) => client.batch_execute("BEGIN READ ONLY").await.is_ok(),
        Err(_) => false,
    };

    state.arm_cancel(&conn_id, c.backend.cancel_handle(), c.backend.config().clone());
    let timeout = std::time::Duration::from_secs(cfg.query_timeout_secs.max(1));
    let mut res = tokio::time::timeout(timeout, c.backend.run_single(&wrapped, (cap + 1) as u32, false)).await;

    // MySQL can't wrap a derived table with duplicate output columns (error 1060) —
    // fall back to appending LIMIT, mirroring `mysql_page`.
    if let Ok(Err(e)) = &res {
        if e.message.contains("Duplicate column name") {
            let appended = format!("{sql}\nLIMIT {}", cap + 1);
            res = tokio::time::timeout(timeout, c.backend.run_single(&appended, (cap + 1) as u32, false)).await;
        }
    }

    let outcome = match res {
        Err(_elapsed) => {
            // Timeout: the client future is dropped but the SERVER may keep executing —
            // request a cancel (real CancelRequest on PG; best-effort/no-op elsewhere).
            // NOTE: embedded drivers (DuckDB/SQLite) run synchronously, so this branch
            // can't fire for them — the timeout only bounds the async network drivers.
            if let Some((handle, cfg2)) = state.cancel_handle(&conn_id) {
                let _ = handle.cancel(&cfg2).await;
            }
            state.disarm_cancel(&conn_id);
            rollback_pg(&mut c, pg_txn).await;
            return Err(AppError::new(format!(
                "query timed out after {}s (cancel requested; the server may still be finishing it) — try a more specific query or raise the timeout in Settings → Slack",
                cfg.query_timeout_secs
            )));
        }
        Ok(r) => {
            state.disarm_cancel(&conn_id);
            rollback_pg(&mut c, pg_txn).await;
            r?
        }
    };

    match outcome {
        QueryOutcome::Rows { columns, mut rows, .. } => {
            let truncated = rows.len() > cap;
            rows.truncate(cap);
            Ok((columns, rows, truncated))
        }
        QueryOutcome::Exec { .. } => Err(AppError::new("the query returned no result set")),
    }
}

/// Format a stored result on demand (export button click) and attach it in-thread.
async fn handle_export(
    app: &AppHandle,
    api: &SlackApi,
    channel: &str,
    user: &str,
    fmt: &str,
    result_id: &str,
    thread_ts: Option<&str>,
) {
    if !blocks::EXPORT_FORMATS.iter().any(|(_, f)| *f == fmt) {
        return;
    }
    let runtime = app.state::<SlackRuntime>();
    let Some(stored) = runtime.results.get(result_id) else {
        let _ = api
            .post_ephemeral(channel, user, "⏰ This result has expired — re-run the query to export it.")
            .await;
        return;
    };
    let opts: crate::export::ExportOptions = match serde_json::from_value(json!({ "format": fmt })) {
        Ok(o) => o,
        Err(_) => return,
    };
    match crate::export::export_rows_to_bytes(&stored.columns, &stored.rows, &opts).await {
        Ok(bytes) => {
            let ext = if fmt == "markdown" { "md" } else { fmt };
            let comment = format!("Requested by <@{user}>");
            let _ = api
                .upload_file(channel, thread_ts, &format!("result.{ext}"), bytes, Some(&comment))
                .await;
        }
        Err(e) => {
            let _ = api.post_ephemeral(channel, user, &format!("Export failed: {}", e.message)).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn post_result(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    prop: &PendingProposal,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    ms: u128,
    truncated: bool,
) {
    let trunc_note = if truncated {
        format!(" (truncated at {} rows)", cfg.max_rows_file)
    } else {
        String::new()
    };
    let summary = format!("{} row{} in {} ms{}", rows.len(), if rows.len() == 1 { "" } else { "s" }, ms, trunc_note);
    let thread = Some(prop.thread_ts.as_str());

    if rows.is_empty() {
        let text = format!("✅ Query completed in {ms} ms — no rows returned.");
        let _ = api.post_message(&prop.channel, &text, Some(blocks::status_card(&text)), thread).await;
        return;
    }
    // Keep the result exportable via its format buttons (TTL'd, capped). The store
    // takes ownership and hands back a shared handle — no deep copy of the rows.
    let runtime = app.state::<SlackRuntime>();
    let (result_id, stored) = runtime.results.insert(columns, rows);
    let columns = &stored.columns;
    let rows = &stored.rows;

    // Explicitly requested chart wins over the format heuristic — rendered locally
    // (plotters, embedded font; no data leaves the machine).
    if let Some(spec) = &prop.chart {
        match chart::render_png(spec, columns, rows) {
            Ok(png) => {
                // Surface any requested-but-unsupported options on the result itself.
                let caption = match spec.unsupported_note() {
                    Some(note) => format!("{summary} — {note}"),
                    None => summary.clone(),
                };
                let _ = api.upload_file(&prop.channel, thread, "chart.png", png, Some(&caption)).await;
                post_export_prompt(api, prop, &result_id).await;
                return;
            }
            Err(e) => {
                let note = format!("⚠️ Couldn't render the requested chart: {} — posting the data instead.", e.message);
                let _ = api.post_message(&prop.channel, &note, Some(blocks::status_card(&note)), thread).await;
            }
        }
    }

    // Only the inline-table card embeds export buttons inline; every other path posts
    // a follow-up export prompt. Compute that once so a new format can't forget it.
    let inline_has_buttons = match format::decide_format(columns, rows, cfg) {
        ResultFormat::Empty => {
            // Defensive: rows were non-empty above, but never panic in the bot loop.
            let _ = api.post_message(&prop.channel, &summary, Some(blocks::status_card(&summary)), thread).await;
            true
        }
        ResultFormat::InlineTable(table) => {
            let _ = api
                .post_message(&prop.channel, &summary, Some(blocks::result_card(&table, &summary, Some(&result_id))), thread)
                .await;
            true
        }
        ResultFormat::ChartImage(spec) => {
            match chart::render_png(&spec, columns, rows) {
                Ok(png) => {
                    let _ = api.upload_file(&prop.channel, thread, "chart.png", png, Some(&summary)).await;
                }
                Err(_) => attach(api, prop, columns, rows, &summary, "csv").await, // unchartable → CSV
            }
            false
        }
        ResultFormat::CsvAttachment => {
            attach(api, prop, columns, rows, &summary, "csv").await;
            false
        }
        ResultFormat::XlsxAttachment => {
            attach(api, prop, columns, rows, &summary, "xlsx").await;
            false
        }
    };
    if !inline_has_buttons {
        post_export_prompt(api, prop, &result_id).await;
    }
}

async fn post_export_prompt(api: &SlackApi, prop: &PendingProposal, result_id: &str) {
    let _ = api
        .post_message(
            &prop.channel,
            "Export this result as…",
            Some(blocks::export_prompt_card(result_id)),
            Some(&prop.thread_ts),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_selects_pass() {
        for q in [
            "SELECT * FROM \"users\" LIMIT 10",
            "WITH top AS (SELECT id FROM t ORDER BY score DESC LIMIT 5) SELECT * FROM top",
            "SELECT created_at, last_update, dropped_calls FROM metrics", // word-boundary: created_at ≠ create
            "SELECT 'DROP TABLE users' AS scary_string FROM t",           // masked literal
            "SELECT \"update\" FROM t",                                   // masked quoted ident
            "SELECT * FROM orders ORDER BY id DESC LIMIT 10 -- most recent", // trailing comment
            "TABLE users",
            "VALUES (1), (2)",
        ] {
            assert!(validate_read_only(q).is_ok(), "false positive: {q}");
        }
    }

    #[test]
    fn non_wrappable_reads_rejected() {
        // Read-only but can't be a derived table → rejected at the gate (the LIMIT
        // wrap would otherwise produce a confusing parser error at execution).
        for q in ["EXPLAIN SELECT 1", "EXPLAIN ANALYZE SELECT 1", "SHOW search_path"] {
            assert!(validate_read_only(q).is_err(), "should reject non-wrappable: {q}");
        }
    }

    #[test]
    fn mutations_blocked_anywhere() {
        for q in [
            "DROP TABLE users",
            "DELETE FROM users",
            "WITH del AS (DELETE FROM t RETURNING *) SELECT * FROM del", // writable CTE
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
            "SELECT * FROM t FOR UPDATE",                                 // row lock
            "SELECT * FROM t FOR SHARE",
            "SELECT 1; DROP TABLE users",                                 // multi-statement
            "TRUNCATE t",
            "CREATE TABLE x (id int)",
        ] {
            assert!(validate_read_only(q).is_err(), "gate missed: {q}");
        }
    }

    #[test]
    fn masking_handles_dollar_quotes_and_comments() {
        assert!(validate_read_only("SELECT $tag$ DROP TABLE x $tag$ AS doc FROM t").is_ok());
        assert!(validate_read_only("SELECT 1 -- drop table x\nFROM t").is_ok());
        assert!(validate_read_only("SELECT /* delete everything */ 1").is_ok());
        // …but real keywords outside masked regions still trip it.
        assert!(validate_read_only("SELECT $tag$x$tag$ FROM t; DELETE FROM t").is_err());
    }
}

async fn attach(
    api: &SlackApi,
    prop: &PendingProposal,
    columns: &[String],
    rows: &[Vec<Option<String>>],
    summary: &str,
    fmt: &str,
) {
    let opts: crate::export::ExportOptions = match serde_json::from_value(json!({ "format": fmt })) {
        Ok(o) => o,
        Err(_) => return,
    };
    match crate::export::export_rows_to_bytes(columns, rows, &opts).await {
        Ok(bytes) => {
            let filename = format!("result.{fmt}");
            let _ = api.upload_file(&prop.channel, Some(&prop.thread_ts), &filename, bytes, Some(summary)).await;
        }
        Err(e) => {
            let _ = api
                .post_message(&prop.channel, &format!("Export failed: {}", e.message), Some(blocks::error_card(&e.message)), Some(&prop.thread_ts))
                .await;
        }
    }
}
