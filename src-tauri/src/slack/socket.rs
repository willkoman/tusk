//! Slack Socket Mode client. Outbound-only: mints a ticketed wss URL via
//! `apps.connections.open` (Bearer xapp token), connects with tokio-tungstenite,
//! ACKS EVERY ENVELOPE IMMEDIATELY (3s deadline — work happens after the ack, in
//! the processor), dedupes retried events by `event_id` (delivery is at-least-once),
//! filters the bot's own messages, and reconnects with exponential backoff.

use crate::db::AppError;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub enum SlackEvent {
    /// A plain message (DM or channel the bot is in). `text` has mentions stripped.
    Message {
        channel: String,
        user: String,
        text: String,
        thread_ts: Option<String>,
        ts: String,
    },
    /// A button click (block_actions payload, parsed by the processor).
    Interaction { payload: Value },
    Connected,
    Disconnected(String),
}

/// Bounded memory of recently seen event ids (at-least-once delivery → retries).
struct Seen {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl Seen {
    fn new() -> Self {
        Self { order: VecDeque::new(), set: HashSet::new() }
    }
    /// Returns true when the id was already seen (a retry to drop).
    fn check(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return false;
        }
        if self.set.contains(id) {
            return true;
        }
        self.set.insert(id.to_string());
        self.order.push_back(id.to_string());
        if self.order.len() > 256 {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        false
    }
}

async fn open_connection(client: &reqwest::Client, app_token: &str) -> Result<String, AppError> {
    let resp = client
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(app_token)
        .header("content-type", "application/x-www-form-urlencoded")
        .send()
        .await
        .map_err(|e| AppError::new(format!("apps.connections.open: {e}")))?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::new(format!("apps.connections.open: {e}")))?;
    if v["ok"].as_bool() != Some(true) {
        let err = v["error"].as_str().unwrap_or("unknown error");
        return Err(AppError::new(format!(
            "apps.connections.open failed: {err} (check the app-level token has connections:write)"
        )));
    }
    v["url"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::new("apps.connections.open: no url in response"))
}

/// Strip `<@U…>` mention tokens from message text.
fn strip_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        match rest[start..].find('>') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = &rest[start + 2..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Parse one events_api payload into a SlackEvent (None = ignore: own-bot message,
/// subtype'd housekeeping event, or a shape we don't handle).
fn parse_event(payload: &Value, bot_user_id: &str) -> Option<SlackEvent> {
    let ev = &payload["event"];
    let etype = ev["type"].as_str()?;
    if !matches!(etype, "message" | "app_mention") {
        return None;
    }
    // Self-loop / housekeeping filters: our own posts carry bot_id (or our user id);
    // message_changed / message_deleted / channel_join / bot_message all carry a subtype.
    if ev["bot_id"].as_str().is_some() || ev["subtype"].as_str().is_some() {
        return None;
    }
    let user = ev["user"].as_str().unwrap_or_default().to_string();
    if user.is_empty() || user == bot_user_id {
        return None;
    }
    let text = strip_mentions(ev["text"].as_str().unwrap_or_default());
    if text.is_empty() {
        return None;
    }
    Some(SlackEvent::Message {
        channel: ev["channel"].as_str().unwrap_or_default().to_string(),
        user,
        text,
        thread_ts: ev["thread_ts"].as_str().map(str::to_string),
        ts: ev["ts"].as_str().unwrap_or_default().to_string(),
    })
}

/// Run the Socket Mode loop until cancelled. Emits Connected/Disconnected around
/// each session; events flow into `tx`. Never returns Err mid-loop — connection
/// failures surface as Disconnected events + backoff.
pub async fn run_socket_mode(
    app_token: String,
    bot_user_id: String,
    tx: mpsc::Sender<SlackEvent>,
    cancel: CancellationToken,
) {
    let client = reqwest::Client::new();
    let mut seen = Seen::new();
    let mut backoff_secs: u64 = 1;

    'outer: loop {
        if cancel.is_cancelled() {
            return;
        }
        let url = match open_connection(&client, &app_token).await {
            Ok(u) => u,
            Err(e) => {
                let _ = tx.send(SlackEvent::Disconnected(e.message)).await;
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                }
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
        };

        let ws = tokio::select! {
            _ = cancel.cancelled() => return,
            r = tokio_tungstenite::connect_async(&url) => r,
        };
        let (mut ws, _resp) = match ws {
            Ok(x) => x,
            Err(e) => {
                let _ = tx.send(SlackEvent::Disconnected(e.to_string())).await;
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                }
                backoff_secs = (backoff_secs * 2).min(60);
                continue;
            }
        };

        loop {
            let msg = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = ws.close(None).await;
                    return;
                }
                m = ws.next() => m,
            };
            let msg = match msg {
                Some(Ok(m)) => m,
                Some(Err(e)) => {
                    let _ = tx.send(SlackEvent::Disconnected(e.to_string())).await;
                    break;
                }
                None => {
                    let _ = tx.send(SlackEvent::Disconnected("socket closed".into())).await;
                    break;
                }
            };
            match msg {
                WsMessage::Ping(p) => {
                    let _ = ws.send(WsMessage::Pong(p)).await;
                }
                WsMessage::Close(_) => {
                    let _ = tx.send(SlackEvent::Disconnected("closed by Slack".into())).await;
                    break;
                }
                WsMessage::Text(t) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    // Ack FIRST (3s deadline) — processing happens downstream.
                    if let Some(envelope_id) = v["envelope_id"].as_str() {
                        let ack = json!({ "envelope_id": envelope_id }).to_string();
                        let _ = ws.send(WsMessage::text(ack)).await;
                    }
                    match v["type"].as_str().unwrap_or_default() {
                        "hello" => {
                            backoff_secs = 1; // healthy session → reset backoff
                            let _ = tx.send(SlackEvent::Connected).await;
                        }
                        // Slack wants a refreshed connection — reconnect immediately.
                        "disconnect" => break,
                        "events_api" => {
                            let event_id = v["payload"]["event_id"].as_str().unwrap_or_default();
                            if seen.check(event_id) {
                                continue; // at-least-once retry — already handled
                            }
                            if let Some(ev) = parse_event(&v["payload"], &bot_user_id) {
                                let _ = tx.send(ev).await;
                            }
                        }
                        "interactive" => {
                            let _ = tx.send(SlackEvent::Interaction { payload: v["payload"].clone() }).await;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
            if cancel.is_cancelled() {
                let _ = ws.close(None).await;
                return;
            }
        }
        // Fell out of the session loop: reconnect (with backoff unless it was a
        // clean refresh — backoff was reset by the last hello either way).
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs.min(5))) => {}
        }
        if cancel.is_cancelled() {
            break 'outer;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_mentions() {
        assert_eq!(strip_mentions("<@U123> top products"), "top products");
        assert_eq!(strip_mentions("hey <@U1> and <@U2>!"), "hey  and !");
    }

    #[test]
    fn seen_dedupes_and_bounds() {
        let mut s = Seen::new();
        assert!(!s.check("a"));
        assert!(s.check("a"));
        for i in 0..300 {
            s.check(&format!("x{i}"));
        }
        assert!(s.order.len() <= 256);
        assert!(!s.check("a")); // evicted → treated as new
    }

    #[test]
    fn parse_filters_bots_and_subtypes() {
        let mk = |extra: Value| {
            let mut base = json!({ "event": {
                "type": "message", "channel": "C1", "user": "U9",
                "text": "hi", "ts": "1.2"
            }});
            if let Some(obj) = extra.as_object() {
                for (k, val) in obj {
                    base["event"][k] = val.clone();
                }
            }
            base
        };
        assert!(parse_event(&mk(json!({})), "UBOT").is_some());
        assert!(parse_event(&mk(json!({"bot_id": "B1"})), "UBOT").is_none());
        assert!(parse_event(&mk(json!({"subtype": "message_changed"})), "UBOT").is_none());
        assert!(parse_event(&mk(json!({"user": "UBOT"})), "UBOT").is_none());
    }

    #[test]
    fn parse_carries_thread_ts() {
        let v = json!({ "event": {
            "type": "app_mention", "channel": "C1", "user": "U9",
            "text": "<@UBOT> count users", "ts": "9.9", "thread_ts": "9.1"
        }});
        match parse_event(&v, "UBOT") {
            Some(SlackEvent::Message { text, thread_ts, .. }) => {
                assert_eq!(text, "count users");
                assert_eq!(thread_ts.as_deref(), Some("9.1"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}
