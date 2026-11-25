// ABOUTME: POST /analyze handler for submitting Nostr events for AI video detection
// ABOUTME: Fetches events from relays, extracts video metadata, submits to detection providers

use fastly::http::{Method, StatusCode};
use fastly::kv_store::KVStore;
use fastly::{Error, Request, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use crate::providers::{hive, reality_defender, sensity};
use crate::providers::{DetectionResult, ResultStatus};

/// Request body for /analyze endpoint
/// Browser fetches event from relay and extracts video URL before calling this
#[derive(Debug, Deserialize)]
struct AnalyzeRequest {
    #[serde(rename = "eventId")]
    event_id: String,
    #[serde(rename = "videoUrl")]
    video_url: String,
    #[serde(rename = "mediaHash")]
    media_hash: Option<String>,
}

/// Response body for /analyze endpoint
#[derive(Debug, Serialize)]
struct AnalyzeResponse {
    #[serde(rename = "jobId")]
    job_id: String,
    status: String,
    #[serde(rename = "videoUrl")]
    video_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Job structure stored in KV store
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub event_id: String,
    pub media_hash: String,
    pub video_url: String,
    pub relay_url: String,
    pub status: String,
    pub submitted: String,
    pub completed: Option<String>,
    pub results: HashMap<String, DetectionResult>,
    pub error: Option<String>,
}

/// Main handler for POST /analyze
pub fn handle(mut req: Request) -> Result<Response, Error> {
    // Verify method
    if req.get_method() != Method::POST {
        return Ok(Response::from_status(StatusCode::METHOD_NOT_ALLOWED)
            .with_body_text_plain("Method not allowed"));
    }

    // Parse request body
    let body = req.take_body_str();
    let request: AnalyzeRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            return Ok(
                Response::from_status(StatusCode::BAD_REQUEST).with_body_json(&json!({
                    "error": "Invalid JSON",
                    "details": e.to_string()
                }))?,
            );
        }
    };

    // Video URL is provided by browser (which fetched event from relay via REST gateway)
    let video_url = request.video_url.clone();

    // Validate video URL
    if video_url.is_empty() {
        return Ok(
            Response::from_status(StatusCode::BAD_REQUEST).with_body_json(&json!({
                "error": "Missing video URL",
                "details": "videoUrl is required"
            }))?,
        );
    }

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

    // Check for existing analysis by hash (deduplication)
    let media_hash = request.media_hash.clone().unwrap_or_else(|| {
        // If no hash provided, generate one from the URL
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(video_url.as_bytes());
        hex::encode(hasher.finalize())
    });
    let hash_key = format!("hash:{}", media_hash);
    // Check if we already have an analysis for this hash (deduplication)
    // Handle case where key doesn't exist yet
    if let Ok(mut hash_lookup) = store.lookup(&hash_key) {
        if let Some(existing_body) = hash_lookup.try_take_body() {
            let existing_event_id = existing_body.into_string();

            // Look up the existing job
            let job_key = format!("job:{}", existing_event_id);
            if let Ok(mut job_lookup) = store.lookup(&job_key) {
                if let Some(job_body) = job_lookup.try_take_body() {
                    let job: Job = serde_json::from_str(&job_body.into_string())?;

                    return Ok(Response::from_status(StatusCode::OK).with_body_json(
                        &AnalyzeResponse {
                            job_id: existing_event_id,
                            status: job.status,
                            video_url: job.video_url,
                            message: Some(
                                "Analysis already exists for this video hash".to_string(),
                            ),
                        },
                    )?);
                }
            }
        }
    }

    // Get base webhook URL from environment or use default
    let base_url = std::env::var("FASTLY_SERVICE_URL")
        .unwrap_or_else(|_| "https://divine-ai-detector.edgecompute.app".to_string());

    // Submit to all three providers
    let mut results = HashMap::new();

    // Submit to Reality Defender
    let rd_webhook = format!("{}/webhook/reality_defender", base_url);
    match reality_defender::submit_video(&video_url, &rd_webhook) {
        Ok(job_ref) => {
            results.insert(
                "reality_defender".to_string(),
                DetectionResult {
                    provider: "reality_defender".to_string(),
                    status: ResultStatus::Pending,
                    score: None,
                    verdict: None,
                    raw: Some(json!({ "job_id": job_ref.job_id })),
                    error: None,
                },
            );
        }
        Err(e) => {
            results.insert(
                "reality_defender".to_string(),
                DetectionResult {
                    provider: "reality_defender".to_string(),
                    status: ResultStatus::Error,
                    score: None,
                    verdict: None,
                    raw: None,
                    error: Some(e.to_string()),
                },
            );
        }
    }

    // Submit to Hive
    let hive_webhook = format!("{}/webhook/hive", base_url);
    match hive::submit_video(&video_url, Some(&hive_webhook)) {
        Ok(job_ref) => {
            results.insert(
                "hive".to_string(),
                DetectionResult {
                    provider: "hive".to_string(),
                    status: ResultStatus::Pending,
                    score: None,
                    verdict: None,
                    raw: Some(json!({ "job_id": job_ref.job_id })),
                    error: None,
                },
            );
        }
        Err(e) => {
            results.insert(
                "hive".to_string(),
                DetectionResult {
                    provider: "hive".to_string(),
                    status: ResultStatus::Error,
                    score: None,
                    verdict: None,
                    raw: None,
                    error: Some(e.to_string()),
                },
            );
        }
    }

    // Submit to Sensity
    let sensity_webhook = format!("{}/webhook/sensity", base_url);
    match sensity::submit_video(&video_url, &sensity_webhook) {
        Ok(job_ref) => {
            results.insert(
                "sensity".to_string(),
                DetectionResult {
                    provider: "sensity".to_string(),
                    status: ResultStatus::Pending,
                    score: None,
                    verdict: None,
                    raw: Some(json!({ "job_id": job_ref.job_id })),
                    error: None,
                },
            );
        }
        Err(e) => {
            results.insert(
                "sensity".to_string(),
                DetectionResult {
                    provider: "sensity".to_string(),
                    status: ResultStatus::Error,
                    score: None,
                    verdict: None,
                    raw: None,
                    error: Some(e.to_string()),
                },
            );
        }
    }

    // Create job record
    let now = time::OffsetDateTime::now_utc();
    let job = Job {
        event_id: request.event_id.clone(),
        media_hash: media_hash.clone(),
        video_url: video_url.clone(),
        relay_url: String::new(), // Browser fetched via REST gateway
        status: "pending".to_string(),
        submitted: now
            .format(&time::format_description::well_known::Iso8601::DEFAULT)
            .unwrap_or_else(|_| now.unix_timestamp().to_string()),
        completed: None,
        results,
        error: None,
    };

    // Store job in KV store
    let job_key = format!("job:{}", request.event_id);
    let job_json = serde_json::to_string(&job)?;
    store.insert(&job_key, job_json)?;

    // Store hash index
    store.insert(&hash_key, request.event_id.clone())?;

    // Update job index (list of all job IDs) - handle case where index doesn't exist yet
    let index_key = "job_index";
    let mut job_ids: Vec<String> = match store.lookup(index_key) {
        Ok(mut lookup) => {
            if let Some(index_body) = lookup.try_take_body() {
                serde_json::from_str(&index_body.into_string()).unwrap_or_else(|_| Vec::new())
            } else {
                Vec::new()
            }
        }
        Err(_) => {
            // Index doesn't exist yet - start with empty list
            Vec::new()
        }
    };

    // Add new job ID at the beginning (most recent first)
    job_ids.insert(0, request.event_id.clone());

    // Keep only the most recent 1000 jobs to prevent unbounded growth
    job_ids.truncate(1000);

    // Store updated index
    let index_json = serde_json::to_string(&job_ids)?;
    store.insert(index_key, index_json)?;

    // Return response
    Ok(
        Response::from_status(StatusCode::OK).with_body_json(&AnalyzeResponse {
            job_id: request.event_id,
            status: job.status,
            video_url: job.video_url,
            message: None,
        })?,
    )
}
