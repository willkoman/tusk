//! Slack event processing: question → AI proposal → approval → execution → result.
//! Events are handled sequentially (the plan's "one query at a time" invariant), and
//! every DB touch goes through the same `lock_conn`/`ensure_alive` path as the UI.

use super::api::SlackApi;
use super::approval::{PendingProposal, ProposalTake, ResultAccess, ResultBinding};
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
use tokio_util::sync::CancellationToken;

struct SlackQueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
    dialect: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlackConnectionIdentity<'a> {
    id: &'a str,
    database: &'a str,
    driver: &'a str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlackExecutionEvent<'a> {
    sql: &'a str,
    duration_ms: u64,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    slack_user: &'a str,
    // Flat fields preserve the existing event contract; the nested identity keeps
    // connection coordinates atomic for consumers that route by source connection.
    connection_id: &'a str,
    database: &'a str,
    connection: SlackConnectionIdentity<'a>,
}

pub async fn handle_event(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    ev: SlackEvent,
    generation: u64,
    cancel: &CancellationToken,
) {
    let runtime = app.state::<SlackRuntime>();
    if !runtime.session_active(generation, cancel) {
        return;
    }
    match ev {
        SlackEvent::Connected => {
            if runtime.set_status_for(generation, cancel, "connected", None) {
                let _ = app.emit("slack:status", runtime.status_info());
            }
        }
        SlackEvent::Disconnected(err) => {
            if runtime.set_status_for(generation, cancel, "connecting", Some(err)) {
                let _ = app.emit("slack:status", runtime.status_info());
            }
        }
        SlackEvent::Message {
            workspace,
            channel,
            user,
            text,
            thread_ts,
            ts,
        } => {
            if !cfg.enabled || !allowed(cfg, &channel, &user) {
                return;
            }
            handle_question(
                app, api, cfg, workspace, channel, user, text, thread_ts, ts, generation, cancel,
            )
            .await;
        }
        SlackEvent::Interaction { payload } => {
            if cfg.enabled {
                handle_interaction(app, api, cfg, payload, generation, cancel).await;
            }
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

fn thread_role(
    cfg: &SlackConfig,
    channel: &str,
    message: &serde_json::Value,
    own_bot: Option<&str>,
) -> Option<&'static str> {
    let author = message["user"].as_str().unwrap_or_default();
    if message["bot_id"].as_str().is_some() {
        return (own_bot == Some(author)).then_some("assistant");
    }
    (!author.is_empty() && allowed(cfg, channel, author)).then_some("user")
}

#[allow(clippy::too_many_arguments)]
async fn handle_question(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    workspace: String,
    channel: String,
    user: String,
    text: String,
    thread_ts: Option<String>,
    ts: String,
    generation: u64,
    cancel: &CancellationToken,
) {
    // Always answer in a thread: the incoming message's thread, or start one on it.
    let thread = thread_ts.clone().unwrap_or_else(|| ts.clone());
    let thinking_ts = match api
        .post_message(
            &channel,
            "Generating query…",
            Some(blocks::thinking_card()),
            Some(&thread),
        )
        .await
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tusk-slack] post failed: {}", e.message);
            return;
        }
    };

    if !app
        .state::<SlackRuntime>()
        .session_active(generation, cancel)
    {
        return;
    }
    match generate_proposal(
        app,
        api,
        cfg,
        &channel,
        &text,
        thread_ts.as_deref(),
        generation,
        cancel,
    )
    .await
    {
        // The AI answered without SQL (destructive ask refused, clarification, …) —
        // that's a normal reply, not an error.
        Ok(Proposal::Reply(reply)) => {
            if !app
                .state::<SlackRuntime>()
                .session_active(generation, cancel)
            {
                return;
            }
            let _ = api
                .update_message(&channel, &thinking_ts, &reply, blocks::status_card(&reply))
                .await;
        }
        Ok(Proposal::Sql {
            explanation,
            sql,
            chart: chart_spec,
            connection_id,
            database,
            dialect,
        }) => {
            let runtime = app.state::<SlackRuntime>();
            let id = match runtime.approvals.new_id() {
                Ok(id) => id,
                Err(e) => {
                    let _ = api
                        .update_message(
                            &channel,
                            &thinking_ts,
                            &e.message,
                            blocks::error_card(&e.message),
                        )
                        .await;
                    return;
                }
            };
            // The proposal card advertises the chart request so the approver
            // knows a chart (with these particulars) will be rendered.
            let shown = match &chart_spec {
                Some(spec) => format!("{explanation}\n📊 {}", spec.describe()),
                None => explanation.clone(),
            };
            let prop = PendingProposal {
                id: id.clone(),
                sql: sql.clone(),
                explanation: shown.clone(),
                chart: chart_spec.map(|spec| *spec),
                workspace,
                channel: channel.clone(),
                user,
                thread_ts: thread.clone(),
                message_ts: thinking_ts.clone(),
                request_message_ts: ts,
                connection_id,
                database,
                dialect,
                created: std::time::Instant::now(),
            };
            if let Err(e) = runtime.approvals.insert(prop) {
                let _ = api
                    .update_message(
                        &channel,
                        &thinking_ts,
                        &e.message,
                        blocks::error_card(&e.message),
                    )
                    .await;
                return;
            }
            if !blocks::sql_can_display(&sql) {
                let upload = api
                    .upload_file(
                        &channel,
                        Some(&thread),
                        "proposal.sql",
                        sql.as_bytes().to_vec(),
                        Some("Exact executable SQL for the pending proposal."),
                    )
                    .await;
                if let Err(e) = upload {
                    runtime.approvals.take(&id);
                    let message = format!(
                        "Cannot show or attach the complete executable SQL: {}",
                        e.message
                    );
                    let _ = api
                        .update_message(
                            &channel,
                            &thinking_ts,
                            &message,
                            blocks::error_card(&message),
                        )
                        .await;
                    return;
                }
            }
            if !runtime.session_active(generation, cancel) {
                runtime.approvals.take(&id);
                return;
            }
            let fallback = if blocks::sql_can_display(&sql) {
                format!("Proposed query: {sql}")
            } else {
                "Proposed query; exact executable SQL attached as proposal.sql.".to_string()
            };
            if api
                .update_message(
                    &channel,
                    &thinking_ts,
                    &fallback,
                    blocks::proposal_card(&shown, &sql, &id),
                )
                .await
                .is_err()
            {
                runtime.approvals.take(&id);
            }
        }
        Err(e) => {
            if !app
                .state::<SlackRuntime>()
                .session_active(generation, cancel)
            {
                return;
            }
            let _ = api
                .update_message(
                    &channel,
                    &thinking_ts,
                    &e.message,
                    blocks::error_card(&e.message),
                )
                .await;
        }
    }
}

/// What the AI produced for a question.
enum Proposal {
    /// A runnable (validated read-only) query + optional chart request.
    Sql {
        explanation: String,
        sql: String,
        chart: Option<Box<ChartSpec>>,
        connection_id: String,
        database: String,
        dialect: String,
    },
    /// A plain reply with no SQL — e.g. a refusal of a destructive ask.
    Reply(String),
}

/// Build context from the live connection, call the AI once, extract + validate the
/// SQL (and any explicitly requested chart spec).
#[allow(clippy::too_many_arguments)] // Stable event context is clearer than a one-use bag struct.
async fn generate_proposal(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    channel: &str,
    question: &str,
    thread_ts: Option<&str>,
    generation: u64,
    cancel: &CancellationToken,
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
            let own_bot = api.bot_user_id();
            let mut forwarded_bytes = 0usize;
            for m in &replies {
                let text = m["text"].as_str().unwrap_or_default();
                if text.is_empty() || text.len() > 64 * 1024 || text.starts_with("Generating query")
                {
                    continue;
                }
                let Some(role) = thread_role(cfg, channel, m, own_bot.as_deref()) else {
                    continue;
                };
                if forwarded_bytes.saturating_add(text.len()) > 128 * 1024 {
                    break;
                }
                forwarded_bytes = forwarded_bytes.saturating_add(text.len());
                if role == "user" {
                    focus.push(' ');
                    focus.push_str(text);
                }
                messages.push(ai::Msg {
                    role: role.into(),
                    content: text.to_string(),
                });
            }
        }
    }
    // Guarantee the question is the final user turn (thread fetch may race or fail).
    let ends_with_question =
        matches!(messages.last(), Some(m) if m.role == "user" && m.content == question);
    if !ends_with_question {
        messages.push(ai::Msg {
            role: "user".into(),
            content: question.to_string(),
        });
    }

    // Snapshot schema/permissions/samples under the connection lock, then RELEASE it
    // before the (slow) AI call so the UI is never blocked on a Slack question.
    let (system, connection_id, database, dialect) = {
        let state = app.state::<crate::AppState>();
        let (connection_id, conn) = state.active()?;
        let mut c = crate::lock_conn(&conn).await?;
        crate::ensure_alive(&mut c).await?;
        c.require_idle("Slack metadata")?;
        let caps = c.backend.capabilities();
        let perms = c
            .backend
            .permissions()
            .await
            .unwrap_or_else(|_| crate::perms::Permissions::unrestricted());
        let tables = c.backend.list_tables().await?;
        // Parity with the desktop panel (AiPanel relevantTables(…, 5)) — every other
        // context budget in slack/context.rs mirrors src/ai/context.ts exactly.
        let relevant = context::relevant_tables(&tables, &focus, 5);
        let mut samples: Vec<SampleTable> = Vec::new();
        if cfg.share_samples {
            for t in &relevant {
                // Explicit opt-in: these real values leave the machine for the AI provider.
                if let Ok((columns, rows)) = c.backend.sample_rows(&t.schema, &t.name, 5).await {
                    samples.push(SampleTable {
                        schema: t.schema.clone(),
                        name: t.name.clone(),
                        columns,
                        rows,
                    });
                }
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
            (&a.src_schema, &a.src_table, &a.constraint).cmp(&(
                &b.src_schema,
                &b.src_table,
                &b.constraint,
            ))
        });
        fks.dedup_by(|a, b| {
            a.constraint == b.constraint
                && a.src_schema == b.src_schema
                && a.src_table == b.src_table
        });

        // Only claim knowledge of the graph when EVERY schema the question touches was
        // actually read. Anything less and the prompt must stay silent about foreign keys.
        let fks_known = !relevant.is_empty()
            && relevant
                .iter()
                .all(|t| fetched.iter().any(|s| **s == t.schema));
        // Skills are on disk (skills.rs), reloaded per event, so an edit applies to the next
        // question without a bot restart. Scope by the SERVER-reported database name — the
        // same value the sidebar and the panel use. `config().dbname` is the field the user
        // typed: empty for DuckDB/SQLite, and empty on Postgres when libpq defaults it, so
        // scoping on it would silently drop database-scoped skills for the bot only.
        let database = c.backend.database_name().await;
        let all_skills = crate::skills::load_all(app);
        let skills = context::active_skills(&all_skills, &database);

        let ctx = SlackAiCtx {
            dialect: caps.kind.to_string(),
            user: perms.current_user.clone(),
            is_superuser: perms.is_superuser,
            permissions_enforced: perms.enforced,
            destructive_policy: cfg.destructive_policy.clone(),
        };
        (
            context::build_system_prompt(&ctx, &tables, &focus, &samples, &fks, fks_known, &skills),
            connection_id,
            database,
            caps.kind.to_string(),
        )
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
        request_id: None, // session cancellation drops this one-shot request future
        allow_no_key: cfg.ai_allow_no_key,
    };
    // Transient provider failures are replayed inside `complete_one_shot`; a real error
    // (or an empty response) bubbles up here and reaches the user as an error card. It
    // must NEVER be quietly re-labelled as "I can't help with that" — that told a user
    // the bot couldn't write their query when the provider had actually fallen over.
    let completion = tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::new("Slack session stopped while generating the query")),
        result = ai::complete_one_shot(&req) => result,
    }?;
    if !app
        .state::<SlackRuntime>()
        .session_active(generation, cancel)
    {
        return Err(AppError::new(
            "Slack session was restarted while generating the query",
        ));
    }
    let ai::Completion {
        text: response,
        truncated,
    } = completion;

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
    let explanation = if explanation.is_empty() {
        "Proposed query:".to_string()
    } else {
        explanation
    };

    // An explicit chart request rides along as a tagged ```chart block.
    let chart_spec = context::extract_chart_block(&response).and_then(|b| ChartSpec::parse(&b));

    // Safety gate: exactly one read-only statement, no mutation keywords anywhere
    // (masked scan — catches writable CTEs / smuggled DDL / row locks). The same
    // gate re-runs at execution time; the AI's SQL is never trusted.
    validate_read_only(&sql)?;
    Ok(Proposal::Sql {
        explanation,
        sql,
        chart: chart_spec.map(Box::new),
        connection_id,
        database,
        dialect,
    })
}

/// Mutation keywords that must never appear ANYWHERE in a Slack-run statement —
/// not just at the start. Catches writable CTEs (`WITH x AS (DELETE …) SELECT`),
/// smuggled DDL, and `FOR UPDATE` row locks. Scanned over MASKED sql (strings,
/// comments, dollar-quotes, quoted identifiers blanked), word-boundary matched.
/// A false positive (a bare column literally named `delete`) safely degrades to
/// "run it in the Tusk editor".
const MUTATION_WORDS: [&str; 15] = [
    "insert", "update", "delete", "merge", "replace", "drop", "alter", "truncate", "create",
    "grant", "revoke", "outfile", "dumpfile", "into", "lock",
];

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
            let executable = i + 2 < n && b[i + 2] == b'!'
                || i + 3 < n && b[i + 2].eq_ignore_ascii_case(&b'm') && b[i + 3] == b'!';
            if executable {
                // Preserve a marker. MySQL/MariaDB execute these comment bodies, so
                // treating them like ordinary comments would hide mutations.
                out[i] = b'/';
                out[i + 1] = b'*';
                out[i + 2] = b'!';
            }
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
            if q != b'\'' {
                // Quoted function names are rejected by the function policy. Keep
                // an opaque identifier token without exposing its keyword content.
                out[i] = b'q';
            }
            i += 1;
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    if q != b'\'' {
                        out[i] = b'q';
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
pub(crate) fn find_mutation_word(sql: &str) -> Option<&'static str> {
    let masked = mask_sql(sql);
    let mut previous = "";
    for token in masked.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if let Some(w) = MUTATION_WORDS.iter().find(|w| **w == token) {
            return Some(w);
        }
        if previous == "for" && token == "share" {
            return Some("share");
        }
        if !token.is_empty() {
            previous = token;
        }
    }
    None
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

/// Functions admitted from Slack. Unknown/schema-qualified routines are rejected:
/// a syntactically read-only SELECT can invoke a volatile UDF, touch host files,
/// sleep workers, or perform network I/O. Keep this list to common deterministic
/// analytics built-ins; false positives safely send the query to the desktop editor.
const SAFE_SELECT_FUNCTIONS: &[&str] = &[
    "abs",
    "acos",
    "age",
    "array_agg",
    "ascii",
    "asin",
    "atan",
    "atan2",
    "avg",
    "bit_and",
    "bit_or",
    "bool_and",
    "bool_or",
    "btrim",
    "cast",
    "ceil",
    "ceiling",
    "char_length",
    "character_length",
    "coalesce",
    "concat",
    "concat_ws",
    "corr",
    "cos",
    "count",
    "covar_pop",
    "covar_samp",
    "cume_dist",
    "current_date",
    "current_time",
    "current_timestamp",
    "date",
    "date_add",
    "date_diff",
    "date_format",
    "date_part",
    "date_sub",
    "date_trunc",
    "datediff",
    "day",
    "dayname",
    "decode",
    "degrees",
    "dense_rank",
    "exp",
    "extract",
    "first_value",
    "floor",
    "format",
    "greatest",
    "group_concat",
    "grouping",
    "grouping_id",
    "hour",
    "if",
    "ifnull",
    "initcap",
    "instr",
    "json_agg",
    "json_array",
    "json_arrayagg",
    "json_build_array",
    "json_build_object",
    "json_extract",
    "json_object",
    "json_objectagg",
    "jsonb_agg",
    "jsonb_build_array",
    "jsonb_build_object",
    "lag",
    "last_day",
    "last_value",
    "lead",
    "least",
    "left",
    "length",
    "ln",
    "log",
    "log10",
    "lower",
    "lpad",
    "ltrim",
    "max",
    "md5",
    "median",
    "min",
    "minute",
    "mod",
    "month",
    "monthname",
    "now",
    "nth_value",
    "ntile",
    "nullif",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "position",
    "power",
    "quarter",
    "radians",
    "rank",
    "regexp_extract",
    "regexp_like",
    "regexp_matches",
    "regexp_replace",
    "repeat",
    "replace",
    "reverse",
    "right",
    "round",
    "row_number",
    "rpad",
    "rtrim",
    "second",
    "sign",
    "sin",
    "split_part",
    "sqrt",
    "stddev",
    "stddev_pop",
    "stddev_samp",
    "strftime",
    "string_agg",
    "strpos",
    "substr",
    "substring",
    "sum",
    "tan",
    "time",
    "to_char",
    "to_date",
    "to_number",
    "to_timestamp",
    "translate",
    "trim",
    "trunc",
    "typeof",
    "upper",
    "variance",
    "var_pop",
    "var_samp",
    "week",
    "year",
];

// Reserved words that legitimately precede `(` in a read-only SELECT — subqueries
// (`FROM (`, `JOIN (`), parenthesized predicates (`WHERE (`, `AND (`), set ops
// (`UNION (`), expressions (`SELECT (a+b)`), and clause syntax. None of these are
// callable routines in any supported engine, so skipping them opens no function
// call the allowlist below would have blocked.
const PAREN_SYNTAX_WORDS: &[&str] = &[
    "all",
    "and",
    "any",
    "as",
    "between",
    "by",
    "case",
    "cross",
    "distinct",
    "else",
    "escape",
    "except",
    "exists",
    "filter",
    "from",
    "full",
    "group",
    "groups",
    "having",
    "ilike",
    "in",
    "inner",
    "intersect",
    "is",
    "join",
    "lateral",
    "like",
    "limit",
    "natural",
    "not",
    "offset",
    "on",
    "or",
    "order",
    "outer",
    "over",
    "partition",
    "recursive",
    "rollup",
    "rows",
    "select",
    "sets",
    "some",
    "then",
    "union",
    "using",
    "values",
    "when",
    "where",
    "window",
    "with",
    "within",
];

fn unsafe_select_function(sql: &str) -> Option<String> {
    let masked = mask_sql(sql);
    let b = masked.as_bytes();
    for open in 0..b.len() {
        if b[open] != b'(' {
            continue;
        }
        let mut end = open;
        while end > 0 && b[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        let mut start = end;
        while start > 0 && (b[start - 1].is_ascii_alphanumeric() || b[start - 1] == b'_') {
            start -= 1;
        }
        if start == end {
            continue;
        }
        let name = &masked[start..end];
        if PAREN_SYNTAX_WORDS.contains(&name) {
            continue;
        }
        let mut before = start;
        while before > 0 && b[before - 1].is_ascii_whitespace() {
            before -= 1;
        }
        if before > 0 && b[before - 1] == b'.' {
            return Some(format!("schema-qualified routine `{name}`"));
        }
        if !SAFE_SELECT_FUNCTIONS.contains(&name) {
            return Some(format!("routine `{name}`"));
        }
    }
    None
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
    if mask_sql(&single).contains("/*!") {
        return Err(AppError::new(
            "blocked: MySQL/MariaDB executable comments are not allowed in Slack queries",
        ));
    }
    if let Some(w) = find_mutation_word(&single) {
        return Err(AppError::new(format!(
            "blocked: the statement contains `{w}` — Slack only runs read-only SELECTs (no DML/DDL, no writable CTEs, no row locks). Run it in the Tusk editor instead.",
        )));
    }
    if let Some(routine) = unsafe_select_function(&single) {
        return Err(AppError::new(format!(
            "blocked: {routine} is outside Slack's conservative read-only function policy. Run it in the Tusk editor instead.",
        )));
    }
    Ok(())
}

const MAX_RESULT_COLUMNS: usize = 10_000;
const MAX_RESULT_CELLS: usize = 2_000_000;
const MAX_RESULT_VALUE_BYTES: usize = 1024 * 1024;
const MAX_RESULT_TOTAL_BYTES: usize = 48 * 1024 * 1024;

fn add_result_page(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    bytes: &mut usize,
    cells: &mut usize,
    first: bool,
) -> Result<(), AppError> {
    if columns.is_empty()
        || columns.len() > MAX_RESULT_COLUMNS
        || rows.iter().any(|r| r.len() != columns.len())
    {
        return Err(AppError::new(
            "Slack result exceeds the supported row/column shape",
        ));
    }
    if first {
        *bytes = columns
            .iter()
            .map(|s| s.len().saturating_add(std::mem::size_of::<String>()))
            .sum::<usize>();
    }
    *cells = cells.saturating_add(rows.len().saturating_mul(columns.len()));
    if *cells > MAX_RESULT_CELLS {
        return Err(AppError::new("Slack result exceeds the 2000000-cell limit"));
    }
    *bytes = bytes.saturating_add(
        rows.len()
            .saturating_mul(std::mem::size_of::<Vec<Option<String>>>()),
    );
    *bytes = bytes.saturating_add(
        rows.len()
            .saturating_mul(columns.len())
            .saturating_mul(std::mem::size_of::<Option<String>>()),
    );
    if *bytes > MAX_RESULT_TOTAL_BYTES {
        return Err(AppError::new(
            "Slack result exceeds the 48 MiB memory budget",
        ));
    }
    for value in rows.iter().flatten().flatten() {
        if value.len() > MAX_RESULT_VALUE_BYTES {
            return Err(AppError::new(
                "Slack result contains a value larger than 1 MiB",
            ));
        }
        *bytes = bytes.saturating_add(value.len());
        if *bytes > MAX_RESULT_TOTAL_BYTES {
            return Err(AppError::new(
                "Slack result exceeds the 48 MiB memory budget",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
fn validate_result_payload(
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), AppError> {
    let mut bytes = 0;
    let mut cells = 0;
    add_result_page(columns, rows, &mut bytes, &mut cells, true)
}

async fn collect_read_limited(
    backend: &mut crate::driver::Backend,
    sql: &str,
    cap: usize,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
    let page = (cap.saturating_add(1).min(1_000)) as u32;
    let out = backend.run_single_read_only(sql, page, true).await?;
    let (columns, mut rows, mut done) = match out {
        QueryOutcome::Rows {
            columns,
            rows,
            done,
            ..
        } => (columns, rows, done),
        QueryOutcome::Exec { .. } => return Err(AppError::new("the query returned no result set")),
    };
    let mut bytes = 0;
    let mut cells = 0;
    add_result_page(&columns, &rows, &mut bytes, &mut cells, true)?;
    while !done && rows.len() <= cap {
        let next = backend.fetch_page(page).await?;
        add_result_page(&columns, &next.rows, &mut bytes, &mut cells, false)?;
        rows.extend(next.rows);
        done = next.done;
    }
    rows.truncate(cap.saturating_add(1));
    Ok((columns, rows))
}

async fn handle_interaction(
    app: &AppHandle,
    api: &SlackApi,
    cfg: &SlackConfig,
    payload: serde_json::Value,
    generation: u64,
    cancel: &CancellationToken,
) {
    if payload["type"].as_str() != Some("block_actions") {
        return;
    }
    let action = &payload["actions"][0];
    let value = action["value"].as_str().unwrap_or_default();
    let action_id = action["action_id"].as_str().unwrap_or_default();
    let user = payload["user"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let channel = payload["channel"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let workspace = payload["team"]["id"]
        .as_str()
        .or(payload["team_id"].as_str())
        .unwrap_or_default()
        .to_string();
    let message_ts = payload["message"]["ts"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let thread_ts = payload["message"]["thread_ts"]
        .as_str()
        .or(payload["message"]["ts"].as_str())
        .unwrap_or_default()
        .to_string();
    if workspace.is_empty()
        || channel.is_empty()
        || user.is_empty()
        || message_ts.is_empty()
        || thread_ts.is_empty()
    {
        return;
    }
    let (verb, id) = match value.split_once(':') {
        Some(x) => x,
        None => return,
    };

    // Export buttons: "export:{fmt}:{result_id}". Bind the requester and exact
    // workspace/channel/thread/message so copied action values are inert.
    if verb == "export" {
        if !allowed(cfg, &channel, &user) {
            return;
        }
        let Some((fmt, result_id)) = id.split_once(':') else {
            return;
        };
        if action_id != format!("export_{fmt}") {
            return;
        }
        handle_export(
            app,
            api,
            &workspace,
            &channel,
            &thread_ts,
            &message_ts,
            &user,
            fmt,
            result_id,
            generation,
            cancel,
        )
        .await;
        return;
    }

    let runtime = app.state::<SlackRuntime>();
    if !allowed(cfg, &channel, &user)
        || !matches!(
            (verb, action_id),
            ("approve", "approve_query") | ("reject", "reject_query")
        )
    {
        return;
    }
    let prop = match runtime.approvals.take_for_interaction(
        id,
        &workspace,
        &channel,
        &thread_ts,
        &message_ts,
        &user,
    ) {
        ProposalTake::Missing => {
            let _ = api
                .post_ephemeral(
                    &channel,
                    &user,
                    "⏰ This proposal has expired — ask the question again.",
                )
                .await;
            return;
        }
        ProposalTake::Unauthorized => {
            let _ = api
                .post_ephemeral(
                    &channel,
                    &user,
                    "Only the requester can approve or reject this query.",
                )
                .await;
            return;
        }
        ProposalTake::SourceMismatch => {
            let _ = api
                .post_ephemeral(
                    &channel,
                    &user,
                    "This action did not come from the original proposal message.",
                )
                .await;
            return;
        }
        ProposalTake::Found(prop) => *prop,
    };

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
    if !runtime.session_active(generation, cancel) {
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
    let result = run_proposal(
        app,
        cfg,
        &prop.sql,
        &prop.connection_id,
        &prop.database,
        cancel,
    )
    .await;
    if !runtime.session_active(generation, cancel) {
        return;
    }
    match result {
        Ok(SlackQueryResult {
            columns,
            rows,
            truncated,
            dialect,
        }) => {
            let ms = started.elapsed().as_millis();
            let duration_ms = u64::try_from(ms).unwrap_or(u64::MAX);
            let event = SlackExecutionEvent {
                sql: &prop.sql,
                duration_ms,
                status: "ok",
                rows: Some(rows.len()),
                error: None,
                slack_user: &prop.user,
                connection_id: &prop.connection_id,
                database: &prop.database,
                connection: SlackConnectionIdentity {
                    id: &prop.connection_id,
                    database: &prop.database,
                    driver: &dialect,
                },
            };
            let _ = app.emit("slack:executed", event);
            post_result(
                app, api, cfg, &prop, columns, rows, &dialect, ms, truncated, generation, cancel,
            )
            .await;
            if !runtime.session_active(generation, cancel) {
                return;
            }
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
            let event = SlackExecutionEvent {
                sql: &prop.sql,
                duration_ms: u64::try_from(ms).unwrap_or(u64::MAX),
                status: "error",
                rows: None,
                error: Some(&e.message),
                slack_user: &prop.user,
                connection_id: &prop.connection_id,
                database: &prop.database,
                connection: SlackConnectionIdentity {
                    id: &prop.connection_id,
                    database: &prop.database,
                    driver: &prop.dialect,
                },
            };
            let _ = app.emit("slack:executed", event);
            let _ = api
                .post_message(
                    &prop.channel,
                    &format!("Query failed: {}", e.message),
                    Some(blocks::error_card(&e.message)),
                    Some(&prop.thread_ts),
                )
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

/// Execute an approved query on a fresh engine-enforced read-only connection:
/// LIMIT-capped, buffered, and never routed through the shared UI cursor. PostgreSQL
/// timeout is preemptive; other engines report their weaker cancellation guarantees.
async fn run_proposal(
    app: &AppHandle,
    cfg: &SlackConfig,
    sql: &str,
    expected_connection_id: &str,
    expected_database: &str,
    session_cancel: &CancellationToken,
) -> Result<SlackQueryResult, AppError> {
    validate_read_only(sql)?;
    let cap = cfg.max_rows_file;
    // Newlines around the inner SQL so a trailing `-- line comment` in the query can't
    // swallow the closing paren / LIMIT. `sql` is already `;`-trimmed by the caller.
    let wrapped = format!("SELECT * FROM (\n{sql}\n) AS _tusk LIMIT {}", cap + 1);

    let state = app.state::<crate::AppState>();
    let (conn_id, conn) = state.active()?;
    if conn_id != expected_connection_id {
        return Err(AppError::new(
            "the active Tusk connection changed after this proposal was created — ask the question again before approving",
        ));
    }
    let (isolated_cfg, kind) = {
        let mut c = crate::lock_conn(&conn).await?;
        crate::ensure_alive(&mut c).await?;
        c.require_idle("Slack query approval")?;
        if c.backend.database_name().await != expected_database {
            return Err(AppError::new(
                "the connected database changed after this proposal was created — ask the question again before approving",
            ));
        }
        let mut isolated_cfg = c.backend.config().clone();
        isolated_cfg.read_only = true;
        let kind = c.backend.capabilities().kind;
        if matches!(kind, "duckdb" | "sqlite")
            && (isolated_cfg.path.as_deref().unwrap_or("").trim().is_empty()
                || matches!(isolated_cfg.path.as_deref(), Some(":memory:")))
        {
            return Err(AppError::new(
                "Slack cannot safely isolate queries against an in-memory embedded database; use the Tusk editor or a file-backed database",
            ));
        }
        if kind == "duckdb" {
            if c.backend.cursor_open() {
                return Err(AppError::new(
                    "finish or stop the active DuckDB result stream before approving a Slack query; Tusk will not close the UI cursor",
                ));
            }
            // DuckDB holds an exclusive file handle even while idle. Releasing an
            // idle handle does not disturb a UI stream (checked above).
            c.backend.release_idle(false);
        }
        (isolated_cfg, kind.to_string())
    }; // UI connection lock released before connect/query work.

    let (mut isolated, _) = tokio::select! {
        _ = session_cancel.cancelled() => return Err(AppError::new("Slack session stopped before query execution")),
        result = crate::driver::connect(&isolated_cfg) => result?,
    };
    if isolated.database_name().await != expected_database {
        return Err(AppError::new(
            "isolated Slack connection resolved to a different database",
        ));
    }

    let cancel_handle = isolated.cancel_handle();
    let cancel_cfg = isolated.config().clone();
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(cfg.query_timeout_secs.max(1));
    let mut res = collect_with_deadline(
        &mut isolated,
        &wrapped,
        cap,
        deadline,
        session_cancel,
        &cancel_handle,
        &cancel_cfg,
        &kind,
        cfg.query_timeout_secs,
    )
    .await;

    // MySQL can't wrap a derived table with duplicate output columns (error 1060).
    // Retry the original read: `mysql_page` then uses its direct LIMIT/OFFSET fallback,
    // while this collector still enforces cap+1 and all memory budgets.
    if let Err(e) = &res {
        if e.message.contains("Duplicate column name") {
            res = collect_with_deadline(
                &mut isolated,
                sql,
                cap,
                deadline,
                session_cancel,
                &cancel_handle,
                &cancel_cfg,
                &kind,
                cfg.query_timeout_secs,
            )
            .await;
        }
    }

    let (columns, mut rows) = res?;
    let truncated = rows.len() > cap;
    rows.truncate(cap);
    Ok(SlackQueryResult {
        columns,
        rows,
        truncated,
        dialect: kind,
    })
}

#[allow(clippy::too_many_arguments)]
async fn collect_with_deadline(
    backend: &mut crate::driver::Backend,
    sql: &str,
    cap: usize,
    deadline: tokio::time::Instant,
    session_cancel: &CancellationToken,
    cancel_handle: &crate::driver::CancelHandle,
    cancel_cfg: &crate::db::ConnectionConfig,
    kind: &str,
    timeout_secs: u64,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), AppError> {
    let work = tokio::time::timeout_at(deadline, collect_read_limited(backend, sql, cap));
    tokio::pin!(work);
    tokio::select! {
        _ = session_cancel.cancelled() => {
            let _ = cancel_handle.clone().cancel(cancel_cfg).await;
            Err(AppError::new(match kind {
                "postgres" => "Slack session stopped; PostgreSQL cancellation was requested on the isolated query".to_string(),
                "mysql" => "Slack session stopped; Tusk stopped waiting, but MySQL may still be finishing the isolated read-only query".to_string(),
                "duckdb" | "sqlite" => format!("Slack session stopped; {kind} execution is synchronous and may run to completion"),
                _ => "Slack session stopped during isolated query execution".to_string(),
            }))
        }
        result = &mut work => match result {
            Ok(value) => {
                if matches!(kind, "duckdb" | "sqlite") && tokio::time::Instant::now() >= deadline {
                    match value {
                        Ok(_) => Err(AppError::new(format!(
                            "query exceeded the {timeout_secs}s limit; {kind} execution is synchronous and could not be preempted, but it has now finished"
                        ))),
                        Err(e) => Err(e),
                    }
                } else {
                    value
                }
            },
            Err(_) => {
                let cancel_result = cancel_handle.clone().cancel(cancel_cfg).await;
                let detail = match kind {
                    "postgres" if cancel_result.is_ok() => "PostgreSQL server cancellation requested",
                    "mysql" => "Tusk stopped waiting; MySQL may still be finishing the isolated read-only query",
                    "duckdb" | "sqlite" => "embedded execution is synchronous; timeout cannot preempt work already inside the engine",
                    _ if cancel_result.is_ok() => "cancellation requested",
                    _ => "cancellation unavailable; the engine may still be finishing the isolated read-only query",
                };
                Err(AppError::new(format!(
                    "query timed out after {timeout_secs}s ({detail}) — try a more specific query or raise the timeout in Settings → Slack"
                )))
            }
        }
    }
}

/// Format a stored result on demand (export button click) and attach it in-thread.
#[allow(clippy::too_many_arguments)] // Slack source coordinates are individually security-checked.
async fn handle_export(
    app: &AppHandle,
    api: &SlackApi,
    workspace: &str,
    channel: &str,
    thread_ts: &str,
    message_ts: &str,
    user: &str,
    fmt: &str,
    result_id: &str,
    generation: u64,
    cancel: &CancellationToken,
) {
    if !blocks::EXPORT_FORMATS.iter().any(|(_, f)| *f == fmt) {
        return;
    }
    let runtime = app.state::<SlackRuntime>();
    let stored = match runtime
        .results
        .access(result_id, workspace, channel, thread_ts, message_ts, user)
    {
        ResultAccess::Found(stored) => stored,
        ResultAccess::Missing => {
            let _ = api
                .post_ephemeral(
                    channel,
                    user,
                    "⏰ This result has expired — re-run the query to export it.",
                )
                .await;
            return;
        }
        ResultAccess::Unauthorized => {
            let _ = api
                .post_ephemeral(
                    channel,
                    user,
                    "Only the original requester can export this result.",
                )
                .await;
            return;
        }
        ResultAccess::SourceMismatch => {
            let _ = api
                .post_ephemeral(
                    channel,
                    user,
                    "This export action did not come from the original result message.",
                )
                .await;
            return;
        }
    };
    if !runtime.session_active(generation, cancel) {
        return;
    }
    if let Err(e) = attachment_preflight(&stored.columns, &stored.rows, fmt) {
        let _ = api.post_ephemeral(channel, user, &e.message).await;
        return;
    }
    let mut opts: crate::export::ExportOptions =
        match serde_json::from_value(json!({ "format": fmt })) {
            Ok(o) => o,
            Err(_) => return,
        };
    // No column-type metadata survives a buffered run; the full result is in hand,
    // so the grid's value heuristic (t/f/true/false-only columns) is exact here.
    opts.bool_cols = crate::export::detect_bool_cols(stored.columns.len(), &stored.rows);
    if fmt == "sql" {
        // Same shape as the desktop dialog: INSERTs target the queried table name,
        // batched multi-row tuples.
        opts.sql.table = stored.label.clone();
        opts.sql.multi_row = true;
    }
    match crate::export::export_rows_to_bytes_for_dialect(
        &stored.columns,
        &stored.rows,
        &opts,
        &stored.dialect,
    )
    .await
    {
        Ok(bytes) if bytes.len() <= super::api::ATTACHMENT_BYTE_CAP => {
            if !runtime.session_active(generation, cancel) {
                return;
            }
            let ext = if fmt == "markdown" { "md" } else { fmt };
            let comment = format!("Requested by Slack user {user}");
            let _ = api
                .upload_file(
                    channel,
                    Some(thread_ts),
                    &format!("{}.{ext}", stored.label),
                    bytes,
                    Some(&comment),
                )
                .await;
        }
        Ok(_) => {
            let _ = api
                .post_ephemeral(
                    channel,
                    user,
                    "Export exceeded the 20 MiB Slack attachment limit.",
                )
                .await;
        }
        Err(e) => {
            let _ = api
                .post_ephemeral(channel, user, &format!("Export failed: {}", e.message))
                .await;
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
    dialect: &str,
    ms: u128,
    truncated: bool,
    generation: u64,
    cancel: &CancellationToken,
) {
    let trunc_note = if truncated {
        format!(" (truncated at {} rows)", cfg.max_rows_file)
    } else {
        String::new()
    };
    let summary = format!(
        "{} row{} in {} ms{}",
        rows.len(),
        if rows.len() == 1 { "" } else { "s" },
        ms,
        trunc_note
    );
    let thread = Some(prop.thread_ts.as_str());

    if rows.is_empty() {
        let text = format!("✅ Query completed in {ms} ms — no rows returned.");
        let _ = api
            .post_message(
                &prop.channel,
                &text,
                Some(blocks::status_card(&text)),
                thread,
            )
            .await;
        return;
    }
    // Keep the result exportable via its format buttons (TTL'd, capped). The store
    // takes ownership and hands back a shared handle — no deep copy of the rows.
    let runtime = app.state::<SlackRuntime>();
    let binding = ResultBinding {
        workspace: prop.workspace.clone(),
        channel: prop.channel.clone(),
        thread_ts: prop.thread_ts.clone(),
        requester: prop.user.clone(),
        dialect: dialect.to_string(),
        label: export_label(&prop.sql),
    };
    let Some((result_id, stored)) = runtime.results.insert(binding, columns, rows) else {
        let text = "Query completed, but the result exceeded Slack's retained-export memory budget. Run a narrower query.";
        let _ = api
            .post_message(&prop.channel, text, Some(blocks::status_card(text)), thread)
            .await;
        return;
    };
    let columns = &stored.columns;
    let rows = &stored.rows;
    if !runtime.session_active(generation, cancel) {
        return;
    }

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
                let _ = api
                    .upload_file(&prop.channel, thread, "chart.png", png, Some(&caption))
                    .await;
                post_export_prompt(&runtime, api, prop, &result_id).await;
                return;
            }
            Err(e) => {
                let note = format!(
                    "⚠️ Couldn't render the requested chart: {} — posting the data instead.",
                    e.message
                );
                let _ = api
                    .post_message(
                        &prop.channel,
                        &note,
                        Some(blocks::status_card(&note)),
                        thread,
                    )
                    .await;
            }
        }
    }

    // Only the inline-table card embeds export buttons inline; every other path posts
    // a follow-up export prompt. Compute that once so a new format can't forget it.
    let inline_has_buttons = match format::decide_format(columns, rows, cfg) {
        ResultFormat::Empty => {
            // Defensive: rows were non-empty above, but never panic in the bot loop.
            let _ = api
                .post_message(
                    &prop.channel,
                    &summary,
                    Some(blocks::status_card(&summary)),
                    thread,
                )
                .await;
            true
        }
        ResultFormat::InlineTable(table) => {
            if let Ok(message_ts) = api
                .post_message(
                    &prop.channel,
                    &summary,
                    Some(blocks::result_card(&table, &summary, Some(&result_id))),
                    thread,
                )
                .await
            {
                runtime.results.bind_message(&result_id, &message_ts);
            }
            true
        }
        ResultFormat::ChartImage(spec) => {
            match chart::render_png(&spec, columns, rows) {
                Ok(png) => {
                    let _ = api
                        .upload_file(&prop.channel, thread, "chart.png", png, Some(&summary))
                        .await;
                }
                Err(_) => attach(api, prop, columns, rows, dialect, &summary, "csv").await, // unchartable → CSV
            }
            false
        }
        ResultFormat::CsvAttachment => {
            attach(api, prop, columns, rows, dialect, &summary, "csv").await;
            false
        }
        ResultFormat::XlsxAttachment => {
            attach(api, prop, columns, rows, dialect, &summary, "xlsx").await;
            false
        }
    };
    if !inline_has_buttons {
        post_export_prompt(&runtime, api, prop, &result_id).await;
    }
}

async fn post_export_prompt(
    runtime: &SlackRuntime,
    api: &SlackApi,
    prop: &PendingProposal,
    result_id: &str,
) {
    if let Ok(message_ts) = api
        .post_message(
            &prop.channel,
            "Export this result as…",
            Some(blocks::export_prompt_card(result_id)),
            Some(&prop.thread_ts),
        )
        .await
    {
        runtime.results.bind_message(result_id, &message_ts);
    }
}

async fn attach(
    api: &SlackApi,
    prop: &PendingProposal,
    columns: &[String],
    rows: &[Vec<Option<String>>],
    dialect: &str,
    summary: &str,
    fmt: &str,
) {
    if let Err(e) = attachment_preflight(columns, rows, fmt) {
        let _ = api
            .post_message(
                &prop.channel,
                &e.message,
                Some(blocks::error_card(&e.message)),
                Some(&prop.thread_ts),
            )
            .await;
        return;
    }
    let mut opts: crate::export::ExportOptions =
        match serde_json::from_value(json!({ "format": fmt })) {
            Ok(o) => o,
            Err(_) => return,
        };
    opts.bool_cols = crate::export::detect_bool_cols(columns.len(), rows);
    let label = export_label(&prop.sql);
    if fmt == "sql" {
        opts.sql.table = label.clone();
        opts.sql.multi_row = true;
    }
    match crate::export::export_rows_to_bytes_for_dialect(columns, rows, &opts, dialect).await {
        Ok(bytes) if bytes.len() <= super::api::ATTACHMENT_BYTE_CAP => {
            let ext = if fmt == "markdown" { "md" } else { fmt };
            let filename = format!("{label}.{ext}");
            let _ = api
                .upload_file(
                    &prop.channel,
                    Some(&prop.thread_ts),
                    &filename,
                    bytes,
                    Some(summary),
                )
                .await;
        }
        Ok(_) => {
            let message = "Export exceeded the 20 MiB Slack attachment limit.";
            let _ = api
                .post_message(
                    &prop.channel,
                    message,
                    Some(blocks::error_card(message)),
                    Some(&prop.thread_ts),
                )
                .await;
        }
        Err(e) => {
            let _ = api
                .post_message(
                    &prop.channel,
                    &format!("Export failed: {}", e.message),
                    Some(blocks::error_card(&e.message)),
                    Some(&prop.thread_ts),
                )
                .await;
        }
    }
}

/// Filename stem for export attachments: the first table named after FROM in the
/// executed query (schema qualifier and quoting dropped, filename-safe chars only),
/// so a thread with several exports doesn't collect identically-named `result.csv`s.
fn export_label(sql: &str) -> String {
    let lower = mask_sql(sql).to_ascii_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let candidate = words
        .windows(2)
        .find(|w| w[0] == "from")
        .map(|w| w[1])
        .unwrap_or("");
    // Only a bare identifier names the file: `FROM (subquery)` has no table, and
    // mask_sql erases quoted identifiers to opaque `q…q` tokens (unrecoverable by
    // design — never expose their content), so both fall back to "result".
    if !candidate
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    {
        return "result".to_string();
    }
    let token: String = candidate
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .collect();
    let label: String = token
        .rsplit('.')
        .next()
        .unwrap_or("")
        .chars()
        .take(64)
        .collect();
    if label.is_empty() || label == "q" {
        "result".to_string()
    } else {
        label
    }
}

fn attachment_preflight(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    fmt: &str,
) -> Result<(), AppError> {
    let raw = columns
        .iter()
        .chain(rows.iter().flatten().flatten())
        .fold(0usize, |n, s| n.saturating_add(s.len()));
    let cells = rows.len().saturating_mul(columns.len());
    let structural = cells
        .saturating_mul(if fmt == "xlsx" { 96 } else { 24 })
        .saturating_add(rows.len().saturating_mul(64))
        .saturating_add(columns.len().saturating_mul(512));
    let expansion = match fmt {
        // JSON can turn every control byte into a six-byte \u00XX escape.
        "json" => raw.saturating_mul(6),
        // Delimited/markdown/SQL escaping can at most double each source byte
        // (quote doubling); SQL batches tuples, so per-row framing stays within
        // the structural allowance above.
        "csv" | "tsv" | "markdown" | "sql" => raw.saturating_mul(2),
        // XML entities can expand one source byte to five, then ZIP framing can add
        // overhead even for incompressible data. Six is a conservative pre-allocation cap.
        "xlsx" => raw.saturating_mul(6),
        _ => return Err(AppError::new("unsupported Slack attachment format")),
    };
    if expansion.saturating_add(structural) > super::api::ATTACHMENT_BYTE_CAP {
        return Err(AppError::new(
            "Export could expand beyond Slack's 20 MiB attachment budget; run a narrower query.",
        ));
    }
    Ok(())
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
            "SELECT count(*), round(avg(score), 2) FROM metrics",
            "SELECT row_number() OVER (ORDER BY id) FROM metrics",
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
        for q in [
            "EXPLAIN SELECT 1",
            "EXPLAIN ANALYZE SELECT 1",
            "SHOW search_path",
        ] {
            assert!(
                validate_read_only(q).is_err(),
                "should reject non-wrappable: {q}"
            );
        }
    }

    #[test]
    fn mutations_blocked_anywhere() {
        for q in [
            "DROP TABLE users",
            "DELETE FROM users",
            "WITH del AS (DELETE FROM t RETURNING *) SELECT * FROM del", // writable CTE
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
            "SELECT * FROM t FOR UPDATE", // row lock
            "SELECT * FROM t FOR SHARE",
            "SELECT * FROM t FOR\nSHARE",
            "SELECT * FROM t INTO OUTFILE '/tmp/leak'",
            "SELECT 1; DROP TABLE users", // multi-statement
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

    #[test]
    fn mysql_executable_comments_are_never_masked_as_inert() {
        assert!(validate_read_only("SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */").is_err());
        assert!(validate_read_only("SELECT 1 /*M!100100 INTO OUTFILE '/tmp/x' */").is_err());
        assert!(validate_read_only("SELECT '/*! DROP TABLE x */' AS text").is_ok());
    }

    #[test]
    fn function_policy_blocks_unknown_or_effectful_routines() {
        for q in [
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT nextval('seq')",
            "SELECT sleep(10)",
            "SELECT load_extension('/tmp/x')",
            "SELECT custom_side_effect()",
            "SELECT pg_catalog.count(*) FROM t",
            "SELECT \"custom\"()",
        ] {
            assert!(validate_read_only(q).is_err(), "unsafe routine passed: {q}");
        }
        for q in [
            "SELECT count(*) FROM t",
            "SELECT date_trunc('month', created_at), sum(total) FROM t GROUP BY 1",
            "SELECT coalesce(lower(name), '') FROM t",
        ] {
            assert!(validate_read_only(q).is_ok(), "safe routine blocked: {q}");
        }
    }

    #[test]
    fn export_label_names_attachments_after_the_queried_table() {
        assert_eq!(export_label("SELECT * FROM orders WHERE id = 1"), "orders");
        assert_eq!(export_label("SELECT * FROM sales.orders o"), "orders");
        // Quoted identifiers are opaque after mask_sql (their content must not leak).
        assert_eq!(export_label("SELECT * FROM \"Order Items\""), "result");
        assert_eq!(export_label("SELECT * FROM `metrics`"), "result");
        assert_eq!(export_label("SELECT * FROM (SELECT 1) x"), "result");
        assert_eq!(export_label("SELECT 1"), "result");
        assert_eq!(export_label("SELECT * FROM 'not a table'"), "result");
    }

    /// Reserved words preceding `(` are SQL syntax, not routine calls — subqueries,
    /// parenthesized predicates, set operations, and expressions must all pass.
    #[test]
    fn function_policy_accepts_keyword_parens() {
        for q in [
            "SELECT * FROM (SELECT id FROM t) sub",
            "SELECT * FROM t WHERE (a = 1 AND (b = 2 OR c = 3))",
            "SELECT (a + b) AS total FROM t",
            "SELECT * FROM t JOIN (SELECT id FROM u) v ON (t.id = v.id)",
            "SELECT * FROM a LEFT JOIN b USING (id)",
            "SELECT id FROM t UNION (SELECT id FROM u)",
            "SELECT CASE WHEN (a > 1) THEN (a) ELSE (b) END FROM t",
            "SELECT * FROM t WHERE a IN (1, 2, 3) HAVING (count(*) > 1)",
            "SELECT sum(x) FROM t GROUP BY (a), (b) ORDER BY (a) LIMIT (5)",
            "WITH x AS (SELECT 1 AS n) SELECT * FROM x WHERE NOT (n = 2)",
            "SELECT * FROM t WHERE a BETWEEN (1) AND (5) OR (b LIKE ('x%'))",
        ] {
            assert!(validate_read_only(q).is_ok(), "keyword paren rejected: {q}");
        }
        // The keyword skip must not admit actual unknown routines.
        for q in [
            "SELECT unions(1)",
            "SELECT fromage(1)",
            "SELECT wherever(1)",
        ] {
            assert!(
                validate_read_only(q).is_err(),
                "unknown routine passed: {q}"
            );
        }
    }

    #[test]
    fn result_memory_budget_rejects_oversized_values_and_shapes() {
        assert!(validate_result_payload(&["a".into()], &[vec![Some("ok".into())]]).is_ok());
        assert!(
            validate_result_payload(&["a".into(), "b".into()], &[vec![Some("ragged".into())]])
                .is_err()
        );
        assert!(
            validate_result_payload(&["a".into()], &[vec![Some("x".repeat(1024 * 1024 + 1))]])
                .is_err()
        );
    }

    #[test]
    fn attachment_expansion_is_bounded_before_formatting() {
        assert!(attachment_preflight(&["a".into()], &[vec![Some("ok".into())]], "json").is_ok());
        let large = "\u{0001}".repeat(super::super::api::ATTACHMENT_BYTE_CAP / 5);
        assert!(attachment_preflight(&["a".into()], &[vec![Some(large)]], "json").is_err());
    }

    #[test]
    fn thread_context_forwards_only_allowlisted_authors_and_this_bot() {
        let cfg = SlackConfig {
            allowlist_channels: vec!["C1".into()],
            allowlist_users: vec!["U1".into()],
            ..Default::default()
        };
        assert_eq!(
            thread_role(&cfg, "C1", &json!({ "user": "U1" }), Some("UBOT")),
            Some("user")
        );
        assert_eq!(
            thread_role(&cfg, "C1", &json!({ "user": "U2" }), Some("UBOT")),
            None
        );
        assert_eq!(
            thread_role(
                &cfg,
                "C1",
                &json!({ "user": "UBOT", "bot_id": "B1" }),
                Some("UBOT")
            ),
            Some("assistant")
        );
        assert_eq!(
            thread_role(
                &cfg,
                "C1",
                &json!({ "user": "UOTHERBOT", "bot_id": "B2" }),
                Some("UBOT")
            ),
            None
        );
    }

    #[test]
    fn execution_event_serializes_connection_identity_atomically() {
        let event = SlackExecutionEvent {
            sql: "SELECT 1",
            duration_ms: 7,
            status: "ok",
            rows: Some(1),
            error: None,
            slack_user: "U1",
            connection_id: "conn-9",
            database: "analytics",
            connection: SlackConnectionIdentity {
                id: "conn-9",
                database: "analytics",
                driver: "duckdb",
            },
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["connectionId"], "conn-9");
        assert_eq!(value["database"], "analytics");
        assert_eq!(value["connection"]["id"], "conn-9");
        assert_eq!(value["connection"]["database"], "analytics");
        assert_eq!(value["connection"]["driver"], "duckdb");
    }
}
