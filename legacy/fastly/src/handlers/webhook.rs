// ABOUTME: POST /webhook/:provider handler for receiving detection provider callbacks
// ABOUTME: Updates job status in KV store when providers complete analysis

use fastly::http::{Method, StatusCode};
use fastly::kv_store::KVStore;
use fastly::{Error, Request, Response};
use serde_json::{json, Value};

use crate::handlers::analyze::Job;
use crate::providers::{DetectionResult, ResultStatus, Verdict};

/// Main handler for POST /webhook/:provider
pub fn handle(mut req: Request, provider: &str) -> Result<Response, Error> {
    // Verify method
    if req.get_method() != Method::POST {
        return Ok(Response::from_status(StatusCode::METHOD_NOT_ALLOWED)
            .with_body_text_plain("Method not allowed"));
    }

    // Parse request body
    let body = req.take_body_str();
    let payload: Value = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            return Ok(
                Response::from_status(StatusCode::BAD_REQUEST).with_body_json(&json!({
                    "error": "Invalid JSON",
                    "details": e.to_string()
                }))?,
            );
        }
    };

    // Parse provider-specific payload
    let result = match provider {
        "reality_defender" => parse_reality_defender_webhook(&payload),
        "hive" => parse_hive_webhook(&payload),
        "sensity" => parse_sensity_webhook(&payload),
        _ => {
            return Ok(
                Response::from_status(StatusCode::BAD_REQUEST).with_body_json(&json!({
                    "error": "Unknown provider"
                }))?,
            );
        }
    };

    let (event_id, detection_result) = match result {
        Ok(r) => r,
        Err(e) => {
            return Ok(
                Response::from_status(StatusCode::BAD_REQUEST).with_body_json(&json!({
                    "error": "Failed to parse webhook payload",
                    "details": e
                }))?,
            );
        }
    };

    // Open KV store
    let store =
        match KVStore::open("jobs")? {
            Some(s) => s,
            None => {
                return Ok(Response::from_status(StatusCode::INTERNAL_SERVER_ERROR)
                    .with_body_json(&json!({
                        "error": "KV store not available"
                    }))?);
            }
        };

    // Look up job
    let job_key = format!("job:{}", event_id);
    let mut job_lookup = store.lookup(&job_key)?;
    let mut job: Job = match job_lookup.try_take_body() {
        Some(body) => {
            let job_str = body.into_string();
            serde_json::from_str(&job_str)?
        }
        None => {
            return Ok(
                Response::from_status(StatusCode::NOT_FOUND).with_body_json(&json!({
                    "error": "Job not found"
                }))?,
            );
        }
    };

    // Update job with detection result
    job.results.insert(provider.to_string(), detection_result);

    // Check if all providers are complete
    let all_complete = job
        .results
        .values()
        .all(|r| matches!(r.status, ResultStatus::Complete | ResultStatus::Error));

    if all_complete {
        job.status = "complete".to_string();
        let now = time::OffsetDateTime::now_utc();
        job.completed = Some(
            now.format(&time::format_description::well_known::Iso8601::DEFAULT)
                .unwrap_or_else(|_| now.unix_timestamp().to_string()),
        );
    }

    // Save updated job
    let job_json = serde_json::to_string(&job)?;
    store.insert(&job_key, job_json)?;

    // Return success
    Ok(
        Response::from_status(StatusCode::OK).with_body_json(&json!({
            "success": true
        }))?,
    )
}

/// Parse Reality Defender webhook payload
fn parse_reality_defender_webhook(payload: &Value) -> Result<(String, DetectionResult), String> {
    // Expected format:
    // {
    //   "event_id": "nevent1...",
    //   "status": "complete",
    //   "result": {
    //     "score": 0.85,
    //     "verdict": "AI_GENERATED"
    //   }
    // }

    let event_id = payload
        .get("event_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing event_id")?
        .to_string();

    let status_str = payload
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or("Missing status")?;

    let status = match status_str {
        "pending" => ResultStatus::Pending,
        "processing" => ResultStatus::Processing,
        "complete" => ResultStatus::Complete,
        "error" => ResultStatus::Error,
        _ => ResultStatus::Error,
    };

    let mut result = DetectionResult {
        provider: "reality_defender".to_string(),
        status,
        score: None,
        verdict: None,
        raw: Some(payload.clone()),
        error: None,
    };

    if let Some(result_obj) = payload.get("result") {
        if let Some(score) = result_obj.get("score").and_then(|v| v.as_f64()) {
            result.score = Some(score);
            result.verdict = Some(Verdict::from_score(score));
        }
    }

    if let Some(error) = payload.get("error").and_then(|v| v.as_str()) {
        result.error = Some(error.to_string());
    }

    Ok((event_id, result))
}

/// Parse Hive webhook payload
fn parse_hive_webhook(payload: &Value) -> Result<(String, DetectionResult), String> {
    // Expected format:
    // {
    //   "event_id": "nevent1...",
    //   "status": "complete",
    //   "classes": [{
    //     "class": "ai_generated_video",
    //     "score": 0.92
    //   }]
    // }

    let event_id = payload
        .get("event_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing event_id")?
        .to_string();

    let status_str = payload
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or("Missing status")?;

    let status = match status_str {
        "pending" => ResultStatus::Pending,
        "processing" => ResultStatus::Processing,
        "complete" => ResultStatus::Complete,
        "error" => ResultStatus::Error,
        _ => ResultStatus::Error,
    };

    let mut result = DetectionResult {
        provider: "hive".to_string(),
        status,
        score: None,
        verdict: None,
        raw: Some(payload.clone()),
        error: None,
    };

    if let Some(classes) = payload.get("classes").and_then(|v| v.as_array()) {
        if let Some(ai_class) = classes.iter().find(|c| {
            c.get("class")
                .and_then(|v| v.as_str())
                .map(|s| s.contains("ai_generated"))
                .unwrap_or(false)
        }) {
            if let Some(score) = ai_class.get("score").and_then(|v| v.as_f64()) {
                result.score = Some(score);
                result.verdict = Some(Verdict::from_score(score));
            }
        }
    }

    if let Some(error) = payload.get("error").and_then(|v| v.as_str()) {
        result.error = Some(error.to_string());
    }

    Ok((event_id, result))
}

/// Parse Sensity webhook payload
fn parse_sensity_webhook(payload: &Value) -> Result<(String, DetectionResult), String> {
    // Expected format:
    // {
    //   "event_id": "nevent1...",
    //   "status": "complete",
    //   "detection": {
    //     "is_deepfake": true,
    //     "confidence": 0.78
    //   }
    // }

    let event_id = payload
        .get("event_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing event_id")?
        .to_string();

    let status_str = payload
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or("Missing status")?;

    let status = match status_str {
        "pending" => ResultStatus::Pending,
        "processing" => ResultStatus::Processing,
        "complete" => ResultStatus::Complete,
        "error" => ResultStatus::Error,
        _ => ResultStatus::Error,
    };

    let mut result = DetectionResult {
        provider: "sensity".to_string(),
        status,
        score: None,
        verdict: None,
        raw: Some(payload.clone()),
        error: None,
    };

    if let Some(detection) = payload.get("detection") {
        if let Some(confidence) = detection.get("confidence").and_then(|v| v.as_f64()) {
            // For Sensity, if is_deepfake is true, use confidence as-is
            // If false, invert it (1.0 - confidence)
            let is_deepfake = detection
                .get("is_deepfake")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let score = if is_deepfake {
                confidence
            } else {
                1.0 - confidence
            };
            result.score = Some(score);
            result.verdict = Some(Verdict::from_score(score));
        }
    }

    if let Some(error) = payload.get("error").and_then(|v| v.as_str()) {
        result.error = Some(error.to_string());
    }

    Ok((event_id, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_reality_defender_webhook_complete() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1test123",
            "status": "complete",
            "result": {
                "score": 0.85
            }
        }"#,
        )
        .unwrap();

        let (event_id, result) = parse_reality_defender_webhook(&payload).unwrap();
        assert_eq!(event_id, "nevent1test123");
        assert_eq!(result.provider, "reality_defender");
        assert!(matches!(result.status, ResultStatus::Complete));
        assert_eq!(result.score, Some(0.85));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_reality_defender_webhook_error() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1test456",
            "status": "error",
            "error": "Video not accessible"
        }"#,
        )
        .unwrap();

        let (_, result) = parse_reality_defender_webhook(&payload).unwrap();
        assert!(matches!(result.status, ResultStatus::Error));
        assert_eq!(result.error, Some("Video not accessible".to_string()));
    }

    #[test]
    fn test_parse_hive_webhook_complete() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1hive123",
            "status": "complete",
            "classes": [
                {"class": "ai_generated_video", "score": 0.92}
            ]
        }"#,
        )
        .unwrap();

        let (event_id, result) = parse_hive_webhook(&payload).unwrap();
        assert_eq!(event_id, "nevent1hive123");
        assert_eq!(result.provider, "hive");
        assert!(matches!(result.status, ResultStatus::Complete));
        assert_eq!(result.score, Some(0.92));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_hive_webhook_no_ai_class() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1hive456",
            "status": "complete",
            "classes": [
                {"class": "safe_content", "score": 0.95}
            ]
        }"#,
        )
        .unwrap();

        let (_, result) = parse_hive_webhook(&payload).unwrap();
        assert_eq!(result.score, None);
    }

    #[test]
    fn test_parse_sensity_webhook_deepfake_detected() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1sensity123",
            "status": "complete",
            "detection": {
                "is_deepfake": true,
                "confidence": 0.78
            }
        }"#,
        )
        .unwrap();

        let (event_id, result) = parse_sensity_webhook(&payload).unwrap();
        assert_eq!(event_id, "nevent1sensity123");
        assert_eq!(result.provider, "sensity");
        assert_eq!(result.score, Some(0.78));
        assert!(matches!(result.verdict, Some(Verdict::LikelyAi)));
    }

    #[test]
    fn test_parse_sensity_webhook_not_deepfake() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1sensity456",
            "status": "complete",
            "detection": {
                "is_deepfake": false,
                "confidence": 0.9
            }
        }"#,
        )
        .unwrap();

        let (_, result) = parse_sensity_webhook(&payload).unwrap();
        // When not deepfake, score = 1.0 - confidence = ~0.1
        let score = result.score.unwrap();
        assert!(
            (score - 0.1).abs() < 0.001,
            "Expected score ~0.1, got {}",
            score
        );
        assert!(matches!(result.verdict, Some(Verdict::Authentic)));
    }

    #[test]
    fn test_parse_webhook_missing_event_id() {
        let payload: Value = serde_json::from_str(
            r#"{
            "status": "complete"
        }"#,
        )
        .unwrap();

        let result = parse_reality_defender_webhook(&payload);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("event_id"));
    }

    #[test]
    fn test_parse_webhook_missing_status() {
        let payload: Value = serde_json::from_str(
            r#"{
            "event_id": "nevent1test"
        }"#,
        )
        .unwrap();

        let result = parse_reality_defender_webhook(&payload);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("status"));
    }
}
