// ABOUTME: Sensity AI API integration for deepfake video detection
// ABOUTME: REST API with webhook callbacks for async processing

use super::{DetectionResult, JobReference, ResultStatus, Verdict};
use fastly::http::{Method, StatusCode};
use fastly::{Error, Request};
use serde::{Deserialize, Serialize};

const BACKEND_NAME: &str = "sensity";
const API_URL: &str = "https://api.sensity.ai";

#[derive(Serialize)]
struct SubmitRequest {
    video_url: String,
    webhook_url: String,
}

#[derive(Deserialize)]
struct SubmitResponse {
    #[serde(alias = "request_id", alias = "analysis_id")]
    job_id: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct WebhookPayload {
    #[serde(alias = "request_id", alias = "analysis_id")]
    job_id: String,
    status: String,
    #[serde(default)]
    analysis: Option<Analysis>,
    #[serde(default)]
    error: Option<ErrorDetails>,
}

#[derive(Deserialize)]
struct Analysis {
    #[serde(default)]
    deepfake_probability: Option<f64>,
    #[serde(default)]
    detection_score: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
}

#[derive(Deserialize)]
struct ErrorDetails {
    message: String,
}

/// Submit a video URL for AI detection
pub fn submit_video(video_url: &str, webhook_url: &str) -> Result<JobReference, Error> {
    // Get API key from secret store
    let secret_store = fastly::secret_store::SecretStore::open("secrets")?;
    let secret = secret_store
        .get("SENSITY_API_KEY")
        .ok_or_else(|| Error::msg("SENSITY_API_KEY not found in secret store"))?;
    let api_key = String::from_utf8(secret.plaintext().to_vec())
        .map_err(|e| Error::msg(format!("Invalid UTF-8 in API key: {}", e)))?;

    // Prepare request body
    let request_body = SubmitRequest {
        video_url: video_url.to_string(),
        webhook_url: webhook_url.to_string(),
    };
    let body_json = serde_json::to_string(&request_body)
        .map_err(|e| Error::msg(format!("Failed to serialize request: {}", e)))?;

    // Construct endpoint URL
    let endpoint = format!("{}/v1/analyze", API_URL);

    // Create HTTP request with API key header
    let req = Request::new(Method::POST, &endpoint)
        .with_header("X-API-Key", api_key)
        .with_header("Content-Type", "application/json")
        .with_body(body_json);

    // Send request via backend
    let mut resp = req.send(BACKEND_NAME)?;

    // Check response status
    if resp.get_status() != StatusCode::OK
        && resp.get_status() != StatusCode::CREATED
        && resp.get_status() != StatusCode::ACCEPTED
    {
        let body = resp.take_body_str();
        return Err(Error::msg(format!(
            "Sensity API error: {} - {}",
            resp.get_status(),
            body
        )));
    }

    // Parse response
    let response_body = resp.take_body_str();
    let submit_response: SubmitResponse = serde_json::from_str(&response_body)
        .map_err(|e| Error::msg(format!("Failed to parse response: {}", e)))?;

    Ok(JobReference {
        provider: "sensity".to_string(),
        job_id: submit_response.job_id,
    })
}

/// Parse webhook payload from Sensity
pub fn parse_webhook(payload: &str) -> Result<DetectionResult, Error> {
    let webhook: WebhookPayload = serde_json::from_str(payload)
        .map_err(|e| Error::msg(format!("Failed to parse webhook payload: {}", e)))?;

    // Determine status
    let status = match webhook.status.to_lowercase().as_str() {
        "pending" | "queued" | "submitted" => ResultStatus::Pending,
        "processing" | "in_progress" | "analyzing" => ResultStatus::Processing,
        "complete" | "completed" | "success" | "done" => ResultStatus::Complete,
        "error" | "failed" => ResultStatus::Error,
        _ => ResultStatus::Processing,
    };

    // Extract and normalize score from analysis
    // Sensity may provide deepfake_probability, detection_score, or confidence
    // Priority: deepfake_probability > detection_score > confidence
    let score = webhook.analysis.and_then(|analysis| {
        analysis
            .deepfake_probability
            .or(analysis.detection_score)
            .or(analysis.confidence)
    });

    // Calculate verdict if we have a score
    let verdict = score.map(|s| Verdict::from_score(s));

    // Extract error message if present
    let error = webhook.error.map(|e| e.message);

    Ok(DetectionResult {
        provider: "sensity".to_string(),
        status,
        score,
        verdict,
        raw: serde_json::from_str(payload).ok(),
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_webhook_complete() {
        let payload = r#"{
            "job_id": "sensity-123",
            "status": "complete",
            "analysis": {
                "deepfake_probability": 0.78,
                "confidence": 0.95
            }
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.provider, "sensity");
        assert_eq!(result.status, ResultStatus::Complete);
        assert_eq!(result.score, Some(0.78));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_webhook_with_aliases() {
        // Test that job_id aliases work
        let payload = r#"{
            "request_id": "sensity-456",
            "status": "processing"
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.status, ResultStatus::Processing);
    }

    #[test]
    fn test_parse_webhook_error() {
        let payload = r#"{
            "job_id": "sensity-789",
            "status": "error",
            "error": {
                "message": "Video file corrupted"
            }
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.status, ResultStatus::Error);
        assert_eq!(result.error, Some("Video file corrupted".to_string()));
    }

    #[test]
    fn test_score_priority() {
        // Test that deepfake_probability takes precedence
        let payload = r#"{
            "job_id": "sensity-999",
            "status": "complete",
            "analysis": {
                "deepfake_probability": 0.8,
                "detection_score": 0.5,
                "confidence": 0.3
            }
        }"#;

        let result = parse_webhook(payload).unwrap();
        assert_eq!(result.score, Some(0.8));
    }

    #[test]
    fn test_verdict_thresholds() {
        let authentic =
            r#"{"job_id":"1","status":"complete","analysis":{"deepfake_probability":0.15}}"#;
        let uncertain =
            r#"{"job_id":"2","status":"complete","analysis":{"deepfake_probability":0.4}}"#;
        let likely_ai =
            r#"{"job_id":"3","status":"complete","analysis":{"deepfake_probability":0.85}}"#;

        let result1 = parse_webhook(authentic).unwrap();
        assert!(matches!(result1.verdict, Some(Verdict::Authentic)));

        let result2 = parse_webhook(uncertain).unwrap();
        assert!(matches!(result2.verdict, Some(Verdict::Uncertain)));

        let result3 = parse_webhook(likely_ai).unwrap();
        assert!(matches!(result3.verdict, Some(Verdict::LikelyAi)));
    }
}
