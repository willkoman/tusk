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

const SEEN_CAP: usize = 2_048;

#[derive(Debug)]
pub enum SlackEvent {
    /// A plain message (DM or channel the bot is in). `text` has mentions stripped.
    Message {
        workspace: String,
        channel: String,
        user: String,
        text: String,
        thread_ts: Option<String>,
        ts: String,
    },
    /// A button click (block_actions payload, parsed by the processor).
    Interaction {
        payload: Value,
    },
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
        Self {
            order: VecDeque::new(),
            set: HashSet::new(),
        }
    }
    /// Returns true when the id was already seen (a retry to drop).
    fn contains(&self, id: &str) -> bool {
        !id.is_empty() && self.set.contains(id)
    }
    fn remember(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        self.set.insert(id.to_string());
        self.order.push_back(id.to_string());
        if self.order.len() > SEEN_CAP {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
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
    let v = super::api::read_json_response(resp, "apps.connections.open", 256 * 1024).await?;
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
    if text.is_empty() || text.len() > 64 * 1024 {
        return None;
    }
    let workspace = payload["team_id"]
        .as_str()
        .or(ev["team"].as_str())
        .unwrap_or_default();
    let channel = ev["channel"].as_str().unwrap_or_default();
    let ts = ev["ts"].as_str().unwrap_or_default();
    if workspace.is_empty() || channel.is_empty() || ts.is_empty() {
        return None;
    }
    Some(SlackEvent::Message {
        workspace: workspace.to_string(),
        channel: channel.to_string(),
        user,
        text,
        thread_ts: ev["thread_ts"].as_str().map(str::to_string),
        ts: ts.to_string(),
    })
}

fn interaction_key(v: &Value) -> Option<String> {
    let payload = &v["payload"];
    let trigger = payload["trigger_id"].as_str().unwrap_or_default();
    if !trigger.is_empty() {
        return Some(format!("interaction:{trigger}"));
    }
    let envelope = v["envelope_id"].as_str().unwrap_or_default();
    (!envelope.is_empty()).then(|| format!("interaction:{envelope}"))
}

fn enqueue_once(tx: &mpsc::Sender<SlackEvent>, seen: &mut Seen, key: &str, event: SlackEvent) {
    if seen.contains(key) {
        return;
    }
    // Never wait behind long sequential AI/query work after ACKing. A bounded full
    // queue drops load rather than stalling the socket and missing later ACKs.
    if tx.try_send(event).is_ok() {
        seen.remember(key);
    }
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
    let client = super::api::http_client();
    let mut seen = Seen::new();
    let mut backoff_secs: u64 = 1;

    'outer: loop {
        if cancel.is_cancelled() {
            return;
        }
        let url = match open_connection(&client, &app_token).await {
            Ok(u) => u,
            Err(e) => {
                let _ = tx.try_send(SlackEvent::Disconnected(e.message));
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
            r = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                tokio_tungstenite::connect_async(&url),
            ) => match r {
                Ok(result) => result,
                Err(_) => Err(tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Slack WebSocket connect timed out after 20 seconds",
                ))),
            },
        };
        let (mut ws, _resp) = match ws {
            Ok(x) => x,
            Err(e) => {
                let _ = tx.try_send(SlackEvent::Disconnected(e.to_string()));
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
                    let _ = tx.try_send(SlackEvent::Disconnected(e.to_string()));
                    break;
                }
                None => {
                    let _ = tx.try_send(SlackEvent::Disconnected("socket closed".into()));
                    break;
                }
            };
            match msg {
                WsMessage::Ping(p) => {
                    if !matches!(
                        tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            ws.send(WsMessage::Pong(p)),
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                }
                WsMessage::Close(_) => {
                    let _ = tx.try_send(SlackEvent::Disconnected("closed by Slack".into()));
                    break;
                }
                WsMessage::Text(t) => {
                    if t.len() > 2 * 1024 * 1024 {
                        break;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else {
                        continue;
                    };
                    // Ack FIRST (3s deadline) — processing happens downstream.
                    if let Some(envelope_id) = v["envelope_id"].as_str() {
                        let ack = json!({ "envelope_id": envelope_id }).to_string();
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            ws.send(WsMessage::text(ack)),
                        )
                        .await
                        {
                            Ok(Ok(())) => {}
                            _ => break,
                        }
                    }
                    match v["type"].as_str().unwrap_or_default() {
                        "hello" => {
                            backoff_secs = 1; // healthy session → reset backoff
                            let _ = tx.try_send(SlackEvent::Connected);
                        }
                        // Slack wants a refreshed connection — reconnect immediately.
                        "disconnect" => break,
                        "events_api" => {
                            let event_id = v["payload"]["event_id"].as_str().unwrap_or_default();
                            if let Some(ev) = parse_event(&v["payload"], &bot_user_id) {
                                let envelope = v["envelope_id"].as_str().unwrap_or_default();
                                let key = if event_id.is_empty() {
                                    format!("event-envelope:{envelope}")
                                } else {
                                    format!("event:{event_id}")
                                };
                                if !key.ends_with(':') {
                                    enqueue_once(&tx, &mut seen, &key, ev);
                                }
                            }
                        }
                        "interactive" => {
                            if let Some(key) = interaction_key(&v) {
                                enqueue_once(
                                    &tx,
                                    &mut seen,
                                    &key,
                                    SlackEvent::Interaction {
                                        payload: v["payload"].clone(),
                                    },
                                );
                            }
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
        assert!(!s.contains("a"));
        s.remember("a");
        assert!(s.contains("a"));
        for i in 0..(SEEN_CAP + 50) {
            s.remember(&format!("x{i}"));
        }
        assert!(s.order.len() <= SEEN_CAP);
        assert!(!s.contains("a")); // evicted → treated as new
    }

    #[test]
    fn parse_filters_bots_and_subtypes() {
        let mk = |extra: Value| {
            let mut base = json!({ "team_id": "T1", "event": {
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
        let v = json!({ "team_id": "T1", "event": {
            "type": "app_mention", "channel": "C1", "user": "U9",
            "text": "<@UBOT> count users", "ts": "9.9", "thread_ts": "9.1"
        }});
        match parse_event(&v, "UBOT") {
            Some(SlackEvent::Message {
                text, thread_ts, ..
            }) => {
                assert_eq!(text, "count users");
                assert_eq!(thread_ts.as_deref(), Some("9.1"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn interactions_have_retry_stable_dedupe_keys() {
        let with_trigger = json!({ "envelope_id": "e1", "payload": { "trigger_id": "t1" } });
        assert_eq!(
            interaction_key(&with_trigger).as_deref(),
            Some("interaction:t1")
        );
        let envelope_only = json!({ "envelope_id": "e2", "payload": {} });
        assert_eq!(
            interaction_key(&envelope_only).as_deref(),
            Some("interaction:e2")
        );
        assert!(interaction_key(&json!({ "payload": {} })).is_none());
    }
}
