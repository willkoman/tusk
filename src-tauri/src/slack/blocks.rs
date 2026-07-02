//! Block Kit message builders. Pure `serde_json::Value` construction, no I/O.
//! Every builder returns the BLOCKS ARRAY (what `chat.postMessage`'s `blocks`
//! field takes). Slack hard-caps a section's mrkdwn text at 3000 chars — all
//! display text is truncated to fit (the full SQL always lives in the approval
//! store, so truncation is cosmetic).

use serde_json::{json, Value};

/// Keep headroom under Slack's 3000-char section cap for the surrounding markup.
const SECTION_CAP: usize = 2800;

/// Char-safe truncation with an ellipsis marker.
pub fn trunc(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let cut: String = s.chars().take(cap.saturating_sub(2)).collect();
    format!("{cut}\n…")
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
        section(format!("🤖 *Proposed query*\n{}", trunc(explanation, 500))),
        section(format!("```{}```", trunc(sql, SECTION_CAP - 10))),
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
        section(format!("🤖 *Proposed query*\n{}", trunc(explanation, 500))),
        section(format!("```{}```", trunc(sql, SECTION_CAP - 10))),
        { "type": "context", "elements": [ { "type": "mrkdwn", "text": status.to_string() } ] }
    ])
}

/// An error card.
pub fn error_card(message: &str) -> Value {
    json!([section(format!("⚠️ {}", trunc(message, SECTION_CAP)))])
}

/// The export formats offered on every result: (button label, ExportOptions format id).
pub const EXPORT_FORMATS: [(&str, &str); 4] =
    [("CSV", "csv"), ("Excel", "xlsx"), ("JSON", "json"), ("Markdown", "markdown")];

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
        section(format!("```{}```", trunc(table_text, SECTION_CAP - 10))),
        json!({ "type": "context", "elements": [ { "type": "mrkdwn", "text": summary.to_string() } ] }),
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
    json!([section(trunc(text, SECTION_CAP))])
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
    }
}
