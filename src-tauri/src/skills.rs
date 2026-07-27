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
use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::db::AppError;

/// Where a skill applies. `Database` matches on the connected database's NAME (what the
/// user sees), not a profile id — ad-hoc connections have no profile, and the same
/// database reached two ways should get the same skills.
pub const SCOPE_WORKSPACE: &str = "workspace";
pub const SCOPE_DATABASE: &str = "database";
const MAX_SKILLS: usize = 256;
const MAX_SKILL_BYTES: usize = 256 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_NAME_BYTES: usize = 200;
const MAX_DESCRIPTION_BYTES: usize = 2 * 1024;
const MAX_DATABASE_BYTES: usize = 512;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "skill".to_string()
    } else {
        s
    }
}

fn canonical_id(raw: &str) -> Result<&str, AppError> {
    if raw.is_empty()
        || raw.len() > MAX_ID_BYTES
        || safe_id(raw) != raw
        || !raw.bytes().any(|b| b.is_ascii_alphanumeric())
    {
        return Err(AppError::new("invalid skill id"));
    }
    Ok(raw)
}

/// `my-skill-1a2b3c` — slug of the name plus a monotonic suffix, so two skills named the
/// same don't collide and the filename stays legible.
fn new_id(name: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
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

#[cfg(windows)]
fn is_reparse(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(_: &Metadata) -> bool {
    false
}

fn ensure_real_dir(dir: &PathBuf) -> Result<(), AppError> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || is_reparse(&meta) || !meta.is_dir() {
                return Err(AppError::new("skills path is not a regular directory"));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = dir.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    AppError::new(format!("cannot create app config directory: {e}"))
                })?;
            }
            fs::create_dir(dir)
                .map_err(|e| AppError::new(format!("cannot create skills directory: {e}")))?;
            let meta = fs::symlink_metadata(dir)
                .map_err(|e| AppError::new(format!("cannot inspect skills directory: {e}")))?;
            if meta.file_type().is_symlink() || is_reparse(&meta) || !meta.is_dir() {
                return Err(AppError::new("skills path is not a regular directory"));
            }
        }
        Err(e) => {
            return Err(AppError::new(format!(
                "cannot inspect skills directory: {e}"
            )))
        }
    }
    Ok(())
}

fn regular_file(path: &PathBuf) -> Result<Metadata, AppError> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| AppError::new(format!("cannot inspect skill file: {e}")))?;
    if meta.file_type().is_symlink() || is_reparse(&meta) || !meta.is_file() {
        return Err(AppError::new("skill path is not a regular file"));
    }
    Ok(meta)
}

fn read_skill_file(path: &PathBuf) -> Result<String, AppError> {
    let meta = regular_file(path)?;
    if meta.len() > MAX_SKILL_BYTES as u64 {
        return Err(AppError::new("skill exceeds the 256 KiB limit"));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    File::open(path)
        .map_err(|e| AppError::new(format!("cannot open skill: {e}")))?
        .take(MAX_SKILL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::new(format!("cannot read skill: {e}")))?;
    if bytes.len() > MAX_SKILL_BYTES {
        return Err(AppError::new("skill exceeds the 256 KiB limit"));
    }
    String::from_utf8(bytes).map_err(|_| AppError::new("skill is not valid UTF-8"))
}

fn set_restrictive_permissions(_file: &File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn sync_dir(_dir: &PathBuf) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(_dir)?.sync_all()?;
    Ok(())
}

fn write_temp(dir: &PathBuf, data: &[u8]) -> Result<tempfile::NamedTempFile, AppError> {
    let mut temp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| AppError::new(format!("cannot create temporary skill: {e}")))?;
    set_restrictive_permissions(temp.as_file())
        .map_err(|e| AppError::new(format!("cannot secure temporary skill: {e}")))?;
    temp.write_all(data)
        .map_err(|e| AppError::new(format!("cannot write skill: {e}")))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|e| AppError::new(format!("cannot sync skill: {e}")))?;
    Ok(temp)
}

fn atomic_replace(dir: &PathBuf, path: &PathBuf, data: &[u8]) -> Result<(), AppError> {
    // An existing destination must be a regular file (no symlinks/reparse points),
    // but a missing one is fine: saving a skill whose file was removed out-of-band
    // recreates it instead of failing.
    match fs::symlink_metadata(path) {
        Ok(_) => {
            regular_file(path)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::new(format!("cannot inspect skill file: {e}"))),
    }
    write_temp(dir, data)?
        .persist(path)
        .map_err(|e| AppError::new(format!("cannot replace skill: {}", e.error)))?;
    sync_dir(dir).map_err(|e| AppError::new(format!("cannot sync skills directory: {e}")))
}

fn atomic_create(dir: &PathBuf, path: &PathBuf, data: &[u8]) -> Result<bool, AppError> {
    match write_temp(dir, data)?.persist_noclobber(path) {
        Ok(_) => {
            sync_dir(dir)
                .map_err(|e| AppError::new(format!("cannot sync skills directory: {e}")))?;
            Ok(true)
        }
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(AppError::new(format!("cannot create skill: {}", e.error))),
    }
}

fn normalize_and_validate(skill: &mut Skill) -> Result<(), AppError> {
    if skill.scope != SCOPE_DATABASE {
        skill.scope = SCOPE_WORKSPACE.to_string();
        skill.database.clear();
    }
    if skill.name.trim().is_empty() {
        return Err(AppError::new("a skill needs a name"));
    }
    if skill.name.len() > MAX_NAME_BYTES {
        return Err(AppError::new("skill name exceeds the 200-byte limit"));
    }
    if skill.description.len() > MAX_DESCRIPTION_BYTES {
        return Err(AppError::new("skill description exceeds the 2 KiB limit"));
    }
    if skill.database.len() > MAX_DATABASE_BYTES {
        return Err(AppError::new(
            "skill database name exceeds the 512-byte limit",
        ));
    }
    if skill.scope == SCOPE_DATABASE && skill.database.trim().is_empty() {
        return Err(AppError::new(
            "a database-scoped skill needs a database name",
        ));
    }
    if skill.body.len() > MAX_SKILL_BYTES {
        return Err(AppError::new("skill exceeds the 256 KiB limit"));
    }
    Ok(())
}

fn entry_count(dir: &PathBuf) -> Result<usize, AppError> {
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|e| AppError::new(format!("cannot list skills: {e}")))? {
        entry.map_err(|e| AppError::new(format!("cannot list skills: {e}")))?;
        count += 1;
        if count > MAX_SKILLS {
            return Err(AppError::new(
                "skills directory exceeds the 256-entry limit",
            ));
        }
    }
    Ok(count)
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
                    let Some((k, v)) = line.split_once(':') else {
                        continue;
                    };
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
    let Ok(dir) = skills_dir(app) else {
        return Vec::new();
    };
    if ensure_real_dir(&dir).is_err() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<Skill> = entries
        .take(MAX_SKILLS)
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            canonical_id(&stem).ok()?;
            let text = read_skill_file(&path).ok()?;
            let mut sk = from_markdown(&text, &stem);
            normalize_and_validate(&mut sk).ok()?;
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
    normalize_and_validate(&mut skill)?;
    let dir = skills_dir(&app)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    ensure_real_dir(&dir)?;
    if skill.id.is_empty() {
        if entry_count(&dir)? >= MAX_SKILLS {
            return Err(AppError::new("no more than 256 skills may be stored"));
        }
        loop {
            skill.id = new_id(&skill.name);
            let data = to_markdown(&skill);
            if data.len() > MAX_SKILL_BYTES {
                return Err(AppError::new("skill exceeds the 256 KiB limit"));
            }
            let path = dir.join(format!("{}.md", skill.id));
            if atomic_create(&dir, &path, data.as_bytes())? {
                return Ok(skill);
            }
        }
    }
    canonical_id(&skill.id)?;
    let data = to_markdown(&skill);
    if data.len() > MAX_SKILL_BYTES {
        return Err(AppError::new("skill exceeds the 256 KiB limit"));
    }
    atomic_replace(&dir, &dir.join(format!("{}.md", skill.id)), data.as_bytes())?;
    Ok(skill)
}

#[tauri::command]
pub fn skills_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    canonical_id(&id)?;
    let dir = skills_dir(&app)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    ensure_real_dir(&dir)?;
    let path = dir.join(format!("{id}.md"));
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::new(format!("cannot inspect skill file: {e}"))),
        Ok(meta) => {
            if meta.file_type().is_symlink() || is_reparse(&meta) || !meta.is_file() {
                return Err(AppError::new("skill path is not a regular file"));
            }
            fs::remove_file(&path)
                .map_err(|e| AppError::new(format!("cannot delete skill: {e}")))?;
            sync_dir(&dir).map_err(|e| AppError::new(format!("cannot sync skills directory: {e}")))
        }
    }
}

/// The skill's file text, for the frontend to hand to `write_text_file`.
#[tauri::command]
pub fn skills_export(app: tauri::AppHandle, id: String) -> Result<String, AppError> {
    canonical_id(&id)?;
    let dir = skills_dir(&app)?;
    ensure_real_dir(&dir)?;
    read_skill_file(&dir.join(format!("{id}.md")))
}

/// Parse imported text and store it as a NEW skill (never clobbers an existing id).
#[tauri::command]
pub fn skills_import(
    app: tauri::AppHandle,
    text: String,
    fallback_name: String,
) -> Result<Skill, AppError> {
    if text.len() > MAX_SKILL_BYTES {
        return Err(AppError::new("skill exceeds the 256 KiB limit"));
    }
    if fallback_name.len() > MAX_NAME_BYTES {
        return Err(AppError::new("skill name exceeds the 200-byte limit"));
    }
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
        let sk = from_markdown(
            "# Notes\n\nJoin orders to customers on customer_id.",
            "my-notes",
        );
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
        let mut db = Skill {
            name: "d".into(),
            scope: SCOPE_DATABASE.into(),
            database: "pagila".into(),
            enabled: true,
            ..Default::default()
        };
        assert!(db.applies_to("pagila"));
        assert!(!db.applies_to("other"));
        db.enabled = false;
        assert!(!db.applies_to("pagila"));

        let ws = Skill {
            name: "w".into(),
            scope: SCOPE_WORKSPACE.into(),
            enabled: true,
            ..Default::default()
        };
        assert!(ws.applies_to("anything"));
    }

    #[test]
    fn ids_are_path_safe_and_frontmatter_cannot_be_forged() {
        assert_eq!(safe_id("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_id("...."), "skill");
        assert!(canonical_id("../../etc/passwd").is_err());
        assert_eq!(canonical_id("etc-passwd").unwrap(), "etc-passwd");
        assert!(canonical_id("---").is_err());
        // A newline in a scalar would otherwise inject a key.
        let s = Skill {
            name: "a\nenabled: false".into(),
            enabled: true,
            ..Default::default()
        };
        assert!(from_markdown(&to_markdown(&s), "f").enabled);
    }

    #[test]
    fn skill_fields_and_document_size_are_bounded() {
        let mut skill = Skill {
            name: "n".into(),
            scope: SCOPE_WORKSPACE.into(),
            enabled: true,
            body: "x".repeat(MAX_SKILL_BYTES + 1),
            ..Default::default()
        };
        assert!(normalize_and_validate(&mut skill).is_err());
        skill.body.clear();
        skill.name = "x".repeat(MAX_NAME_BYTES + 1);
        assert!(normalize_and_validate(&mut skill).is_err());
    }

    #[test]
    fn create_is_collision_safe_and_replace_is_atomic() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().to_path_buf();
        let path = dir.join("one.md");
        assert!(atomic_create(&dir, &path, b"first").unwrap());
        assert!(!atomic_create(&dir, &path, b"second").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        atomic_replace(&dir, &path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
    }

    #[cfg(unix)]
    #[test]
    fn linked_skill_files_are_refused() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.md");
        fs::write(&target, "secret").unwrap();
        let link = temp.path().join("linked.md");
        symlink(&target, &link).unwrap();
        assert!(read_skill_file(&link).is_err());
    }
}
