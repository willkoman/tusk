//! Rust port of `src/ai/context.ts` for the Slack bot (the bot runs in Rust and
//! can't call the frontend). PARITY PAIR: keep the budgets, relevance scoring, and
//! sample formatting in step with the TS version — same class of pairing as
//! `editor/lexer.ts` ↔ `script.rs`. The system prompt itself intentionally differs:
//! Slack asks for exactly one read-only SELECT in a ```sql block.

use crate::tree::TableInfo;
use std::collections::HashSet;

// Budgets — mirror src/ai/context.ts.
const SCHEMA_BUDGET: usize = 12_000;
const FK_BUDGET: usize = 3_000;
const NAME_LIST_BUDGET: usize = 2_500;
const SAMPLE_BUDGET: usize = 4_000;
const SKILLS_BUDGET: usize = 8_000;
const CELL_CAP: usize = 80;

/// Sample rows pulled from a relation, for grounding the model in real values.
pub struct SampleTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

/// Connection facts the prompt needs (Slack has no editor SQL / selection).
pub struct SlackAiCtx {
    pub dialect: String, // "postgres" | "mysql" | "sqlite" | "duckdb"
    pub user: String,
    pub is_superuser: bool,
    pub permissions_enforced: bool,
    /// "refuse" = refuse destructive asks outright; anything else = propose a
    /// read-only preview SELECT instead. Execution gates enforce regardless.
    pub destructive_policy: String,
}

fn quote_note(dialect: &str) -> &'static str {
    match dialect {
        "mysql" => "Quote identifiers with backticks (`col`).",
        _ => "Quote identifiers with double quotes (\"col\").",
    }
}

/// 0 = table name appears verbatim in the focus, 1 = shares a word, 2 = unrelated.
fn relevance_score(t: &TableInfo, focus_lower: &str, focus_words: &HashSet<String>) -> u8 {
    let n = t.name.to_lowercase();
    if focus_lower.contains(&n) {
        return 0;
    }
    if n.split('_').any(|tok| focus_words.contains(tok)) {
        return 1;
    }
    2
}

fn focus_words(focus_lower: &str) -> HashSet<String> {
    focus_lower
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        .filter(|w| w.len() > 2)
        .map(str::to_string)
        .collect()
}

/// Tables actually relevant to the focus (score ≤ 1), most-relevant first, capped.
pub fn relevant_tables<'a>(tables: &'a [TableInfo], focus: &str, limit: usize) -> Vec<&'a TableInfo> {
    let f = focus.to_lowercase();
    let words = focus_words(&f);
    let mut scored: Vec<(u8, usize, &TableInfo)> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| (relevance_score(t, &f, &words), i, t))
        .filter(|(s, _, _)| *s <= 1)
        .collect();
    scored.sort_by_key(|(s, i, _)| (*s, *i));
    scored.into_iter().take(limit).map(|(_, _, t)| t).collect()
}

/// Render fetched sample rows as a compact, budgeted block of pipe-separated tables.
pub fn format_samples(samples: &[SampleTable]) -> String {
    // Parity with src/ai/context.ts `formatSamples`: collapse whitespace RUNS to a
    // single space WITHOUT trimming the edges (TS `s.replace(/\s+/g, " ")`), then cap.
    let collapse_ws = |s: &str| -> String {
        let mut out = String::with_capacity(s.len());
        let mut in_ws = false;
        for ch in s.chars() {
            if ch.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                }
                in_ws = true;
            } else {
                out.push(ch);
                in_ws = false;
            }
        }
        out
    };
    let cell = |v: &Option<String>| -> String {
        match v {
            None => "NULL".to_string(),
            Some(s) => {
                let s = collapse_ws(s);
                if s.chars().count() > CELL_CAP {
                    let cut: String = s.chars().take(CELL_CAP - 1).collect();
                    format!("{cut}…")
                } else {
                    s
                }
            }
        }
    };
    let mut out = String::new();
    for s in samples {
        if s.columns.is_empty() || s.rows.is_empty() {
            continue;
        }
        let plural = if s.rows.len() == 1 { "" } else { "s" };
        let mut block = format!("\n{}.{} ({} sample row{plural}):\n", s.schema, s.name, s.rows.len());
        block.push_str(&s.columns.join(" | "));
        block.push('\n');
        for r in &s.rows {
            let line: Vec<String> = (0..s.columns.len())
                .map(|k| cell(&r.get(k).cloned().flatten()))
                .collect();
            block.push_str(&line.join(" | "));
            block.push('\n');
        }
        if out.len() + block.len() > SAMPLE_BUDGET {
            break;
        }
        out.push_str(&block);
    }
    out
}

fn schema_summary(tables: &[TableInfo], focus: &str) -> String {
    let f = focus.to_lowercase();
    let words = focus_words(&f);
    let mut ranked: Vec<(u8, usize, &TableInfo)> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| (relevance_score(t, &f, &words), i, t))
        .collect();
    ranked.sort_by_key(|(s, i, _)| (*s, *i));

    let mut out = String::new();
    let mut rest: Vec<String> = Vec::new();
    for (_, _, t) in &ranked {
        let cols = t
            .columns
            .iter()
            .map(|c| format!("{} {}", c.name, c.data_type))
            .collect::<Vec<_>>()
            .join(", ");
        let line = format!("{}.{}({cols})\n", t.schema, t.name);
        if out.len() + line.len() > SCHEMA_BUDGET {
            rest.push(format!("{}.{}", t.schema, t.name));
        } else {
            out.push_str(&line);
        }
    }
    if !rest.is_empty() {
        // Never silently drop a table: list the remainder by NAME.
        let mut names = String::new();
        let mut listed = 0usize;
        for n in &rest {
            if names.len() + n.len() + 2 > NAME_LIST_BUDGET {
                break;
            }
            if !names.is_empty() {
                names.push_str(", ");
            }
            names.push_str(n);
            listed += 1;
        }
        out.push_str(&format!(
            "\nOther tables (columns available on request — ask the user to mention the table):\n{names}"
        ));
        if listed < rest.len() {
            out.push_str(&format!(", … and {} more", rest.len() - listed));
        }
        out.push('\n');
    }
    if out.is_empty() {
        "(no user tables)".to_string()
    } else {
        out
    }
}

/// Skills that apply to `database`, database-scoped first (the specific instruction
/// survives a budget cutoff). PARITY: mirrors `activeSkills` in `src/ai/skills.ts`.
pub fn active_skills<'a>(all: &'a [crate::skills::Skill], database: &str) -> Vec<&'a crate::skills::Skill> {
    let mut v: Vec<(u8, usize, &crate::skills::Skill)> = all
        .iter()
        .enumerate()
        .filter(|(_, s)| s.applies_to(database))
        .map(|(i, s)| (if s.scope == crate::skills::SCOPE_DATABASE { 0 } else { 1 }, i, s))
        .collect();
    v.sort_by_key(|(r, i, _)| (*r, *i));
    v.into_iter().map(|(_, _, s)| s).collect()
}

/// PARITY: mirrors `formatSkills` in `src/ai/skills.ts` — a dropped skill is NAMED, never
/// silently cut, so a user can tell their instruction didn't reach the model.
pub fn format_skills(skills: &[&crate::skills::Skill]) -> String {
    let mut out = String::new();
    let mut dropped: Vec<&str> = Vec::new();
    for s in skills {
        let body = s.body.trim();
        if body.is_empty() {
            continue;
        }
        let head = if s.description.trim().is_empty() {
            s.name.clone()
        } else {
            format!("{} — {}", s.name, s.description.trim())
        };
        let scope = if s.scope == crate::skills::SCOPE_DATABASE {
            format!(" (database: {})", s.database)
        } else {
            String::new()
        };
        let block = format!("\n## {head}{scope}\n{body}\n");
        if out.len() + block.len() > SKILLS_BUDGET {
            dropped.push(&s.name);
        } else {
            out.push_str(&block);
        }
    }
    if !dropped.is_empty() {
        out.push_str(&format!("\n(Not included, over the context budget: {})\n", dropped.join(", ")));
    }
    out
}

/// One FK as `orders.user_id -> users.id`, composite as `a.(x, y) -> b.(p, q)`.
/// PARITY: mirrors `fkLine` in `src/ai/context.ts`.
fn fk_line(e: &crate::relgraph::FkEdge) -> String {
    let rel = |schema: &str, table: &str| {
        if !schema.is_empty() && schema != "public" { format!("{schema}.{table}") } else { table.to_string() }
    };
    let cols = |c: &[String]| if c.len() == 1 { c[0].clone() } else { format!("({})", c.join(", ")) };
    format!(
        "{}.{} -> {}.{}",
        rel(&e.src_schema, &e.src_table),
        cols(&e.src_cols),
        rel(&e.dst_schema, &e.dst_table),
        cols(&e.dst_cols)
    )
}

/// FK edges, ones touching the focus tables first, budgeted.
/// PARITY: mirrors `foreignKeySummary` in `src/ai/context.ts`.
pub fn foreign_key_summary(fks: &[crate::relgraph::FkEdge], focus: &str) -> String {
    if fks.is_empty() {
        return String::new();
    }
    let f = focus.to_lowercase();
    let touches = |t: &str| f.contains(&t.to_lowercase());
    let mut ranked: Vec<(usize, &crate::relgraph::FkEdge)> = fks.iter().enumerate().collect();
    ranked.sort_by_key(|(i, e)| {
        let rel = if touches(&e.src_table) || touches(&e.dst_table) { 0 } else { 1 };
        (rel, *i)
    });

    let mut out = String::new();
    let mut dropped = 0usize;
    for (_, e) in ranked {
        let line = format!("{}\n", fk_line(e));
        if out.len() + line.len() > FK_BUDGET {
            dropped += 1;
        } else {
            out.push_str(&line);
        }
    }
    if dropped > 0 {
        out.push_str(&format!("… and {dropped} more foreign keys\n"));
    }
    out
}

/// The Slack-flavored system prompt: one read-only SELECT, one-sentence explanation.
/// `fks_known` distinguishes "no FKs declared" from "we never fetched them" — asserting
/// the former when it's the latter invites confidently wrong joins.
pub fn build_system_prompt(
    ctx: &SlackAiCtx,
    tables: &[TableInfo],
    conversation_text: &str,
    samples: &[SampleTable],
    fks: &[crate::relgraph::FkEdge],
    fks_known: bool,
    skills: &[&crate::skills::Skill],
) -> String {
    let mut lines: Vec<String> = vec![
        format!(
            "You are a SQL assistant connected to a {} database, answering questions asked in Slack. {}",
            ctx.dialect,
            quote_note(&ctx.dialect)
        ),
        format!(
            "Current role: {}{}.",
            if ctx.user.is_empty() { "(unknown)" } else { &ctx.user },
            if ctx.is_superuser { " (superuser)" } else { "" }
        ),
        String::new(),
        "Generate a single read-only SELECT query answering the user's question. Format your response as:".to_string(),
        "1. One sentence explaining what the query does (and any assumptions you made).".to_string(),
        "2. The query in a ```sql code block.".to_string(),
        String::new(),
        "Rules:".to_string(),
        "- Only SELECT queries. No INSERT/UPDATE/DELETE/DDL, no writable CTEs, no FOR UPDATE/FOR SHARE, and exactly one statement. This is enforced — mutating SQL will be rejected, never executed.".to_string(),
        if ctx.destructive_policy == "refuse" {
            "- If the user asks for anything destructive or mutating (insert/update/delete/drop/alter/truncate/any DDL/grants), do NOT write that SQL and do NOT emit any code block. Politely refuse and tell them to run it themselves in the Tusk desktop editor.".to_string()
        } else {
            "- If the user asks for anything destructive or mutating (insert/update/delete/drop/alter/truncate/any DDL/grants), do NOT write that SQL. Instead propose a read-only SELECT that previews the data their request would affect (e.g. the rows that would be deleted), state clearly that mutations can't run from Slack, and point them to the Tusk desktop editor for the actual change.".to_string()
        },
        "- Always quote identifiers as noted above.".to_string(),
        "- Use LIMIT when the user asks for \"top N\" or when the result could be large.".to_string(),
        "- If the question is ambiguous, make reasonable assumptions and note them in your explanation.".to_string(),
        "- If (and ONLY if) the user explicitly asks for a chart/graph/plot/visualization, ALSO return a second fenced block tagged `chart` after the sql block, containing JSON:".to_string(),
        "  {\"type\":\"line|bar|scatter|pie\",\"x\":\"<x column>\",\"series\":[\"<numeric column>\",...],\"title\":\"...\",\"xLabel\":\"...\",\"yLabel\":\"...\"}".to_string(),
        "  Column names must exactly match the SQL output columns. Honor the user's requested chart type, axis assignment, labels, and series choices; pick sensible defaults for anything unspecified. Keep chartable results small (LIMIT ≤ 100). Never emit a chart block when no chart was asked for.".to_string(),
    ];
    if ctx.permissions_enforced && !ctx.is_superuser {
        lines.push("- This role has limited privileges — stick to tables listed below.".to_string());
    }
    // User-authored skills: instructions, so they land BEFORE the data (the model should
    // know the house rules before it reads the schema). Safety rules still outrank them —
    // the Slack read-only gates are enforced in code, not by the prompt.
    let skill_text = format_skills(skills);
    if !skill_text.trim().is_empty() {
        lines.push(String::new());
        lines.push("# Skills".to_string());
        lines.push("Instructions the user has written for this workspace/database. Follow them. Where they conflict with your defaults, they win; where they conflict with the rules above, the rules above win.".to_string());
        lines.push(skill_text.trim_end().to_string());
    }
    lines.push(String::new());
    lines.push("Database schema (schema.table(columns)):".to_string());
    lines.push(schema_summary(tables, conversation_text));
    // The join graph — Tusk knows it, so the model must not guess join columns.
    let fk_text = foreign_key_summary(fks, conversation_text);
    if !fk_text.trim().is_empty() {
        lines.push(String::new());
        lines.push("Foreign keys (src -> dst). JOIN on these rather than guessing column names — this list is authoritative for the tables shown above:".to_string());
        lines.push(fk_text.trim_end().to_string());
    } else if fks_known && !tables.is_empty() {
        lines.push(String::new());
        lines.push("This schema declares no foreign keys. Infer joins from column names, and say so when you do.".to_string());
    }
    let sample_text = format_samples(samples);
    if !sample_text.trim().is_empty() {
        lines.push(String::new());
        lines.push(
            "Sample rows from the most relevant tables (real data, so you understand value shapes/formats — never assume these are the only rows):"
                .to_string(),
        );
        lines.push(sample_text.trim_end().to_string());
    }
    lines.join("\n")
}

/// All fenced blocks in an assistant message as (info-string, body) pairs.
pub fn extract_blocks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        let after = &rest[open + 3..];
        // The info string (e.g. "sql", "chart") runs to the first newline.
        let Some(nl) = after.find('\n') else { break };
        let lang = after[..nl].trim().to_lowercase();
        let body_start = &after[nl + 1..];
        let Some(close) = body_start.find("```") else { break };
        let body = body_start[..close].trim();
        if !body.is_empty() {
            out.push((lang, body.to_string()));
        }
        rest = &body_start[close + 3..];
    }
    out
}

/// Extract ```sql blocks (or untagged fences) — NOT ```chart/other-tagged blocks.
/// Mirrors context.ts `extractSqlBlocks` (which predates the chart tag) without regex.
pub fn extract_sql_blocks(text: &str) -> Vec<String> {
    extract_blocks(text)
        .into_iter()
        .filter(|(lang, _)| lang.is_empty() || lang == "sql")
        .map(|(_, body)| body)
        .collect()
}

/// The first ```chart block's body, if any (JSON chart spec).
pub fn extract_chart_block(text: &str) -> Option<String> {
    extract_blocks(text).into_iter().find(|(lang, _)| lang == "chart").map(|(_, b)| b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::ColumnInfo;

    fn t(name: &str, cols: &[(&str, &str)]) -> TableInfo {
        TableInfo {
            schema: "public".into(),
            name: name.into(),
            columns: cols
                .iter()
                .map(|(n, d)| ColumnInfo { name: n.to_string(), data_type: d.to_string() })
                .collect(),
        }
    }

    #[test]
    fn relevance_ranks_verbatim_then_shared_word() {
        let tables = vec![t("orders", &[("id", "int")]), t("order_items", &[("id", "int")]), t("users", &[("id", "int")])];
        let rel = relevant_tables(&tables, "top orders by items sold", 10);
        let names: Vec<&str> = rel.iter().map(|t| t.name.as_str()).collect();
        // "orders" appears verbatim (score 0); "order_items" shares the word "items"
        // (score 1); "users" is unrelated (score 2 → excluded). Mirrors context.ts.
        assert_eq!(names, vec!["orders", "order_items"]);
    }

    fn edge(src: &str, sc: &[&str], dst: &str, dc: &[&str]) -> crate::relgraph::FkEdge {
        crate::relgraph::FkEdge {
            constraint: format!("{src}_fk"),
            src_schema: "public".into(),
            src_table: src.into(),
            src_cols: sc.iter().map(|s| s.to_string()).collect(),
            dst_schema: "public".into(),
            dst_table: dst.into(),
            dst_cols: dc.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// PARITY with `src/ai/context.ts` `foreignKeySummary` — same rendering, same ranking.
    #[test]
    fn fk_summary_matches_the_ts_rendering() {
        assert_eq!(
            foreign_key_summary(&[edge("orders", &["customer_id"], "customers", &["id"])], "").trim(),
            "orders.customer_id -> customers.id"
        );
        assert_eq!(
            foreign_key_summary(&[edge("a", &["x", "y"], "b", &["p", "q"])], "").trim(),
            "a.(x, y) -> b.(p, q)"
        );
    }

    #[test]
    fn fk_summary_ranks_focus_tables_first_and_reports_drops() {
        let mut many: Vec<_> = (0..400).map(|i| edge(&format!("t{i}"), &["a"], &format!("u{i}"), &["id"])).collect();
        many.push(edge("orders", &["customer_id"], "customers", &["id"]));
        let out = foreign_key_summary(&many, "join orders to customers");
        assert!(out.starts_with("orders.customer_id -> customers.id
"));
        assert!(out.contains("more foreign keys"), "dropped edges must be acknowledged");
        assert!(out.len() < FK_BUDGET + 100);
    }

    /// The trap: an empty edge list means EITHER "none declared" OR "never fetched".
    /// Asserting the former when it's the latter invites confidently wrong joins.
    #[test]
    fn fk_absence_is_only_asserted_when_the_graph_was_fetched() {
        let ctx = SlackAiCtx {
            dialect: "postgres".into(),
            user: "me".into(),
            is_superuser: false,
            permissions_enforced: false,
            destructive_policy: "proposeReadonly".into(),
        };
        let tables = vec![t("orders", &[("id", "int")])];

        let unfetched = build_system_prompt(&ctx, &tables, "", &[], &[], false, &[]);
        assert!(!unfetched.to_lowercase().contains("no foreign keys"));

        let fetched = build_system_prompt(&ctx, &tables, "", &[], &[], true, &[]);
        assert!(fetched.contains("declares no foreign keys"));

        let with_fks = build_system_prompt(&ctx, &tables, "", &[], &[edge("orders", &["customer_id"], "customers", &["id"])], true, &[]);
        assert!(with_fks.contains("orders.customer_id -> customers.id"));
        assert!(with_fks.contains("JOIN on these rather than guessing"));
    }

    fn skill(name: &str, scope: &str, db: &str, body: &str) -> crate::skills::Skill {
        crate::skills::Skill {
            id: name.into(), name: name.into(), description: String::new(),
            scope: scope.into(), database: db.into(), enabled: true, body: body.into(),
        }
    }

    /// PARITY with `activeSkills` in `src/ai/skills.ts`: database-scoped first, so the
    /// specific instruction survives a budget cutoff ahead of the generic one.
    #[test]
    fn active_skills_scopes_and_orders_like_the_ts_side() {
        let all = vec![
            skill("ws", "workspace", "", "generic"),
            skill("db", "database", "pagila", "specific"),
            skill("other", "database", "elsewhere", "nope"),
        ];
        let got: Vec<&str> = active_skills(&all, "pagila").iter().map(|s| s.name.as_str()).collect();
        assert_eq!(got, vec!["db", "ws"]); // database-scoped ranks first
        let none: Vec<&str> = active_skills(&all, "unknown-db").iter().map(|s| s.name.as_str()).collect();
        assert_eq!(none, vec!["ws"]); // only workspace applies
    }

    #[test]
    fn skills_reach_the_prompt_and_a_dropped_one_is_named() {
        let ctx = SlackAiCtx {
            dialect: "postgres".into(), user: "me".into(), is_superuser: false,
            permissions_enforced: false, destructive_policy: "proposeReadonly".into(),
        };
        let tables = vec![t("orders", &[("id", "int")])];
        let s1 = skill("Revenue", "database", "pagila", "Revenue excludes refunds.");
        let out = build_system_prompt(&ctx, &tables, "", &[], &[], false, &[&s1]);
        assert!(out.contains("# Skills"));
        assert!(out.contains("Revenue excludes refunds."));
        // Skills are INSTRUCTIONS: they must precede the schema dump.
        assert!(out.find("# Skills").unwrap() < out.find("Database schema").unwrap());

        // Over budget → named, never silently cut.
        let big = skill("Huge", "workspace", "", &"x".repeat(SKILLS_BUDGET + 10));
        let small = skill("Small", "workspace", "", "keep me");
        let text = format_skills(&[&small, &big]);
        assert!(text.contains("keep me"));
        assert!(text.contains("Not included, over the context budget: Huge"));
    }

    #[test]
    fn schema_summary_lists_overflow_by_name() {
        let many: Vec<TableInfo> = (0..2000).map(|i| t(&format!("table_{i}"), &[("col_a", "text"), ("col_b", "integer")])).collect();
        let s = schema_summary(&many, "");
        assert!(s.len() < SCHEMA_BUDGET + NAME_LIST_BUDGET + 200);
        assert!(s.contains("Other tables"));
    }

    #[test]
    fn extract_sql_blocks_finds_fenced() {
        let text = "Here you go:\n```sql\nSELECT 1;\n```\nand also\n```\nSELECT 2\n```";
        assert_eq!(extract_sql_blocks(text), vec!["SELECT 1;".to_string(), "SELECT 2".to_string()]);
    }

    #[test]
    fn chart_blocks_split_from_sql() {
        let text = "Sales by month.\n```sql\nSELECT \"month\", \"total\" FROM \"s\"\n```\n```chart\n{\"type\":\"bar\",\"x\":\"month\",\"series\":[\"total\"]}\n```";
        assert_eq!(extract_sql_blocks(text), vec!["SELECT \"month\", \"total\" FROM \"s\"".to_string()]);
        let chart = extract_chart_block(text).unwrap();
        assert!(chart.contains("\"type\":\"bar\""));
        assert!(extract_chart_block("no charts here ```sql\nSELECT 1\n```").is_none());
    }

    #[test]
    fn format_samples_caps_cells() {
        let s = SampleTable {
            schema: "public".into(),
            name: "users".into(),
            columns: vec!["name".into()],
            rows: vec![vec![Some("x".repeat(500))], vec![None]],
        };
        let out = format_samples(&[s]);
        assert!(out.contains("…"));
        assert!(out.contains("NULL"));
    }
}
