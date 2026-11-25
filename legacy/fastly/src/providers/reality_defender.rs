// ABOUTME: Reality Defender API integration for AI video detection
// ABOUTME: Async webhook pattern with job submission and webhook result parsing

use super::{DetectionResult, JobReference, ResultStatus, Verdict};
use fastly::http::{Method, StatusCode};
use fastly::{Error, Request};
use serde::{Deserialize, Serialize};

const BACKEND_NAME: &str = "reality_defender";
const API_URL: &str = "https://api.prd.realitydefender.xyz";

#[derive(Serialize)]
struct SubmitRequest {
    url: String,
    webhook_url: String,
}

#[derive(Deserialize)]
struct SubmitResponse {
    job_id: String,
}

#[derive(Deserialize)]
struct WebhookPayload {
    job_id: String,
    status: String,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    ai_probability: Option<f64>,
    #[serde(default)]
    error: Option<String>,
}

/// Submit a video URL for AI detection
pub fn submit_video(video_url: &str, webhook_url: &str) -> Result<JobReference, Error> {
    // Get API key from secret store
    let secret_store = fastly::secret_store::SecretStore::open("secrets")?;
    let secret = secret_store
        .get("REALITY_DEFENDER_API_KEY")
        .ok_or_else(|| Error::msg("REALITY_DEFENDER_API_KEY not found in secret store"))?;
    let api_key = String::from_utf8(secret.plaintext().to_vec())
        .map_err(|e| Error::msg(format!("Invalid UTF-8 in API key: {}", e)))?;

    // Prepare request body
    let request_body = SubmitRequest {
        url: video_url.to_string(),
        webhook_url: webhook_url.to_string(),
    };
    let body_json = serde_json::to_string(&request_body)
        .map_err(|e| Error::msg(format!("Failed to serialize request: {}", e)))?;

    // Create HTTP request
    let req = Request::new(Method::POST, API_URL)
        .with_header("X-API-KEY", api_key)
        .with_header("Content-Type", "application/json")
        .with_body(body_json);

    // Send request via backend
    let mut resp = req.send(BACKEND_NAME)?;

    // Check response status
    if resp.get_status() != StatusCode::OK && resp.get_status() != StatusCode::CREATED {
        let body = resp.take_body_str();
        return Err(Error::msg(format!(
            "Reality Defender API error: {} - {}",
            resp.get_status(),
            body
        )));
    }

    // Parse response
    let response_body = resp.take_body_str();
    let submit_response: SubmitResponse = serde_json::from_str(&response_body)
        .map_err(|e| Error::msg(format!("Failed to parse response: {}", e)))?;

    Ok(JobReference {
        provider: "reality_defender".to_string(),
        job_id: submit_response.job_id,
    })
}

/// Parse webhook payload from Reality Defender
pub fn parse_webhook(payload: &str) -> Result<DetectionResult, Error> {
    let webhook: WebhookPayload = serde_json::from_str(payload)
        .map_err(|e| Error::msg(format!("Failed to parse webhook payload: {}", e)))?;

    // Determine status
    let status = match webhook.status.to_lowercase().as_str() {
        "pending" => ResultStatus::Pending,
        "processing" | "in_progress" => ResultStatus::Processing,
        "complete" | "completed" | "success" => ResultStatus::Complete,
        "error" | "failed" => ResultStatus::Error,
        _ => ResultStatus::Processing,
    };

    // Extract and normalize score
    // Reality Defender may provide score or ai_probability
    let score = webhook.score.or(webhook.ai_probability);

    // Calculate verdict if we have a score
    let verdict = score.map(|s| Verdict::from_score(s));

    Ok(DetectionResult {
        provider: "reality_defender".to_string(),
        status,
        score,
        verdict,
        raw: serde_json::from_str(payload).ok(),
        error: webhook.error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_webhook_complete() {
        let payload = r#"{
            "job_id": "test-123",
            "status": "complete",
            "ai_probability": 0.85
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.provider, "reality_defender");
        assert_eq!(result.status, ResultStatus::Complete);
        assert_eq!(result.score, Some(0.85));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_webhook_error() {
        let payload = r#"{
            "job_id": "test-456",
            "status": "error",
            "error": "Video not accessible"
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error, Some("Video not accessible".to_string()));
    }

    #[test]
    fn test_verdict_thresholds() {
        let authentic = r#"{"job_id":"1","status":"complete","score":0.2}"#;
        let uncertain = r#"{"job_id":"2","status":"complete","score":0.5}"#;
        let likely_ai = r#"{"job_id":"3","status":"complete","score":0.9}"#;

        let result1 = parse_webhook(authentic).unwrap();
        assert!(matches!(result1.verdict, Some(Verdict::Authentic)));

        let result2 = parse_webhook(uncertain).unwrap();
        assert!(matches!(result2.verdict, Some(Verdict::Uncertain)));

        let result3 = parse_webhook(likely_ai).unwrap();
        assert!(matches!(result3.verdict, Some(Verdict::LikelyAi)));
    }
}
