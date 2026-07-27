//! Block Kit message builders. Pure `serde_json::Value` construction, no I/O.
//! Every builder returns the BLOCKS ARRAY (what `chat.postMessage`'s `blocks`
//! field takes). Slack hard-caps a section's mrkdwn text at 3000 chars — all
//! display text is bounded and Slack metacharacters are encoded. Executable SQL
//! is never truncated: callers attach it as a .sql file when it cannot fit exactly.

use serde_json::{json, Value};

/// Keep headroom under Slack's 3000-char section cap for the surrounding markup.
const SECTION_CAP: usize = 2800;
const SQL_MARKUP_CHARS: usize = 10;

/// Char-safe truncation with an ellipsis marker.
pub fn trunc(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let cut: String = s.chars().take(cap.saturating_sub(2)).collect();
    format!("{cut}\n…")
}

/// Slack requires these three characters to be entity-encoded in mrkdwn text.
/// Encoding prevents user/model/database text from creating mentions or links.
pub fn escape_mrkdwn(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn bounded_mrkdwn(s: &str, cap: usize) -> String {
    let escaped = escape_mrkdwn(s);
    trunc(&escaped, cap)
}

/// SQL shown in the approval card must be byte-for-byte recoverable after Slack
/// decodes entities. A fence in the SQL or an oversized escaped form requires a
/// file attachment instead.
pub fn sql_can_display(sql: &str) -> bool {
    !sql.contains("```")
        && escape_mrkdwn(sql)
            .chars()
            .count()
            .saturating_add(SQL_MARKUP_CHARS)
            <= SECTION_CAP
}

fn sql_section(sql: &str) -> Value {
    if sql_can_display(sql) {
        section(format!("```\n{}\n```", escape_mrkdwn(sql)))
    } else {
        section("_Exact executable SQL attached as `proposal.sql`._".to_string())
    }
}

fn safe_code(s: &str, cap: usize) -> String {
    // Slack has no escape for a code fence. A zero-width separator preserves the
    // visible cell text while preventing untrusted result data from ending it.
    let fenced = s.replace("```", "``\u{200b}`");
    bounded_mrkdwn(&fenced, cap)
}

fn section(text: String) -> Value {
    json!({ "type": "section", "text": { "type": "mrkdwn", "text": text } })
}

/// The "thinking…" card — posted immediately while the AI generates SQL.
pub fn thinking_card() -> Value {
    json!([section("🤔 *Generating query…*".to_string())])
}

/// The proposal card — explanation + SQL + Approve/Reject buttons.
/// `proposal_id` ties the buttons to a pending proposal in `approval.rs`.
pub fn proposal_card(explanation: &str, sql: &str, proposal_id: &str) -> Value {
    json!([
        section(format!("🤖 *Proposed query*\n{}", bounded_mrkdwn(explanation, 500))),
        sql_section(sql),
        { "type": "actions", "elements": [
            { "type": "button", "text": { "type": "plain_text", "text": "✅ Approve" },
              "style": "primary", "value": format!("approve:{proposal_id}"),
              "action_id": "approve_query" },
            { "type": "button", "text": { "type": "plain_text", "text": "❌ Reject" },
              "style": "danger", "value": format!("reject:{proposal_id}"),
              "action_id": "reject_query" }
        ]}
    ])
}

/// A proposal card with its buttons replaced by a status line (running/done/rejected/expired).
pub fn resolved_proposal_card(explanation: &str, sql: &str, status: &str) -> Value {
    json!([
        section(format!("🤖 *Proposed query*\n{}", bounded_mrkdwn(explanation, 500))),
        sql_section(sql),
        { "type": "context", "elements": [ { "type": "mrkdwn", "text": bounded_mrkdwn(status, 500) } ] }
    ])
}

/// An error card.
pub fn error_card(message: &str) -> Value {
    json!([section(format!(
        "⚠️ {}",
        bounded_mrkdwn(message, SECTION_CAP - 3)
    ))])
}

/// The export formats offered on every result: (button label, ExportOptions format id).
pub const EXPORT_FORMATS: [(&str, &str); 4] = [
    ("CSV", "csv"),
    ("Excel", "xlsx"),
    ("JSON", "json"),
    ("Markdown", "markdown"),
];

/// An actions row of "Export as …" buttons tied to a stored result.
fn export_actions(result_id: &str) -> Value {
    let buttons: Vec<Value> = EXPORT_FORMATS
        .iter()
        .map(|(label, fmt)| {
            json!({
                "type": "button",
                "text": { "type": "plain_text", "text": *label },
                "value": format!("export:{fmt}:{result_id}"),
                "action_id": format!("export_{fmt}"),
            })
        })
        .collect();
    json!({ "type": "actions", "elements": buttons })
}

/// A monospace inline result table (already rendered to text) + a summary line +
/// export buttons (when the result is stored for export).
pub fn result_card(table_text: &str, summary: &str, result_id: Option<&str>) -> Value {
    let mut blocks = vec![
        section(format!(
            "```\n{}\n```",
            safe_code(table_text, SECTION_CAP - SQL_MARKUP_CHARS)
        )),
        json!({ "type": "context", "elements": [ { "type": "mrkdwn", "text": bounded_mrkdwn(summary, 500) } ] }),
    ];
    if let Some(id) = result_id {
        blocks.push(export_actions(id));
    }
    Value::Array(blocks)
}

/// A follow-up "export this result as…" card (posted under file/chart results).
pub fn export_prompt_card(result_id: &str) -> Value {
    json!([
        { "type": "context", "elements": [ { "type": "mrkdwn", "text": "Export this result as…" } ] },
        export_actions(result_id)
    ])
}

/// A bare status/summary card (empty results, cancellations, …).
pub fn status_card(text: &str) -> Value {
    json!([section(bounded_mrkdwn(text, SECTION_CAP))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_card_wires_button_values() {
        let v = proposal_card("Lists users.", "SELECT * FROM \"users\"", "p42");
        let actions = &v[2]["elements"];
        assert_eq!(actions[0]["value"], "approve:p42");
        assert_eq!(actions[0]["action_id"], "approve_query");
        assert_eq!(actions[1]["value"], "reject:p42");
    }

    #[test]
    fn export_buttons_carry_format_and_result_id() {
        let v = result_card("a  b", "1 row", Some("res-7"));
        let actions = v.as_array().unwrap().last().unwrap();
        assert_eq!(actions["type"], "actions");
        assert_eq!(actions["elements"][0]["value"], "export:csv:res-7");
        assert_eq!(actions["elements"][1]["value"], "export:xlsx:res-7");
        // Without a stored result there are no buttons.
        let bare = result_card("a", "1 row", None);
        assert_eq!(bare.as_array().unwrap().len(), 2);
    }

    #[test]
    fn sections_stay_under_slack_cap() {
        let long_sql = "SELECT ".to_string() + &"x, ".repeat(5000);
        let v = proposal_card("e", &long_sql, "p1");
        let text = v[1]["text"]["text"].as_str().unwrap();
        assert!(text.chars().count() <= 3000);
        assert!(text.contains("proposal.sql"));
    }

    #[test]
    fn exact_sql_is_never_truncated_and_unsafe_sql_requires_attachment() {
        let sql = "SELECT '<admin>' AS x";
        assert!(sql_can_display(sql));
        let v = proposal_card("e", sql, "p1");
        assert_eq!(
            v[1]["text"]["text"],
            "```\nSELECT '&lt;admin&gt;' AS x\n```"
        );

        assert!(!sql_can_display("SELECT '```'"));
        assert!(!sql_can_display(&"x".repeat(SECTION_CAP)));
    }

    #[test]
    fn dynamic_mrkdwn_and_result_fences_are_neutralized() {
        let v = error_card("bad <@U1> & <https://evil>");
        let text = v[0]["text"]["text"].as_str().unwrap();
        assert!(text.contains("&lt;@U1&gt;"));
        assert!(text.contains("&amp;"));

        let v = result_card("a```b", "ok", None);
        let text = v[0]["text"]["text"].as_str().unwrap();
        assert!(!text[4..text.len() - 4].contains("```"));
    }
}
