//! Slack Web API wrappers — outbound HTTPS via `reqwest`, bot token as Bearer.
//! Every method surfaces Slack's `error` field as a real `AppError` (Slack returns
//! HTTP 200 with `{"ok":false,"error":"…"}` on most failures).

use crate::db::AppError;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Mutex;

const REQUEST_BODY_CAP: usize = 256 * 1024;
const RESPONSE_BODY_CAP: usize = 2 * 1024 * 1024;
pub const ATTACHMENT_BYTE_CAP: usize = 20 * 1024 * 1024;
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const UPLOAD_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

pub struct SlackApi {
    client: reqwest::Client,
    bot_token: String,
    bot_user_id: Mutex<Option<String>>,
}

impl SlackApi {
    pub fn new(bot_token: String) -> Self {
        Self {
            client: http_client(),
            bot_token,
            bot_user_id: Mutex::new(None),
        }
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value, AppError> {
        let encoded = serde_json::to_vec(&body)
            .map_err(|e| AppError::new(format!("Slack {method}: invalid request: {e}")))?;
        if encoded.len() > REQUEST_BODY_CAP {
            return Err(AppError::new(format!(
                "Slack {method}: request exceeds the 256 KiB body limit"
            )));
        }
        let url = format!("https://slack.com/api/{method}");
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.bot_token)
            .header("content-type", "application/json; charset=utf-8")
            .body(encoded)
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack {method}: {e}")))?;
        let json = read_json_response(resp, &format!("Slack {method}"), RESPONSE_BODY_CAP).await?;
        if json["ok"].as_bool() != Some(true) {
            let err = json["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!("Slack {method} failed: {err}")));
        }
        Ok(json)
    }

    /// Validate the bot token; returns (team, bot user id).
    pub async fn auth_test(&self) -> Result<(String, String), AppError> {
        let v = self.call("auth.test", json!({})).await?;
        let team = v["team"].as_str().unwrap_or("").to_string();
        let user = v["user_id"].as_str().unwrap_or("").to_string();
        if team.is_empty() || user.is_empty() {
            return Err(AppError::new(
                "Slack auth.test response is missing the workspace or bot user id",
            ));
        }
        *crate::lock_sync(&self.bot_user_id) = (!user.is_empty()).then(|| user.clone());
        Ok((team, user))
    }

    pub fn bot_user_id(&self) -> Option<String> {
        crate::lock_sync(&self.bot_user_id).clone()
    }

    /// Post a message (text or Block Kit). Returns the message `ts` (for threading/updating).
    pub async fn post_message(
        &self,
        channel: &str,
        text: &str,
        blocks: Option<Value>,
        thread_ts: Option<&str>,
    ) -> Result<String, AppError> {
        let mut body = json!({ "channel": channel, "text": super::blocks::escape_mrkdwn(text) });
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
            json!({
                "channel": channel,
                "ts": ts,
                "text": super::blocks::escape_mrkdwn(text),
                "blocks": blocks,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Ephemeral message — visible only to `user` in `channel`.
    pub async fn post_ephemeral(
        &self,
        channel: &str,
        user: &str,
        text: &str,
    ) -> Result<(), AppError> {
        self.call(
            "chat.postEphemeral",
            json!({ "channel": channel, "user": user, "text": super::blocks::escape_mrkdwn(text) }),
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
                ("limit", limit.clamp(1, 100).to_string()),
            ])
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack conversations.replies: {e}")))?;
        let json =
            read_json_response(resp, "Slack conversations.replies", RESPONSE_BODY_CAP).await?;
        if json["ok"].as_bool() != Some(true) {
            let err = json["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!(
                "Slack conversations.replies failed: {err}"
            )));
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
        if data.len() > ATTACHMENT_BYTE_CAP {
            return Err(AppError::new(
                "Slack attachment exceeds the 20 MiB upload limit",
            ));
        }
        if filename.len() > 255 || initial_comment.is_some_and(|s| s.len() > 3_000) {
            return Err(AppError::new(
                "Slack attachment metadata exceeds its size limit",
            ));
        }
        tokio::time::timeout(
            UPLOAD_TOTAL_TIMEOUT,
            self.upload_file_inner(channel, thread_ts, filename, data, initial_comment),
        )
        .await
        .map_err(|_| AppError::new("Slack file upload timed out after 90 seconds"))?
    }

    async fn upload_file_inner(
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
            .form(&[
                ("filename", filename.to_string()),
                ("length", data.len().to_string()),
            ])
            .send()
            .await
            .map_err(|e| AppError::new(format!("Slack file upload: {e}")))?;
        let v =
            read_json_response(resp, "Slack files.getUploadURLExternal", RESPONSE_BODY_CAP).await?;
        if v["ok"].as_bool() != Some(true) {
            let err = v["error"].as_str().unwrap_or("unknown error");
            return Err(AppError::new(format!(
                "Slack files.getUploadURLExternal failed: {err}"
            )));
        }
        let upload_url = v["upload_url"].as_str().unwrap_or_default().to_string();
        let file_id = v["file_id"].as_str().unwrap_or_default().to_string();
        if upload_url.is_empty() || file_id.is_empty() {
            return Err(AppError::new(
                "Slack file upload: missing upload_url/file_id",
            ));
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
            return Err(AppError::new(format!(
                "Slack file upload (bytes): HTTP {}",
                up.status()
            )));
        }
        read_response_limited(up, "Slack file upload (bytes)", 64 * 1024).await?;

        // 3. Complete + share.
        let mut body = json!({
            "files": [{ "id": file_id, "title": filename }],
            "channel_id": channel,
        });
        if let Some(t) = thread_ts {
            body["thread_ts"] = json!(t);
        }
        if let Some(c) = initial_comment {
            body["initial_comment"] = json!(super::blocks::escape_mrkdwn(c));
        }
        self.call("files.completeUploadExternal", body)
            .await
            .map(|_| ())
    }
}

pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("static Slack HTTP client settings are valid")
}

async fn read_response_limited(
    resp: reqwest::Response,
    label: &str,
    cap: usize,
) -> Result<Vec<u8>, AppError> {
    let status = resp.status();
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(AppError::new(format!(
            "{label}: response exceeds the {cap}-byte limit"
        )));
    }
    let mut stream = resp.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| AppError::new(format!("{label}: response read failed: {e}")))?;
        if body.len().saturating_add(chunk.len()) > cap {
            return Err(AppError::new(format!(
                "{label}: response exceeds the {cap}-byte limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(AppError::new(format!("{label}: HTTP {status}")));
    }
    Ok(body)
}

pub(crate) async fn read_json_response(
    resp: reqwest::Response,
    label: &str,
    cap: usize,
) -> Result<Value, AppError> {
    let body = read_response_limited(resp, label, cap).await?;
    serde_json::from_slice(&body)
        .map_err(|e| AppError::new(format!("{label}: invalid JSON response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_and_request_caps_are_explicit() {
        assert_eq!(ATTACHMENT_BYTE_CAP, 20 * 1024 * 1024);
        const {
            assert!(REQUEST_BODY_CAP < ATTACHMENT_BYTE_CAP);
            assert!(RESPONSE_BODY_CAP < ATTACHMENT_BYTE_CAP);
        }
    }
}
