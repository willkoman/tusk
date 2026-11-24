//! AI provider proxy. Keeps the API key in the OS keychain (never in the WebView) and
//! streams completions from the configured provider over a Tauri `Channel`.
//!
//! **This module knows five WIRE protocols, not N providers.** `Wire::{Anthropic,
//! Gemini, Openai, Responses, Bedrock}` selects the request/response shape (Bedrock's
//! Converse stream is AWS's binary event stream, the rest are SSE); the provider is just
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
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tokio::sync::oneshot;

use crate::db::AppError;

const KEYCHAIN_SERVICE: &str = "tusk-ai";

/// In-flight `ai_chat` streams, keyed by the frontend's `requestId`, so `ai_cancel`
/// can interrupt one. Held outside any connection lock — a cancel must always be
/// able to reach a stream that's blocked on the network.
struct CancelEntry {
    generation: u64,
    tx: oneshot::Sender<()>,
}

pub struct AiCancels {
    requests: Mutex<HashMap<String, CancelEntry>>,
    next_generation: AtomicU64,
}

impl Default for AiCancels {
    fn default() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
        }
    }
}

/// Unregisters the in-flight stream on EVERY exit path (done / error / cancel / panic).
struct CancelGuard<'a> {
    cancels: &'a AiCancels,
    id: String,
    generation: u64,
}
impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.cancels.requests.lock() {
            if m.get(&self.id)
                .is_some_and(|entry| entry.generation == self.generation)
            {
                m.remove(&self.id);
            }
        }
    }
}

impl AiCancels {
    fn register(&self, id: String) -> Option<(oneshot::Receiver<()>, CancelGuard<'_>)> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let mut requests = self.requests.lock().ok()?;
        // Replacing the entry drops the old sender, cancelling that stale generation.
        requests.insert(id.clone(), CancelEntry { generation, tx });
        drop(requests);
        Some((
            rx,
            CancelGuard {
                cancels: self,
                id,
                generation,
            },
        ))
    }
}

/// Interrupt the `ai_chat` stream with this `requestId`. No-op if it already finished.
#[tauri::command]
pub fn ai_cancel(request_id: String, cancels: tauri::State<'_, AiCancels>) {
    let entry = cancels
        .requests
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&request_id));
    if let Some(entry) = entry {
        let _ = entry.tx.send(());
    }
}

fn key_entry(provider: &str) -> Result<keyring::Entry, AppError> {
    if provider.is_empty()
        || provider.len() > 100
        || !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::new("invalid AI provider id"));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| AppError::new(e.to_string()))
}

const STORED_KEY_PREFIX: &str = "tusk-ai-key-v1:";

#[derive(Deserialize, Serialize)]
struct StoredKey {
    key: String,
    origins: Vec<String>,
}

fn provider_default_base(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("https://api.anthropic.com"),
        "openai" => Some("https://api.openai.com"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta"),
        "opencode" => Some("https://opencode.ai/zen/go"),
        "opencode-zen" => Some("https://opencode.ai/zen"),
        "openrouter" => Some("https://openrouter.ai/api"),
        "groq" => Some("https://api.groq.com/openai"),
        "ollama" => Some("http://localhost:11434"),
        "lmstudio" => Some("http://localhost:1234"),
        "bedrock" => Some(BEDROCK_DEFAULT_BASE),
        "custom" => None,
        _ => None,
    }
}

const BEDROCK_DEFAULT_BASE: &str = "https://bedrock-runtime.us-east-1.amazonaws.com";

/// The two Bedrock inference planes Tusk talks to. One Bedrock API key (a Bearer token)
/// authenticates both, in the same region:
///
/// - **Runtime** `https://bedrock-runtime[-fips].<region>.amazonaws.com`: the Converse API.
///   Every model Bedrock hosts, addressed by a foundation-model id, a system inference
///   profile (`us.`/`eu.`/`apac.`/`global.`…), or an application-profile ARN. Its catalog
///   lives on the CONTROL plane, `bedrock[-fips].<region>.amazonaws.com`.
/// - **Mantle** `https://bedrock-mantle.<region>.api.aws`: Bedrock's OpenAI- and
///   Anthropic-compatible engine. Unversioned ids (`anthropic.claude-opus-5`), its own
///   `/v1/models`, and three routes (see `MantleRoute`). Not in every region.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BedrockPlane {
    Runtime,
    Mantle,
}

/// AWS's own Bedrock inference host for a region, on the default HTTPS port, path
/// ignored: `(plane, fips, region)`. A VPC endpoint or a proxy does not match: those
/// stay custom origins that need explicit approval, like any other provider's override.
/// Mirrors `bedrockHost` in `src/ai/providers.ts`.
fn bedrock_host(url: &str) -> Option<(BedrockPlane, bool, String)> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let (plane, fips, region) = if let Some(rest) = host.strip_suffix(".amazonaws.com") {
        let (service, region) = rest.split_once('.')?;
        match service {
            "bedrock-runtime" => (BedrockPlane::Runtime, false, region),
            "bedrock-runtime-fips" => (BedrockPlane::Runtime, true, region),
            _ => return None,
        }
    } else {
        let region = host
            .strip_suffix(".api.aws")?
            .strip_prefix("bedrock-mantle.")?;
        (BedrockPlane::Mantle, false, region)
    };
    valid_aws_region(region).then(|| (plane, fips, region.to_string()))
}

/// AWS's own Bedrock RUNTIME endpoint for a region: `(fips, region)`.
fn bedrock_runtime_region(url: &str) -> Option<(bool, String)> {
    match bedrock_host(url)? {
        (BedrockPlane::Runtime, fips, region) => Some((fips, region)),
        _ => None,
    }
}

/// `us-east-1`, `eu-central-2`, `us-gov-west-1`, `ap-southeast-7`: lowercase words joined
/// by `-`, at least three of them, the last a number.
fn valid_aws_region(region: &str) -> bool {
    let parts: Vec<&str> = region.split('-').collect();
    region.len() <= 32
        && parts.len() >= 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
        && parts
            .last()
            .is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit()))
        && parts[0].bytes().all(|b| b.is_ascii_lowercase())
}

/// An origin the registry ships for this provider, so a key may be bound to it without
/// the explicit custom-origin approval. For Bedrock that is EVERY region's AWS runtime
/// and Mantle endpoint — picking a region is not pointing Tusk at somebody else's server,
/// and one Bedrock API key serves both planes.
fn shipped_origin(provider: &str, origin: &str) -> bool {
    default_origin(provider).as_deref() == Some(origin)
        || (provider == "bedrock" && bedrock_host(origin).is_some())
}

/// The Bedrock CONTROL-plane base (`ListFoundationModels`, `ListInferenceProfiles`) for
/// an AWS runtime base. Only derived from AWS's own runtime host, so a key bound to that
/// runtime origin can only ever travel to AWS's matching control-plane host.
fn bedrock_control_base(runtime_base: &str) -> Option<String> {
    let (fips, region) = bedrock_runtime_region(runtime_base)?;
    let service = if fips { "bedrock-fips" } else { "bedrock" };
    Some(format!("https://{service}.{region}.amazonaws.com"))
}

/// The region's Mantle base for an AWS runtime base (or a Mantle base itself). Like the
/// control plane it is only derived from AWS's own hosts. A FIPS runtime has no Mantle
/// counterpart, so it gets none rather than a silent hop off the FIPS endpoint.
fn bedrock_mantle_base(base: &str) -> Option<String> {
    match bedrock_host(base)? {
        (_, true, _) => None,
        (_, false, region) => Some(format!("https://bedrock-mantle.{region}.api.aws")),
    }
}

fn parse_network_url(value: &str) -> Result<reqwest::Url, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("AI URL is required"));
    }
    let url =
        reqwest::Url::parse(trimmed).map_err(|e| AppError::new(format!("invalid AI URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() || url.cannot_be_a_base() {
        return Err(AppError::new("AI URL must be an absolute HTTP(S) URL"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new("AI URL must not contain credentials"));
    }
    Ok(url)
}

fn parse_base_url(base: &str) -> Result<reqwest::Url, AppError> {
    let url = parse_network_url(base)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::new(
            "AI base URL must not contain a query or fragment",
        ));
    }
    Ok(url)
}

fn endpoint_origin(url: &str) -> Result<String, AppError> {
    let parsed = parse_network_url(url)?;
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err(AppError::new("AI endpoint must have a network origin"));
    }
    Ok(origin)
}

fn default_origin(provider: &str) -> Option<String> {
    provider_default_base(provider).and_then(|base| endpoint_origin(base).ok())
}

fn encode_stored_key(key: String, origin: String) -> Result<String, AppError> {
    let record = StoredKey {
        key,
        origins: vec![origin],
    };
    serde_json::to_string(&record)
        .map(|json| format!("{STORED_KEY_PREFIX}{json}"))
        .map_err(|e| AppError::new(e.to_string()))
}

fn decode_stored_key(raw: String) -> Result<Option<StoredKey>, AppError> {
    let Some(json) = raw.strip_prefix(STORED_KEY_PREFIX) else {
        return Ok(None);
    };
    serde_json::from_str(json)
        .map(Some)
        .map_err(|_| AppError::new("stored AI key metadata is invalid; save the key again"))
}

fn get_key_for_origin(provider: &str, endpoint: &str) -> Result<String, AppError> {
    let origin = endpoint_origin(endpoint)?;
    let entry = key_entry(provider)?;
    let raw = entry.get_password().map_err(|_| {
        AppError::new(format!(
            "no API key saved for {provider}. Add one in Settings → AI."
        ))
    })?;
    if let Some(stored) = decode_stored_key(raw.clone())? {
        // A key saved for one shipped origin serves every shipped origin of the same
        // provider (Bedrock's regions), but never an approved custom one.
        if stored.origins.iter().any(|approved| {
            approved == &origin
                || (shipped_origin(provider, approved) && shipped_origin(provider, &origin))
        }) {
            return Ok(stored.key);
        }
        return Err(AppError::new(format!(
            "the saved {provider} key is not approved for {origin}; approve this origin and save the key again"
        )));
    }

    // Legacy entries contain only the raw key. They remain usable at the provider's
    // shipped origin, but never inherit a custom override. Saving once upgrades them.
    if shipped_origin(provider, &origin) {
        return Ok(raw);
    }
    Err(AppError::new(format!(
        "the saved {provider} key predates origin binding; approve {origin} and save it again"
    )))
}

/// Save an API key for a provider to the OS keychain, bound to one approved origin.
#[tauri::command]
pub fn ai_save_key(
    provider: String,
    key: String,
    base_url: Option<String>,
    approve_origin: bool,
) -> Result<(), AppError> {
    if key.is_empty() || key.len() > 64 * 1024 {
        return Err(AppError::new("AI key must be between 1 and 65536 bytes"));
    }
    let base = base_url
        .as_deref()
        .or_else(|| provider_default_base(&provider))
        .ok_or_else(|| AppError::new("set and approve an AI base URL before saving this key"))?;
    let origin = endpoint_origin(base)?;
    if reqwest::Url::parse(&origin)
        .ok()
        .map(|url| url.scheme() != "https")
        .unwrap_or(true)
    {
        return Err(AppError::new(
            "refusing to bind an AI API key to a non-HTTPS origin",
        ));
    }
    if !shipped_origin(&provider, &origin) && !approve_origin {
        return Err(AppError::new(format!(
            "explicit origin approval is required before this key can be used at {origin}"
        )));
    }
    let value = encode_stored_key(key, origin)?;
    key_entry(&provider)?
        .set_password(&value)
        .map_err(|e| AppError::new(e.to_string()))
}

/// Whether a usable key is stored for a provider (the key itself is never returned).
/// Always origin-bound: without an explicit base this checks the provider's shipped
/// origin — a bare "does any key exist" answer would report Connected for a key that
/// every actual request path (also origin-bound) refuses to send.
#[tauri::command]
pub fn ai_has_key(provider: String, base_url: Option<String>) -> bool {
    let endpoint = base_url.or_else(|| default_origin(&provider));
    endpoint
        .map(|base| get_key_for_origin(&provider, &base).is_ok())
        .unwrap_or(false)
}

/// Remove a provider's stored key.
#[tauri::command]
pub fn ai_clear_key(provider: String) -> Result<(), AppError> {
    match key_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AppError::new(format!(
            "cannot delete the saved AI key: {error}"
        ))),
    }
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
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wire {
    Anthropic,
    Gemini,
    Openai,
    /// OpenAI's Responses API (`/v1/responses`). A different body (`input`/`instructions`/
    /// `max_output_tokens`) and different SSE events from chat-completions. Needed for
    /// GPT models on OpenCode Zen, which serves them only on this endpoint.
    Responses,
    /// Amazon Bedrock's Converse API (`/model/{id}/converse-stream`), authenticated with a
    /// Bedrock API key as a Bearer token. Not SSE: the reply is AWS's binary event stream
    /// (`application/vnd.amazon.eventstream`), decoded by `EventBuffer`.
    Bedrock,
}

/// Every wire name the frontend may send. The ONE list — `ai_list_models`,
/// `validate_request` and the Slack config validator all check against it.
pub(crate) const WIRE_NAMES: [&str; 5] = ["anthropic", "gemini", "openai", "responses", "bedrock"];

pub(crate) fn known_wire(name: &str) -> bool {
    WIRE_NAMES.contains(&name)
}

impl Wire {
    fn parse(s: &str) -> Wire {
        match s {
            "anthropic" => Wire::Anthropic,
            "gemini" => Wire::Gemini,
            "responses" => Wire::Responses,
            "bedrock" => Wire::Bedrock,
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
    Delta {
        text: String,
    },
    /// The stream ended cleanly. `truncated` = the model hit its token ceiling, so
    /// the reply is cut short (a fenced code block may be left unclosed).
    Done {
        truncated: bool,
    },
    /// The user pressed Stop. Distinct from `Error` — nothing went wrong.
    Cancelled,
    Error {
        message: String,
    },
}

/// A finished (non-streaming) completion.
pub struct Completion {
    pub text: String,
    /// The model hit `max_tokens` — the text is cut off mid-thought.
    pub truncated: bool,
}

/// Extract the incremental text from one SSE `data:` JSON payload, per wire.
fn extract_delta(wire: Wire, json: &serde_json::Value) -> Option<String> {
    match wire {
        Wire::Anthropic => {
            if json.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                json.pointer("/delta/text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
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
        // Bedrock frames are binary events, decoded by `bedrock_frame`, never SSE lines.
        Wire::Bedrock => None,
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
        if let Some(r) = json
            .pointer("/promptFeedback/blockReason")
            .and_then(|r| r.as_str())
        {
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
            let msg = json
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("stream error");
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
            .then(|| {
                json.pointer("/response/incomplete_details/reason")
                    .and_then(|r| r.as_str())
            })
            .flatten()
            .map(str::to_string),
        Wire::Bedrock => None,
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
        "recitation" => {
            Finish::Aborted("the provider blocked the response (recitation filter)".into())
        }
        "content_filter" => {
            Finish::Aborted("the provider blocked the response (content filter)".into())
        }
        "blocklist" | "prohibited_content" | "spii" => {
            Finish::Aborted("the provider blocked the response (content policy)".into())
        }
        // Bedrock Converse stop reasons.
        "guardrail_intervened" => {
            Finish::Aborted("the provider blocked the response (Bedrock guardrail)".into())
        }
        "content_filtered" => {
            Finish::Aborted("the provider blocked the response (content filter)".into())
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
    if versioned {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1beta")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProbe {
    wire: String,
    model: String,
    base_url: String,
}

fn endpoint_url(base: &str, path: &[&str], query: &[(&str, &str)]) -> Result<String, AppError> {
    let mut url = parse_base_url(base)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::new("AI base URL cannot contain path segments"))?;
        segments.pop_if_empty();
        for segment in path {
            if segment.is_empty() {
                return Err(AppError::new(
                    "AI endpoint path contains an empty component",
                ));
            }
            // `push` percent-encodes `/`, `?`, `#`, spaces, and other path delimiters.
            segments.push(segment);
        }
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    Ok(url.to_string())
}

/// Build the (url, headers, body) for the request, keyed on the WIRE — so a new
/// provider is a registry row in `src/ai/providers.ts`, not a new arm here.
type WireRequest = (String, Vec<(String, String)>, serde_json::Value);

/// Prefix that marks a Bedrock model id as a MANTLE id in Tusk's catalog and config
/// (`mantle/anthropic.claude-opus-5`). Mantle and the runtime share vendor-dotted ids
/// (`deepseek.v3.2` is on both) yet are different APIs, so the plane has to be in the id.
/// Mirrors `MANTLE_PREFIX` in `src/ai/providers.ts`.
const MANTLE_PREFIX: &str = "mantle/";

/// Mantle's three inference routes, each a shape Tusk already speaks. Which models a
/// route serves is not published (`/v1/models` carries no endpoint field); the partition,
/// probed model by model (2026-11, us-east-1):
///
/// - `Chat` — `{mantle}/v1/chat/completions`: the open-weight models Mantle runs itself
///   (gpt-oss, DeepSeek, Qwen, Mistral, Kimi, GLM, MiniMax, Nemotron, Gemma 3, …).
/// - `Partner` — `{mantle}/openai/v1/responses`: models served through their maker's own
///   API (OpenAI's GPT line, xAI's Grok, Gemma 4). Responses is their native shape, and
///   GPT refuses chat-completions' `max_tokens`.
/// - `Anthropic` — `{mantle}/anthropic/v1/messages`: Claude, on the Messages API.
///
/// A wrong route is refused up front with a 400 naming the route, before the model runs,
/// so `complete_with_retry` moves on to the next one and remembers the one that answered.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum MantleRoute {
    Chat,
    Partner,
    Anthropic,
}

impl MantleRoute {
    fn wire(self) -> Wire {
        match self {
            MantleRoute::Chat => Wire::Openai,
            MantleRoute::Partner => Wire::Responses,
            MantleRoute::Anthropic => Wire::Anthropic,
        }
    }

    /// The base the route's wire appends its own `/v1/…` path to.
    fn base(self, mantle: &str) -> String {
        match self {
            MantleRoute::Chat => mantle.to_string(),
            MantleRoute::Partner => format!("{mantle}/openai"),
            MantleRoute::Anthropic => format!("{mantle}/anthropic"),
        }
    }

    /// The routes to try for a bare Mantle id: the likely one first, then the others.
    fn order(model: &str) -> [MantleRoute; 3] {
        let m = model.to_ascii_lowercase();
        let first = if m.starts_with("anthropic.") {
            MantleRoute::Anthropic
        } else if m.starts_with("openai.gpt-oss") {
            MantleRoute::Chat
        } else if m.starts_with("openai.") || m.starts_with("xai.") {
            MantleRoute::Partner
        } else {
            MantleRoute::Chat
        };
        let mut out = [first; 3];
        let mut i = 1;
        for r in [
            MantleRoute::Chat,
            MantleRoute::Partner,
            MantleRoute::Anthropic,
        ] {
            if r != first {
                out[i] = r;
                i += 1;
            }
        }
        out
    }
}

type RouteCache = std::sync::Mutex<HashMap<String, MantleRoute>>;

/// The route each Mantle model last answered on, per Mantle base, for this process. A
/// cache only: losing it costs one refused request.
fn mantle_routes() -> &'static RouteCache {
    static ROUTES: std::sync::OnceLock<RouteCache> = std::sync::OnceLock::new();
    ROUTES.get_or_init(Default::default)
}

fn mantle_route_key(mantle: &str, model: &str) -> String {
    format!("{mantle} {model}")
}

fn remember_mantle_route(mantle: &str, model: &str, route: MantleRoute) {
    if let Ok(mut routes) = mantle_routes().lock() {
        if routes.len() >= 512 {
            routes.clear();
        }
        routes.insert(mantle_route_key(mantle, model), route);
    }
}

/// Where one attempt goes: the wire whose shape it speaks, its base, the model id that
/// wire is sent, and the output cap. Usually just the request's own fields; a Bedrock
/// Mantle id lowers onto one of Mantle's routes, and a refused attempt may adjust the
/// cap or the system prompt (`Adjust`).
#[derive(Clone, Debug, PartialEq)]
struct Target {
    wire: Wire,
    base: Option<String>,
    model: String,
    max_tokens: Option<u32>,
    /// Send the system prompt inside the first user turn: Converse refuses a system
    /// block for models without a system role (older Mistral).
    fold_system: bool,
    /// The Mantle base and route this target is, so a success can be remembered.
    mantle: Option<(String, MantleRoute)>,
}

/// Every target a request may be sent to, in the order to try them. One for every wire
/// but a Bedrock Mantle id, which gets one per Mantle route (the remembered one first).
fn targets(req: &AiRequest) -> Result<Vec<Target>, AppError> {
    let wire = req.wire();
    let plain = Target {
        wire,
        base: req.base_url.clone(),
        model: req.model.clone(),
        max_tokens: req.max_tokens,
        fold_system: false,
        mantle: None,
    };
    let Some(bare) = req.model.strip_prefix(MANTLE_PREFIX) else {
        return Ok(vec![plain]);
    };
    if wire != Wire::Bedrock {
        return Ok(vec![plain]);
    }
    if bare.trim().is_empty() {
        return Err(AppError::new("the Bedrock Mantle model id is empty"));
    }
    let base = req.base_url.as_deref().unwrap_or(BEDROCK_DEFAULT_BASE);
    let mantle = bedrock_mantle_base(base).ok_or_else(|| {
        AppError::new(
            "Bedrock Mantle models need AWS's own regional endpoint (https://bedrock-runtime.<region>.amazonaws.com, not FIPS). Pick a region, or use a runtime model id.",
        )
    })?;
    let mut order = MantleRoute::order(bare).to_vec();
    let known = mantle_routes()
        .lock()
        .ok()
        .and_then(|r| r.get(&mantle_route_key(&mantle, bare)).copied());
    if let Some(route) = known {
        order.retain(|r| *r != route);
        order.insert(0, route);
    }
    Ok(order
        .into_iter()
        .map(|route| Target {
            wire: route.wire(),
            base: Some(route.base(&mantle)),
            model: bare.to_string(),
            max_tokens: req.max_tokens,
            fold_system: false,
            mantle: Some((mantle.clone(), route)),
        })
        .collect())
}

/// The request as sent to its first target. The send loop builds each target itself.
#[cfg(test)]
fn build_request(req: &AiRequest, key: &str) -> Result<WireRequest, AppError> {
    let first = targets(req)?.remove(0);
    build_for(req, &first, key)
}

fn build_for(req: &AiRequest, t: &Target, key: &str) -> Result<WireRequest, AppError> {
    let model = &t.model;
    match t.wire {
        Wire::Anthropic => {
            let base = t.base.as_deref().unwrap_or("https://api.anthropic.com");
            let url = endpoint_url(base, &["v1", "messages"], &[])?;
            let mut headers = vec![
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ("content-type".into(), "application/json".into()),
            ];
            // Keyless local endpoints get NO auth headers — same rule as the OpenAI
            // wires: some servers reject an empty credential outright.
            if !key.is_empty() {
                headers.push(("x-api-key".into(), key.to_string()));
                // Gateways that speak this shape authenticate PER ENDPOINT, not per gateway:
                // OpenCode's `/v1/messages` reads `x-api-key` (like Anthropic proper) and
                // ignores Bearer, while its `/v1/chat/completions` reads Bearer and ignores
                // x-api-key — probed on both /zen and /zen/go. So x-api-key above already
                // covers OpenCode. Other Anthropic-shaped proxies read Bearer instead; send
                // it too when this isn't Anthropic proper. Unknown auth headers are ignored
                // (they yield "Missing API key", not a 400), so the extra header is safe —
                // except on Bedrock Mantle, whose Anthropic route refuses a request that
                // carries both ("must not include both 'authorization' and 'x-api-key'").
                if req.provider != "anthropic" && t.mantle.is_none() {
                    headers.push(("authorization".into(), format!("Bearer {key}")));
                }
            }
            let msgs: Vec<_> = req
                .messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect();
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": t.max_tokens.unwrap_or(2048),
                "stream": true,
                "messages": msgs,
            });
            if let Some(sys) = &req.system {
                body["system"] = serde_json::json!(sys);
            }
            Ok((url, headers, body))
        }
        Wire::Gemini => {
            // `base` includes the API-version segment (`…/v1beta` for Google, `…/zen/v1`
            // for OpenCode), because the two differ. Auth is the `x-goog-api-key` HEADER,
            // not the `?key=` query param: Google accepts both, OpenCode Zen only the
            // header (probed — `?key=` yields "Missing API key").
            let base = gemini_base(
                t.base
                    .as_deref()
                    .unwrap_or("https://generativelanguage.googleapis.com/v1beta"),
            );
            let action = format!("{model}:streamGenerateContent");
            let url = endpoint_url(&base, &["models", &action], &[("alt", "sse")])?;
            let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
            if !key.is_empty() {
                headers.push(("x-goog-api-key".into(), key.to_string()));
            }
            let contents: Vec<_> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" {
                        "model"
                    } else {
                        "user"
                    };
                    serde_json::json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            let mut body = serde_json::json!({ "contents": contents });
            if let Some(sys) = &req.system {
                body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
            }
            if let Some(mt) = t.max_tokens {
                body["generationConfig"] = serde_json::json!({ "maxOutputTokens": mt });
            }
            Ok((url, headers, body))
        }
        // Every OpenAI-compatible service: OpenAI, OpenCode, OpenRouter, Groq,
        // DeepSeek, Mistral, xAI, Ollama/LM Studio, … — they differ only by base URL.
        Wire::Openai => {
            let base = t.base.as_deref().unwrap_or("https://api.openai.com");
            let url = endpoint_url(base, &["v1", "chat", "completions"], &[])?;
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
            let mut body = serde_json::json!({ "model": model, "stream": true, "messages": msgs });
            if let Some(mt) = t.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
            Ok((url, headers, body))
        }
        // OpenAI's Responses API. Same Bearer auth as chat-completions, different body:
        // the system prompt is `instructions`, turns are `input`, and the output cap is
        // `max_output_tokens` (minimum 16).
        Wire::Responses => {
            let base = t.base.as_deref().unwrap_or("https://api.openai.com");
            let url = endpoint_url(base, &["v1", "responses"], &[])?;
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
            if let Some(mt) = t.max_tokens {
                body["max_output_tokens"] = serde_json::json!(mt.max(16));
            }
            if let Some(sys) = &req.system {
                body["instructions"] = serde_json::json!(sys);
            }
            Ok((url, headers, body))
        }
        // Amazon Bedrock Converse. The model id (a foundation model, a system inference
        // profile such as `us.anthropic.…`, or an application-profile ARN) is a PATH
        // segment — `push` percent-encodes the ARN's `/`. Auth is a Bedrock API key as a
        // Bearer token; SigV4 is not spoken here.
        Wire::Bedrock => {
            let base = t.base.as_deref().unwrap_or(BEDROCK_DEFAULT_BASE);
            let url = endpoint_url(base, &["model", model, "converse-stream"], &[])?;
            let mut headers = vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("accept".into(), "application/vnd.amazon.eventstream".into()),
            ];
            if !key.is_empty() {
                headers.push(("authorization".into(), format!("Bearer {key}")));
            }
            let system = req.system.as_deref().filter(|s| !s.trim().is_empty());
            let folded = system.filter(|_| t.fold_system);
            let mut body =
                serde_json::json!({ "messages": bedrock_messages(&req.messages, folded) });
            if let Some(sys) = system.filter(|_| !t.fold_system) {
                body["system"] = serde_json::json!([{ "text": sys }]);
            }
            if let Some(mt) = t.max_tokens {
                body["inferenceConfig"] = serde_json::json!({ "maxTokens": mt });
            }
            Ok((url, headers, body))
        }
    }
}

/// Converse turns. Converse refuses a blank text block, a conversation that opens with
/// the assistant, and (for most models) two consecutive turns from one role — the chat
/// panel can produce all three (an empty reply, a cancelled turn), so blank turns are
/// dropped, consecutive same-role turns are joined, and leading assistant turns go.
/// `system`, when given, opens the first user turn instead of riding in the request's
/// `system` block (models without a system role refuse that block).
fn bedrock_messages(messages: &[Msg], system: Option<&str>) -> Vec<serde_json::Value> {
    let mut turns: Vec<(&str, String)> = Vec::new();
    for m in messages {
        if m.content.trim().is_empty() {
            continue;
        }
        if turns.is_empty() && m.role == "assistant" {
            continue;
        }
        match turns.last_mut() {
            Some((role, text)) if *role == m.role => {
                text.push_str("\n\n");
                text.push_str(&m.content);
            }
            _ => turns.push((m.role.as_str(), m.content.clone())),
        }
    }
    if let Some(sys) = system {
        match turns.first_mut() {
            Some((_, text)) => *text = format!("{sys}\n\n{text}"),
            None => turns.push(("user", sys.to_string())),
        }
    }
    turns
        .into_iter()
        .map(|(role, text)| serde_json::json!({ "role": role, "content": [{ "text": text }] }))
        .collect()
}

/// Amazon Bedrock's model catalog: the RUNTIME's models (read from the control plane)
/// followed by MANTLE's, each Mantle id prefixed `mantle/`. Both hosts are derived only
/// from AWS's own runtime host (`bedrock_control_base`, `bedrock_mantle_base`), and the
/// key is read for that runtime origin, so it cannot travel anywhere a runtime origin
/// approval did not cover.
///
/// Mantle is not in every region; when it cannot be reached the runtime list stands on
/// its own (and the reverse, so a key scoped to Mantle alone still lists something).
/// Only when both fail is it an error, reporting the runtime's reason.
async fn bedrock_catalog(
    provider: &str,
    base_url: Option<&str>,
    allow_no_key: bool,
) -> Result<Vec<String>, AppError> {
    let runtime = base_url.unwrap_or(BEDROCK_DEFAULT_BASE);
    let control = bedrock_control_base(runtime).ok_or_else(|| {
        AppError::new(
            "Bedrock can list models only for an AWS endpoint (https://bedrock-runtime.<region>.amazonaws.com). Type model ids by hand for this endpoint.",
        )
    })?;
    let key = match get_key_for_origin(provider, runtime) {
        Ok(k) => k,
        Err(_) if allow_no_key => String::new(),
        Err(e) => return Err(e),
    };
    bedrock_catalog_with_key(runtime, &control, &key).await
}

async fn bedrock_catalog_with_key(
    runtime: &str,
    control: &str,
    key: &str,
) -> Result<Vec<String>, AppError> {
    let mantle = bedrock_mantle_base(runtime);
    let client = http_client()?;
    let mantle_models = async {
        match &mantle {
            Some(base) => bedrock_mantle_catalog(&client, base, key).await,
            None => Ok(Vec::new()),
        }
    };
    let (runtime_models, mantle_models) = tokio::join!(
        bedrock_runtime_catalog(&client, control, key),
        mantle_models
    );
    match (runtime_models, mantle_models) {
        (Ok(mut out), Ok(more)) => {
            out.extend(more);
            Ok(out)
        }
        (Ok(out), Err(_)) => Ok(out),
        (Err(_), Ok(more)) if !more.is_empty() => Ok(more),
        (Err(e), _) => Err(e),
    }
}

/// Whether a `ListFoundationModels` summary is a model Tusk can chat with over Converse:
/// text in, text out, Converse streaming, and not speech-to-speech. A model with no
/// `converse` capability block that needs video (TwelveLabs Pegasus) is refused by
/// Converse ("doesn't support the model"), so it is left out too.
fn bedrock_chat_model(m: &serde_json::Value) -> bool {
    let has = |field: &str, value: &str| {
        m[field]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(value)))
    };
    let modalities_known = m["inputModalities"].is_array() && m["outputModalities"].is_array();
    if modalities_known
        && (!has("inputModalities", "TEXT")
            || !has("outputModalities", "TEXT")
            || has("outputModalities", "SPEECH"))
    {
        return false;
    }
    if has("inputModalities", "VIDEO") && m["converse"].is_null() {
        return false;
    }
    if m.pointer("/modelLifecycle/status").and_then(|s| s.as_str()) == Some("LEGACY") {
        return false;
    }
    match m.pointer("/inferenceAPIsSupported/converse/streaming") {
        Some(v) => v.as_bool() == Some(true),
        None => m["responseStreamingSupported"].as_bool() != Some(false),
    }
}

/// The runtime's Converse-callable models, from the control plane: active inference
/// profiles over chat models (system-defined ids like `us.anthropic.…`, then the
/// account's application profiles by ARN), followed by the chat models invocable
/// ON_DEMAND. Many current models are reachable ONLY through a profile, which is why
/// both are read.
async fn bedrock_runtime_catalog(
    client: &reqwest::Client,
    control: &str,
    key: &str,
) -> Result<Vec<String>, AppError> {
    let models = bedrock_get(
        client,
        &endpoint_url(
            control,
            &["foundation-models"],
            &[("byOutputModality", "TEXT")],
        )?,
        key,
    )
    .await?;
    let summaries = models["modelSummaries"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default();
    let chat: std::collections::HashSet<&str> = summaries
        .iter()
        .filter(|m| bedrock_chat_model(m))
        .filter_map(|m| m["modelId"].as_str())
        .collect();
    let mut on_demand: Vec<String> = summaries
        .iter()
        .filter(|m| {
            m["inferenceTypesSupported"]
                .as_array()
                .is_some_and(|t| t.iter().any(|x| x.as_str() == Some("ON_DEMAND")))
        })
        .filter_map(|m| m["modelId"].as_str())
        .filter(|id| chat.contains(id))
        .map(str::to_string)
        .collect();
    on_demand.sort();

    let mut out = Vec::new();
    for kind in ["SYSTEM_DEFINED", "APPLICATION"] {
        let mut profiles = Vec::new();
        let mut next: Option<String> = None;
        // Paged; 20 pages of 1,000 is far beyond any real account.
        for _ in 0..20 {
            let mut query = vec![("maxResults", "1000"), ("type", kind)];
            if let Some(token) = next.as_deref() {
                query.push(("nextToken", token));
            }
            let page = bedrock_get(
                client,
                &endpoint_url(control, &["inference-profiles"], &query)?,
                key,
            )
            .await?;
            for p in page["inferenceProfileSummaries"]
                .as_array()
                .map(|a| a.as_slice())
                .unwrap_or_default()
            {
                if p["status"].as_str().is_some_and(|s| s != "ACTIVE") {
                    continue;
                }
                let serves_chat = p["models"].as_array().is_some_and(|ms| {
                    ms.iter().any(|m| {
                        m["modelArn"]
                            .as_str()
                            .and_then(|arn| arn.rsplit_once("foundation-model/"))
                            .is_some_and(|(_, id)| chat.contains(id))
                    })
                });
                if !serves_chat {
                    continue;
                }
                // Converse takes a system profile by id, an application profile by ARN.
                let id = if kind == "APPLICATION" {
                    p["inferenceProfileArn"].as_str()
                } else {
                    p["inferenceProfileId"].as_str()
                };
                if let Some(id) = id {
                    profiles.push(id.to_string());
                }
            }
            next = page["nextToken"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(str::to_string);
            if next.is_none() {
                break;
            }
        }
        profiles.sort();
        out.extend(profiles);
    }
    out.extend(on_demand);
    let mut seen = std::collections::HashSet::new();
    out.retain(|id| seen.insert(id.clone()));
    Ok(out)
}

/// Mantle's own catalog (`GET {mantle}/v1/models`, Bearer), as `mantle/<id>`. A model
/// the account cannot call is listed with `status: "unavailable"` and a reason (most
/// often the account's data-retention mode, which some vendors' models refuse); those
/// are left out, since every request to them fails.
async fn bedrock_mantle_catalog(
    client: &reqwest::Client,
    mantle: &str,
    key: &str,
) -> Result<Vec<String>, AppError> {
    let json = bedrock_get(client, &endpoint_url(mantle, &["v1", "models"], &[])?, key).await?;
    let mut out: Vec<String> = json["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|m| m["status"].as_str().is_none_or(|s| s == "available"))
        .filter_map(|m| m["id"].as_str())
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .map(|id| format!("{MANTLE_PREFIX}{id}"))
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// One authenticated Bedrock GET (control plane or Mantle), as JSON.
async fn bedrock_get(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<serde_json::Value, AppError> {
    ensure_key_transport(url, key, false)?;
    let resp = client
        .get(url)
        .header("authorization", format!("Bearer {key}"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = limited_body(resp, 64 * 1024).await.unwrap_or_default();
        let detail = String::from_utf8(detail)
            .unwrap_or_else(|_| "response body is not valid UTF-8".to_string());
        return Err(AppError::new(format!(
            "provider error {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let body = limited_body(resp, MAX_MODEL_BODY).await?;
    serde_json::from_slice(&body).map_err(|e| AppError::new(e.to_string()))
}

/// Every other wire's catalog: one GET of the provider's `/models` (see `ai_list_models`).
async fn wire_catalog(
    provider: &str,
    wire: Wire,
    base_url: Option<&str>,
    allow_no_key: bool,
) -> Result<Vec<String>, AppError> {
    let (url, header_kind): (String, Wire) = match wire {
        Wire::Anthropic => {
            let base = base_url.unwrap_or("https://api.anthropic.com");
            (
                endpoint_url(base, &["v1", "models"], &[("limit", "1000")])?,
                wire,
            )
        }
        Wire::Gemini => {
            // `base` carries the version segment; auth is the header (see `build_request`).
            let base =
                gemini_base(base_url.unwrap_or("https://generativelanguage.googleapis.com/v1beta"));
            (
                endpoint_url(&base, &["models"], &[("pageSize", "1000")])?,
                wire,
            )
        }
        // Responses providers publish the same `/v1/models` catalog as chat-completions.
        Wire::Openai | Wire::Responses => {
            let base = base_url.unwrap_or("https://api.openai.com");
            (endpoint_url(base, &["v1", "models"], &[])?, wire)
        }
        Wire::Bedrock => return bedrock_catalog(provider, base_url, allow_no_key).await,
    };
    let key = match get_key_for_origin(provider, &url) {
        Ok(k) => k,
        Err(_) if allow_no_key => String::new(),
        Err(e) => return Err(e),
    };
    // Keyless endpoints get no empty credential header on ANY wire (same rule as
    // `build_request` — some servers reject a blank credential outright).
    let headers: Vec<(String, String)> = match header_kind {
        Wire::Anthropic if !key.is_empty() => vec![
            ("x-api-key".into(), key.clone()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        Wire::Anthropic => vec![("anthropic-version".into(), "2023-06-01".into())],
        Wire::Gemini if !key.is_empty() => {
            vec![("x-goog-api-key".to_string(), key.clone())]
        }
        Wire::Gemini => Vec::new(),
        Wire::Openai | Wire::Responses | Wire::Bedrock if !key.is_empty() => {
            vec![("authorization".to_string(), format!("Bearer {key}"))]
        }
        Wire::Openai | Wire::Responses | Wire::Bedrock => Vec::new(),
    };
    ensure_key_transport(&url, &key, allow_no_key)?;
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
        let detail = String::from_utf8(detail)
            .unwrap_or_else(|_| "response body is not valid UTF-8".to_string());
        return Err(AppError::new(format!(
            "provider error {status}: {}",
            detail.chars().take(300).collect::<String>()
        )));
    }
    let body = limited_body(resp, MAX_MODEL_BODY).await?;
    let json: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| AppError::new(e.to_string()))?;
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
        Wire::Anthropic | Wire::Openai | Wire::Responses | Wire::Bedrock => json["data"]
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
            "embedding",
            "whisper",
            "tts",
            "dall-e",
            "moderation",
            "audio",
            "realtime",
            "transcribe",
            "image",
            "davinci",
            "babbage",
        ];
        out.retain(|id| !SKIP.iter().any(|s| id.contains(s)));
        out.sort(); // ascending groups router ids by vendor prefix ("anthropic/…", "openai/…")
    }
    Ok(out)
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
    probe: Option<AiProbe>,
) -> Result<Vec<String>, AppError> {
    key_entry(&provider)?;
    if wire.as_deref().is_some_and(|w| !known_wire(w)) {
        return Err(AppError::new("unknown AI wire protocol"));
    }
    if base_url.as_ref().is_some_and(|s| s.len() > 2_000) {
        return Err(AppError::new("AI base URL is too long"));
    }
    if probe
        .as_ref()
        .is_some_and(|p| p.model.len() > 500 || p.base_url.len() > 2_000)
    {
        return Err(AppError::new("AI connection probe is too large"));
    }
    let wire = match &wire {
        Some(w) => Wire::parse(w),
        None => Wire::legacy_for_provider(&provider),
    };
    let allow_no_key = allow_no_key.unwrap_or(false);
    let mut out = wire_catalog(&provider, wire, base_url.as_deref(), allow_no_key).await?;
    out.retain(|id| {
        !id.is_empty() && id.len() <= 500 && id == id.trim() && !id.chars().any(|c| c.is_control())
    });
    out.truncate(5_000);

    // Some gateways expose an unauthenticated model catalog. Settings can request a
    // tiny streamed completion so Test verifies the saved credential on a real auth
    // endpoint rather than treating a public `/models` response as proof.
    // Bedrock's catalog is itself authenticated (the control plane refuses an invalid
    // key), so with no model chosen yet that listing is the proof; the first id of a
    // fresh account may not even be enabled for it.
    let probe = probe.filter(|p| !(p.wire == "bedrock" && p.model.trim().is_empty()));
    if let Some(probe) = probe {
        if !known_wire(&probe.wire) {
            return Err(AppError::new("unknown AI probe wire protocol"));
        }
        let model = if probe.model.trim().is_empty() {
            out.first().cloned().unwrap_or_default()
        } else {
            probe.model
        };
        if model.is_empty() {
            return Err(AppError::new(
                "no model is available for an authenticated test",
            ));
        }
        let req = AiRequest {
            provider: provider.clone(),
            wire: Some(probe.wire),
            model,
            base_url: Some(probe.base_url),
            system: None,
            messages: vec![Msg {
                role: "user".into(),
                content: "Reply with OK.".into(),
            }],
            max_tokens: Some(16),
            request_id: None,
            allow_no_key,
        };
        complete_with_retry(&req, |_| {}, None, false)
            .await?
            .ok_or_else(|| AppError::new("AI connection test was unexpectedly cancelled"))?;
    }
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

fn ensure_key_transport(url: &str, key: &str, allow_no_key: bool) -> Result<(), AppError> {
    let parsed = parse_network_url(url)
        .map_err(|e| AppError::new(format!("invalid AI endpoint URL: {}", e.message)))?;
    if !key.is_empty() && parsed.scheme() != "https" {
        return Err(AppError::new(
            "refusing to send an AI API key over a non-HTTPS endpoint",
        ));
    }
    if key.is_empty() {
        if !allow_no_key {
            return Err(AppError::new("AI endpoint requires a saved API key"));
        }
        let loopback = parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_matches(|c| c == '[' || c == ']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !loopback {
            return Err(AppError::new(
                "keyless AI endpoints are restricted to localhost or a loopback IP",
            ));
        }
    }
    Ok(())
}

async fn limited_body(resp: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::new(e.to_string()))?;
        if out.len().saturating_add(bytes.len()) > max {
            return Err(AppError::new(format!(
                "provider response exceeds {max} bytes"
            )));
        }
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

fn validate_request(req: &AiRequest) -> Result<(), AppError> {
    key_entry(&req.provider)?;
    if req.provider.len() > 100
        || req.model.len() > 500
        || req.base_url.as_ref().is_some_and(|s| s.len() > 2_000)
    {
        return Err(AppError::new(
            "AI request contains an oversized provider, model, or base URL",
        ));
    }
    if req.max_tokens.is_some_and(|n| !(1..=128_000).contains(&n)) {
        return Err(AppError::new("AI maxTokens must be between 1 and 128000"));
    }
    if req.model.trim().is_empty()
        || req.model != req.model.trim()
        || req.model.chars().any(|c| c.is_control())
    {
        return Err(AppError::new("AI model id must be nonempty and contain no surrounding whitespace or control characters"));
    }
    if req.wire.as_deref().is_some_and(|w| !known_wire(w)) {
        return Err(AppError::new("unknown AI wire protocol"));
    }
    if req.messages.len() > 1_000
        || req
            .messages
            .iter()
            .any(|m| !matches!(m.role.as_str(), "user" | "assistant") || m.role.len() > 20)
        || req.request_id.as_ref().is_some_and(|id| id.len() > 200)
    {
        return Err(AppError::new(
            "AI request contains too many messages or an invalid role/request id",
        ));
    }
    let bytes = req.system.as_ref().map_or(0, String::len)
        + req
            .messages
            .iter()
            .map(|m| m.role.len() + m.content.len())
            .sum::<usize>();
    if bytes > MAX_AI_INPUT {
        return Err(AppError::new(format!(
            "AI request context exceeds {MAX_AI_INPUT} bytes"
        )));
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

/// Incremental SSE byte buffer. `scanned` prevents re-scanning a long partial line from
/// byte zero every time a small network chunk arrives.
#[derive(Default)]
struct SseBuffer {
    bytes: Vec<u8>,
    scanned: usize,
}

impl SseBuffer {
    fn extend(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    fn remaining(&self) -> &[u8] {
        &self.bytes
    }
}

/// Drain COMPLETE lines from a byte buffer, leaving any partial trailing line.
/// Splitting on the `\n` BYTE (0x0A, which never appears inside a multibyte UTF-8
/// sequence) guarantees each returned line is a whole UTF-8 boundary — so decoding
/// per line can't mangle a character split across two network chunks (the bug when
/// you `from_utf8_lossy` each raw chunk before splitting).
fn drain_sse_lines(buf: &mut SseBuffer) -> Result<Vec<String>, AppError> {
    let mut lines = Vec::new();
    let mut start = 0;
    for nl in buf.scanned..buf.bytes.len() {
        if buf.bytes[nl] != b'\n' {
            continue;
        }
        if nl - start > MAX_SSE_LINE {
            return Err(AppError::new(format!(
                "provider SSE line exceeds {MAX_SSE_LINE} bytes"
            )));
        }
        let line = std::str::from_utf8(&buf.bytes[start..nl])
            .map_err(|_| AppError::new("provider SSE stream contains invalid UTF-8"))?;
        lines.push(line.trim_end().to_string());
        start = nl + 1;
    }
    if buf.bytes.len().saturating_sub(start) > MAX_SSE_LINE {
        return Err(AppError::new(format!(
            "provider SSE line exceeds {MAX_SSE_LINE} bytes"
        )));
    }
    if start > 0 {
        // One compaction per network chunk, not one front-drain per line. The old loop
        // shifted the remaining buffer for every tiny SSE frame and became quadratic.
        buf.bytes = buf.bytes.split_off(start);
    }
    buf.scanned = buf.bytes.len();
    Ok(lines)
}

/// Parse one SSE line (`data: {json}` / `data: [DONE]`) into a frame for `wire`.
fn parse_sse_line(line: &str, wire: Wire) -> Frame {
    let mut f = Frame::default();
    let Some(payload) = line.strip_prefix("data:") else {
        return f;
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return f;
    }
    if payload == "[DONE]" {
        f.done = true;
        return f;
    }
    let json = match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        Ok(_) => {
            f.error = Some("provider sent a non-object SSE data frame".into());
            return f;
        }
        Err(_) => {
            // Ignore SSE comments/event/id/retry fields above, but a nonempty `data:`
            // payload is provider content. Treat malformed content as failure instead of
            // silently turning a broken stream into a clean completion.
            f.error = Some("provider sent malformed JSON in an SSE data frame".into());
            return f;
        }
    };
    f.error = extract_error(wire, &json);
    f.delta = extract_delta(wire, &json).filter(|t| !t.is_empty());
    f.finish = extract_finish(wire, &json).filter(|r| !r.is_empty());
    if wire == Wire::Anthropic && json["type"] == "message_stop" {
        f.done = true;
    }
    // Responses has no `[DONE]` sentinel — a typed terminal event ends the stream.
    if wire == Wire::Responses
        && (json["type"] == "response.completed" || json["type"] == "response.incomplete")
    {
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
    /// Refused before the model ran, in a way a reshaped request gets past (see
    /// `Adjust`). Carries the provider's message for when no reshaping is left.
    Adjust(Adjust, String),
}

/// A refusal that a different shape of the SAME request can get past. Each arrives as an
/// HTTP error before the model produced anything, so resending is not a replay.
#[derive(Debug, PartialEq)]
enum Adjust {
    /// Bedrock Mantle serves this model on another of its routes.
    Route,
    /// The output cap is above the model's own, which the provider stated.
    MaxTokens(u32),
    /// The model has no system role (Converse): send the prompt in the first user turn.
    FoldSystem,
}

/// Classify a non-success reply as an `Adjust`, or `None` when it is a plain failure.
fn adjustment(status: u16, body: &str, t: &Target, has_system: bool) -> Option<Adjust> {
    let lower = body.to_ascii_lowercase();
    if t.mantle.is_some()
        && matches!(status, 400 | 404)
        && (lower.contains("supported on this route")
            || (lower.contains("does not support the '") && lower.contains(" api")))
    {
        return Some(Adjust::Route);
    }
    if status != 400 {
        return None;
    }
    if t.wire == Wire::Bedrock
        && has_system
        && !t.fold_system
        && lower.contains("support system message")
    {
        return Some(Adjust::FoldSystem);
    }
    // The Anthropic shape always sends a cap (2048 when none was asked for).
    let requested = t
        .max_tokens
        .or((t.wire == Wire::Anthropic).then_some(2048))?;
    stated_output_limit(&lower, requested).map(Adjust::MaxTokens)
}

/// The model's output-token ceiling, when a refusal states one below `requested`:
/// Converse "exceeds the model limit of 10000", Anthropic "128000 > 64000, which is the
/// maximum allowed", Mantle "exceeds model maximum (4096)", OpenAI "supports at most
/// 16384 completion tokens". A context-length refusal names no output ceiling and is
/// left alone: lowering the cap would not fix it.
fn stated_output_limit(msg: &str, requested: u32) -> Option<u32> {
    let lower = msg.to_ascii_lowercase();
    if !lower.contains("token") {
        return None;
    }
    let mut markers = vec![
        "model limit of ",
        "model maximum (",
        "supports at most ",
        "maximum of ",
    ];
    if lower.contains("maximum allowed") {
        markers.push("> ");
    }
    for marker in markers {
        let mut from = 0;
        while let Some(i) = lower[from..].find(marker) {
            let at = from + i + marker.len();
            let digits: String = lower[at..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                if (1..requested).contains(&n) {
                    return Some(n);
                }
            }
            from = at;
        }
    }
    None
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
        "overloaded",
        "rate limit",
        "rate_limit",
        "timeout",
        "timed out",
        "temporarily",
        "try again",
        "internal server",
        "connection",
        "connect",
        "reset by peer",
        "unavailable",
        // Bedrock event-stream exceptions arrive as `<exceptionType>: <message>`.
        "throttl",
        "internalserver",
        "modelstreamerror",
        "ended before a terminal event",
        "502",
        "503",
        "529",
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

const DELTA_BATCH_BYTES: usize = 1024;
const DELTA_BATCH_MS: u64 = 30;

struct DeltaBatch {
    pending: String,
    last_flush: std::time::Instant,
}

impl DeltaBatch {
    fn new() -> Self {
        Self {
            pending: String::new(),
            last_flush: std::time::Instant::now(),
        }
    }

    fn push(&mut self, text: &str) -> bool {
        self.pending.push_str(text);
        self.pending.len() >= DELTA_BATCH_BYTES
            || self.last_flush.elapsed() >= std::time::Duration::from_millis(DELTA_BATCH_MS)
    }

    fn take(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        self.last_flush = std::time::Instant::now();
        Some(std::mem::take(&mut self.pending))
    }
}

fn flush_delta<F: FnMut(String)>(batch: &mut DeltaBatch, on_delta: &mut F, emitted: &mut bool) {
    if let Some(text) = batch.take() {
        *emitted = true;
        on_delta(text);
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
    target: &Target,
    key: &str,
    on_delta: &mut F,
    cancel: &mut Option<oneshot::Receiver<()>>,
    partial_is_fatal: bool,
) -> Result<Option<Completion>, Attempt> {
    let (url, headers, body) =
        build_for(req, target, key).map_err(|e| Attempt::Fatal(e.message))?;
    ensure_key_transport(&url, key, req.allow_no_key).map_err(|e| Attempt::Fatal(e.message))?;
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
        let detail = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => return Ok(None),
            body = limited_body(resp, 64 * 1024) => body.unwrap_or_default(),
        };
        let detail = String::from_utf8(detail)
            .unwrap_or_else(|_| "response body is not valid UTF-8".to_string());
        let msg = format!(
            "provider error {status}: {}",
            detail.chars().take(500).collect::<String>()
        );
        let has_system = req.system.as_deref().is_some_and(|s| !s.trim().is_empty());
        if let Some(adjust) = adjustment(status.as_u16(), &detail, target, has_system) {
            return Err(Attempt::Adjust(adjust, msg));
        }
        return Err(if retryable_status(status.as_u16()) {
            Attempt::Retry(msg)
        } else {
            Attempt::Fatal(msg)
        });
    }

    // SSE lines (multibyte-safe) or Bedrock's binary events, both decoded into the same
    // `Frame`s, so every wire shares one set of error / finish / truncation rules.
    let wire = target.wire;
    let mut decoder = Decoder::for_wire(wire);
    let mut state = StreamState::new();
    let mut stream = resp.bytes_stream();
    loop {
        let flush_in = (!state.batch.pending.is_empty()).then(|| {
            std::time::Duration::from_millis(DELTA_BATCH_MS)
                .saturating_sub(state.batch.last_flush.elapsed())
        });
        let chunk = tokio::select! {
            biased;
            _ = wait_cancel(cancel) => {
                state.flush(on_delta);
                return Ok(None);
            },
            _ = async {
                match flush_in {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                state.flush(on_delta);
                continue;
            },
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break }; // stream ended without an explicit Done
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                state.flush(on_delta);
                return Err(soft_fail(e.to_string(), state.emitted && partial_is_fatal));
            }
        };
        let frames = match decoder.push(&bytes, wire) {
            Ok(frames) => frames,
            Err(e) => {
                state.flush(on_delta);
                return Err(Attempt::Fatal(e.message));
            }
        };
        for f in frames {
            if state.apply(f, on_delta, partial_is_fatal)? {
                return Ok(Some(state.finish(on_delta)));
            }
        }
    }
    // Some compatible servers omit the final newline. Process that complete final
    // frame rather than silently discarding a terminal event or error.
    match decoder.finish(wire) {
        Ok(Some(f)) => {
            if state.apply(f, on_delta, partial_is_fatal)? {
                return Ok(Some(state.finish(on_delta)));
            }
        }
        Ok(None) => {}
        Err(e) => {
            state.flush(on_delta);
            return Err(Attempt::Fatal(e.message));
        }
    }
    if state.saw_finish {
        Ok(Some(state.finish(on_delta)))
    } else {
        state.flush(on_delta);
        Err(soft_fail(
            "provider stream ended before a terminal event".to_string(),
            state.emitted && partial_is_fatal,
        ))
    }
}

/// What one streaming attempt has received so far.
struct StreamState {
    text: String,
    truncated: bool,
    /// Deltas have reached `on_delta` (the screen, on the `ai_chat` path).
    emitted: bool,
    saw_finish: bool,
    batch: DeltaBatch,
}

impl StreamState {
    fn new() -> Self {
        Self {
            text: String::new(),
            truncated: false,
            emitted: false,
            saw_finish: false,
            batch: DeltaBatch::new(),
        }
    }

    fn flush<F: FnMut(String)>(&mut self, on_delta: &mut F) {
        flush_delta(&mut self.batch, on_delta, &mut self.emitted);
    }

    fn finish<F: FnMut(String)>(&mut self, on_delta: &mut F) -> Completion {
        self.flush(on_delta);
        Completion {
            text: std::mem::take(&mut self.text),
            truncated: self.truncated,
        }
    }

    /// Apply one decoded frame. `Ok(true)` = a terminal frame: the reply is complete.
    fn apply<F: FnMut(String)>(
        &mut self,
        f: Frame,
        on_delta: &mut F,
        partial_is_fatal: bool,
    ) -> Result<bool, Attempt> {
        if let Some(msg) = f.error {
            self.flush(on_delta);
            return Err(soft_fail(msg, self.emitted && partial_is_fatal));
        }
        if let Some(t) = f.delta {
            if self.text.len().saturating_add(t.len()) > MAX_AI_OUTPUT {
                self.flush(on_delta);
                return Err(Attempt::Fatal(format!(
                    "AI response exceeds {MAX_AI_OUTPUT} bytes"
                )));
            }
            self.text.push_str(&t);
            if self.batch.push(&t) {
                self.flush(on_delta);
            }
        }
        if let Some(r) = f.finish {
            self.saw_finish = true;
            match classify_finish(&r) {
                Finish::Normal => {}
                Finish::Truncated => self.truncated = true,
                Finish::Aborted(m) => {
                    self.flush(on_delta);
                    return Err(Attempt::Fatal(m));
                }
            }
        }
        Ok(f.done)
    }
}

/// Turns response bytes into `Frame`s for one wire.
enum Decoder {
    Sse(SseBuffer),
    Events(EventBuffer),
}

impl Decoder {
    fn for_wire(wire: Wire) -> Self {
        match wire {
            Wire::Bedrock => Decoder::Events(EventBuffer::default()),
            _ => Decoder::Sse(SseBuffer::default()),
        }
    }

    fn push(&mut self, bytes: &[u8], wire: Wire) -> Result<Vec<Frame>, AppError> {
        match self {
            Decoder::Sse(buf) => {
                buf.extend(bytes);
                Ok(drain_sse_lines(buf)?
                    .iter()
                    .map(|line| parse_sse_line(line, wire))
                    .collect())
            }
            Decoder::Events(buf) => {
                buf.bytes.extend_from_slice(bytes);
                Ok(drain_events(buf)?.iter().map(bedrock_frame).collect())
            }
        }
    }

    /// The bytes left when the body ends. An SSE stream may end on a final line with no
    /// newline; an event stream that stops mid-message has no frame to give, and the
    /// caller's "ended before a terminal event" covers it.
    fn finish(&mut self, wire: Wire) -> Result<Option<Frame>, AppError> {
        let Decoder::Sse(buf) = self else {
            return Ok(None);
        };
        let rest = buf.remaining();
        if rest.is_empty() {
            return Ok(None);
        }
        if rest.len() > MAX_SSE_LINE {
            return Err(AppError::new(format!(
                "provider SSE line exceeds {MAX_SSE_LINE} bytes"
            )));
        }
        let line = std::str::from_utf8(rest)
            .map_err(|_| AppError::new("provider SSE stream contains invalid UTF-8"))?;
        Ok(Some(parse_sse_line(line.trim_end(), wire)))
    }
}

/// Largest single event-stream message accepted. A text delta is a few bytes; this is
/// the same ceiling as one SSE line plus room for the headers.
const MAX_EVENT_BYTES: usize = MAX_SSE_LINE + 64 * 1024;

/// AWS event-stream bytes not yet decoded (`application/vnd.amazon.eventstream`).
#[derive(Default)]
struct EventBuffer {
    bytes: Vec<u8>,
}

/// One decoded event-stream message: the string headers Bedrock sets, and the payload.
#[derive(Default, Debug)]
struct StreamEvent {
    message_type: String,
    event_type: String,
    exception_type: String,
    error_code: String,
    error_message: String,
    payload: Vec<u8>,
}

/// CRC-32 (IEEE, the zlib/PNG polynomial): what the event-stream prelude and message
/// checksums use.
const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!0u32, |c, &b| {
        CRC32_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8)
    })
}

fn be_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// Drain every COMPLETE message, leaving a partial one buffered. Layout: total length
/// (u32), headers length (u32), prelude CRC, headers, payload, message CRC, all
/// big-endian. Both checksums are verified; a corrupt or oversized frame is an error,
/// never a silently shortened reply.
fn drain_events(buf: &mut EventBuffer) -> Result<Vec<StreamEvent>, AppError> {
    let mut out = Vec::new();
    let mut at = 0;
    while buf.bytes.len() - at >= 12 {
        let b = &buf.bytes[at..];
        let total = be_u32(&b[0..4]) as usize;
        let headers_len = be_u32(&b[4..8]) as usize;
        if crc32(&b[0..8]) != be_u32(&b[8..12]) {
            return Err(AppError::new(
                "provider event stream has a corrupt frame prelude",
            ));
        }
        if !(16..=MAX_EVENT_BYTES).contains(&total) || headers_len > total - 16 {
            return Err(AppError::new(format!(
                "provider event stream frame of {total} bytes is malformed or exceeds {MAX_EVENT_BYTES} bytes"
            )));
        }
        if b.len() < total {
            break;
        }
        if crc32(&b[0..total - 4]) != be_u32(&b[total - 4..total]) {
            return Err(AppError::new(
                "provider event stream frame failed its checksum",
            ));
        }
        let mut event = parse_event_headers(&b[12..12 + headers_len])?;
        event.payload = b[12 + headers_len..total - 4].to_vec();
        out.push(event);
        at += total;
    }
    if at > 0 {
        buf.bytes = buf.bytes.split_off(at);
    }
    Ok(out)
}

fn parse_event_headers(mut h: &[u8]) -> Result<StreamEvent, AppError> {
    let bad = || AppError::new("provider event stream frame has malformed headers");
    let mut event = StreamEvent::default();
    while !h.is_empty() {
        let name_len = h[0] as usize;
        let name = h.get(1..1 + name_len).ok_or_else(bad)?;
        let name = std::str::from_utf8(name).map_err(|_| bad())?.to_string();
        let kind = *h.get(1 + name_len).ok_or_else(bad)?;
        let rest = &h[2 + name_len..];
        // Value sizes by type: 0/1 bool (none), 2 byte, 3 short, 4 int, 5 long,
        // 6 bytes / 7 string (u16 length prefix), 8 timestamp, 9 uuid.
        let (value, used): (Option<&[u8]>, usize) = match kind {
            0 | 1 => (None, 0),
            2 => (None, 1),
            3 => (None, 2),
            4 => (None, 4),
            5 | 8 => (None, 8),
            9 => (None, 16),
            6 | 7 => {
                let len_bytes = rest.get(0..2).ok_or_else(bad)?;
                let len = u16::from_be_bytes([len_bytes[0], len_bytes[1]]) as usize;
                let v = rest.get(2..2 + len).ok_or_else(bad)?;
                ((kind == 7).then_some(v), 2 + len)
            }
            _ => return Err(bad()),
        };
        if rest.len() < used {
            return Err(bad());
        }
        if let Some(v) = value {
            let v = std::str::from_utf8(v).map_err(|_| bad())?.to_string();
            match name.as_str() {
                ":message-type" => event.message_type = v,
                ":event-type" => event.event_type = v,
                ":exception-type" => event.exception_type = v,
                ":error-code" => event.error_code = v,
                ":error-message" => event.error_message = v,
                _ => {}
            }
        }
        h = &rest[used..];
    }
    Ok(event)
}

/// One Converse stream event as a `Frame`. Text arrives in `contentBlockDelta`
/// (`delta.text`; reasoning deltas are not shown), the stop reason in `messageStop`,
/// which also ends the reply (the `metadata` event after it only carries usage). A
/// mid-stream failure is an `exception` message (`throttlingException`,
/// `modelStreamErrorException`, `validationException`, ...) or an `error` message.
fn bedrock_frame(ev: &StreamEvent) -> Frame {
    let mut f = Frame::default();
    let json = || serde_json::from_slice::<serde_json::Value>(&ev.payload).ok();
    match ev.message_type.as_str() {
        "event" => {
            let Some(json) = json().filter(|j| j.is_object()) else {
                f.error = Some("provider sent a malformed Bedrock stream event".into());
                return f;
            };
            match ev.event_type.as_str() {
                "contentBlockDelta" => {
                    f.delta = json
                        .pointer("/delta/text")
                        .and_then(|t| t.as_str())
                        .filter(|t| !t.is_empty())
                        .map(str::to_string);
                }
                "messageStop" => {
                    f.finish = json
                        .get("stopReason")
                        .and_then(|r| r.as_str())
                        .filter(|r| !r.is_empty())
                        .map(str::to_string);
                    f.done = true;
                }
                _ => {}
            }
        }
        "exception" => {
            let msg = json()
                .and_then(|j| {
                    j.get("message")
                        .or_else(|| j.get("Message"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| {
                    String::from_utf8_lossy(&ev.payload)
                        .chars()
                        .take(500)
                        .collect()
                });
            let kind = if ev.exception_type.is_empty() {
                "exception"
            } else {
                ev.exception_type.as_str()
            };
            f.error = Some(format!("{kind}: {msg}"));
        }
        "error" => {
            let code = if ev.error_code.is_empty() {
                "error"
            } else {
                ev.error_code.as_str()
            };
            f.error = Some(format!("{code}: {}", ev.error_message));
        }
        _ => {}
    }
    f
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

async fn retry_delay(
    delay: std::time::Duration,
    cancel: &mut Option<oneshot::Receiver<()>>,
) -> bool {
    tokio::select! {
        biased;
        _ = wait_cancel(cancel) => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

/// Reshapings (`Adjust`) allowed per completion: three Mantle routes, a cap, a fold.
const MAX_ADJUSTMENTS: u32 = 5;

/// Stream a completion, transparently replaying transient failures (overloaded /
/// rate-limited / dropped socket) up to `MAX_ATTEMPTS` with backoff, and reshaping a
/// request the provider refused up front (`Adjust`: another Mantle route, the model's own
/// output cap, a folded system prompt) without counting it as an attempt. `Ok(None)` =
/// cancelled.
async fn complete_with_retry<F: FnMut(String) + Send>(
    req: &AiRequest,
    on_delta: F,
    cancel: Option<oneshot::Receiver<()>>,
    partial_is_fatal: bool,
) -> Result<Option<Completion>, AppError> {
    complete_with_keys(req, on_delta, cancel, partial_is_fatal, &get_key_for_origin).await
}

/// The credential for an endpoint: `(provider, endpoint) -> key`. The app reads the
/// origin-bound keychain entry (`get_key_for_origin`); live tests pass a key in.
type KeySource<'a> = &'a (dyn Fn(&str, &str) -> Result<String, AppError> + Sync);

async fn complete_with_keys<F: FnMut(String) + Send>(
    req: &AiRequest,
    mut on_delta: F,
    mut cancel: Option<oneshot::Receiver<()>>,
    partial_is_fatal: bool,
    key_for: KeySource<'_>,
) -> Result<Option<Completion>, AppError> {
    validate_request(req)?;
    let routes = targets(req)?;
    let mut route = 0;
    let mut target = routes[0].clone();
    // Keychain entries are origin-bound, so the credential is read for each concrete
    // endpoint (resolved before any request) — a changed base URL cannot silently
    // redirect an existing key. Bedrock's planes share one key; read it once per origin.
    let mut keys: HashMap<String, String> = HashMap::new();
    let client = http_client()?;
    let mut last = String::new();
    let mut attempt = 0;
    let mut adjustments = 0;
    while attempt < MAX_ATTEMPTS {
        let (endpoint, _, _) = build_for(req, &target, "")?;
        let origin = endpoint_origin(&endpoint)?;
        let key = match keys.get(&origin) {
            Some(k) => k.clone(),
            None => {
                let k = match key_for(&req.provider, &endpoint) {
                    Ok(k) => k,
                    Err(_) if req.allow_no_key => String::new(),
                    Err(e) => return Err(e),
                };
                keys.insert(origin, k.clone());
                k
            }
        };
        match stream_attempt(
            &client,
            req,
            &target,
            &key,
            &mut on_delta,
            &mut cancel,
            partial_is_fatal,
        )
        .await
        {
            Ok(done) => {
                if let (Some(_), Some((mantle, r))) = (&done, &target.mantle) {
                    remember_mantle_route(mantle, &target.model, *r);
                }
                return Ok(done);
            }
            Err(Attempt::Fatal(m)) => return Err(AppError::new(m)),
            Err(Attempt::Adjust(adjust, m)) => {
                adjustments += 1;
                if adjustments > MAX_ADJUSTMENTS {
                    return Err(AppError::new(m));
                }
                match adjust {
                    Adjust::Route if route + 1 < routes.len() => {
                        route += 1;
                        let (cap, fold) = (target.max_tokens, target.fold_system);
                        target = routes[route].clone();
                        target.max_tokens = cap;
                        target.fold_system = fold;
                    }
                    Adjust::Route => {
                        return Err(AppError::new(format!(
                            "Bedrock Mantle serves {} on none of its chat routes ({m})",
                            target.model
                        )))
                    }
                    Adjust::MaxTokens(cap) => target.max_tokens = Some(cap),
                    Adjust::FoldSystem => target.fold_system = true,
                }
            }
            Err(Attempt::Retry(m)) => {
                last = m;
                attempt += 1;
                if attempt < MAX_ATTEMPTS {
                    // 400ms, 800ms.
                    if !retry_delay(
                        std::time::Duration::from_millis(400 << (attempt - 1)),
                        &mut cancel,
                    )
                    .await
                    {
                        return Ok(None);
                    }
                }
            }
        }
    }
    Err(AppError::new(format!(
        "{last} (gave up after {MAX_ATTEMPTS} attempts)"
    )))
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
            "the AI returned an empty response. The stream ended before any text arrived.",
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
        let mut buf = SseBuffer::default();
        buf.extend(a);
        assert!(drain_sse_lines(&mut buf).unwrap().is_empty()); // no newline yet
        buf.extend(b);
        let lines = drain_sse_lines(&mut buf).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(
            parse_sse_line(&lines[0], Wire::Openai).delta.as_deref(),
            Some("région")
        ); // NOT "r��gion"
    }

    #[test]
    fn keyed_ai_endpoints_require_https() {
        assert!(ensure_key_transport("https://example.test/v1", "secret", false).is_ok());
        assert!(ensure_key_transport("http://example.test/v1", "secret", false).is_err());
        assert!(ensure_key_transport("http://127.0.0.1:11434/v1", "", true).is_ok());
        assert!(ensure_key_transport("http://[::1]:1234/v1", "", true).is_ok());
        assert!(ensure_key_transport("http://localhost:11434/v1", "", true).is_ok());
        assert!(ensure_key_transport("https://models.example.test/v1", "", true).is_err());
        assert!(ensure_key_transport("http://localhost:11434/v1", "", false).is_err());
        assert!(ensure_key_transport("not a url", "", true).is_err());
    }

    #[test]
    fn endpoint_builder_validates_bases_and_encodes_model_segments() {
        assert!(endpoint_url("https://user:pass@example.test", &["v1"], &[]).is_err());
        assert!(endpoint_url("https://example.test/base?redirect=evil", &["v1"], &[]).is_err());
        assert!(endpoint_url("file:///tmp/model", &["v1"], &[]).is_err());

        let req = AiRequest {
            provider: "gemini".into(),
            wire: Some("gemini".into()),
            model: "model/with?alt=evil#fragment".into(),
            base_url: Some("https://generativelanguage.googleapis.com/v1beta".into()),
            system: None,
            messages: vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            max_tokens: None,
            request_id: None,
            allow_no_key: false,
        };
        let (url, _, _) = build_request(&req, "secret").unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.query(), Some("alt=sse"));
        assert!(parsed
            .path()
            .contains("model%2Fwith%3Falt=evil%23fragment:streamGenerateContent"));

        let openai = AiRequest {
            provider: "openai".into(),
            wire: Some("openai".into()),
            model: "model".into(),
            base_url: Some("https://api.openai.com".into()),
            system: None,
            messages: vec![Msg {
                role: "user".into(),
                content: "hi".into(),
            }],
            max_tokens: Some(16),
            request_id: None,
            allow_no_key: false,
        };
        let (_, _, body) = build_request(&openai, "secret").unwrap();
        assert_eq!(body["max_tokens"], 16);
    }

    #[test]
    fn legacy_keys_are_pinned_to_shipped_provider_origins() {
        assert_eq!(
            default_origin("openai").as_deref(),
            Some("https://api.openai.com")
        );
        assert_ne!(
            default_origin("openai").as_deref(),
            Some("https://proxy.example")
        );
        assert!(default_origin("custom").is_none());
        assert_eq!(
            endpoint_origin("https://api.openai.com:443/v1?x=1").unwrap(),
            "https://api.openai.com"
        );
        let encoded = encode_stored_key("secret".into(), "https://proxy.example".into()).unwrap();
        let stored = decode_stored_key(encoded).unwrap().unwrap();
        assert_eq!(stored.key, "secret");
        assert_eq!(stored.origins, ["https://proxy.example"]);
    }

    #[test]
    fn sse_limit_applies_to_lines_not_transport_chunks() {
        let many_bytes = b"data: {}\n".repeat((MAX_SSE_LINE / 9) + 10);
        assert!(many_bytes.len() > MAX_SSE_LINE);
        let mut many = SseBuffer::default();
        many.extend(&many_bytes);
        assert!(drain_sse_lines(&mut many).is_ok());
        let mut one_bytes = vec![b'x'; MAX_SSE_LINE + 1];
        one_bytes.push(b'\n');
        let mut one = SseBuffer::default();
        one.extend(&one_bytes);
        assert!(drain_sse_lines(&mut one).is_err());
    }

    #[test]
    fn sse_drain_compacts_once_and_keeps_partial_tail() {
        let mut buf = SseBuffer::default();
        buf.extend(b"data: {}\ndata: {}\ndata: {\"partial\"");
        let lines = drain_sse_lines(&mut buf).unwrap();
        assert_eq!(lines, ["data: {}", "data: {}"]);
        assert_eq!(buf.remaining(), b"data: {\"partial\"");
        let scanned = buf.scanned;
        buf.extend(b" tail");
        assert_eq!(scanned, b"data: {\"partial\"".len());
        assert!(drain_sse_lines(&mut buf).unwrap().is_empty());
    }

    #[test]
    fn ai_request_limits_reject_oversized_context_and_tokens() {
        let mut req = AiRequest {
            provider: "openai".into(),
            wire: Some("openai".into()),
            model: "model".into(),
            base_url: Some("https://example.test".into()),
            system: None,
            messages: vec![Msg {
                role: "user".into(),
                content: "hello".into(),
            }],
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
        req.messages[0].content = "hello".into();
        req.model = " bad\nmodel ".into();
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn sse_done_and_ignore() {
        assert!(parse_sse_line("data: [DONE]", Wire::Openai).done);
        let ignored = parse_sse_line(": comment", Wire::Openai);
        assert!(ignored.delta.is_none() && ignored.error.is_none() && !ignored.done);
        assert!(parse_sse_line("data:  ", Wire::Openai).delta.is_none());
        assert!(parse_sse_line("event: ping", Wire::Openai).error.is_none());
        assert!(parse_sse_line("data: {broken", Wire::Openai)
            .error
            .unwrap()
            .contains("malformed JSON"));
        assert!(parse_sse_line("data: 42", Wire::Openai)
            .error
            .unwrap()
            .contains("non-object"));
    }

    #[test]
    fn tiny_deltas_batch_before_crossing_ipc() {
        let mut batch = DeltaBatch::new();
        assert!(!batch.push("a"));
        assert!(!batch.push("b"));
        assert_eq!(batch.take().as_deref(), Some("ab"));
        assert!(batch.take().is_none());
        assert!(batch.push(&"x".repeat(DELTA_BATCH_BYTES)));
    }

    #[test]
    fn duplicate_request_guards_cannot_unregister_new_generation() {
        let cancels = AiCancels::default();
        let (mut old_rx, old_guard) = cancels.register("same".into()).unwrap();
        let (_new_rx, new_guard) = cancels.register("same".into()).unwrap();
        assert!(matches!(
            old_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
        drop(old_guard);
        assert_eq!(cancels.requests.lock().unwrap().len(), 1);
        drop(new_guard);
        assert!(cancels.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn retry_backoff_is_cancellable() {
        let (tx, rx) = oneshot::channel();
        let mut cancel = Some(rx);
        tx.send(()).unwrap();
        assert!(!retry_delay(std::time::Duration::from_secs(60), &mut cancel).await);
    }

    /// The regression that made a stream "die mid-reply with no way to retry": an
    /// error frame arrives with HTTP 200 after some deltas. Ignoring it (the old
    /// behaviour) ended the loop and reported a clean `Done` on a truncated message.
    #[test]
    fn in_stream_error_frames_are_surfaced() {
        let anthropic =
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let e = parse_sse_line(anthropic, Wire::Anthropic)
            .error
            .expect("anthropic error frame");
        assert!(e.contains("overloaded_error") && e.contains("Overloaded"));
        assert!(retryable_msg(&e), "overloaded must be retryable");

        let openai =
            r#"data: {"error":{"message":"Rate limit reached","type":"rate_limit_error"}}"#;
        assert_eq!(
            parse_sse_line(openai, Wire::Openai).error.as_deref(),
            Some("Rate limit reached")
        );

        let gemini = r#"data: {"promptFeedback":{"blockReason":"SAFETY"}}"#;
        assert!(parse_sse_line(gemini, Wire::Gemini)
            .error
            .unwrap()
            .contains("SAFETY"));

        // A normal delta frame must not be mistaken for an error.
        assert!(parse_sse_line(
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            Wire::Openai
        )
        .error
        .is_none());
        // vLLM/LiteLLM stamp `"error": null` on every frame — must not read as a failure.
        let ok = parse_sse_line(
            r#"data: {"error":null,"choices":[{"delta":{"content":"hi"}}]}"#,
            Wire::Openai,
        );
        assert!(ok.error.is_none() && ok.delta.as_deref() == Some("hi"));
    }

    /// The Slack symptom: a `max_tokens` stop leaves a ```sql fence unclosed, so block
    /// extraction finds nothing. The reply must be reported as truncated, not as a refusal.
    #[test]
    fn truncation_is_detected_per_provider() {
        let a = r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#;
        assert!(matches!(
            classify_finish(&parse_sse_line(a, Wire::Anthropic).finish.unwrap()),
            Finish::Truncated
        ));

        let o = r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#;
        assert!(matches!(
            classify_finish(&parse_sse_line(o, Wire::Openai).finish.unwrap()),
            Finish::Truncated
        ));

        // Gemini's final chunk carries text AND the finish reason — both must survive.
        let g = r#"data: {"candidates":[{"content":{"parts":[{"text":"tail"}]},"finishReason":"MAX_TOKENS"}]}"#;
        let f = parse_sse_line(g, Wire::Gemini);
        assert_eq!(f.delta.as_deref(), Some("tail"));
        assert!(matches!(
            classify_finish(&f.finish.unwrap()),
            Finish::Truncated
        ));
    }

    #[test]
    fn finish_reasons_classify() {
        assert!(matches!(classify_finish("end_turn"), Finish::Normal));
        assert!(matches!(classify_finish("STOP"), Finish::Normal));
        assert!(matches!(classify_finish("tool_use"), Finish::Normal));
        assert!(matches!(
            classify_finish("content_filter"),
            Finish::Aborted(_)
        ));
        assert!(matches!(classify_finish("SAFETY"), Finish::Aborted(_)));
        // UNKNOWN reasons are NORMAL. The reply is already in hand when this runs, so an
        // allow-list would discard a good completion the moment a provider mints a value.
        // These are all real: Gemini, Anthropic, vLLM/llama.cpp/OpenRouter.
        for r in [
            "OTHER",
            "FINISH_REASON_UNSPECIFIED",
            "MALFORMED_FUNCTION_CALL",
            "pause_turn",
            "model_context_window_exceeded",
            "eos_token",
            "abort",
            "",
        ] {
            assert!(
                matches!(classify_finish(r), Finish::Normal),
                "unknown reason {r:?} must not abort"
            );
        }
        // Anthropic's stop_reason only rides on `message_delta`, never a content delta.
        assert!(parse_sse_line(
            r#"data: {"type":"content_block_delta","delta":{"text":"x"}}"#,
            Wire::Anthropic
        )
        .finish
        .is_none());
    }

    /// OpenAI's Responses API (`/v1/responses`) — the shape OpenCode Zen serves GPT on.
    /// Typed events, no `[DONE]` sentinel, and a separate `response.incomplete` for
    /// truncation. Getting any of these wrong reproduces the silent-truncation class of bug.
    #[test]
    fn responses_wire_frames() {
        let d = parse_sse_line(
            r#"data: {"type":"response.output_text.delta","delta":"hi"}"#,
            Wire::Responses,
        );
        assert_eq!(d.delta.as_deref(), Some("hi"));
        assert!(!d.done && d.error.is_none());

        // Other typed events carry no text — notably `.done`, which repeats the FULL text
        // and would duplicate the whole reply if it were treated as a delta.
        assert!(parse_sse_line(
            r#"data: {"type":"response.output_text.done","text":"hi"}"#,
            Wire::Responses
        )
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
        assert!(matches!(
            classify_finish(&inc.finish.unwrap()),
            Finish::Truncated
        ));

        // Mid-stream failure must surface, not end the stream silently.
        let failed = parse_sse_line(
            r#"data: {"type":"response.failed","response":{"error":{"message":"upstream overloaded"}}}"#,
            Wire::Responses,
        );
        assert_eq!(failed.error.as_deref(), Some("upstream overloaded"));
        assert!(retryable_msg(&failed.error.unwrap()));

        // The two OpenAI shapes must not cross-read each other's frames.
        assert!(parse_sse_line(
            r#"data: {"choices":[{"delta":{"content":"x"}}]}"#,
            Wire::Responses
        )
        .delta
        .is_none());
        assert!(parse_sse_line(
            r#"data: {"type":"response.output_text.delta","delta":"x"}"#,
            Wire::Openai
        )
        .delta
        .is_none());
    }

    #[test]
    fn gemini_base_appends_a_version_segment_unless_one_is_present() {
        // A pre-registry slack.json mirrored the old version-less default.
        assert_eq!(
            gemini_base("https://generativelanguage.googleapis.com"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            gemini_base("https://generativelanguage.googleapis.com/"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        // Already versioned → untouched.
        assert_eq!(
            gemini_base("https://generativelanguage.googleapis.com/v1beta"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            gemini_base("https://opencode.ai/zen/v1"),
            "https://opencode.ai/zen/v1"
        );
        // REGRESSION GUARD: a saved custom proxy base carries a path but NO version. The
        // pre-registry code appended /v1beta to it; keying on "has a path" silently dropped
        // the segment and 404'd every request for those users.
        assert_eq!(
            gemini_base("https://gw.corp.example/google"),
            "https://gw.corp.example/google/v1beta"
        );
        assert_eq!(
            gemini_base("https://gw.corp.example/google/"),
            "https://gw.corp.example/google/v1beta"
        );
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
        assert!(matches!(
            soft_fail("Overloaded".into(), true),
            Attempt::Fatal(_)
        ));
        assert!(matches!(
            soft_fail("Overloaded".into(), false),
            Attempt::Retry(_)
        ));
    }

    // ---- Amazon Bedrock -------------------------------------------------------------

    /// Encode one AWS event-stream message with string headers (the inverse of
    /// `drain_events`), so the decoder is tested against the documented byte layout.
    fn event_message(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
        let mut h = Vec::new();
        for (name, value) in headers {
            h.push(name.len() as u8);
            h.extend_from_slice(name.as_bytes());
            h.push(7);
            h.extend_from_slice(&(value.len() as u16).to_be_bytes());
            h.extend_from_slice(value.as_bytes());
        }
        let total = 12 + h.len() + payload.len() + 4;
        let mut m = Vec::new();
        m.extend_from_slice(&(total as u32).to_be_bytes());
        m.extend_from_slice(&(h.len() as u32).to_be_bytes());
        let prelude_crc = crc32(&m);
        m.extend_from_slice(&prelude_crc.to_be_bytes());
        m.extend_from_slice(&h);
        m.extend_from_slice(payload);
        let crc = crc32(&m);
        m.extend_from_slice(&crc.to_be_bytes());
        m
    }

    fn bedrock_event(event_type: &str, json: &str) -> Vec<u8> {
        event_message(
            &[
                (":event-type", event_type),
                (":content-type", "application/json"),
                (":message-type", "event"),
            ],
            json.as_bytes(),
        )
    }

    #[test]
    fn crc32_matches_the_ieee_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn event_stream_decodes_across_arbitrary_chunk_splits() {
        let mut bytes = bedrock_event("messageStart", r#"{"role":"assistant"}"#);
        bytes.extend(bedrock_event(
            "contentBlockDelta",
            r#"{"contentBlockIndex":0,"delta":{"text":"SELECT région"}}"#,
        ));
        bytes.extend(bedrock_event(
            "contentBlockDelta",
            r#"{"contentBlockIndex":0,"delta":{"text":" FROM t"}}"#,
        ));
        bytes.extend(bedrock_event("messageStop", r#"{"stopReason":"end_turn"}"#));
        // Every split point, including inside the prelude, the headers and the CRC.
        for split in 0..bytes.len() {
            let mut d = Decoder::for_wire(Wire::Bedrock);
            let mut frames = d.push(&bytes[..split], Wire::Bedrock).unwrap();
            frames.extend(d.push(&bytes[split..], Wire::Bedrock).unwrap());
            let text: String = frames.iter().filter_map(|f| f.delta.clone()).collect();
            assert_eq!(text, "SELECT région FROM t", "split at {split}");
            let last = frames.last().unwrap();
            assert!(last.done && last.finish.as_deref() == Some("end_turn"));
            assert!(d.finish(Wire::Bedrock).unwrap().is_none());
        }
    }

    #[test]
    fn event_stream_rejects_corrupt_and_oversized_frames() {
        let good = bedrock_event("contentBlockDelta", r#"{"delta":{"text":"x"}}"#);
        let mut bad_crc = good.clone();
        let n = bad_crc.len();
        bad_crc[n - 1] ^= 0xFF;
        let mut buf = EventBuffer { bytes: bad_crc };
        assert!(drain_events(&mut buf).is_err());

        let mut bad_prelude = good.clone();
        bad_prelude[3] ^= 0x01;
        let mut buf = EventBuffer { bytes: bad_prelude };
        assert!(drain_events(&mut buf).is_err());

        // A prelude announcing a frame past the ceiling is refused before it is buffered.
        let mut huge = Vec::new();
        huge.extend_from_slice(&((MAX_EVENT_BYTES + 1) as u32).to_be_bytes());
        huge.extend_from_slice(&0u32.to_be_bytes());
        let c = crc32(&huge);
        huge.extend_from_slice(&c.to_be_bytes());
        let mut buf = EventBuffer { bytes: huge };
        assert!(drain_events(&mut buf).is_err());
    }

    #[test]
    fn bedrock_exceptions_and_stop_reasons_map_to_frames() {
        let mut buf = EventBuffer {
            bytes: event_message(
                &[
                    (":exception-type", "throttlingException"),
                    (":message-type", "exception"),
                ],
                br#"{"message":"Too many requests, please wait before trying again."}"#,
            ),
        };
        let ev = drain_events(&mut buf).unwrap();
        let f = bedrock_frame(&ev[0]);
        let msg = f.error.unwrap();
        assert!(msg.starts_with("throttlingException: Too many requests"));
        assert!(retryable_msg(&msg));
        assert!(retryable_msg(
            "internalServerException: An internal server error occurred."
        ));
        assert!(retryable_msg(
            "modelStreamErrorException: Retry your request."
        ));
        assert!(!retryable_msg(
            "validationException: The provided model identifier is invalid."
        ));

        let mut buf = EventBuffer {
            bytes: bedrock_event("messageStop", r#"{"stopReason":"max_tokens"}"#),
        };
        let f = bedrock_frame(&drain_events(&mut buf).unwrap()[0]);
        assert!(f.done);
        assert!(matches!(
            classify_finish(f.finish.as_deref().unwrap()),
            Finish::Truncated
        ));
        assert!(matches!(
            classify_finish("guardrail_intervened"),
            Finish::Aborted(_)
        ));
        assert!(matches!(
            classify_finish("content_filtered"),
            Finish::Aborted(_)
        ));
        assert!(matches!(classify_finish("end_turn"), Finish::Normal));

        // Reasoning deltas and usage metadata carry no visible text.
        let mut buf = EventBuffer {
            bytes: bedrock_event(
                "contentBlockDelta",
                r#"{"delta":{"reasoningContent":{"text":"thinking"}}}"#,
            ),
        };
        let f = bedrock_frame(&drain_events(&mut buf).unwrap()[0]);
        assert!(f.delta.is_none() && f.error.is_none() && !f.done);
    }

    #[test]
    fn bedrock_runtime_hosts_are_shipped_origins_and_others_are_not() {
        assert_eq!(
            bedrock_runtime_region("https://bedrock-runtime.eu-central-1.amazonaws.com"),
            Some((false, "eu-central-1".into()))
        );
        assert_eq!(
            bedrock_runtime_region("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/x"),
            Some((true, "us-gov-west-1".into()))
        );
        for not_aws in [
            "http://bedrock-runtime.us-east-1.amazonaws.com",
            "https://bedrock-runtime.us-east-1.amazonaws.com:8443",
            "https://bedrock-runtime.us-east-1.amazonaws.com.evil.example",
            "https://bedrock-runtime.evil.amazonaws.com",
            "https://bedrock.us-east-1.amazonaws.com",
            "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
            "https://user@bedrock-runtime.us-east-1.amazonaws.com",
        ] {
            assert_eq!(bedrock_runtime_region(not_aws), None, "{not_aws}");
        }
        assert!(shipped_origin(
            "bedrock",
            "https://bedrock-runtime.ap-southeast-2.amazonaws.com"
        ));
        assert!(!shipped_origin("bedrock", "https://proxy.example.com"));
        // Only Bedrock trusts a family of origins.
        assert!(!shipped_origin(
            "custom",
            "https://bedrock-runtime.us-east-1.amazonaws.com"
        ));
        assert_eq!(
            bedrock_control_base("https://bedrock-runtime.us-west-2.amazonaws.com").as_deref(),
            Some("https://bedrock.us-west-2.amazonaws.com")
        );
        assert_eq!(
            bedrock_control_base("https://bedrock-runtime-fips.us-east-1.amazonaws.com").as_deref(),
            Some("https://bedrock-fips.us-east-1.amazonaws.com")
        );
        assert_eq!(bedrock_control_base("https://proxy.example.com"), None);
    }

    #[test]
    fn bedrock_request_targets_converse_stream_with_a_converse_body() {
        let msg = |role: &str, content: &str| Msg {
            role: role.into(),
            content: content.into(),
        };
        let req = AiRequest {
            provider: "bedrock".into(),
            wire: Some("bedrock".into()),
            model: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc"
                .into(),
            base_url: Some("https://bedrock-runtime.us-east-1.amazonaws.com".into()),
            system: Some("You write SQL.".into()),
            messages: vec![
                msg("assistant", "Hi! How can I help?"),
                msg("user", "list tables"),
                msg("user", "in public"),
                msg("assistant", "   "),
                msg("assistant", "SELECT 1"),
            ],
            max_tokens: Some(512),
            request_id: None,
            allow_no_key: false,
        };
        let (url, headers, body) = build_request(&req, "k").unwrap();
        // The ARN's `/` is encoded so it stays ONE path segment.
        assert_eq!(
            url,
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/arn:aws:bedrock:us-east-1:123456789012:application-inference-profile%2Fabc/converse-stream"
        );
        assert!(headers
            .iter()
            .any(|(k, v)| k == "authorization" && v == "Bearer k"));
        assert_eq!(
            body,
            serde_json::json!({
                "messages": [
                    { "role": "user", "content": [{ "text": "list tables\n\nin public" }] },
                    { "role": "assistant", "content": [{ "text": "SELECT 1" }] },
                ],
                "system": [{ "text": "You write SQL." }],
                "inferenceConfig": { "maxTokens": 512 },
            })
        );
        assert!(known_wire("bedrock") && Wire::parse("bedrock") == Wire::Bedrock);
    }
    fn chat_req(model: &str, base: &str) -> AiRequest {
        AiRequest {
            provider: "bedrock".into(),
            wire: Some("bedrock".into()),
            model: model.into(),
            base_url: Some(base.into()),
            system: Some("You write SQL.".into()),
            messages: vec![Msg {
                role: "user".into(),
                content: "list tables".into(),
            }],
            max_tokens: Some(512),
            request_id: None,
            allow_no_key: false,
        }
    }

    #[test]
    fn bedrock_mantle_hosts_are_shipped_and_derive_only_from_aws_hosts() {
        assert_eq!(
            bedrock_host("https://bedrock-mantle.us-west-2.api.aws/v1"),
            Some((BedrockPlane::Mantle, false, "us-west-2".into()))
        );
        assert!(shipped_origin(
            "bedrock",
            "https://bedrock-mantle.us-east-1.api.aws"
        ));
        for not_aws in [
            "http://bedrock-mantle.us-east-1.api.aws",
            "https://bedrock-mantle.us-east-1.api.aws:444",
            "https://bedrock-mantle.us-east-1.api.aws.evil.example",
            "https://evil.bedrock-mantle.us-east-1.api.aws",
            "https://bedrock-mantle.evil.api.aws",
            "https://bedrock.us-east-1.api.aws",
        ] {
            assert_eq!(bedrock_host(not_aws), None, "{not_aws}");
            assert!(!shipped_origin("bedrock", not_aws), "{not_aws}");
        }
        assert_eq!(
            bedrock_mantle_base("https://bedrock-runtime.us-west-2.amazonaws.com").as_deref(),
            Some("https://bedrock-mantle.us-west-2.api.aws")
        );
        assert_eq!(
            bedrock_mantle_base("https://bedrock-mantle.us-east-1.api.aws").as_deref(),
            Some("https://bedrock-mantle.us-east-1.api.aws")
        );
        // No silent hop off a FIPS endpoint, and nothing derived from a proxy.
        assert_eq!(
            bedrock_mantle_base("https://bedrock-runtime-fips.us-east-1.amazonaws.com"),
            None
        );
        assert_eq!(bedrock_mantle_base("https://proxy.example.com"), None);
    }

    #[test]
    fn mantle_ids_lower_onto_their_route_with_the_rest_as_fallbacks() {
        let base = "https://bedrock-runtime.us-east-1.amazonaws.com";
        let mantle = "https://bedrock-mantle.us-east-1.api.aws";
        let routes = |m: &str| -> Vec<(Wire, String)> {
            targets(&chat_req(m, base))
                .unwrap()
                .into_iter()
                .map(|t| {
                    assert_eq!(t.model, m.strip_prefix(MANTLE_PREFIX).unwrap());
                    assert_eq!(t.mantle.as_ref().unwrap().0, mantle);
                    (t.wire, t.base.unwrap())
                })
                .collect()
        };
        let chat = (Wire::Openai, mantle.to_string());
        let partner = (Wire::Responses, format!("{mantle}/openai"));
        let anthropic = (Wire::Anthropic, format!("{mantle}/anthropic"));
        assert_eq!(
            routes("mantle/anthropic.claude-opus-5"),
            [anthropic.clone(), chat.clone(), partner.clone()]
        );
        assert_eq!(
            routes("mantle/openai.gpt-oss-120b"),
            [chat.clone(), partner.clone(), anthropic.clone()]
        );
        assert_eq!(
            routes("mantle/openai.gpt-5.5"),
            [partner.clone(), chat.clone(), anthropic.clone()]
        );
        assert_eq!(
            routes("mantle/xai.grok-4.3"),
            [partner.clone(), chat.clone(), anthropic.clone()]
        );
        assert_eq!(
            routes("mantle/deepseek.v3.2"),
            [chat.clone(), partner.clone(), anthropic.clone()]
        );

        // A route that answered before is tried first next time.
        remember_mantle_route(mantle, "google.gemma-4-e4b", MantleRoute::Partner);
        assert_eq!(
            routes("mantle/google.gemma-4-e4b"),
            [partner, chat, anthropic]
        );

        // Runtime ids, other wires and endpoints Mantle cannot be derived from.
        let runtime = targets(&chat_req("us.anthropic.claude-opus-5", base)).unwrap();
        assert_eq!(runtime.len(), 1);
        assert_eq!(runtime[0].wire, Wire::Bedrock);
        let mut other = chat_req("mantle/x", "https://api.openai.com");
        other.wire = Some("openai".into());
        assert_eq!(targets(&other).unwrap()[0].model, "mantle/x");
        assert!(targets(&chat_req("mantle/x", "https://proxy.example.com")).is_err());
        assert!(targets(&chat_req("mantle/", base)).is_err());
    }

    #[test]
    fn mantle_routes_are_the_shapes_tusk_already_speaks() {
        let req = chat_req(
            "mantle/anthropic.claude-haiku-4-5",
            "https://bedrock-runtime.us-east-1.amazonaws.com",
        );
        let (url, headers, body) = build_request(&req, "k").unwrap();
        assert_eq!(
            url,
            "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages"
        );
        // x-api-key only: this route refuses a request carrying both credentials.
        assert!(headers.iter().any(|(k, v)| k == "x-api-key" && v == "k"));
        assert!(!headers.iter().any(|(k, _)| k == "authorization"));
        assert_eq!(body["model"], "anthropic.claude-haiku-4-5");
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["system"], "You write SQL.");

        let req = chat_req(
            "mantle/zai.glm-5",
            "https://bedrock-runtime.us-west-2.amazonaws.com",
        );
        let (url, _, body) = build_request(&req, "k").unwrap();
        assert_eq!(
            url,
            "https://bedrock-mantle.us-west-2.api.aws/v1/chat/completions"
        );
        assert_eq!(body["model"], "zai.glm-5");

        let req = chat_req(
            "mantle/openai.gpt-5.5",
            "https://bedrock-runtime.us-west-2.amazonaws.com",
        );
        let (url, _, body) = build_request(&req, "k").unwrap();
        assert_eq!(
            url,
            "https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses"
        );
        assert_eq!(body["model"], "openai.gpt-5.5");
        assert_eq!(body["instructions"], "You write SQL.");
    }

    #[test]
    fn refusals_that_a_reshaped_request_gets_past_are_recognised() {
        let base = "https://bedrock-runtime.us-east-1.amazonaws.com";
        let mantle = targets(&chat_req("mantle/google.gemma-4-31b", base)).unwrap()[0].clone();
        let converse = targets(&chat_req("us.amazon.nova-micro-v1:0", base)).unwrap()[0].clone();
        // Real Mantle route refusals (chat, the Anthropic route, a Responses route).
        for body in [
            r#"{"error":{"code":"validation_error","message":"model `google.gemma-4-31b` isn't supported on this route","param":null,"type":"invalid_request_error"}}"#,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"The model 'openai.gpt-oss-20b' does not support the '/anthropic/v1/messages' API"}}"#,
            r#"{"error":{"code":"validation_error","message":"The model 'anthropic.claude-haiku-4-5' does not support the '/v1/responses' API"}}"#,
        ] {
            assert_eq!(
                adjustment(400, body, &mantle, true),
                Some(Adjust::Route),
                "{body}"
            );
            // Only a Mantle target switches route.
            assert_ne!(adjustment(400, body, &converse, true), Some(Adjust::Route));
        }
        // Not a route problem: the model is there, the account cannot use it.
        assert_eq!(
            adjustment(
                400,
                r#"{"error":{"code":"validation_error","message":"data retention mode 'none' is not available for this model"}}"#,
                &mantle,
                true
            ),
            None
        );

        // Output caps, as each API states them.
        let mut capped = converse.clone();
        capped.max_tokens = Some(128_000);
        let caps = [
            (
                r#"{"message":"The maximum tokens you requested exceeds the model limit of 10000. Try again with a maximum tokens value that is lower than 10000."}"#,
                10000,
            ),
            (
                r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for anthropic.claude-haiku-4-5"}}"#,
                64000,
            ),
            (
                r#"{"error":{"code":"validation_error","message":"'max_tokens' (128000) exceeds model maximum (4096)"}}"#,
                4096,
            ),
            (
                r#"{"error":{"message":"max_tokens is too large: 128000. This model supports at most 16384 completion tokens, whereas you provided 128000."}}"#,
                16384,
            ),
        ];
        for (body, cap) in caps {
            assert_eq!(
                adjustment(400, body, &capped, false),
                Some(Adjust::MaxTokens(cap)),
                "{body}"
            );
        }
        // A context-length refusal names no output ceiling; lowering the cap cannot help.
        assert_eq!(
            adjustment(
                400,
                r#"{"error":{"message":"This model's maximum context length is 4096 tokens. However, you requested 4105 tokens (9 in the messages, 4096 in the completion)."}}"#,
                &capped,
                false
            ),
            None
        );
        // Never raised, and only on a 400.
        assert_eq!(
            stated_output_limit("model limit of 200000 tokens", 1000),
            None
        );
        assert_eq!(
            adjustment(
                500,
                r#"{"message":"exceeds the model limit of 10000 tokens"}"#,
                &capped,
                false
            ),
            None
        );

        // A model without a system role (Converse), once, and only with a system prompt.
        let nosys = r#"{"message":"This model doesn't support system messages. Try again without a system message or use a model that supports system messages."}"#;
        assert_eq!(
            adjustment(400, nosys, &converse, true),
            Some(Adjust::FoldSystem)
        );
        assert_eq!(adjustment(400, nosys, &converse, false), None);
        let mut folded = converse.clone();
        folded.fold_system = true;
        assert_eq!(adjustment(400, nosys, &folded, true), None);
    }

    #[test]
    fn a_folded_system_prompt_opens_the_first_user_turn() {
        let mut req = chat_req("mistral.mistral-7b-instruct-v0:2", BEDROCK_DEFAULT_BASE);
        let mut t = targets(&req).unwrap().remove(0);
        t.fold_system = true;
        let (_, _, body) = build_for(&req, &t, "k").unwrap();
        assert!(body.get("system").is_none());
        assert_eq!(
            body["messages"][0]["content"][0]["text"],
            "You write SQL.\n\nlist tables"
        );
        req.messages.clear();
        let (_, _, body) = build_for(&req, &t, "k").unwrap();
        assert_eq!(
            body["messages"],
            serde_json::json!([{ "role": "user", "content": [{ "text": "You write SQL." }] }])
        );
    }

    #[test]
    fn the_runtime_catalog_keeps_only_converse_chat_models() {
        let model = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
        assert!(bedrock_chat_model(&model(
            r#"{"modelId":"amazon.nova-micro-v1:0","inputModalities":["TEXT"],"outputModalities":["TEXT"],
                "converse":null,"inferenceAPIsSupported":{"converse":{"streaming":true,"sync":true}},
                "modelLifecycle":{"status":"ACTIVE"}}"#
        )));
        // Older summaries without the API block fall back to responseStreamingSupported.
        assert!(bedrock_chat_model(&model(
            r#"{"modelId":"x","inputModalities":["TEXT","IMAGE"],"outputModalities":["TEXT"],"responseStreamingSupported":true}"#
        )));
        for not_chat in [
            // A reranker: text in and out, but no Converse streaming.
            r#"{"modelId":"cohere.rerank-v3-5:0","inputModalities":["TEXT"],"outputModalities":["TEXT"],"responseStreamingSupported":false,
                "inferenceAPIsSupported":{"converse":{"streaming":false,"sync":false}}}"#,
            // Speech-to-speech.
            r#"{"modelId":"amazon.nova-2-5-sonic","inputModalities":["SPEECH","TEXT"],"outputModalities":["SPEECH","TEXT"],
                "inferenceAPIsSupported":{"converse":{"streaming":true,"sync":false}}}"#,
            r#"{"modelId":"amazon.nova-2-sonic-v1:0","inputModalities":["SPEECH"],"outputModalities":["SPEECH","TEXT"]}"#,
            // Video understanding that Converse refuses.
            r#"{"modelId":"twelvelabs.pegasus-1-5-v1:0","inputModalities":["TEXT","VIDEO"],"outputModalities":["TEXT"],"converse":null,
                "inferenceAPIsSupported":{"converse":{"streaming":true,"sync":false}}}"#,
            // On its way out: Bedrock refuses legacy models to accounts not using them.
            r#"{"modelId":"ai21.jamba-1-5-mini-v1:0","inputModalities":["TEXT"],"outputModalities":["TEXT"],
                "modelLifecycle":{"status":"LEGACY"},"inferenceAPIsSupported":{"converse":{"streaming":true,"sync":true}}}"#,
        ] {
            assert!(!bedrock_chat_model(&model(not_chat)), "{not_chat}");
        }
    }

    /// Live Bedrock, both planes, with a real API key:
    /// `TUSK_TEST_BEDROCK_KEY=… cargo test --lib bedrock_live -- --ignored --nocapture`
    /// (region: `TUSK_TEST_BEDROCK_REGION`, default us-east-1). Spends a few hundred tokens.
    #[tokio::test]
    #[ignore = "needs TUSK_TEST_BEDROCK_KEY and the network"]
    async fn bedrock_live() {
        let Ok(key) = std::env::var("TUSK_TEST_BEDROCK_KEY") else {
            eprintln!("TUSK_TEST_BEDROCK_KEY unset; skipping");
            return;
        };
        // What `run()` installs for the app (see lib.rs).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let region =
            std::env::var("TUSK_TEST_BEDROCK_REGION").unwrap_or_else(|_| "us-east-1".into());
        let runtime = format!("https://bedrock-runtime.{region}.amazonaws.com");
        let control = bedrock_control_base(&runtime).unwrap();
        let catalog = bedrock_catalog_with_key(&runtime, &control, &key)
            .await
            .unwrap();
        let on_mantle = catalog
            .iter()
            .filter(|m| m.starts_with(MANTLE_PREFIX))
            .count();
        eprintln!("catalog: {} models, {on_mantle} on Mantle", catalog.len());
        assert!(catalog.len() > on_mantle, "runtime models listed");
        assert!(on_mantle > 0, "Mantle models listed");

        let source = |_: &str, _: &str| Ok(key.clone());
        for (model, max_tokens) in [
            // Runtime Converse through a cross-region profile.
            ("us.anthropic.claude-haiku-4-5-20251001-v1:0", 64),
            // Over the model's 10,000 cap: clamped and resent.
            ("us.amazon.nova-micro-v1:0", 64_000),
            // Mantle: chat, Anthropic, and a model the first guess gets wrong (chat →
            // refused → the partner route).
            ("mantle/zai.glm-4.7-flash", 64),
            ("mantle/anthropic.claude-haiku-4-5", 64),
            ("mantle/google.gemma-4-e2b", 256),
            ("mantle/xai.grok-4.3", 600),
        ] {
            let mut req = chat_req(model, &runtime);
            req.system = Some("Reply with one short word.".into());
            req.messages[0].content = "Say hello.".into();
            req.max_tokens = Some(max_tokens);
            let out = complete_with_keys(&req, |_| {}, None, false, &source)
                .await
                .unwrap_or_else(|e| panic!("{model}: {}", e.message))
                .unwrap();
            eprintln!("{model}: {:?} (truncated: {})", out.text, out.truncated);
            assert!(!out.text.trim().is_empty() || out.truncated, "{model}");
        }
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
        Some(id) => cancels.register(id.clone()).map(|(rx, registered)| {
            guard = Some(registered);
            rx
        }),
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
        Ok(Some(c)) => on_event.send(AiEvent::Done {
            truncated: c.truncated,
        }),
        Ok(None) => on_event.send(AiEvent::Cancelled),
        Err(e) => on_event.send(AiEvent::Error { message: e.message }),
    };
    Ok(())
}
