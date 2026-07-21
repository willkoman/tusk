//! User-authored **AI skills**: reusable instruction bundles the assistant is given as
//! working context. A skill is scoped either to the whole workspace (every connection) or
//! to one database by name.
//!
//! **On-disk format is the export format.** Each skill is one Markdown file with a small
//! frontmatter block in `<app-config>/skills/<id>.md`, so "export" is a file copy and
//! "import" is a parse — no separate serialization, and a skill can be hand-edited, diffed,
//! or checked into a repo. Deliberately not `serde_yaml`: the frontmatter is five known
//! scalar keys, and a YAML dependency would accept far more than we can round-trip.
//!
//! Both consumers read these: the desktop panel (`src/ai/skills.ts`) and the Slack bot.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::db::AppError;

/// Where a skill applies. `Database` matches on the connected database's NAME (what the
/// user sees), not a profile id — ad-hoc connections have no profile, and the same
/// database reached two ways should get the same skills.
pub const SCOPE_WORKSPACE: &str = "workspace";
pub const SCOPE_DATABASE: &str = "database";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Filename stem. Assigned on first save; stable across edits.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// "workspace" | "database"
    #[serde(default = "d_scope")]
    pub scope: String,
    /// Database name this applies to. Empty for workspace scope.
    #[serde(default)]
    pub database: String,
    #[serde(default = "d_true")]
    pub enabled: bool,
    /// The instructions themselves (Markdown). This is what reaches the model.
    #[serde(default)]
    pub body: String,
}

fn d_scope() -> String {
    SCOPE_WORKSPACE.to_string()
}
fn d_true() -> bool {
    true
}

impl Skill {
    /// Does this skill apply to a connection on `database`? Disabled skills never do.
    pub fn applies_to(&self, database: &str) -> bool {
        self.enabled
            && match self.scope.as_str() {
                SCOPE_DATABASE => !self.database.is_empty() && self.database == database,
                _ => true, // workspace (and any unknown scope, which must not silently vanish)
            }
    }
}

/// Filename-safe stem. Never allow `/`, `..`, or a leading dot to reach the path join.
fn safe_id(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "skill".to_string() } else { s }
}

/// `my-skill-1a2b3c` — slug of the name plus a monotonic suffix, so two skills named the
/// same don't collide and the filename stays legible.
fn new_id(name: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let slug: String = safe_id(&name.to_lowercase()).chars().take(32).collect();
    format!("{slug}-{:x}{:x}", nanos, n)
}

fn skills_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(e.to_string()))?
        .join("skills"))
}

/// Escape a frontmatter scalar. Values are single-line; a newline would forge a new key.
fn esc(v: &str) -> String {
    v.replace(['\r', '\n'], " ").trim().to_string()
}

/// Serialize to the on-disk / export format.
pub fn to_markdown(s: &Skill) -> String {
    format!(
        "---\nname: {}\ndescription: {}\nscope: {}\ndatabase: {}\nenabled: {}\n---\n{}\n",
        esc(&s.name),
        esc(&s.description),
        esc(&s.scope),
        esc(&s.database),
        s.enabled,
        s.body.trim_end()
    )
}

/// Parse the on-disk / import format. A file with no frontmatter is still a valid skill —
/// the whole text becomes the body and the name falls back to the caller's default, so a
/// user can drop a plain `.md` file in and have it work.
pub fn from_markdown(text: &str, fallback_name: &str) -> Skill {
    let mut sk = Skill {
        name: fallback_name.to_string(),
        scope: d_scope(),
        enabled: true,
        ..Default::default()
    };
    // Normalize CRLF so a Windows-authored file parses identically.
    let text = text.replace("\r\n", "\n");
    let rest = match text.strip_prefix("---\n") {
        Some(after) => match after.split_once("\n---") {
            Some((front, body)) => {
                for line in front.lines() {
                    let Some((k, v)) = line.split_once(':') else { continue };
                    let v = v.trim();
                    match k.trim() {
                        "name" if !v.is_empty() => sk.name = v.to_string(),
                        "description" => sk.description = v.to_string(),
                        "scope" => sk.scope = v.to_string(),
                        "database" => sk.database = v.to_string(),
                        // Anything but a literal `false` is enabled — a corrupt value
                        // must not silently disable a skill the user relies on.
                        "enabled" => sk.enabled = !v.eq_ignore_ascii_case("false"),
                        _ => {}
                    }
                }
                body.trim_start_matches('-').trim_start_matches('\n')
            }
            None => &text, // unterminated frontmatter — treat the whole file as body
        },
        None => &text,
    };
    sk.body = rest.trim().to_string();
    if sk.scope != SCOPE_DATABASE {
        sk.scope = SCOPE_WORKSPACE.to_string();
        sk.database.clear();
    }
    sk
}

/// Every skill on disk, name-sorted. Unreadable/garbage files are skipped, never fatal —
/// one bad file must not take down the AI panel.
pub fn load_all(app: &tauri::AppHandle) -> Vec<Skill> {
    let Ok(dir) = skills_dir(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Skill> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let stem = e.path().file_stem()?.to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path()).ok()?;
            let mut sk = from_markdown(&text, &stem);
            sk.id = stem;
            Some(sk)
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

#[tauri::command]
pub fn skills_list(app: tauri::AppHandle) -> Vec<Skill> {
    load_all(&app)
}

/// Create (blank id) or update. Returns the stored skill, id assigned.
#[tauri::command]
pub fn skills_save(app: tauri::AppHandle, mut skill: Skill) -> Result<Skill, AppError> {
    if skill.name.trim().is_empty() {
        return Err(AppError::new("a skill needs a name"));
    }
    if skill.scope == SCOPE_DATABASE && skill.database.trim().is_empty() {
        return Err(AppError::new("a database-scoped skill needs a database name"));
    }
    let dir = skills_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::new(e.to_string()))?;
    if skill.id.trim().is_empty() {
        skill.id = new_id(&skill.name);
    }
    skill.id = safe_id(&skill.id);
    std::fs::write(dir.join(format!("{}.md", skill.id)), to_markdown(&skill))
        .map_err(|e| AppError::new(e.to_string()))?;
    Ok(skill)
}

#[tauri::command]
pub fn skills_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let path = skills_dir(&app)?.join(format!("{}.md", safe_id(&id)));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // already gone
        Err(e) => Err(AppError::new(e.to_string())),
    }
}

/// The skill's file text, for the frontend to hand to `write_text_file`.
#[tauri::command]
pub fn skills_export(app: tauri::AppHandle, id: String) -> Result<String, AppError> {
    let path = skills_dir(&app)?.join(format!("{}.md", safe_id(&id)));
    std::fs::read_to_string(&path).map_err(|e| AppError::new(e.to_string()))
}

/// Parse imported text and store it as a NEW skill (never clobbers an existing id).
#[tauri::command]
pub fn skills_import(app: tauri::AppHandle, text: String, fallback_name: String) -> Result<Skill, AppError> {
    let mut sk = from_markdown(&text, &fallback_name);
    if sk.name.trim().is_empty() {
        sk.name = "Imported skill".to_string();
    }
    sk.id = String::new(); // force a fresh id
    skills_save(app, sk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_markdown() {
        let s = Skill {
            id: "x".into(),
            name: "Revenue rules".into(),
            description: "How we compute MRR".into(),
            scope: SCOPE_DATABASE.into(),
            database: "pagila".into(),
            enabled: false,
            body: "# Rules\n\nAlways exclude refunds.".into(),
        };
        let back = from_markdown(&to_markdown(&s), "fallback");
        assert_eq!(back.name, s.name);
        assert_eq!(back.description, s.description);
        assert_eq!(back.scope, s.scope);
        assert_eq!(back.database, s.database);
        assert!(!back.enabled);
        assert_eq!(back.body, s.body);
    }

    #[test]
    fn a_plain_markdown_file_is_a_valid_skill() {
        // Drop any .md in the folder (or import one) and it works: whole text = body.
        let sk = from_markdown("# Notes\n\nJoin orders to customers on customer_id.", "my-notes");
        assert_eq!(sk.name, "my-notes");
        assert_eq!(sk.scope, SCOPE_WORKSPACE);
        assert!(sk.enabled);
        assert!(sk.body.starts_with("# Notes"));
    }

    #[test]
    fn crlf_and_unterminated_frontmatter_do_not_lose_the_body() {
        let sk = from_markdown("---\r\nname: Win\r\n---\r\nbody text\r\n", "f");
        assert_eq!(sk.name, "Win");
        assert_eq!(sk.body, "body text");
        // No closing fence: don't silently eat the file.
        let sk2 = from_markdown("---\nname: Broken\nstill going", "f");
        assert!(sk2.body.contains("still going"));
    }

    #[test]
    fn a_corrupt_enabled_value_leaves_the_skill_on() {
        // Silently disabling a skill the user relies on is worse than ignoring the value.
        assert!(from_markdown("---\nname: N\nenabled: yes-ish\n---\nb", "f").enabled);
        assert!(!from_markdown("---\nname: N\nenabled: false\n---\nb", "f").enabled);
        assert!(!from_markdown("---\nname: N\nenabled: FALSE\n---\nb", "f").enabled);
    }

    #[test]
    fn database_scope_requires_a_database_else_it_degrades_to_workspace() {
        // A database-scoped skill with no database would match nothing and look broken.
        let sk = from_markdown("---\nname: N\nscope: database\n---\nb", "f");
        assert_eq!(sk.scope, SCOPE_DATABASE);
        assert!(!sk.applies_to("anything")); // empty database matches nothing
        let ws = from_markdown("---\nname: N\nscope: nonsense\n---\nb", "f");
        assert_eq!(ws.scope, SCOPE_WORKSPACE); // unknown scope → workspace, never dropped
    }

    #[test]
    fn applies_to_respects_scope_and_enabled() {
        let mut db = Skill { name: "d".into(), scope: SCOPE_DATABASE.into(), database: "pagila".into(), enabled: true, ..Default::default() };
        assert!(db.applies_to("pagila"));
        assert!(!db.applies_to("other"));
        db.enabled = false;
        assert!(!db.applies_to("pagila"));

        let ws = Skill { name: "w".into(), scope: SCOPE_WORKSPACE.into(), enabled: true, ..Default::default() };
        assert!(ws.applies_to("anything"));
    }

    #[test]
    fn ids_are_path_safe_and_frontmatter_cannot_be_forged() {
        assert_eq!(safe_id("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_id("...."), "skill");
        // A newline in a scalar would otherwise inject a key.
        let s = Skill { name: "a\nenabled: false".into(), enabled: true, ..Default::default() };
        assert!(from_markdown(&to_markdown(&s), "f").enabled);
    }
}
