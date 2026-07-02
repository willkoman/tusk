//! Local chart rendering: plotters → in-memory PNG. Fully in-house — no external
//! chart service, no JS runtime. Text renders through plotters' `ab_glyph` backend
//! off the EMBEDDED JetBrains Mono font (assets/, OFL) — deterministic on every
//! platform, registered once as "sans-serif" (plotters' default label family)
//! before any text draw (an unregistered family is a hard error, not a fallback).

use crate::db::AppError;
use plotters::element::Pie;
use plotters::prelude::*;
use plotters::style::register_font;
use serde::Deserialize;
use std::sync::Once;

const W: u32 = 900;
const H: u32 = 500;
/// Charts are for shapes, not dumps — beyond this the bot suggests a file export.
const MAX_POINTS: usize = 400;
const MAX_PIE_SLICES: usize = 12;

/// Matches the app's accent palette family.
const PALETTE: [RGBColor; 8] = [
    RGBColor(59, 130, 246),
    RGBColor(45, 212, 191),
    RGBColor(167, 139, 250),
    RGBColor(244, 114, 182),
    RGBColor(251, 146, 60),
    RGBColor(63, 185, 80),
    RGBColor(239, 68, 68),
    RGBColor(234, 179, 8),
];

static FONT_INIT: Once = Once::new();
fn ensure_font() {
    FONT_INIT.call_once(|| {
        let _ = register_font(
            "sans-serif",
            FontStyle::Normal,
            include_bytes!("../../assets/JetBrainsMono-Regular.ttf"),
        );
    });
}

/// A chart request — either parsed from the AI's ```chart block (the user asked
/// for a chart, with their particulars honored) or auto-derived from the result
/// shape (format.rs heuristic).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChartSpec {
    #[serde(rename = "type")]
    pub kind: String, // "line" | "bar" | "scatter" | "pie"
    /// X column name (default: first column).
    pub x: Option<String>,
    /// Numeric series column names (default: every numeric column except x).
    pub series: Vec<String>,
    pub title: Option<String>,
    pub x_label: Option<String>,
    pub y_label: Option<String>,
    /// Any other keys the model emitted (e.g. stacked, horizontal, colors) that this
    /// renderer doesn't yet support — captured so they can be surfaced rather than
    /// silently dropped.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

impl ChartSpec {
    /// Tolerant parse of the AI's chart-block JSON; None when it isn't a usable spec.
    pub fn parse(text: &str) -> Option<ChartSpec> {
        let spec: ChartSpec = serde_json::from_str(text).ok()?;
        matches!(spec.kind.as_str(), "line" | "bar" | "scatter" | "pie").then_some(spec)
    }

    /// Short human description for the proposal card (incl. any unsupported
    /// particulars the model asked for, so the approver isn't misled).
    pub fn describe(&self) -> String {
        let mut s = format!("{} chart", self.kind);
        if let Some(x) = &self.x {
            s.push_str(&format!(" — x: {x}"));
        }
        if !self.series.is_empty() {
            s.push_str(&format!("; series: {}", self.series.join(", ")));
        }
        if let Some(note) = self.unsupported_note() {
            s.push_str(&format!(" ({note})"));
        }
        s
    }

    /// A note about requested-but-unsupported chart options (stacked, horizontal, …),
    /// or None when everything asked for is honored.
    pub fn unsupported_note(&self) -> Option<String> {
        if self.extra.is_empty() {
            return None;
        }
        let keys: Vec<&str> = self.extra.keys().map(String::as_str).collect();
        Some(format!("note: not yet supported, ignored: {}", keys.join(", ")))
    }
}

/// Column values resolved + parsed for drawing.
struct Prepared {
    labels: Vec<String>,
    /// Real x values when the x column is numeric (scatter uses them).
    x_numeric: Option<Vec<f64>>,
    series: Vec<(String, Vec<Option<f64>>)>,
}

fn col_index(columns: &[String], name: &str) -> Option<usize> {
    columns.iter().position(|c| c.eq_ignore_ascii_case(name))
}

/// True if the column has at least one value and every present value parses as f64.
/// Shared with `format::auto_chart_spec` so the heuristic and the renderer agree on
/// what "numeric" means (else the heuristic proposes charts the renderer rejects).
pub(crate) fn numeric(values: &[Option<String>]) -> bool {
    let mut saw = false;
    for v in values.iter().flatten() {
        saw = true;
        if v.parse::<f64>().is_err() {
            return false;
        }
    }
    saw
}

fn prepare(spec: &ChartSpec, columns: &[String], rows: &[Vec<Option<String>>]) -> Result<Prepared, AppError> {
    if rows.is_empty() {
        return Err(AppError::new("nothing to chart — the query returned no rows"));
    }
    if rows.len() > MAX_POINTS {
        return Err(AppError::new(format!(
            "too many rows to chart ({} > {MAX_POINTS}) — narrow the query or export a file",
            rows.len()
        )));
    }
    let col = |k: usize| -> Vec<Option<String>> { rows.iter().map(|r| r.get(k).cloned().flatten()).collect() };

    let xi = match &spec.x {
        Some(name) => col_index(columns, name)
            .ok_or_else(|| AppError::new(format!("chart x column \"{name}\" is not in the result")))?,
        None => 0,
    };
    let series_idx: Vec<usize> = if spec.series.is_empty() {
        (0..columns.len()).filter(|&k| k != xi && numeric(&col(k))).collect()
    } else {
        spec.series
            .iter()
            .map(|name| {
                col_index(columns, name)
                    .ok_or_else(|| AppError::new(format!("chart series column \"{name}\" is not in the result")))
            })
            .collect::<Result<_, _>>()?
    };
    if series_idx.is_empty() {
        return Err(AppError::new("no numeric columns to chart"));
    }

    let x_vals = col(xi);
    let labels: Vec<String> = x_vals.iter().map(|v| v.clone().unwrap_or_else(|| "NULL".into())).collect();
    let x_numeric = numeric(&x_vals)
        .then(|| x_vals.iter().map(|v| v.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0)).collect());

    let series = series_idx
        .into_iter()
        .map(|k| {
            let vals: Vec<Option<f64>> = col(k).iter().map(|v| v.as_deref().and_then(|s| s.parse().ok())).collect();
            if vals.iter().all(|v| v.is_none()) {
                return Err(AppError::new(format!("chart series column \"{}\" has no numeric values", columns[k])));
            }
            Ok((columns[k].clone(), vals))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Prepared { labels, x_numeric, series })
}

fn ce<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(format!("chart render: {e}"))
}

fn y_range(series: &[(String, Vec<Option<f64>>)]) -> (f64, f64) {
    let mut lo = 0.0f64;
    let mut hi = f64::MIN;
    for (_, vals) in series {
        for v in vals.iter().flatten() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
    }
    if hi == f64::MIN {
        hi = 1.0;
    }
    if (hi - lo).abs() < f64::EPSILON {
        hi = lo + 1.0;
    }
    (lo, hi + (hi - lo) * 0.05)
}

/// Render a chart spec against a result to PNG bytes.
pub fn render_png(spec: &ChartSpec, columns: &[String], rows: &[Vec<Option<String>>]) -> Result<Vec<u8>, AppError> {
    ensure_font();
    let p = prepare(spec, columns, rows)?;
    let mut buf = vec![0u8; (W * H * 3) as usize];
    {
        let root = BitMapBackend::with_buffer(&mut buf, (W, H)).into_drawing_area();
        root.fill(&WHITE).map_err(ce)?;
        match spec.kind.as_str() {
            "pie" => draw_pie(&root, spec, &p)?,
            _ => draw_xy(&root, spec, &p)?,
        }
        root.present().map_err(ce)?;
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, W, H);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().map_err(ce)?.write_image_data(&buf).map_err(ce)?;
    Ok(out)
}

type Area<'a> = DrawingArea<BitMapBackend<'a>, plotters::coord::Shift>;

fn draw_xy(root: &Area, spec: &ChartSpec, p: &Prepared) -> Result<(), AppError> {
    let n = p.labels.len();
    let (ylo, yhi) = y_range(&p.series);
    let scatter_x = spec.kind == "scatter";
    // Scatter with a numeric x column plots real x values; everything else
    // (and non-numeric scatter) uses category indices with label formatting.
    let (xlo, xhi) = if scatter_x && p.x_numeric.is_some() {
        let xs = p.x_numeric.as_ref().unwrap();
        let lo = xs.iter().cloned().fold(f64::MAX, f64::min);
        let hi = xs.iter().cloned().fold(f64::MIN, f64::max);
        let pad = ((hi - lo).abs()).max(1.0) * 0.05;
        (lo - pad, hi + pad)
    } else {
        (-0.6, n as f64 - 0.4)
    };

    let title = spec.title.clone().unwrap_or_else(|| "Query results".to_string());
    let mut chart = ChartBuilder::on(root)
        .caption(&title, ("sans-serif", 22))
        .margin(14)
        .x_label_area_size(36)
        .y_label_area_size(64)
        .build_cartesian_2d(xlo..xhi, ylo..yhi)
        .map_err(ce)?;

    let labels = p.labels.clone();
    let categorical = !(scatter_x && p.x_numeric.is_some());
    let category_fmt = move |x: &f64| {
        let i = x.round();
        if (i - x).abs() > 0.001 || i < 0.0 {
            return String::new();
        }
        labels.get(i as usize).cloned().unwrap_or_default()
    };
    let mut mesh = chart.configure_mesh();
    mesh.x_desc(spec.x_label.clone().unwrap_or_default())
        .y_desc(spec.y_label.clone().unwrap_or_default())
        .axis_desc_style(("sans-serif", 15))
        .label_style(("sans-serif", 13));
    if categorical {
        mesh.x_labels(n.min(12)).x_label_formatter(&category_fmt);
    }
    mesh.draw().map_err(ce)?;

    let ns = p.series.len();
    for (si, (name, vals)) in p.series.iter().enumerate() {
        let color = PALETTE[si % PALETTE.len()];
        match spec.kind.as_str() {
            "bar" => {
                // Grouped bars: manual rectangles (plotters has no grouped Histogram).
                let group_w = 0.8;
                let bar_w = group_w / ns as f64;
                chart
                    .draw_series(vals.iter().enumerate().filter_map(|(i, v)| {
                        v.map(|v| {
                            let x0 = i as f64 - group_w / 2.0 + si as f64 * bar_w;
                            Rectangle::new([(x0, 0.0), (x0 + bar_w * 0.92, v)], color.filled())
                        })
                    }))
                    .map_err(ce)?
                    .label(name.clone())
                    .legend(move |(x, y)| Rectangle::new([(x, y - 5), (x + 10, y + 5)], color.filled()));
            }
            "scatter" => {
                let xs = p.x_numeric.clone();
                chart
                    .draw_series(vals.iter().enumerate().filter_map(|(i, v)| {
                        v.map(|v| {
                            let x = xs.as_ref().map(|xs| xs[i]).unwrap_or(i as f64);
                            Circle::new((x, v), 4, color.filled())
                        })
                    }))
                    .map_err(ce)?
                    .label(name.clone())
                    .legend(move |(x, y)| Circle::new((x + 5, y), 4, color.filled()));
            }
            // line (default)
            _ => {
                let pts: Vec<(f64, f64)> =
                    vals.iter().enumerate().filter_map(|(i, v)| v.map(|v| (i as f64, v))).collect();
                chart
                    .draw_series(LineSeries::new(pts, color.stroke_width(2)))
                    .map_err(ce)?
                    .label(name.clone())
                    .legend(move |(x, y)| PathElement::new([(x, y), (x + 16, y)], color.stroke_width(2)));
            }
        }
    }
    if ns > 1 {
        chart
            .configure_series_labels()
            .border_style(RGBColor(180, 180, 180))
            .background_style(WHITE.mix(0.85))
            .label_font(("sans-serif", 13))
            .draw()
            .map_err(ce)?;
    }
    Ok(())
}

fn draw_pie(root: &Area, spec: &ChartSpec, p: &Prepared) -> Result<(), AppError> {
    let (name, vals) = &p.series[0];
    if p.labels.len() > MAX_PIE_SLICES {
        return Err(AppError::new(format!(
            "too many slices for a pie chart ({} > {MAX_PIE_SLICES}) — try a bar chart",
            p.labels.len()
        )));
    }
    let mut sizes: Vec<f64> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for (i, v) in vals.iter().enumerate() {
        let v = v.unwrap_or(0.0);
        if v < 0.0 {
            return Err(AppError::new("pie charts need non-negative values — try a bar chart"));
        }
        if v > 0.0 {
            sizes.push(v);
            labels.push(p.labels[i].clone());
        }
    }
    if sizes.is_empty() {
        return Err(AppError::new("all values are zero — nothing to chart"));
    }
    let colors: Vec<RGBColor> = (0..sizes.len()).map(|i| PALETTE[i % PALETTE.len()]).collect();
    let title = spec.title.clone().unwrap_or_else(|| format!("{name} — Query results"));
    root.draw(&Text::new(title, (20, 14), ("sans-serif", 22).into_font()))
        .map_err(ce)?;
    let center = (W as i32 / 2, H as i32 / 2 + 10);
    let radius = H as f64 * 0.32;
    let mut pie = Pie::new(&center, &radius, &sizes, &colors, &labels);
    pie.label_style(("sans-serif", 15).into_font().color(&BLACK));
    pie.percentages(("sans-serif", 13).into_font().color(&WHITE));
    root.draw(&pie).map_err(ce)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows_of(data: &[(&str, f64)]) -> (Vec<String>, Vec<Vec<Option<String>>>) {
        (
            vec!["month".to_string(), "revenue".to_string()],
            data.iter().map(|(m, v)| vec![Some(m.to_string()), Some(v.to_string())]).collect(),
        )
    }

    fn png_ok(bytes: &[u8]) -> bool {
        bytes.starts_with(&[0x89, b'P', b'N', b'G'])
    }

    #[test]
    fn parses_only_valid_specs() {
        assert!(ChartSpec::parse(r#"{"type":"bar","x":"month","series":["revenue"]}"#).is_some());
        assert!(ChartSpec::parse(r#"{"type":"treemap"}"#).is_none());
        assert!(ChartSpec::parse("not json").is_none());
    }

    #[test]
    fn unsupported_particulars_are_surfaced_not_dropped() {
        let spec = ChartSpec::parse(r#"{"type":"bar","x":"region","series":["rev"],"stacked":true,"horizontal":true}"#).unwrap();
        let note = spec.unsupported_note().expect("should flag unsupported keys");
        assert!(note.contains("stacked"));
        assert!(note.contains("horizontal"));
        assert!(spec.describe().contains("stacked"));
        // A fully-supported spec has no note.
        let clean = ChartSpec::parse(r#"{"type":"line","x":"month","series":["rev"],"title":"T"}"#).unwrap();
        assert!(clean.unsupported_note().is_none());
    }

    #[test]
    fn renders_each_kind_to_png() {
        let (cols, rows) = rows_of(&[("Jan", 10.0), ("Feb", 25.5), ("Mar", 17.0)]);
        for kind in ["line", "bar", "scatter", "pie"] {
            let spec = ChartSpec { kind: kind.into(), x: Some("month".into()), series: vec!["revenue".into()], ..Default::default() };
            let png = render_png(&spec, &cols, &rows).unwrap_or_else(|e| panic!("{kind}: {}", e.message));
            assert!(png_ok(&png), "{kind} did not produce a PNG");
            assert!(png.len() > 1000, "{kind} PNG suspiciously small");
        }
    }

    #[test]
    fn honors_axis_assignment_and_defaults() {
        let cols = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let rows: Vec<Vec<Option<String>>> =
            (0..5).map(|i| vec![Some(format!("r{i}")), Some(format!("{i}")), Some(format!("{}", i * 2))]).collect();
        // Defaults: x = first column, series = all numeric others.
        let spec = ChartSpec { kind: "line".into(), ..Default::default() };
        assert!(render_png(&spec, &cols, &rows).is_ok());
        // Explicit x on a named column; unknown columns error clearly.
        let bad = ChartSpec { kind: "line".into(), x: Some("nope".into()), ..Default::default() };
        assert!(render_png(&bad, &cols, &rows).unwrap_err().message.contains("nope"));
    }

    #[test]
    fn rejects_unchartable_data() {
        let cols = vec!["name".to_string(), "city".to_string()];
        let rows = vec![vec![Some("bob".into()), Some("nyc".into())]];
        let spec = ChartSpec { kind: "bar".into(), ..Default::default() };
        assert!(render_png(&spec, &cols, &rows).unwrap_err().message.contains("no numeric"));
        let (c2, r2) = rows_of(&[("x", 1.0)]);
        let too_many: Vec<Vec<Option<String>>> =
            (0..500).map(|i| vec![Some(format!("l{i}")), Some("1".into())]).collect();
        let spec2 = ChartSpec { kind: "line".into(), ..Default::default() };
        assert!(render_png(&spec2, &c2, &too_many).unwrap_err().message.contains("too many rows"));
        assert!(render_png(&spec2, &c2, &r2).is_ok());
    }
}
