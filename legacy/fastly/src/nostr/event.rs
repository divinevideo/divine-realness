// ABOUTME: Nostr event data structures and parsing logic
// ABOUTME: Handles NIP-94 imeta tags to extract video URLs, hashes, and MIME types

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub url: String,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
}

/// Parses NIP-94 imeta tags to extract video information
/// Tags format: ["imeta", "url https://...", "x abc123...", "m video/mp4"]
/// Returns a vector of MediaInfo structs containing URL, SHA256 hash, and MIME type
pub fn parse_imeta_tags(event: &NostrEvent) -> Vec<MediaInfo> {
    let mut media_infos = Vec::new();

    for tag in &event.tags {
        if tag.is_empty() {
            continue;
        }

        // Check if this is an imeta tag
        if tag[0] == "imeta" {
            let mut url: Option<String> = None;
            let mut sha256: Option<String> = None;
            let mut mime_type: Option<String> = None;

            // Parse the key-value pairs in the imeta tag
            for i in 1..tag.len() {
                let part = &tag[i];

                // Split on first space to get key and value
                if let Some(space_pos) = part.find(' ') {
                    let (key, value) = part.split_at(space_pos);
                    let value = value.trim();

                    match key {
                        "url" => url = Some(value.to_string()),
                        "x" => sha256 = Some(value.to_string()),
                        "m" => mime_type = Some(value.to_string()),
                        _ => {} // Ignore unknown keys
                    }
                }
            }

            // Only add if we have at least a URL
            if let Some(url_value) = url {
                media_infos.push(MediaInfo {
                    url: url_value,
                    sha256,
                    mime_type,
                });
            }
        }
    }

    media_infos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_imeta_tags_single_video() {
        let event = NostrEvent {
            id: "test123".to_string(),
            pubkey: "pubkey123".to_string(),
            created_at: 1234567890,
            kind: 1,
            tags: vec![vec![
                "imeta".to_string(),
                "url https://example.com/video.mp4".to_string(),
                "x abc123def456".to_string(),
                "m video/mp4".to_string(),
            ]],
            content: "Test content".to_string(),
            sig: "sig123".to_string(),
        };

        let media = parse_imeta_tags(&event);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].url, "https://example.com/video.mp4");
        assert_eq!(media[0].sha256, Some("abc123def456".to_string()));
        assert_eq!(media[0].mime_type, Some("video/mp4".to_string()));
    }

    #[test]
    fn test_parse_imeta_tags_multiple_videos() {
        let event = NostrEvent {
            id: "test123".to_string(),
            pubkey: "pubkey123".to_string(),
            created_at: 1234567890,
            kind: 1,
            tags: vec![
                vec![
                    "imeta".to_string(),
                    "url https://example.com/video1.mp4".to_string(),
                    "x hash1".to_string(),
                    "m video/mp4".to_string(),
                ],
                vec![
                    "imeta".to_string(),
                    "url https://example.com/video2.webm".to_string(),
                    "x hash2".to_string(),
                    "m video/webm".to_string(),
                ],
            ],
            content: "Test content".to_string(),
            sig: "sig123".to_string(),
        };

        let media = parse_imeta_tags(&event);
        assert_eq!(media.len(), 2);
        assert_eq!(media[0].url, "https://example.com/video1.mp4");
        assert_eq!(media[1].url, "https://example.com/video2.webm");
    }

    #[test]
    fn test_parse_imeta_tags_partial_info() {
        let event = NostrEvent {
            id: "test123".to_string(),
            pubkey: "pubkey123".to_string(),
            created_at: 1234567890,
            kind: 1,
            tags: vec![vec![
                "imeta".to_string(),
                "url https://example.com/video.mp4".to_string(),
            ]],
            content: "Test content".to_string(),
            sig: "sig123".to_string(),
        };

        let media = parse_imeta_tags(&event);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].url, "https://example.com/video.mp4");
        assert_eq!(media[0].sha256, None);
        assert_eq!(media[0].mime_type, None);
    }

    #[test]
    fn test_parse_imeta_tags_no_imeta() {
        let event = NostrEvent {
            id: "test123".to_string(),
            pubkey: "pubkey123".to_string(),
            created_at: 1234567890,
            kind: 1,
            tags: vec![
                vec!["p".to_string(), "somepubkey".to_string()],
                vec!["e".to_string(), "someeventid".to_string()],
            ],
            content: "Test content".to_string(),
            sig: "sig123".to_string(),
        };

        let media = parse_imeta_tags(&event);
        assert_eq!(media.len(), 0);
    }
}
