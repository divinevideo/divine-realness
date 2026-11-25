// ABOUTME: HiveAI API integration for AI video detection
// ABOUTME: Supports both sync and async modes with webhook callback option

use super::{DetectionResult, JobReference, ResultStatus, Verdict};
use fastly::http::{Method, StatusCode};
use fastly::{Error, Request};
use serde::{Deserialize, Serialize};

const BACKEND_NAME: &str = "hive_ai";
const API_URL: &str = "https://api.thehive.ai/api/v2/task/sync";

#[derive(Serialize)]
struct SubmitRequest {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_url: Option<String>,
}

#[derive(Deserialize)]
struct SubmitResponse {
    task_id: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct WebhookPayload {
    task_id: String,
    status: String,
    #[serde(default)]
    result: Option<WebhookResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct WebhookResult {
    #[serde(default)]
    deepfake_score: Option<f64>,
    #[serde(default)]
    ai_generated_score: Option<f64>,
    #[serde(default)]
    synthetic_score: Option<f64>,
}

/// Submit a video URL for AI detection
/// If webhook_url is None, uses sync mode; otherwise uses async with webhook
pub fn submit_video(video_url: &str, webhook_url: Option<&str>) -> Result<JobReference, Error> {
    // Get API key from secret store
    let secret_store = fastly::secret_store::SecretStore::open("secrets")?;
    let secret = secret_store
        .get("HIVE_API_KEY")
        .ok_or_else(|| Error::msg("HIVE_API_KEY not found in secret store"))?;
    let api_key = String::from_utf8(secret.plaintext().to_vec())
        .map_err(|e| Error::msg(format!("Invalid UTF-8 in API key: {}", e)))?;

    // Prepare request body
    let request_body = SubmitRequest {
        url: video_url.to_string(),
        callback_url: webhook_url.map(|s| s.to_string()),
    };
    let body_json = serde_json::to_string(&request_body)
        .map_err(|e| Error::msg(format!("Failed to serialize request: {}", e)))?;

    // Create HTTP request with Bearer token auth
    let req = Request::new(Method::POST, API_URL)
        .with_header("Authorization", format!("Bearer {}", api_key))
        .with_header("Content-Type", "application/json")
        .with_body(body_json);

    // Send request via backend
    let mut resp = req.send(BACKEND_NAME)?;

    // Check response status
    if resp.get_status() != StatusCode::OK && resp.get_status() != StatusCode::CREATED {
        let body = resp.take_body_str();
        return Err(Error::msg(format!(
            "HiveAI API error: {} - {}",
            resp.get_status(),
            body
        )));
    }

    // Parse response
    let response_body = resp.take_body_str();
    let submit_response: SubmitResponse = serde_json::from_str(&response_body)
        .map_err(|e| Error::msg(format!("Failed to parse response: {}", e)))?;

    Ok(JobReference {
        provider: "hive".to_string(),
        job_id: submit_response.task_id,
    })
}

/// Parse webhook payload from HiveAI
pub fn parse_webhook(payload: &str) -> Result<DetectionResult, Error> {
    let webhook: WebhookPayload = serde_json::from_str(payload)
        .map_err(|e| Error::msg(format!("Failed to parse webhook payload: {}", e)))?;

    // Determine status
    let status = match webhook.status.to_lowercase().as_str() {
        "pending" | "queued" => ResultStatus::Pending,
        "processing" | "in_progress" => ResultStatus::Processing,
        "complete" | "completed" | "success" => ResultStatus::Complete,
        "error" | "failed" => ResultStatus::Error,
        _ => ResultStatus::Processing,
    };

    // Extract and normalize score from result
    // HiveAI may provide deepfake_score, ai_generated_score, or synthetic_score
    // We take the highest score as the most indicative
    let score = webhook.result.and_then(|result| {
        let scores = vec![
            result.deepfake_score,
            result.ai_generated_score,
            result.synthetic_score,
        ];
        scores
            .into_iter()
            .flatten()
            .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
    });

    // Calculate verdict if we have a score
    let verdict = score.map(|s| Verdict::from_score(s));

    Ok(DetectionResult {
        provider: "hive".to_string(),
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
            "task_id": "hive-123",
            "status": "complete",
            "result": {
                "deepfake_score": 0.92,
                "ai_generated_score": 0.88
            }
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.provider, "hive");
        assert_eq!(result.status, ResultStatus::Complete);
        // Should pick the higher score (0.92)
        assert_eq!(result.score, Some(0.92));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_webhook_error() {
        let payload = r#"{
            "task_id": "hive-456",
            "status": "error",
            "error": "Invalid video format"
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error, Some("Invalid video format".to_string()));
    }

    #[test]
    fn test_score_selection() {
        // Test that we pick the maximum score
        let payload = r#"{
            "task_id": "hive-789",
            "status": "complete",
            "result": {
                "deepfake_score": 0.3,
                "ai_generated_score": 0.6,
                "synthetic_score": 0.45
            }
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.score, Some(0.6));
        assert!(matches!(result.verdict, Some(Verdict::Uncertain)));
    }

    #[test]
    fn test_verdict_thresholds() {
        let authentic = r#"{"task_id":"1","status":"complete","result":{"deepfake_score":0.1}}"#;
        let uncertain = r#"{"task_id":"2","status":"complete","result":{"deepfake_score":0.5}}"#;
        let likely_ai = r#"{"task_id":"3","status":"complete","result":{"deepfake_score":0.95}}"#;

        let result1 = parse_webhook(authentic).unwrap();
        assert!(matches!(result1.verdict, Some(Verdict::Authentic)));

        let result2 = parse_webhook(uncertain).unwrap();
        assert!(matches!(result2.verdict, Some(Verdict::Uncertain)));

        let result3 = parse_webhook(likely_ai).unwrap();
        assert!(matches!(result3.verdict, Some(Verdict::LikelyAi)));
    }
}
