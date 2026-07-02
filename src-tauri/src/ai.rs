//! AI provider proxy. Keeps the API key in the OS keychain (never in the WebView) and
//! streams completions from the configured provider over a Tauri `Channel`. Pluggable:
//! Anthropic, OpenAI (also covers OpenAI-compatible / OpenCode / local servers via a
//! custom `base_url`), and Gemini. The model proposes SQL/answers — it never executes
//! anything itself; running is always an explicit user action in the app.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::db::AppError;

const KEYCHAIN_SERVICE: &str = "tusk-ai";

fn key_entry(provider: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| AppError::new(e.to_string()))
}

/// Save an API key for a provider to the OS keychain.
#[tauri::command]
pub fn ai_save_key(provider: String, key: String) -> Result<(), AppError> {
    key_entry(&provider)?
        .set_password(&key)
        .map_err(|e| AppError::new(e.to_string()))
}

/// Whether a key is stored for a provider (the key itself is never returned).
#[tauri::command]
pub fn ai_has_key(provider: String) -> bool {
    key_entry(&provider)
        .map(|e| e.get_password().is_ok())
        .unwrap_or(false)
}

/// Remove a provider's stored key.
#[tauri::command]
pub fn ai_clear_key(provider: String) -> Result<(), AppError> {
    if let Ok(e) = key_entry(&provider) {
        let _ = e.delete_credential();
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Msg {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub provider: String, // "anthropic" | "openai" | "gemini"
    pub model: String,
    /// Override the API base (OpenAI-compatible / OpenCode / local / proxy).
    pub base_url: Option<String>,
    pub system: Option<String>,
    pub messages: Vec<Msg>,
    pub max_tokens: Option<u32>,
}

/// Streamed back to the frontend over the channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

fn get_key(provider: &str) -> Result<String, AppError> {
    key_entry(provider)?.get_password().map_err(|_| {
        AppError::new(format!(
            "no API key saved for {provider} — add one in AI settings"
        ))
    })
}

/// Extract the incremental text from one SSE `data:` JSON payload, per provider.
fn extract_delta(provider: &str, json: &serde_json::Value) -> Option<String> {
    match provider {
        "anthropic" => {
            if json.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                json.pointer("/delta/text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        }
        "gemini" => json
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|t| t.as_str())
            .map(str::to_string),
        // openai + compatible
        _ => json
            .pointer("/choices/0/delta/content")
            .and_then(|t| t.as_str())
            .map(str::to_string),
    }
}

/// Build the (url, headers, body) for the provider request.
fn build_request(
    req: &AiRequest,
    key: &str,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let model = &req.model;
    match req.provider.as_str() {
        "anthropic" => {
            let base = req.base_url.as_deref().unwrap_or("https://api.anthropic.com");
            let url = format!("{base}/v1/messages");
            let headers = vec![
                ("x-api-key".into(), key.to_string()),
                ("anthropic-version".into(), "2023-06-01".into()),
                ("content-type".into(), "application/json".into()),
            ];
            let msgs: Vec<_> = req
                .messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": req.max_tokens.unwrap_or(2048),
                "stream": true,
                "messages": msgs,
            });
            if let Some(sys) = &req.system {
                body["system"] = serde_json::json!(sys);
            }
            (url, headers, body)
        }
        "gemini" => {
            let base = req
                .base_url
                .as_deref()
                .unwrap_or("https://generativelanguage.googleapis.com");
            let url = format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}");
            let headers = vec![("content-type".into(), "application/json".into())];
            let contents: Vec<_> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    serde_json::json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            let mut body = serde_json::json!({ "contents": contents });
            if let Some(sys) = &req.system {
                body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
            }
            (url, headers, body)
        }
        // openai + OpenAI-compatible (OpenCode / local / proxy via base_url)
        _ => {
            let base = req.base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = format!("{base}/v1/chat/completions");
            let headers = vec![
                ("authorization".into(), format!("Bearer {key}")),
                ("content-type".into(), "application/json".into()),
            ];
            let mut msgs: Vec<serde_json::Value> = Vec::new();
            if let Some(sys) = &req.system {
                msgs.push(serde_json::json!({ "role": "system", "content": sys }));
            }
            for m in &req.messages {
                msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
            let body = serde_json::json!({ "model": model, "stream": true, "messages": msgs });
            (url, headers, body)
        }
    }
}

/// Live model catalog for a provider (ids only), using the saved keychain key.
/// Per provider: Anthropic `GET /v1/models`, Gemini `GET /v1beta/models` (filtered
/// to generateContent-capable, `models/` prefix stripped), OpenAI + compatible
/// `GET /v1/models` (obvious non-chat families dropped, newest-first sort).
/// Errors surface to the frontend, which falls back to its curated list.
#[tauri::command]
pub async fn ai_list_models(
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, AppError> {
    let key = get_key(&provider)?;
    let (url, headers): (String, Vec<(String, String)>) = match provider.as_str() {
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or("https://api.anthropic.com");
            (
                format!("{base}/v1/models?limit=1000"),
                vec![
                    ("x-api-key".into(), key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                ],
            )
        }
        "gemini" => {
            let base = base_url
                .as_deref()
                .unwrap_or("https://generativelanguage.googleapis.com");
            (format!("{base}/v1beta/models?pageSize=1000&key={key}"), vec![])
        }
        // openai + OpenAI-compatible (OpenCode / local / proxy via base_url)
        _ => {
            let base = base_url.as_deref().unwrap_or("https://api.openai.com");
            (
                format!("{base}/v1/models"),
                vec![("authorization".into(), format!("Bearer {key}"))],
            )
        }
    };
    let client = reqwest::Client::new();
    let mut builder = client.get(&url);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(AppError::new(format!(
            "provider error {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    let mut out: Vec<String> = match provider.as_str() {
        "gemini" => json["models"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter(|m| {
                m["supportedGenerationMethods"]
                    .as_array()
                    .map(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
                    .unwrap_or(true)
            })
            .filter_map(|m| m["name"].as_str())
            .map(|n| n.trim_start_matches("models/").to_string())
            .collect(),
        // anthropic + openai both wrap in `data: [{id}]`
        _ => json["data"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["id"].as_str())
            .map(str::to_string)
            .collect(),
    };
    if provider == "openai" {
        // /v1/models mixes in embeddings/audio/image/moderation models — drop the
        // obvious non-chat families (also harmless on compatible/local servers).
        const SKIP: [&str; 11] = [
            "embedding", "whisper", "tts", "dall-e", "moderation", "audio",
            "realtime", "transcribe", "image", "davinci", "babbage",
        ];
        out.retain(|id| !SKIP.iter().any(|s| id.contains(s)));
        out.sort_by(|a, b| b.cmp(a));
    }
    Ok(out)
}

/// One parsed SSE line's meaning.
enum SseItem {
    Delta(String),
    Done,
    Ignore,
}

/// Drain COMPLETE lines from a byte buffer, leaving any partial trailing line.
/// Splitting on the `\n` BYTE (0x0A, which never appears inside a multibyte UTF-8
/// sequence) guarantees each returned line is a whole UTF-8 boundary — so decoding
/// per line can't mangle a character split across two network chunks (the bug when
/// you `from_utf8_lossy` each raw chunk before splitting).
fn drain_sse_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    loop {
        let Some(nl) = buf.iter().position(|&b| b == b'\n') else { break };
        let line: Vec<u8> = buf.drain(..=nl).collect();
        lines.push(String::from_utf8_lossy(&line[..line.len() - 1]).trim_end().to_string());
    }
    lines
}

/// Parse one SSE line (`data: {json}` / `data: [DONE]`) into an item for `provider`.
fn parse_sse_line(line: &str, provider: &str) -> SseItem {
    let Some(payload) = line.strip_prefix("data:") else { return SseItem::Ignore };
    let payload = payload.trim();
    if payload.is_empty() {
        return SseItem::Ignore;
    }
    if payload == "[DONE]" {
        return SseItem::Done;
    }
    match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(json) => match extract_delta(provider, &json) {
            Some(text) => SseItem::Delta(text),
            None => SseItem::Ignore,
        },
        Err(_) => SseItem::Ignore,
    }
}

/// Non-streaming completion for backend consumers (the Slack bot): same provider
/// request as `ai_chat` (one request builder, two consumers), but the SSE deltas are
/// accumulated into a single String instead of being forwarded over a Channel.
pub async fn complete_one_shot(req: &AiRequest) -> Result<String, AppError> {
    let key = get_key(&req.provider)?;
    let (url, headers, body) = build_request(req, &key);
    let client = reqwest::Client::new();
    let mut builder = client.post(&url).json(&body);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }
    let resp = builder.send().await.map_err(|e| AppError::new(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(AppError::new(format!(
            "AI provider error {status}: {}",
            detail.chars().take(500).collect::<String>()
        )));
    }
    let mut out = String::new();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::new(e.to_string()))?;
        buf.extend_from_slice(&bytes);
        for line in drain_sse_lines(&mut buf) {
            match parse_sse_line(&line, &req.provider) {
                SseItem::Delta(text) => out.push_str(&text),
                SseItem::Done => return Ok(out),
                SseItem::Ignore => {}
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_lines_survive_multibyte_chunk_splits() {
        // "région" — the 2-byte 'é' (0xC3 0xA9) split across two network chunks.
        let full = b"data: {\"choices\":[{\"delta\":{\"content\":\"r\xc3\xa9gion\"}}]}\n";
        let split = full.iter().position(|&b| b == 0xC3).unwrap() + 1; // between 0xC3 and 0xA9
        let (a, b) = full.split_at(split);
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(a);
        assert!(drain_sse_lines(&mut buf).is_empty()); // no newline yet
        buf.extend_from_slice(b);
        let lines = drain_sse_lines(&mut buf);
        assert_eq!(lines.len(), 1);
        match parse_sse_line(&lines[0], "openai") {
            SseItem::Delta(t) => assert_eq!(t, "région"), // NOT "r��gion"
            _ => panic!("expected a delta"),
        }
    }

    #[test]
    fn sse_done_and_ignore() {
        assert!(matches!(parse_sse_line("data: [DONE]", "openai"), SseItem::Done));
        assert!(matches!(parse_sse_line(": comment", "openai"), SseItem::Ignore));
        assert!(matches!(parse_sse_line("data:  ", "openai"), SseItem::Ignore));
    }
}

/// Stream a completion from the configured provider, emitting `AiEvent`s over the channel.
/// The API key is read from the keychain (never crosses the IPC boundary as plaintext from
/// the frontend). Always resolves Ok — failures are delivered as an `Error` event so the
/// frontend has a single event stream to consume.
#[tauri::command]
pub async fn ai_chat(req: AiRequest, on_event: tauri::ipc::Channel<AiEvent>) -> Result<(), AppError> {
    let key = match get_key(&req.provider) {
        Ok(k) => k,
        Err(e) => {
            let _ = on_event.send(AiEvent::Error { message: e.message });
            return Ok(());
        }
    };
    let (url, headers, body) = build_request(&req, &key);
    let client = reqwest::Client::new();
    let mut builder = client.post(&url).json(&body);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiEvent::Error { message: e.to_string() });
            return Ok(());
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        let _ = on_event.send(AiEvent::Error {
            message: format!("provider error {status}: {}", detail.chars().take(500).collect::<String>()),
        });
        return Ok(());
    }

    // Line-based SSE: drain complete lines (multibyte-safe), parse per provider.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = on_event.send(AiEvent::Error { message: e.to_string() });
                return Ok(());
            }
        };
        buf.extend_from_slice(&bytes);
        for line in drain_sse_lines(&mut buf) {
            match parse_sse_line(&line, &req.provider) {
                SseItem::Delta(text) => {
                    if !text.is_empty() {
                        let _ = on_event.send(AiEvent::Delta { text });
                    }
                }
                SseItem::Done => {
                    let _ = on_event.send(AiEvent::Done);
                    return Ok(());
                }
                SseItem::Ignore => {}
            }
        }
    }
    let _ = on_event.send(AiEvent::Done);
    Ok(())
}
