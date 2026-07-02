//! Slack Web API wrappers — outbound HTTPS via `reqwest`, bot token as Bearer.
//! Every method surfaces Slack's `error` field as a real `AppError` (Slack returns
//! HTTP 200 with `{"ok":false,"error":"…"}` on most failures).

use crate::db::AppError;
use serde_json::{json, Value};

pub struct SlackApi {
    client: reqwest::Client,
    bot_token: String,
}

impl SlackApi {
    pub fn new(bot_token: String) -> Self {
        Self { client: reqwest::Client::new(), bot_token }
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value, AppError> {
        let url = format!("https://slack.com/api/{method}");
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.bot_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack {method}: {e}")))?;
        let status = resp.status();
        let json: Value = resp
            .json()
            .await
            .map_err(|e| AppError::new(format!("Slack {method}: bad response ({status}): {e}")))?;
        if json["ok"].as_bool() != Some(true) {
            let err = json["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!("Slack {method} failed: {err}")));
        }
        Ok(json)
    }

    /// Validate the bot token; returns (team, bot user id).
    pub async fn auth_test(&self) -> Result<(String, String), AppError> {
        let v = self.call("auth.test", json!({})).await?;
        Ok((
            v["team"].as_str().unwrap_or("").to_string(),
            v["user_id"].as_str().unwrap_or("").to_string(),
        ))
    }

    /// Post a message (text or Block Kit). Returns the message `ts` (for threading/updating).
    pub async fn post_message(
        &self,
        channel: &str,
        text: &str,
        blocks: Option<Value>,
        thread_ts: Option<&str>,
    ) -> Result<String, AppError> {
        let mut body = json!({ "channel": channel, "text": text });
        if let Some(b) = blocks {
            body["blocks"] = b;
        }
        if let Some(t) = thread_ts {
            body["thread_ts"] = json!(t);
        }
        let v = self.call("chat.postMessage", body).await?;
        Ok(v["ts"].as_str().unwrap_or("").to_string())
    }

    /// Replace a message's content. ALWAYS pass the full replacement blocks —
    /// `chat.update` with text-only strips the existing blocks.
    pub async fn update_message(
        &self,
        channel: &str,
        ts: &str,
        text: &str,
        blocks: Value,
    ) -> Result<(), AppError> {
        self.call(
            "chat.update",
            json!({ "channel": channel, "ts": ts, "text": text, "blocks": blocks }),
        )
        .await
        .map(|_| ())
    }

    /// Ephemeral message — visible only to `user` in `channel`.
    pub async fn post_ephemeral(&self, channel: &str, user: &str, text: &str) -> Result<(), AppError> {
        self.call(
            "chat.postEphemeral",
            json!({ "channel": channel, "user": user, "text": text }),
        )
        .await
        .map(|_| ())
    }

    /// Last `limit` messages of a thread (for conversational context).
    /// Internal (user-created) Slack apps keep full Tier-3 access to this method.
    pub async fn thread_replies(
        &self,
        channel: &str,
        thread_ts: &str,
        limit: u32,
    ) -> Result<Vec<Value>, AppError> {
        // conversations.replies is a GET-style method; Slack accepts form-encoded POST.
        let url = "https://slack.com/api/conversations.replies";
        let resp = self
            .client
            .post(url)
            .bearer_auth(&self.bot_token)
            .form(&[
                ("channel", channel.to_string()),
                ("ts", thread_ts.to_string()),
                ("limit", limit.to_string()),
            ])
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack conversations.replies: {e}")))?;
        let json: Value = resp
            .json()
            .await
            .map_err(|e| AppError::new(format!("Slack conversations.replies: {e}")))?;
        if json["ok"].as_bool() != Some(true) {
            let err = json["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!("Slack conversations.replies failed: {err}")));
        }
        Ok(json["messages"].as_array().cloned().unwrap_or_default())
    }

    /// Upload a file and share it in a channel/thread — the 3-step external-upload flow
    /// (`files.upload` is sunset): getUploadURLExternal → POST raw bytes → completeUploadExternal.
    pub async fn upload_file(
        &self,
        channel: &str,
        thread_ts: Option<&str>,
        filename: &str,
        data: Vec<u8>,
        initial_comment: Option<&str>,
    ) -> Result<(), AppError> {
        // 1. Reserve an upload URL.
        let resp = self
            .client
            .post("https://slack.com/api/files.getUploadURLExternal")
            .bearer_auth(&self.bot_token)
            .form(&[("filename", filename.to_string()), ("length", data.len().to_string())])
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack file upload: {e}")))?;
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AppError::new(format!("Slack file upload: {e}")))?;
        if v["ok"].as_bool() != Some(true) {
            let err = v["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!("Slack files.getUploadURLExternal failed: {err}")));
        }
        let upload_url = v["upload_url"].as_str().unwrap_or_default().to_string();
        let file_id = v["file_id"].as_str().unwrap_or_default().to_string();
        if upload_url.is_empty() || file_id.is_empty() {
            return Err(AppError::new("Slack file upload: missing upload_url/file_id"));
        }

        // 2. POST the raw bytes.
        let up = self
            .client
            .post(&upload_url)
            .header("content-type", "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack file upload (bytes): {e}")))?;
        if !up.status().is_success() {
            return Err(AppError::new(format!("Slack file upload (bytes): HTTP {}", up.status())));
        }

        // 3. Complete + share.
        let mut body = json!({
            "files": [{ "id": file_id, "title": filename }],
            "channel_id": channel,
        });
        if let Some(t) = thread_ts {
            body["thread_ts"] = json!(t);
        }
        if let Some(c) = initial_comment {
            body["initial_comment"] = json!(c);
        }
        self.call("files.completeUploadExternal", body).await.map(|_| ())
    }
}
