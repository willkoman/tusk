//! AI provider proxy. Keeps the API key in the OS keychain (never in the WebView) and
//! streams completions from the configured provider over a Tauri `Channel`.
//!
//! **This module knows four WIRE protocols, not N providers.** `Wire::{Anthropic,
//! Gemini, Openai, Responses}` selects the request/response shape; the provider is just
//! a keychain account + a base URL, both supplied by the frontend registry
//! (`src/ai/providers.ts`). Adding OpenRouter / Groq / DeepSeek / Ollama / any other
//! OpenAI-compatible service is a registry row, NOT an arm in `build_request`.
//! A gateway may use a DIFFERENT wire per model (OpenCode Zen does) — that's why the
//! wire rides on the request rather than the provider.
//!
//! The model proposes SQL/answers — it never executes anything itself; running is
//! always an explicit user action in the app.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

use crate::db::AppError;

const KEYCHAIN_SERVICE: &str = "tusk-ai";

/// In-flight `ai_chat` streams, keyed by the frontend's `requestId`, so `ai_cancel`
/// can interrupt one. Held outside any connection lock — a cancel must always be
/// able to reach a stream that's blocked on the network.
#[derive(Default)]
pub struct AiCancels(Mutex<HashMap<String, oneshot::Sender<()>>>);

/// Unregisters the in-flight stream on EVERY exit path (done / error / cancel / panic).
struct CancelGuard<'a> {
    cancels: &'a AiCancels,
    id: String,
}
impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.cancels.0.lock() {
            m.remove(&self.id);
        }
    }
}

/// Interrupt the `ai_chat` stream with this `requestId`. No-op if it already finished.
#[tauri::command]
pub fn ai_cancel(request_id: String, cancels: tauri::State<'_, AiCancels>) {
    let tx = cancels.0.lock().ok().and_then(|mut m| m.remove(&request_id));
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
}

fn key_entry(provider: &str) -> Result<keyring::Entry, AppError> {
    if provider.is_empty()
        || provider.len() > 100
        || !provider.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::new("invalid AI provider id"));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| AppError::new(e.to_string()))
}

/// Save an API key for a provider to the OS keychain.
#[tauri::command]
pub fn ai_save_key(provider: String, key: String) -> Result<(), AppError> {
    if key.is_empty() || key.len() > 64 * 1024 {
        return Err(AppError::new("AI key must be between 1 and 65536 bytes"));
    }
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

/// The request/response shapes we speak. **Dispatch is on the wire, never on
/// the provider name** — the provider is just a keychain account + a base URL, so a
/// dozen OpenAI-compatible services (routers, local servers, DeepSeek, Groq, …) all
/// ride the `Openai` arm without a code change. `src/ai/providers.ts` is the registry.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Anthropic,
    Gemini,
    Openai,
    /// OpenAI's Responses API (`/v1/responses`). A different body (`input`/`instructions`/
    /// `max_output_tokens`) and different SSE events from chat-completions. Needed for
    /// GPT models on OpenCode Zen, which serves them only on this endpoint.
    Responses,
}

impl Wire {
    fn parse(s: &str) -> Wire {
        match s {
            "anthropic" => Wire::Anthropic,
            "gemini" => Wire::Gemini,
            "responses" => Wire::Responses,
            _ => Wire::Openai,
        }
    }
    /// Pre-registry configs (and older `slack.json`s) carry only a provider name.
    /// The three original providers were their own wire, so the name maps cleanly.
    fn legacy_for_provider(provider: &str) -> Wire {
        Wire::parse(provider)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    /// Registry provider id — the OS-keychain account, opaque to this module.
    pub provider: String,
    /// Wire protocol ("anthropic" | "gemini" | "openai"). Absent on configs written
    /// before the registry existed; falls back to the provider name.
    #[serde(default)]
    pub wire: Option<String>,
    pub model: String,
    /// The API base. The frontend registry always sends a concrete one; the
    /// per-wire defaults below only cover legacy callers.
    pub base_url: Option<String>,
    pub system: Option<String>,
    pub messages: Vec<Msg>,
    pub max_tokens: Option<u32>,
    /// Frontend-generated id so `ai_cancel` can interrupt this stream. Backend
    /// callers (the Slack bot) leave it unset — nothing can cancel those.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Local servers (Ollama, LM Studio) authenticate nothing. Without this a
    /// missing keychain entry would be a hard error before the first request.
    #[serde(default)]
    pub allow_no_key: bool,
}

impl AiRequest {
    fn wire(&self) -> Wire {
        match &self.wire {
            Some(w) => Wire::parse(w),
            None => Wire::legacy_for_provider(&self.provider),
        }
    }
}

/// Streamed back to the frontend over the channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
    /// The stream ended cleanly. `truncated` = the model hit its token ceiling, so
    /// the reply is cut short (a fenced code block may be left unclosed).
    Done { truncated: bool },
    /// The user pressed Stop. Distinct from `Error` — nothing went wrong.
    Cancelled,
    Error { message: String },
}

/// A finished (non-streaming) completion.
pub struct Completion {
    pub text: String,
    /// The model hit `max_tokens` — the text is cut off mid-thought.
    pub truncated: bool,
}

fn get_key(provider: &str) -> Result<String, AppError> {
    key_entry(provider)?.get_password().map_err(|_| {
        AppError::new(format!(
            "no API key saved for {provider} — add one in AI settings"
        ))
    })
}

/// Extract the incremental text from one SSE `data:` JSON payload, per wire.
fn extract_delta(wire: Wire, json: &serde_json::Value) -> Option<String> {
    match wire {
        Wire::Anthropic => {
            if json.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                json.pointer("/delta/text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        }
        Wire::Gemini => json
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|t| t.as_str())
            .map(str::to_string),
        Wire::Openai => json
            .pointer("/choices/0/delta/content")
            .and_then(|t| t.as_str())
            .map(str::to_string),
        // Responses streams typed events; only `response.output_text.delta` carries text.
        Wire::Responses => (json["type"] == "response.output_text.delta")
            .then(|| json.get("delta").and_then(|t| t.as_str()))
            .flatten()
            .map(str::to_string),
    }
}

/// An error delivered INSIDE the SSE stream (HTTP 200, then it falls over). Anthropic
/// sends `{"type":"error","error":{...}}` for overloaded/rate-limit mid-stream; OpenAI
/// and most compatible servers send a top-level `error` object; Gemini reports a blocked
/// prompt via `promptFeedback.blockReason`. Ignoring these (as we used to) turns a
/// provider failure into a silently truncated reply — the bug this function exists for.
fn extract_error(wire: Wire, json: &serde_json::Value) -> Option<String> {
    if wire == Wire::Anthropic && json.get("type").and_then(|t| t.as_str()) == Some("error") {
        let e = &json["error"];
        let kind = e["type"].as_str().unwrap_or("error");
        let msg = e["message"].as_str().unwrap_or("stream error");
        return Some(format!("{kind}: {msg}"));
    }
    if wire == Wire::Gemini {
        if let Some(r) = json.pointer("/promptFeedback/blockReason").and_then(|r| r.as_str()) {
            return Some(format!("the provider blocked the prompt ({r})"));
        }
    }
    if wire == Wire::Responses {
        // `response.failed` carries the reason on the nested response object.
        if json["type"] == "response.failed" {
            let msg = json
                .pointer("/response/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("the response failed");
            return Some(msg.to_string());
        }
        // A bare typed error event.
        if json["type"] == "error" {
            let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("stream error");
            return Some(msg.to_string());
        }
    }
    match json.get("error") {
        // Several OpenAI-compatible servers (vLLM, LiteLLM, …) put a literal
        // `"error": null` on every normal frame — that is NOT an error.
        None => None,
        Some(e) if e.is_null() => None,
        Some(e) if e.is_string() => e.as_str().map(str::to_string),
        Some(e) => e
            .get("message")
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .or_else(|| Some("provider stream error".into())),
    }
}

/// The stop/finish reason, if this frame carries one.
fn extract_finish(wire: Wire, json: &serde_json::Value) -> Option<String> {
    match wire {
        Wire::Anthropic => (json["type"] == "message_delta")
            .then(|| json.pointer("/delta/stop_reason").and_then(|r| r.as_str()))
            .flatten()
            .map(str::to_string),
        Wire::Gemini => json
            .pointer("/candidates/0/finishReason")
            .and_then(|r| r.as_str())
            .map(str::to_string),
        Wire::Openai => json
            .pointer("/choices/0/finish_reason")
            .and_then(|r| r.as_str())
            .map(str::to_string),
        // Responses reports truncation as a separate `response.incomplete` event.
        Wire::Responses => (json["type"] == "response.incomplete")
            .then(|| json.pointer("/response/incomplete_details/reason").and_then(|r| r.as_str()))
            .flatten()
            .map(str::to_string),
    }
}

enum Finish {
    /// The model said what it wanted to say.
    Normal,
    /// Hit the token ceiling — text is cut off (an open ```fence stays open).
    Truncated,
    /// The provider killed the response (safety/content filter, or something new).
    Aborted(String),
}

/// **Unknown stop reasons are NORMAL, never aborts.** This is a deny-list, not an
/// allow-list. Every provider mints its own reasons (Gemini documents `OTHER` and
/// `FINISH_REASON_UNSPECIFIED`; OpenAI-compatible servers invent their own), and an
/// allow-list turns a perfectly good completion into a hard error the moment a provider
/// adds a value — the reply is already in hand by the time this runs. Only abort on
/// reasons we positively know mean "the provider withheld the answer". Same bias as the
/// lint vocabulary in `sql/dialects.ts`: a missing word must be a false negative.
fn classify_finish(reason: &str) -> Finish {
    match reason.to_ascii_lowercase().as_str() {
        // `max_output_tokens` is the Responses API's spelling of the same thing.
        "max_tokens" | "length" | "max_output_tokens" => Finish::Truncated,
        "safety" => Finish::Aborted("the provider blocked the response (safety filter)".into()),
        "recitation" => Finish::Aborted("the provider blocked the response (recitation filter)".into()),
        "content_filter" => Finish::Aborted("the provider blocked the response (content filter)".into()),
        "blocklist" | "prohibited_content" | "spii" => {
            Finish::Aborted("the provider blocked the response (content policy)".into())
        }
        // stop / end_turn / tool_use / eos / OTHER / FINISH_REASON_UNSPECIFIED / anything new.
        _ => Finish::Normal,
    }
}

/// The gemini wire's base must carry an API-version segment (`…/v1beta` for Google,
/// `…/zen/v1` for OpenCode) because it appends `/models/{model}:…`. Configs written before
/// that was true — notably a `slack.json` that mirrored the old version-less default —
/// hold a bare host. Heal those rather than 404: a base with no path gets `/v1beta`.
fn gemini_base(base: &str) -> String {
    // Trim FIRST: a bare trailing slash (`https://host/`) is not a path segment.
    let trimmed = base.trim_end_matches('/');
    // Key on whether the LAST segment looks like an API version (`v1`, `v1beta`, …).
    // "has any path" is wrong: a saved proxy base (`https://gw.corp/google`) carries a
    // path but no version, and before this wire existed the old code appended `/v1beta`
    // to it unconditionally. Dropping the segment there is a silent regression.
    let last = trimmed.rsplit('/').next().unwrap_or("");
    let versioned = last.starts_with('v') && last[1..].starts_with(|c: char| c.is_ascii_digit());
    if versioned { trimmed.to_string() } else { format!("{trimmed}/v1beta") }
}

/// Build the (url, headers, body) for the request, keyed on the WIRE — so a new
/// provider is a registry row in `src/ai/providers.ts`, not a new arm here.
fn build_request(
    req: &AiRequest,
    key: &str,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let model = &req.model;
    match req.wire() {
        Wire::Anthropic => {
            let base = req.base_url.as_deref().unwrap_or("https://api.anthropic.com");
            let url = format!("{base}/v1/messages");
            let mut headers = vec![
                ("x-api-key".to_string(), key.to_string()),
                ("anthropic-version".into(), "2023-06-01".into()),
                ("content-type".into(), "application/json".into()),
            ];
            // Gateways that speak this shape authenticate PER ENDPOINT, not per gateway:
            // OpenCode's `/v1/messages` reads `x-api-key` (like Anthropic proper) and
            // ignores Bearer, while its `/v1/chat/completions` reads Bearer and ignores
            // x-api-key — probed on both /zen and /zen/go. So x-api-key above already
            // covers OpenCode. Other Anthropic-shaped proxies read Bearer instead; send
            // it too when this isn't Anthropic proper. Unknown auth headers are ignored
            // (they yield "Missing API key", not a 400), so the extra header is safe.
            if req.provider != "anthropic" {
                headers.push(("authorization".into(), format!("Bearer {key}")));
            }
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
        Wire::Gemini => {
            // `base` includes the API-version segment (`…/v1beta` for Google, `…/zen/v1`
            // for OpenCode), because the two differ. Auth is the `x-goog-api-key` HEADER,
            // not the `?key=` query param: Google accepts both, OpenCode Zen only the
            // header (probed — `?key=` yields "Missing API key").
            let base = gemini_base(
                req.base_url
                    .as_deref()
                    .unwrap_or("https://generativelanguage.googleapis.com/v1beta"),
            );
            let url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");
            let headers = vec![
                ("x-goog-api-key".to_string(), key.to_string()),
                ("content-type".into(), "application/json".into()),
            ];
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
        // Every OpenAI-compatible service: OpenAI, OpenCode, OpenRouter, Groq,
        // DeepSeek, Mistral, xAI, Ollama/LM Studio, … — they differ only by base URL.
        Wire::Openai => {
            let base = req.base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = format!("{base}/v1/chat/completions");
            let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
            // A local server has no key; sending `Bearer ` (empty) trips some of them.
            if !key.is_empty() {
                headers.push(("authorization".into(), format!("Bearer {key}")));
            }
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
        // OpenAI's Responses API. Same Bearer auth as chat-completions, different body:
        // the system prompt is `instructions`, turns are `input`, and the output cap is
        // `max_output_tokens` (minimum 16).
        Wire::Responses => {
            let base = req.base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = format!("{base}/v1/responses");
            let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
            if !key.is_empty() {
                headers.push(("authorization".into(), format!("Bearer {key}")));
            }
            let input: Vec<_> = req
                .messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({ "model": model, "stream": true, "input": input });
            if let Some(mt) = req.max_tokens {
                body["max_output_tokens"] = serde_json::json!(mt.max(16));
            }
            if let Some(sys) = &req.system {
                body["instructions"] = serde_json::json!(sys);
            }
            (url, headers, body)
        }
    }
}

/// Live model catalog for a provider (ids only), using the saved keychain key.
/// Per wire: Anthropic `GET {base}/v1/models` (x-api-key), Gemini `GET {base}/models`
/// (x-goog-api-key; `base` carries the version segment; filtered to generateContent-capable,
/// `models/` prefix stripped), OpenAI + Responses + compatible `GET {base}/v1/models`
/// (Bearer; obvious non-chat families dropped, sorted so router ids group by vendor).
/// Errors surface to the frontend, which falls back to its curated list.
#[tauri::command]
pub async fn ai_list_models(
    provider: String,
    wire: Option<String>,
    base_url: Option<String>,
    allow_no_key: Option<bool>,
) -> Result<Vec<String>, AppError> {
    key_entry(&provider)?;
    if wire.as_deref().is_some_and(|w| !matches!(w, "anthropic" | "gemini" | "openai" | "responses")) {
        return Err(AppError::new("unknown AI wire protocol"));
    }
    if base_url.as_ref().is_some_and(|s| s.len() > 2_000) {
        return Err(AppError::new("AI base URL is too long"));
    }
    let wire = match &wire {
        Some(w) => Wire::parse(w),
        None => Wire::legacy_for_provider(&provider),
    };
    let key = match get_key(&provider) {
        Ok(k) => k,
        Err(_) if allow_no_key.unwrap_or(false) => String::new(),
        Err(e) => return Err(e),
    };
    let (url, headers): (String, Vec<(String, String)>) = match wire {
        Wire::Anthropic => {
            let base = base_url.as_deref().unwrap_or("https://api.anthropic.com");
            (
                format!("{base}/v1/models?limit=1000"),
                vec![
                    ("x-api-key".into(), key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                ],
            )
        }
        Wire::Gemini => {
            // `base` carries the version segment; auth is the header (see `build_request`).
            let base = gemini_base(
                base_url
                    .as_deref()
                    .unwrap_or("https://generativelanguage.googleapis.com/v1beta"),
            );
            (
                format!("{base}/models?pageSize=1000"),
                vec![("x-goog-api-key".to_string(), key.clone())],
            )
        }
        // Responses providers publish the same `/v1/models` catalog as chat-completions.
        Wire::Openai | Wire::Responses => {
            let base = base_url.as_deref().unwrap_or("https://api.openai.com");
            let mut h = Vec::new();
            if !key.is_empty() {
                h.push(("authorization".to_string(), format!("Bearer {key}")));
            }
            (format!("{base}/v1/models"), h)
        }
    };
    ensure_key_transport(&url, &key)?;
    let client = http_client()?;
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
        let detail = limited_body(resp, 64 * 1024).await.unwrap_or_default();
        let detail = String::from_utf8_lossy(&detail);
        return Err(AppError::new(format!(
            "provider error {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let body = limited_body(resp, MAX_MODEL_BODY).await?;
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|e| AppError::new(e.to_string()))?;
    let mut out: Vec<String> = match wire {
        Wire::Gemini => json["models"]
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
        // anthropic + openai-compatible + responses all wrap in `data: [{id}]`
        Wire::Anthropic | Wire::Openai | Wire::Responses => json["data"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["id"].as_str())
            .map(str::to_string)
            .collect(),
    };
    if matches!(wire, Wire::Openai | Wire::Responses) {
        // `/v1/models` mixes in embeddings/audio/image/moderation models. Applies to
        // every OpenAI-wire provider, not just OpenAI — routers relay the same families.
        const SKIP: [&str; 11] = [
            "embedding", "whisper", "tts", "dall-e", "moderation", "audio",
            "realtime", "transcribe", "image", "davinci", "babbage",
        ];
        out.retain(|id| !SKIP.iter().any(|s| id.contains(s)));
        out.sort(); // ascending groups router ids by vendor prefix ("anthropic/…", "openai/…")
    }
    out.retain(|id| !id.is_empty() && id.len() <= 500);
    out.truncate(5_000);
    Ok(out)
}

const MAX_MODEL_BODY: usize = 5 * 1024 * 1024;
const MAX_SSE_LINE: usize = 1024 * 1024;
const MAX_AI_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_AI_INPUT: usize = 4 * 1024 * 1024;

fn http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(5 * 60))
        // API-key headers must never follow a provider-controlled cross-origin or
        // HTTPS-to-HTTP redirect. Callers can configure the final endpoint directly.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::new(e.to_string()))
}

fn ensure_key_transport(url: &str, key: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| AppError::new(format!("invalid AI endpoint URL: {e}")))?;
    if !key.is_empty() && parsed.scheme() != "https" {
        return Err(AppError::new("refusing to send an AI API key over a non-HTTPS endpoint"));
    }
    Ok(())
}

async fn limited_body(resp: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::new(e.to_string()))?;
        if out.len().saturating_add(bytes.len()) > max {
            return Err(AppError::new(format!("provider response exceeds {max} bytes")));
        }
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

fn validate_request(req: &AiRequest) -> Result<(), AppError> {
    key_entry(&req.provider)?;
    if req.provider.len() > 100 || req.model.len() > 500 || req.base_url.as_ref().is_some_and(|s| s.len() > 2_000) {
        return Err(AppError::new("AI request contains an oversized provider, model, or base URL"));
    }
    if req.max_tokens.is_some_and(|n| !(1..=128_000).contains(&n)) {
        return Err(AppError::new("AI maxTokens must be between 1 and 128000"));
    }
    if req.wire.as_deref().is_some_and(|w| !matches!(w, "anthropic" | "gemini" | "openai" | "responses")) {
        return Err(AppError::new("unknown AI wire protocol"));
    }
    if req.messages.len() > 1_000
        || req.messages.iter().any(|m| !matches!(m.role.as_str(), "user" | "assistant") || m.role.len() > 20)
        || req.request_id.as_ref().is_some_and(|id| id.len() > 200)
    {
        return Err(AppError::new("AI request contains too many messages or an invalid role/request id"));
    }
    let bytes = req.system.as_ref().map_or(0, String::len)
        + req.messages.iter().map(|m| m.role.len() + m.content.len()).sum::<usize>();
    if bytes > MAX_AI_INPUT {
        return Err(AppError::new(format!("AI request context exceeds {MAX_AI_INPUT} bytes")));
    }
    Ok(())
}

/// One parsed SSE line. A single frame can carry several signals at once (Gemini's
/// last chunk has both text and `finishReason`), so this is a struct, not an enum —
/// an enum would silently drop the finish reason of a truncated final chunk.
#[derive(Default)]
struct Frame {
    delta: Option<String>,
    finish: Option<String>,
    error: Option<String>,
    done: bool,
}

/// Drain COMPLETE lines from a byte buffer, leaving any partial trailing line.
/// Splitting on the `\n` BYTE (0x0A, which never appears inside a multibyte UTF-8
/// sequence) guarantees each returned line is a whole UTF-8 boundary — so decoding
/// per line can't mangle a character split across two network chunks (the bug when
/// you `from_utf8_lossy` each raw chunk before splitting).
fn drain_sse_lines(buf: &mut Vec<u8>) -> Result<Vec<String>, AppError> {
    let mut lines = Vec::new();
    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
        if nl > MAX_SSE_LINE {
            return Err(AppError::new(format!("provider SSE line exceeds {MAX_SSE_LINE} bytes")));
        }
        let line: Vec<u8> = buf.drain(..=nl).collect();
        lines.push(String::from_utf8_lossy(&line[..line.len() - 1]).trim_end().to_string());
    }
    if buf.len() > MAX_SSE_LINE {
        return Err(AppError::new(format!("provider SSE line exceeds {MAX_SSE_LINE} bytes")));
    }
    Ok(lines)
}

/// Parse one SSE line (`data: {json}` / `data: [DONE]`) into a frame for `wire`.
fn parse_sse_line(line: &str, wire: Wire) -> Frame {
    let mut f = Frame::default();
    let Some(payload) = line.strip_prefix("data:") else { return f };
    let payload = payload.trim();
    if payload.is_empty() {
        return f;
    }
    if payload == "[DONE]" {
        f.done = true;
        return f;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else { return f };
    f.error = extract_error(wire, &json);
    f.delta = extract_delta(wire, &json).filter(|t| !t.is_empty());
    f.finish = extract_finish(wire, &json).filter(|r| !r.is_empty());
    if wire == Wire::Anthropic && json["type"] == "message_stop" {
        f.done = true;
    }
    // Responses has no `[DONE]` sentinel — a typed terminal event ends the stream.
    if wire == Wire::Responses && (json["type"] == "response.completed" || json["type"] == "response.incomplete") {
        f.done = true;
    }
    f
}

/// Why an attempt failed, and whether starting over could plausibly succeed.
enum Attempt {
    /// Transient (overloaded / rate-limited / 5xx / dropped socket) AND nothing has
    /// been shown to the user yet — safe to replay the request from scratch.
    Retry(String),
    /// Permanent (bad key, bad model, content filter), or we already emitted deltas
    /// and replaying would duplicate them on screen.
    Fatal(String),
}

fn retryable_status(s: u16) -> bool {
    matches!(s, 408 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// Transient-looking provider/transport messages. Deliberately generous: a needless
/// retry costs one request, while a missed one strands the user (or, in Slack, prints
/// a bogus "go use the desktop app").
fn retryable_msg(m: &str) -> bool {
    let m = m.to_ascii_lowercase();
    [
        "overloaded", "rate limit", "rate_limit", "timeout", "timed out", "temporarily",
        "try again", "internal server", "connection", "connect", "reset by peer",
        "unavailable", "ended before a terminal event", "502", "503", "529",
    ]
    .iter()
    .any(|k| m.contains(k))
}

/// Resolves when the (optional) cancel channel fires; never, if there is none.
/// `&mut oneshot::Receiver` is a Future (via `impl Future for &mut F where F: Future + Unpin`),
/// so it can be re-polled across select! iterations without being consumed.
async fn wait_cancel(rx: &mut Option<oneshot::Receiver<()>>) {
    match rx {
        // A dropped sender also means "stop" — nothing can cancel us any more.
        Some(r) => {
            let _ = r.await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// One attempt at a streamed completion. Feeds every text delta to `on_delta` and
/// returns the accumulated text. Any provider error frame, aborting finish reason, or
/// transport failure becomes an `Attempt` — never a silent early return.
///
/// `partial_is_fatal` = the deltas have already been shown to the user (the `ai_chat`
/// path), so a mid-stream failure cannot be retried without duplicating text. The Slack
/// path buffers instead, so it can safely replay.
async fn stream_attempt<F: FnMut(String) + Send>(
    client: &reqwest::Client,
    req: &AiRequest,
    key: &str,
    on_delta: &mut F,
    cancel: &mut Option<oneshot::Receiver<()>>,
    partial_is_fatal: bool,
) -> Result<Option<Completion>, Attempt> {
    let (url, headers, body) = build_request(req, key);
    ensure_key_transport(&url, key).map_err(|e| Attempt::Fatal(e.message))?;
    let mut builder = client.post(&url).json(&body);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }

    let resp = tokio::select! {
        biased;
        _ = wait_cancel(cancel) => return Ok(None),
        r = builder.send() => match r {
            Ok(r) => r,
            // Nothing emitted yet by definition — the request never landed.
            Err(e) => return Err(Attempt::Retry(e.to_string())),
        },
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = limited_body(resp, 64 * 1024).await.unwrap_or_default();
        let detail = String::from_utf8_lossy(&detail);
        let msg = format!("provider error {status}: {}", detail.chars().take(500).collect::<String>());
        return Err(if retryable_status(status.as_u16()) {
            Attempt::Retry(msg)
        } else {
            Attempt::Fatal(msg)
        });
    }

    // Line-based SSE: drain complete lines (multibyte-safe), parse per provider.
    let mut text = String::new();
    let mut truncated = false;
    let mut emitted = false;
    let mut saw_finish = false;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Ok(None),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break }; // stream ended without an explicit Done
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => return Err(soft_fail(e.to_string(), emitted && partial_is_fatal)),
        };
        buf.extend_from_slice(&bytes);
        let lines = drain_sse_lines(&mut buf).map_err(|e| Attempt::Fatal(e.message))?;
        for line in lines {
            let f = parse_sse_line(&line, req.wire());
            if let Some(msg) = f.error {
                return Err(soft_fail(msg, emitted && partial_is_fatal));
            }
            if let Some(t) = f.delta {
                if text.len().saturating_add(t.len()) > MAX_AI_OUTPUT {
                    return Err(Attempt::Fatal(format!("AI response exceeds {MAX_AI_OUTPUT} bytes")));
                }
                emitted = true;
                text.push_str(&t);
                on_delta(t);
            }
            if let Some(r) = f.finish {
                saw_finish = true;
                match classify_finish(&r) {
                    Finish::Normal => {}
                    Finish::Truncated => truncated = true,
                    Finish::Aborted(m) => return Err(Attempt::Fatal(m)),
                }
            }
            if f.done {
                return Ok(Some(Completion { text, truncated }));
            }
        }
    }
    // Some compatible servers omit the final newline. Process that complete final
    // frame rather than silently discarding a terminal event or error.
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
        let f = parse_sse_line(&line, req.wire());
        if let Some(msg) = f.error {
            return Err(soft_fail(msg, emitted && partial_is_fatal));
        }
        if let Some(t) = f.delta {
            if text.len().saturating_add(t.len()) > MAX_AI_OUTPUT {
                return Err(Attempt::Fatal(format!("AI response exceeds {MAX_AI_OUTPUT} bytes")));
            }
            emitted = true;
            text.push_str(&t);
            on_delta(t);
        }
        if let Some(r) = f.finish {
            saw_finish = true;
            match classify_finish(&r) {
                Finish::Normal => {}
                Finish::Truncated => truncated = true,
                Finish::Aborted(m) => return Err(Attempt::Fatal(m)),
            }
        }
        if f.done {
            return Ok(Some(Completion { text, truncated }));
        }
    }
    if saw_finish {
        Ok(Some(Completion { text, truncated }))
    } else {
        Err(soft_fail(
            "provider stream ended before a terminal event".to_string(),
            emitted && partial_is_fatal,
        ))
    }
}

/// Retryable unless we've already painted partial output on screen.
fn soft_fail(msg: String, locked_in: bool) -> Attempt {
    if !locked_in && retryable_msg(&msg) {
        Attempt::Retry(msg)
    } else {
        Attempt::Fatal(msg)
    }
}

const MAX_ATTEMPTS: u32 = 3;

/// Stream a completion, transparently replaying transient failures (overloaded /
/// rate-limited / dropped socket) up to `MAX_ATTEMPTS` with backoff. `Ok(None)` = cancelled.
async fn complete_with_retry<F: FnMut(String) + Send>(
    req: &AiRequest,
    mut on_delta: F,
    mut cancel: Option<oneshot::Receiver<()>>,
    partial_is_fatal: bool,
) -> Result<Option<Completion>, AppError> {
    validate_request(req)?;
    // Local servers (Ollama / LM Studio) have no key to look up.
    let key = match get_key(&req.provider) {
        Ok(k) => k,
        Err(_) if req.allow_no_key => String::new(),
        Err(e) => return Err(e),
    };
    let client = http_client()?;
    let mut last = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match stream_attempt(&client, req, &key, &mut on_delta, &mut cancel, partial_is_fatal).await {
            Ok(done) => return Ok(done),
            Err(Attempt::Fatal(m)) => return Err(AppError::new(m)),
            Err(Attempt::Retry(m)) => {
                last = m;
                if attempt + 1 < MAX_ATTEMPTS {
                    // 400ms, 800ms.
                    tokio::time::sleep(std::time::Duration::from_millis(400 << attempt)).await;
                }
            }
        }
    }
    Err(AppError::new(format!("{last} (gave up after {MAX_ATTEMPTS} attempts)")))
}

/// Non-streaming completion for backend consumers (the Slack bot): same provider
/// request as `ai_chat` (one request builder, two consumers), but the SSE deltas are
/// accumulated into a single String instead of being forwarded over a Channel.
///
/// Unlike the streaming path this buffers, so transient failures replay invisibly.
/// An empty response is an ERROR, not an empty success — the Slack bot used to render
/// one as "I can't help with that", masking a real provider failure.
pub async fn complete_one_shot(req: &AiRequest) -> Result<Completion, AppError> {
    let out = complete_with_retry(req, |_| {}, None, false)
        .await?
        .ok_or_else(|| AppError::new("AI completion was unexpectedly cancelled"))?;
    if out.text.trim().is_empty() {
        return Err(AppError::new(
            "the AI returned an empty response (the stream ended before any text arrived)",
        ));
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
        assert!(drain_sse_lines(&mut buf).unwrap().is_empty()); // no newline yet
        buf.extend_from_slice(b);
        let lines = drain_sse_lines(&mut buf).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(parse_sse_line(&lines[0], Wire::Openai).delta.as_deref(), Some("région")); // NOT "r��gion"
    }

    #[test]
    fn keyed_ai_endpoints_require_https() {
        assert!(ensure_key_transport("https://example.test/v1", "secret").is_ok());
        assert!(ensure_key_transport("http://example.test/v1", "secret").is_err());
        assert!(ensure_key_transport("http://127.0.0.1:11434/v1", "").is_ok());
        assert!(ensure_key_transport("not a url", "").is_err());
    }

    #[test]
    fn sse_limit_applies_to_lines_not_transport_chunks() {
        let mut many = b"data: {}\n".repeat((MAX_SSE_LINE / 9) + 10);
        assert!(many.len() > MAX_SSE_LINE);
        assert!(drain_sse_lines(&mut many).is_ok());
        let mut one = vec![b'x'; MAX_SSE_LINE + 1];
        one.push(b'\n');
        assert!(drain_sse_lines(&mut one).is_err());
    }

    #[test]
    fn ai_request_limits_reject_oversized_context_and_tokens() {
        let mut req = AiRequest {
            provider: "openai".into(),
            wire: Some("openai".into()),
            model: "model".into(),
            base_url: Some("https://example.test".into()),
            system: None,
            messages: vec![Msg { role: "user".into(), content: "hello".into() }],
            max_tokens: Some(1024),
            request_id: None,
            allow_no_key: false,
        };
        assert!(validate_request(&req).is_ok());
        req.max_tokens = Some(u32::MAX);
        assert!(validate_request(&req).is_err());
        req.max_tokens = Some(1024);
        req.messages[0].content = "x".repeat(MAX_AI_INPUT + 1);
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn sse_done_and_ignore() {
        assert!(parse_sse_line("data: [DONE]", Wire::Openai).done);
        let ignored = parse_sse_line(": comment", Wire::Openai);
        assert!(ignored.delta.is_none() && ignored.error.is_none() && !ignored.done);
        assert!(parse_sse_line("data:  ", Wire::Openai).delta.is_none());
    }

    /// The regression that made a stream "die mid-reply with no way to retry": an
    /// error frame arrives with HTTP 200 after some deltas. Ignoring it (the old
    /// behaviour) ended the loop and reported a clean `Done` on a truncated message.
    #[test]
    fn in_stream_error_frames_are_surfaced() {
        let anthropic = r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let e = parse_sse_line(anthropic, Wire::Anthropic).error.expect("anthropic error frame");
        assert!(e.contains("overloaded_error") && e.contains("Overloaded"));
        assert!(retryable_msg(&e), "overloaded must be retryable");

        let openai = r#"data: {"error":{"message":"Rate limit reached","type":"rate_limit_error"}}"#;
        assert_eq!(parse_sse_line(openai, Wire::Openai).error.as_deref(), Some("Rate limit reached"));

        let gemini = r#"data: {"promptFeedback":{"blockReason":"SAFETY"}}"#;
        assert!(parse_sse_line(gemini, Wire::Gemini).error.unwrap().contains("SAFETY"));

        // A normal delta frame must not be mistaken for an error.
        assert!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#, Wire::Openai).error.is_none());
        // vLLM/LiteLLM stamp `"error": null` on every frame — must not read as a failure.
        let ok = parse_sse_line(r#"data: {"error":null,"choices":[{"delta":{"content":"hi"}}]}"#, Wire::Openai);
        assert!(ok.error.is_none() && ok.delta.as_deref() == Some("hi"));
    }

    /// The Slack symptom: a `max_tokens` stop leaves a ```sql fence unclosed, so block
    /// extraction finds nothing. The reply must be reported as truncated, not as a refusal.
    #[test]
    fn truncation_is_detected_per_provider() {
        let a = r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#;
        assert!(matches!(classify_finish(&parse_sse_line(a, Wire::Anthropic).finish.unwrap()), Finish::Truncated));

        let o = r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#;
        assert!(matches!(classify_finish(&parse_sse_line(o, Wire::Openai).finish.unwrap()), Finish::Truncated));

        // Gemini's final chunk carries text AND the finish reason — both must survive.
        let g = r#"data: {"candidates":[{"content":{"parts":[{"text":"tail"}]},"finishReason":"MAX_TOKENS"}]}"#;
        let f = parse_sse_line(g, Wire::Gemini);
        assert_eq!(f.delta.as_deref(), Some("tail"));
        assert!(matches!(classify_finish(&f.finish.unwrap()), Finish::Truncated));
    }

    #[test]
    fn finish_reasons_classify() {
        assert!(matches!(classify_finish("end_turn"), Finish::Normal));
        assert!(matches!(classify_finish("STOP"), Finish::Normal));
        assert!(matches!(classify_finish("tool_use"), Finish::Normal));
        assert!(matches!(classify_finish("content_filter"), Finish::Aborted(_)));
        assert!(matches!(classify_finish("SAFETY"), Finish::Aborted(_)));
        // UNKNOWN reasons are NORMAL. The reply is already in hand when this runs, so an
        // allow-list would discard a good completion the moment a provider mints a value.
        // These are all real: Gemini, Anthropic, vLLM/llama.cpp/OpenRouter.
        for r in ["OTHER", "FINISH_REASON_UNSPECIFIED", "MALFORMED_FUNCTION_CALL",
                  "pause_turn", "model_context_window_exceeded", "eos_token", "abort", ""] {
            assert!(matches!(classify_finish(r), Finish::Normal), "unknown reason {r:?} must not abort");
        }
        // Anthropic's stop_reason only rides on `message_delta`, never a content delta.
        assert!(parse_sse_line(r#"data: {"type":"content_block_delta","delta":{"text":"x"}}"#, Wire::Anthropic)
            .finish
            .is_none());
    }

    /// OpenAI's Responses API (`/v1/responses`) — the shape OpenCode Zen serves GPT on.
    /// Typed events, no `[DONE]` sentinel, and a separate `response.incomplete` for
    /// truncation. Getting any of these wrong reproduces the silent-truncation class of bug.
    #[test]
    fn responses_wire_frames() {
        let d = parse_sse_line(r#"data: {"type":"response.output_text.delta","delta":"hi"}"#, Wire::Responses);
        assert_eq!(d.delta.as_deref(), Some("hi"));
        assert!(!d.done && d.error.is_none());

        // Other typed events carry no text — notably `.done`, which repeats the FULL text
        // and would duplicate the whole reply if it were treated as a delta.
        assert!(parse_sse_line(r#"data: {"type":"response.output_text.done","text":"hi"}"#, Wire::Responses)
            .delta
            .is_none());

        // A typed terminal event ends the stream (Responses sends no `[DONE]`).
        assert!(parse_sse_line(r#"data: {"type":"response.completed"}"#, Wire::Responses).done);

        // Truncation is both terminal AND truncated.
        let inc = parse_sse_line(
            r#"data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#,
            Wire::Responses,
        );
        assert!(inc.done);
        assert!(matches!(classify_finish(&inc.finish.unwrap()), Finish::Truncated));

        // Mid-stream failure must surface, not end the stream silently.
        let failed = parse_sse_line(
            r#"data: {"type":"response.failed","response":{"error":{"message":"upstream overloaded"}}}"#,
            Wire::Responses,
        );
        assert_eq!(failed.error.as_deref(), Some("upstream overloaded"));
        assert!(retryable_msg(&failed.error.unwrap()));

        // The two OpenAI shapes must not cross-read each other's frames.
        assert!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"x"}}]}"#, Wire::Responses).delta.is_none());
        assert!(parse_sse_line(r#"data: {"type":"response.output_text.delta","delta":"x"}"#, Wire::Openai).delta.is_none());
    }

    #[test]
    fn gemini_base_appends_a_version_segment_unless_one_is_present() {
        // A pre-registry slack.json mirrored the old version-less default.
        assert_eq!(gemini_base("https://generativelanguage.googleapis.com"), "https://generativelanguage.googleapis.com/v1beta");
        assert_eq!(gemini_base("https://generativelanguage.googleapis.com/"), "https://generativelanguage.googleapis.com/v1beta");
        // Already versioned → untouched.
        assert_eq!(gemini_base("https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com/v1beta");
        assert_eq!(gemini_base("https://opencode.ai/zen/v1"), "https://opencode.ai/zen/v1");
        // REGRESSION GUARD: a saved custom proxy base carries a path but NO version. The
        // pre-registry code appended /v1beta to it; keying on "has a path" silently dropped
        // the segment and 404'd every request for those users.
        assert_eq!(gemini_base("https://gw.corp.example/google"), "https://gw.corp.example/google/v1beta");
        assert_eq!(gemini_base("https://gw.corp.example/google/"), "https://gw.corp.example/google/v1beta");
    }

    #[test]
    fn wire_parse_round_trips_the_registry_strings() {
        // These four strings are what `src/ai/providers.ts` sends. An unknown wire falls
        // back to Openai — the shape most third-party gateways speak.
        assert!(Wire::parse("anthropic") == Wire::Anthropic);
        assert!(Wire::parse("gemini") == Wire::Gemini);
        assert!(Wire::parse("openai") == Wire::Openai);
        assert!(Wire::parse("responses") == Wire::Responses);
        assert!(Wire::parse("something-new") == Wire::Openai);
        // Legacy configs (and older slack.json) carry only a provider name.
        assert!(Wire::legacy_for_provider("gemini") == Wire::Gemini);
        assert!(Wire::legacy_for_provider("groq") == Wire::Openai);
    }

    #[test]
    fn retry_classification() {
        assert!(retryable_status(529) && retryable_status(429) && retryable_status(503));
        assert!(!retryable_status(401) && !retryable_status(400) && !retryable_status(404));
        assert!(retryable_msg("upstream connect error"));
        assert!(!retryable_msg("invalid x-api-key"));
        // Once deltas are on screen, even a transient failure must not replay them.
        assert!(matches!(soft_fail("Overloaded".into(), true), Attempt::Fatal(_)));
        assert!(matches!(soft_fail("Overloaded".into(), false), Attempt::Retry(_)));
    }
}

/// Stream a completion from the configured provider, emitting `AiEvent`s over the channel.
/// The API key is read from the keychain (never crosses the IPC boundary as plaintext from
/// the frontend). Always resolves Ok — failures are delivered as an `Error` event so the
/// frontend has a single event stream to consume, and a failed turn is retryable there.
///
/// Transient failures BEFORE the first delta are replayed internally; once text has been
/// painted, a failure surfaces as `Error` (the frontend offers Retry rather than
/// duplicating the partial reply). `req.requestId` registers the stream for `ai_cancel`.
#[tauri::command]
pub async fn ai_chat(
    req: AiRequest,
    on_event: tauri::ipc::Channel<AiEvent>,
    cancels: tauri::State<'_, AiCancels>,
) -> Result<(), AppError> {
    // Register a cancel channel keyed by the frontend's request id. Without an id
    // (shouldn't happen from the panel) the stream simply isn't cancellable — a `None`
    // receiver, NOT a dropped sender, which would fire the cancel branch immediately.
    let mut guard = None;
    let rx = match &req.request_id {
        Some(id) => {
            let (tx, rx) = oneshot::channel();
            if let Ok(mut m) = cancels.0.lock() {
                m.insert(id.clone(), tx);
            }
            guard = Some(CancelGuard { cancels: cancels.inner(), id: id.clone() });
            Some(rx)
        }
        None => None,
    };

    // Clone (not borrow) the channel into the delta closure: the closure must be Send
    // to cross the awaits inside the retry loop.
    let emit = on_event.clone();
    let res = complete_with_retry(
        &req,
        move |text| {
            let _ = emit.send(AiEvent::Delta { text });
        },
        rx,
        true, // partial output is on screen — never replay over it
    )
    .await;
    drop(guard);

    let _ = match res {
        Ok(Some(c)) => on_event.send(AiEvent::Done { truncated: c.truncated }),
        Ok(None) => on_event.send(AiEvent::Cancelled),
        Err(e) => on_event.send(AiEvent::Error { message: e.message }),
    };
    Ok(())
}
