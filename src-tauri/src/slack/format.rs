//! Result → Slack presentation decision + renderers. Pure logic, unit-tested.

use super::chart::ChartSpec;
use super::config::SlackConfig;

pub enum ResultFormat {
    /// Small result — monospace table text for an inline code block.
    InlineTable(String),
    /// Chart-able result — a spec for the local plotters renderer (chart.rs).
    ChartImage(ChartSpec),
    /// Medium result — CSV file attachment.
    CsvAttachment,
    /// Large or wide result — XLSX file attachment.
    XlsxAttachment,
    /// No rows.
    Empty,
}

/// Cap for the rendered inline table text (must fit a 3000-char section block).
const INLINE_TEXT_CAP: usize = 2700;
const INLINE_MAX_COLS: usize = 5;
const CHART_MAX_ROWS: usize = 50;
const XLSX_COL_THRESHOLD: usize = 15;

pub fn decide_format(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    cfg: &SlackConfig,
) -> ResultFormat {
    if rows.is_empty() {
        return ResultFormat::Empty;
    }
    if rows.len() <= cfg.max_rows_inline && columns.len() <= INLINE_MAX_COLS {
        let text = render_inline_table(columns, rows);
        if text.chars().count() <= INLINE_TEXT_CAP {
            return ResultFormat::InlineTable(text);
        }
    }
    if cfg.charts_enabled {
        if let Some(spec) = auto_chart_spec(columns, rows) {
            return ResultFormat::ChartImage(spec);
        }
    }
    if rows.len() <= cfg.max_rows_file && columns.len() <= XLSX_COL_THRESHOLD {
        return ResultFormat::CsvAttachment;
    }
    ResultFormat::XlsxAttachment
}

/// Space-padded monospace table (rendered inside a triple-backtick code block).
/// Boolean-looking columns render as TRUE/FALSE — the same words the desktop
/// grid displays and the Slack export files emit (same heuristic + token map).
pub fn render_inline_table(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    const CELL_CAP: usize = 40;
    let bools = crate::export::detect_bool_cols(columns.len(), rows);
    let cell = |k: usize, v: &Option<String>| -> String {
        let s = match v {
            None => "NULL".to_string(),
            Some(s) => match bools.contains(&k).then(|| crate::export::bool_token(s)).flatten() {
                Some(true) => "TRUE".to_string(),
                Some(false) => "FALSE".to_string(),
                None => s.replace(['\n', '\r'], " "),
            },
        };
        if s.chars().count() > CELL_CAP {
            let cut: String = s.chars().take(CELL_CAP - 1).collect();
            format!("{cut}…")
        } else {
            s
        }
    };
    let mut widths: Vec<usize> = columns.iter().map(|c| c.chars().count()).collect();
    let rendered: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            (0..columns.len())
                .map(|k| {
                    let s = cell(k, &r.get(k).cloned().flatten());
                    widths[k] = widths[k].max(s.chars().count());
                    s
                })
                .collect()
        })
        .collect();
    let pad = |s: &str, w: usize| -> String {
        let n = s.chars().count();
        format!("{s}{}", " ".repeat(w.saturating_sub(n)))
    };
    let mut out = String::new();
    let head: Vec<String> = columns.iter().enumerate().map(|(k, c)| pad(c, widths[k])).collect();
    out.push_str(head.join("  ").trim_end());
    out.push('\n');
    let rule: Vec<String> = widths.iter().map(|w| "-".repeat(*w)).collect();
    out.push_str(&rule.join("  "));
    out.push('\n');
    for r in rendered {
        let line: Vec<String> = r.iter().enumerate().map(|(k, s)| pad(s, widths[k])).collect();
        out.push_str(line.join("  ").trim_end());
        out.push('\n');
    }
    out
}

fn looks_like_date(name: &str, values: &[Option<String>]) -> bool {
    let n = name.to_lowercase();
    if ["date", "time", "created", "month", "year", "day", "week"]
        .iter()
        .any(|w| n.contains(w))
    {
        return true;
    }
    // YYYY-MM-DD prefix on every non-null value.
    let mut saw = false;
    for v in values.iter().flatten() {
        saw = true;
        let b = v.as_bytes();
        let ok = b.len() >= 10
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[7] == b'-'
            && b[8..10].iter().all(u8::is_ascii_digit);
        if !ok {
            return false;
        }
    }
    saw
}

/// Auto-chart heuristic (only when no explicit chart was requested): 2–4 columns,
/// first column date-like, rest numeric, ≤50 rows → a default spec for chart.rs.
pub fn auto_chart_spec(columns: &[String], rows: &[Vec<Option<String>>]) -> Option<ChartSpec> {
    if columns.len() < 2 || columns.len() > 4 || rows.is_empty() || rows.len() > CHART_MAX_ROWS {
        return None;
    }
    let col = |k: usize| -> Vec<Option<String>> { rows.iter().map(|r| r.get(k).cloned().flatten()).collect() };
    if !looks_like_date(&columns[0], &col(0)) {
        return None;
    }
    for k in 1..columns.len() {
        if !super::chart::numeric(&col(k)) {
            return None;
        }
    }
    Some(ChartSpec {
        kind: if rows.len() <= 12 { "bar" } else { "line" }.to_string(),
        x: Some(columns[0].clone()),
        series: columns[1..].to_vec(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SlackConfig {
        SlackConfig::default()
    }
    fn rows(n: usize, cols: usize) -> Vec<Vec<Option<String>>> {
        (0..n).map(|i| (0..cols).map(|k| Some(format!("v{i}_{k}"))).collect()).collect()
    }
    fn cols(n: usize) -> Vec<String> {
        (0..n).map(|k| format!("c{k}")).collect()
    }

    #[test]
    fn empty_result() {
        assert!(matches!(decide_format(&cols(2), &[], &cfg()), ResultFormat::Empty));
    }

    #[test]
    fn small_result_inline() {
        assert!(matches!(decide_format(&cols(3), &rows(5, 3), &cfg()), ResultFormat::InlineTable(_)));
    }

    #[test]
    fn medium_result_csv() {
        assert!(matches!(decide_format(&cols(6), &rows(100, 6), &cfg()), ResultFormat::CsvAttachment));
    }

    #[test]
    fn huge_or_wide_result_xlsx() {
        let mut c = cfg();
        c.max_rows_file = 50;
        assert!(matches!(decide_format(&cols(3), &rows(60, 3), &c), ResultFormat::XlsxAttachment));
        assert!(matches!(decide_format(&cols(20), &rows(10, 20), &cfg()), ResultFormat::XlsxAttachment));
    }

    #[test]
    fn chart_detected_when_enabled() {
        let mut c = cfg();
        c.charts_enabled = true;
        c.max_rows_inline = 0; // force past inline
        let columns = vec!["month".to_string(), "revenue".to_string()];
        let data: Vec<Vec<Option<String>>> =
            (1..=9).map(|m| vec![Some(format!("2026-0{m}-01")), Some(format!("{}", m * 100))]).collect();
        assert!(matches!(decide_format(&columns, &data, &c), ResultFormat::ChartImage(_)));
        // charts off → falls through to CSV
        c.charts_enabled = false;
        assert!(matches!(decide_format(&columns, &data, &c), ResultFormat::CsvAttachment));
    }

    #[test]
    fn non_numeric_second_col_not_chartable() {
        let columns = vec!["date".to_string(), "name".to_string()];
        let data = vec![vec![Some("2026-01-01".into()), Some("bob".into())]];
        assert!(auto_chart_spec(&columns, &data).is_none());
    }

    #[test]
    fn auto_spec_names_columns() {
        let columns = vec!["month".to_string(), "rev".to_string()];
        let data: Vec<Vec<Option<String>>> =
            (1..=9).map(|m| vec![Some(format!("2026-0{m}-01")), Some(format!("{m}"))]).collect();
        let spec = auto_chart_spec(&columns, &data).unwrap();
        assert_eq!(spec.kind, "bar");
        assert_eq!(spec.x.as_deref(), Some("month"));
        assert_eq!(spec.series, vec!["rev".to_string()]);
    }

    #[test]
    fn inline_table_pads_and_caps() {
        let t = render_inline_table(&cols(2), &rows(2, 2));
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines.len(), 4); // header + rule + 2 rows
        assert!(lines[1].starts_with("--"));
    }
}
