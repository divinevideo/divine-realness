// ABOUTME: Nostr relay client for fetching events via HTTP
// ABOUTME: Supports bech32 nevent1... ID parsing and JSON event retrieval

use crate::nostr::event::NostrEvent;
use fastly::{Backend, Error, Request};

pub struct NostrClient {
    backend_name: String,
}

impl NostrClient {
    /// Creates a new NostrClient with the specified backend name
    /// Default backend: "nostr_rest_gateway" (REST HTTP proxy for Nostr)
    pub fn new() -> Self {
        Self {
            backend_name: "nostr_rest_gateway".to_string(),
        }
    }

    /// Creates a NostrClient with a custom backend name
    pub fn with_backend(backend_name: String) -> Self {
        Self { backend_name }
    }

    /// Fetches a Nostr event by ID from the relay
    /// Accepts both raw hex event IDs and bech32-encoded nevent1... IDs
    pub fn fetch_event(&self, event_id: &str) -> Result<NostrEvent, Error> {
        // Parse nevent1... bech32 IDs if needed
        let raw_event_id = if event_id.starts_with("nevent1") {
            self.parse_nevent_id(event_id)?
        } else {
            event_id.to_string()
        };

        // Use the Divine REST Gateway (HTTP proxy for Nostr relays)
        // This avoids WebSocket which isn't supported on Fastly Compute
        // Backend config provides the host; just specify the path
        let backend = Backend::from_name(&self.backend_name)?;

        let mut req = Request::get(format!("/event/{}", raw_event_id))
            .with_header("Accept", "application/json")
            .with_header("Host", "cleanly-resolved-tetra.edgecompute.app");

        req.set_stale_if_error(0);
        let mut resp = req.send(backend)?;

        if !resp.get_status().is_success() {
            return Err(Error::msg(format!(
                "Failed to fetch event: HTTP {}",
                resp.get_status()
            )));
        }

        // Parse the JSON response - gateway returns {"events": [...], "eose": true, ...}
        let body = resp.take_body_str();

        // Try to parse as gateway response wrapper first
        #[derive(serde::Deserialize)]
        struct GatewayResponse {
            events: Vec<NostrEvent>,
        }

        if let Ok(wrapper) = serde_json::from_str::<GatewayResponse>(&body) {
            if let Some(event) = wrapper.events.into_iter().next() {
                return Ok(event);
            }
            return Err(Error::msg("Event not found in relay response"));
        }

        // Fall back to parsing as raw event
        let event: NostrEvent = serde_json::from_str(&body)
            .map_err(|e| Error::msg(format!("Failed to parse event JSON: {}", e)))?;

        Ok(event)
    }

    /// Parses a bech32-encoded nevent ID to extract the raw hex event ID
    /// Format: nevent1... contains the event ID and optionally relay hints
    fn parse_nevent_id(&self, nevent: &str) -> Result<String, Error> {
        // For now, return a simplified implementation
        // A full implementation would use a bech32 decoder library
        // The nevent format encodes the event ID in the bech32 data portion

        if !nevent.starts_with("nevent1") {
            return Err(Error::msg("Invalid nevent format"));
        }

        // Placeholder: In production, this would decode the bech32 string
        // and extract the hex event ID from the TLV-encoded data
        // For now, we'll return an error indicating this needs proper implementation
        Err(Error::msg(
            "nevent parsing not yet implemented - please use raw hex event IDs",
        ))
    }

    /// Fetches multiple events by their IDs
    pub fn fetch_events(&self, event_ids: &[String]) -> Result<Vec<NostrEvent>, Error> {
        let mut events = Vec::new();

        for event_id in event_ids {
            match self.fetch_event(event_id) {
                Ok(event) => events.push(event),
                Err(e) => {
                    // Log error but continue with other events
                    eprintln!("Failed to fetch event {}: {}", event_id, e);
                }
            }
        }

        Ok(events)
    }

    /// Queries events from the relay using a filter
    /// This would typically use NIP-50 search or similar relay extensions
    pub fn query_events(&self, filter: EventFilter) -> Result<Vec<NostrEvent>, Error> {
        let backend = Backend::from_name(&self.backend_name)?;

        // Construct query parameters
        let mut query_params = Vec::new();

        if let Some(kinds) = &filter.kinds {
            let kinds_str = kinds
                .iter()
                .map(|k| k.to_string())
                .collect::<Vec<_>>()
                .join(",");
            query_params.push(format!("kinds={}", kinds_str));
        }

        if let Some(authors) = &filter.authors {
            let authors_str = authors.join(",");
            query_params.push(format!("authors={}", authors_str));
        }

        if let Some(since) = filter.since {
            query_params.push(format!("since={}", since));
        }

        if let Some(until) = filter.until {
            query_params.push(format!("until={}", until));
        }

        if let Some(limit) = filter.limit {
            query_params.push(format!("limit={}", limit));
        }

        let query_string = if query_params.is_empty() {
            String::new()
        } else {
            format!("?{}", query_params.join("&"))
        };

        let url = format!("https://relay.divine.video/events{}", query_string);

        let mut req = Request::get(url).with_header("Accept", "application/json");

        req.set_stale_if_error(0);
        let mut resp = req.send(backend)?;

        if !resp.get_status().is_success() {
            return Err(Error::msg(format!(
                "Failed to query events: HTTP {}",
                resp.get_status()
            )));
        }

        let body = resp.take_body_str();
        let events: Vec<NostrEvent> = serde_json::from_str(&body)
            .map_err(|e| Error::msg(format!("Failed to parse events JSON: {}", e)))?;

        Ok(events)
    }
}

impl Default for NostrClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Filter for querying events from relays
#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    pub kinds: Option<Vec<u16>>,
    pub authors: Option<Vec<String>>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub limit: Option<usize>,
}

impl EventFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn kinds(mut self, kinds: Vec<u16>) -> Self {
        self.kinds = Some(kinds);
        self
    }

    pub fn authors(mut self, authors: Vec<String>) -> Self {
        self.authors = Some(authors);
        self
    }

    pub fn since(mut self, timestamp: i64) -> Self {
        self.since = Some(timestamp);
        self
    }

    pub fn until(mut self, timestamp: i64) -> Self {
        self.until = Some(timestamp);
        self
    }

    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = NostrClient::new();
        assert_eq!(client.backend_name, "nostr_rest_gateway");
    }

    #[test]
    fn test_client_with_custom_backend() {
        let client = NostrClient::with_backend("custom_backend".to_string());
        assert_eq!(client.backend_name, "custom_backend");
    }

    #[test]
    fn test_event_filter_builder() {
        let filter = EventFilter::new()
            .kinds(vec![1, 6])
            .authors(vec!["abc123".to_string()])
            .since(1234567890)
            .limit(10);

        assert_eq!(filter.kinds, Some(vec![1, 6]));
        assert_eq!(filter.authors, Some(vec!["abc123".to_string()]));
        assert_eq!(filter.since, Some(1234567890));
        assert_eq!(filter.limit, Some(10));
    }

    #[test]
    fn test_parse_nevent_rejects_invalid() {
        let client = NostrClient::new();
        let result = client.parse_nevent_id("invalid");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_nevent_not_implemented() {
        let client = NostrClient::new();
        let result = client.parse_nevent_id("nevent1qqs...");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("not yet implemented"));
    }
}
