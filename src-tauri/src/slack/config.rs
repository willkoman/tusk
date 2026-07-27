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
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

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
    /// Include a few real row values in AI context. Real data leaves the machine
    /// for the configured provider, so this is explicit opt-in and defaults OFF.
    #[serde(default)]
    pub share_samples: bool,
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
    /// Wire protocol for `ai_provider` ("anthropic" | "gemini" | "openai"). Empty on
    /// `slack.json` files written before the provider registry existed — `ai_request()`
    /// then falls back to deriving it from `ai_provider`, which is correct for the
    /// three providers that could have been saved back then.
    #[serde(default)]
    pub ai_wire: String,
    #[serde(default)]
    pub ai_model: String,
    #[serde(default)]
    pub ai_base_url: Option<String>,
    #[serde(default = "d_max_tokens")]
    pub ai_max_tokens: u32,
    /// Local model servers need no API key.
    #[serde(default)]
    pub ai_allow_no_key: bool,
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

impl SlackConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        if !(1..=100).contains(&self.max_rows_inline) {
            return Err(AppError::new(
                "Slack maxRowsInline must be between 1 and 100",
            ));
        }
        if !(100..=100_000).contains(&self.max_rows_file) {
            return Err(AppError::new(
                "Slack maxRowsFile must be between 100 and 100000",
            ));
        }
        if !(1..=600).contains(&self.query_timeout_secs) {
            return Err(AppError::new(
                "Slack queryTimeoutSecs must be between 1 and 600",
            ));
        }
        if !(256..=128_000).contains(&self.ai_max_tokens) {
            return Err(AppError::new(
                "Slack aiMaxTokens must be between 256 and 128000",
            ));
        }
        if !matches!(
            self.destructive_policy.as_str(),
            "proposeReadonly" | "refuse"
        ) {
            return Err(AppError::new("invalid Slack destructivePolicy"));
        }
        if self.allowlist_channels.len() > 100
            || self.allowlist_users.len() > 100
            || self
                .allowlist_channels
                .iter()
                .chain(&self.allowlist_users)
                .any(|s| s.len() > 100)
        {
            return Err(AppError::new(
                "Slack allowlists may contain at most 100 IDs of 100 characters each",
            ));
        }
        if self.ai_provider.len() > 100
            || self.ai_wire.len() > 32
            || self.ai_model.len() > 500
            || self.ai_base_url.as_ref().is_some_and(|s| s.len() > 2_000)
        {
            return Err(AppError::new(
                "Slack AI configuration contains an oversized field",
            ));
        }
        if !self.ai_wire.is_empty()
            && !matches!(
                self.ai_wire.as_str(),
                "anthropic" | "gemini" | "openai" | "responses"
            )
        {
            return Err(AppError::new("invalid Slack AI wire protocol"));
        }
        Ok(())
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
    use std::io::Read;
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(SlackConfig::default());
    }
    let mut data = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| AppError::new(e.to_string()))?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| AppError::new(e.to_string()))?;
    if data.len() as u64 > MAX_CONFIG_BYTES {
        return Err(AppError::new("Slack config exceeds 1 MiB"));
    }
    let data =
        String::from_utf8(data).map_err(|_| AppError::new("Slack config is not valid UTF-8"))?;
    let cfg: SlackConfig = serde_json::from_str(&data)
        .map_err(|e| AppError::new(format!("invalid Slack config {}: {e}", path.display())))?;
    cfg.validate()?;
    Ok(cfg)
}

pub fn save(app: &tauri::AppHandle, cfg: &SlackConfig) -> Result<(), AppError> {
    use std::io::Write;
    cfg.validate()?;
    let path = store_path(app)?;
    let data = serde_json::to_string_pretty(cfg).map_err(|e| AppError::new(e.to_string()))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("Slack config has no parent directory"))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::new(e.to_string()))?;
    if let Ok(meta) = std::fs::metadata(&path) {
        temp.as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| AppError::new(e.to_string()))?;
    }
    temp.write_all(data.as_bytes())
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.as_file_mut()
        .sync_all()
        .map_err(|e| AppError::new(e.to_string()))?;
    temp.persist(&path)
        .map_err(|e| AppError::new(e.error.to_string()))?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| AppError::new(format!("cannot sync Slack config directory: {e}")))?;
    Ok(())
}

fn entry(account: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| AppError::new(e.to_string()))
}

/// Store whichever tokens were provided (None = leave the existing one untouched).
pub fn save_tokens(bot: Option<String>, app_level: Option<String>) -> Result<(), AppError> {
    if bot.iter().chain(app_level.iter()).any(|t| t.len() > 20_000) {
        return Err(AppError::new("Slack token exceeds the 20000-byte limit"));
    }
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

fn restore_token(account: &str, value: Option<String>) -> Result<(), AppError> {
    let entry = entry(account)?;
    match value {
        Some(token) => entry
            .set_password(&token)
            .map_err(|e| AppError::new(format!("cannot restore Slack {account}: {e}"))),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::new(format!("cannot delete Slack {account}: {e}"))),
        },
    }
}

pub fn restore_tokens(bot: Option<String>, app_level: Option<String>) -> Result<(), AppError> {
    let mut errors = Vec::new();
    for (account, value) in [(BOT_TOKEN_ACCOUNT, bot), (APP_TOKEN_ACCOUNT, app_level)] {
        if let Err(error) = restore_token(account, value) {
            errors.push(error.message);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::new(errors.join("; ")))
    }
}

pub fn clear_selected_tokens(bot: bool, app_level: bool) -> Result<(), AppError> {
    let mut errors = Vec::new();
    for (account, clear) in [(BOT_TOKEN_ACCOUNT, bot), (APP_TOKEN_ACCOUNT, app_level)] {
        if clear {
            if let Err(error) = restore_token(account, None) {
                errors.push(error.message);
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::new(errors.join("; ")))
    }
}

pub fn clear_tokens() -> Result<(), AppError> {
    clear_selected_tokens(true, true)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate_and_hostile_limits_fail_closed() {
        let defaults = SlackConfig::default();
        assert!(defaults.validate().is_ok());
        assert!(!defaults.share_samples);
        for cfg in [
            SlackConfig {
                max_rows_file: usize::MAX,
                ..Default::default()
            },
            SlackConfig {
                query_timeout_secs: 0,
                ..Default::default()
            },
            SlackConfig {
                ai_max_tokens: u32::MAX,
                ..Default::default()
            },
            SlackConfig {
                ai_wire: "typo".into(),
                ..Default::default()
            },
        ] {
            assert!(cfg.validate().is_err());
        }
    }

    #[test]
    fn missing_sample_setting_migrates_to_off() {
        let cfg: SlackConfig = serde_json::from_str("{}").unwrap();
        assert!(!cfg.share_samples);
    }
}
