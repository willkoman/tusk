//! Slack integration configuration. Non-secret settings live in `slack.json` in the
//! app config dir (like `connections.json`); the bot + app tokens live in the OS
//! keychain (service "tusk-slack") and are never written to disk or returned to the
//! frontend. The AI provider/model settings are mirrored here from the frontend's
//! localStorage config (Rust can't read the WebView's localStorage) — the API key
//! itself stays in the existing `tusk-ai` keychain entries.

use crate::db::AppError;
use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "tusk-slack";
const BOT_TOKEN_ACCOUNT: &str = "bot-token";
const APP_TOKEN_ACCOUNT: &str = "app-token";
const FILE: &str = "slack.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Channel IDs the bot answers in. Empty = any channel the bot is a member of.
    #[serde(default)]
    pub allowlist_channels: Vec<String>,
    /// Slack user IDs allowed to ask. Empty = anyone in an allowed channel.
    #[serde(default)]
    pub allowlist_users: Vec<String>,
    #[serde(default = "d_rows_inline")]
    pub max_rows_inline: usize,
    #[serde(default = "d_rows_file")]
    pub max_rows_file: usize,
    #[serde(default = "d_timeout")]
    pub query_timeout_secs: u64,
    /// Auto-chart date+numeric results. Rendering is fully local (plotters →
    /// PNG, embedded font) — no data leaves the machine, so this defaults ON.
    /// Explicit chart requests in the question are honored regardless.
    #[serde(default = "d_true")]
    pub charts_enabled: bool,
    /// What the AI does when asked for something destructive (writes/DDL):
    /// "proposeReadonly" (default) = propose a read-only SELECT previewing the
    /// affected data; "refuse" = refuse outright and point to the Tusk editor.
    /// Either way the execution gates NEVER run non-SELECT SQL — this only
    /// shapes the bot's reply.
    #[serde(default = "d_destructive")]
    pub destructive_policy: String,
    /// AI settings mirrored from the frontend at save time.
    #[serde(default)]
    pub ai_provider: String,
    #[serde(default)]
    pub ai_model: String,
    #[serde(default)]
    pub ai_base_url: Option<String>,
    #[serde(default = "d_max_tokens")]
    pub ai_max_tokens: u32,
}

fn d_rows_inline() -> usize {
    20
}
fn d_rows_file() -> usize {
    10_000
}
fn d_timeout() -> u64 {
    30
}
fn d_true() -> bool {
    true
}
fn d_destructive() -> String {
    "proposeReadonly".to_string()
}
fn d_max_tokens() -> u32 {
    2048
}

impl Default for SlackConfig {
    fn default() -> Self {
        serde_json::from_str("{}").expect("all SlackConfig fields have serde defaults")
    }
}

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::new(e.to_string()))?;
    Ok(dir.join(FILE))
}

pub fn load(app: &tauri::AppHandle) -> Result<SlackConfig, AppError> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(SlackConfig::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| AppError::new(e.to_string()))?;
    Ok(serde_json::from_str(&data).unwrap_or_default())
}

pub fn save(app: &tauri::AppHandle, cfg: &SlackConfig) -> Result<(), AppError> {
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(cfg).map_err(|e| AppError::new(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| AppError::new(e.to_string()))
}

fn entry(account: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| AppError::new(e.to_string()))
}

/// Store whichever tokens were provided (None = leave the existing one untouched).
pub fn save_tokens(bot: Option<String>, app_level: Option<String>) -> Result<(), AppError> {
    if let Some(t) = bot.filter(|t| !t.is_empty()) {
        entry(BOT_TOKEN_ACCOUNT)?
            .set_password(&t)
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    if let Some(t) = app_level.filter(|t| !t.is_empty()) {
        entry(APP_TOKEN_ACCOUNT)?
            .set_password(&t)
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    Ok(())
}

pub fn clear_tokens() {
    if let Ok(e) = entry(BOT_TOKEN_ACCOUNT) {
        let _ = e.delete_credential();
    }
    if let Ok(e) = entry(APP_TOKEN_ACCOUNT) {
        let _ = e.delete_credential();
    }
}

pub fn bot_token() -> Option<String> {
    entry(BOT_TOKEN_ACCOUNT).ok()?.get_password().ok()
}

pub fn app_token() -> Option<String> {
    entry(APP_TOKEN_ACCOUNT).ok()?.get_password().ok()
}

pub fn has_tokens() -> (bool, bool) {
    (bot_token().is_some(), app_token().is_some())
}
