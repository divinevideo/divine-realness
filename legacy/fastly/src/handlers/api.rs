// ABOUTME: API endpoints for querying job status and results
// ABOUTME: Provides GET /api/jobs and GET /api/jobs/:id endpoints

use fastly::http::{Method, StatusCode};
use fastly::kv_store::KVStore;
use fastly::{Error, Request, Response};
use serde::Serialize;
use serde_json::json;

use crate::handlers::analyze::Job;

// Note: We return full Job objects instead of summaries so dashboard can access results

/// Handler for GET /api/jobs - list all jobs
pub fn list_jobs(req: Request) -> Result<Response, Error> {
    // Verify method
    if req.get_method() != Method::GET {
        return Ok(Response::from_status(StatusCode::METHOD_NOT_ALLOWED)
            .with_body_text_plain("Method not allowed"));
    }

    // Parse query parameters for pagination
    let url = req.get_url();
    let query_pairs: std::collections::HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let limit: usize = query_pairs
        .get("limit")
        .and_then(|l| l.parse().ok())
        .unwrap_or(50)
        .min(100);

    let offset: usize = query_pairs
        .get("offset")
        .and_then(|o| o.parse().ok())
        .unwrap_or(0);

    // Try to open KV store and get job index
    let (jobs, total_count) = match KVStore::open("jobs") {
        Ok(Some(store)) => {
            // KV store exists, try to get job index
            match store.lookup("job_index") {
                Ok(mut lookup) => {
                    match lookup.try_take_body() {
                        Some(body) => {
                            let body_str = body.into_string();
                            let job_ids: Vec<String> =
                                serde_json::from_str(&body_str).unwrap_or_else(|_| Vec::new());
                            let total = job_ids.len();

                            // Apply pagination and fetch jobs
                            let paginated: Vec<String> =
                                job_ids.into_iter().skip(offset).take(limit).collect();

                            let mut jobs: Vec<Job> = Vec::new();
                            for event_id in paginated {
                                let job_key = format!("job:{}", event_id);
                                if let Ok(mut jl) = store.lookup(&job_key) {
                                    if let Some(jb) = jl.try_take_body() {
                                        if let Ok(job) =
                                            serde_json::from_str::<Job>(&jb.into_string())
                                        {
                                            jobs.push(job);
                                        }
                                    }
                                }
                            }
                            (jobs, total)
                        }
                        None => (Vec::new(), 0), // Index key exists but empty
                    }
                }
                Err(_) => (Vec::new(), 0), // Index key doesn't exist
            }
        }
        Ok(None) => (Vec::new(), 0), // KV store not configured
        Err(_) => (Vec::new(), 0),   // Error opening KV store
    };

    Ok(
        Response::from_status(StatusCode::OK).with_body_json(&json!({
            "jobs": jobs,
            "count": jobs.len(),
            "total": total_count,
            "limit": limit,
            "offset": offset,
        }))?,
    )
}

/// Handler for GET /api/jobs/:id - get job by event ID or SHA256
pub fn get_job(req: Request, id: &str) -> Result<Response, Error> {
    // Verify method
    if req.get_method() != Method::GET {
        return Ok(Response::from_status(StatusCode::METHOD_NOT_ALLOWED)
            .with_body_text_plain("Method not allowed"));
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

    // Helper to parse job from body
    fn parse_job_body(body: fastly::Body) -> Result<Job, String> {
        let job_str = body.into_string();
        serde_json::from_str(&job_str).map_err(|e| e.to_string())
    }

    // Helper to look up a job by key, handling KV errors gracefully
    fn lookup_job(store: &fastly::kv_store::KVStore, key: &str) -> Option<Job> {
        if let Ok(mut lookup) = store.lookup(key) {
            if let Some(body) = lookup.try_take_body() {
                if let Ok(job) = serde_json::from_str::<Job>(&body.into_string()) {
                    return Some(job);
                }
            }
        }
        None
    }

    // Helper to look up hash index
    fn lookup_hash(store: &fastly::kv_store::KVStore, hash_key: &str) -> Option<String> {
        if let Ok(mut lookup) = store.lookup(hash_key) {
            if let Some(body) = lookup.try_take_body() {
                return Some(body.into_string());
            }
        }
        None
    }

    // Determine if this is an event ID or hash and look up the job
    // Note: Both hex event IDs and SHA256 hashes are 64 hex chars
    // So for 64-char hex, we try event ID first, then fall back to hash lookup
    let job: Option<Job> = if id.starts_with("nevent") || id.starts_with("note") {
        // It's definitely a bech32 event ID
        let job_key = format!("job:{}", id);
        lookup_job(&store, &job_key)
    } else if id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        // Could be a hex event ID or a SHA256 hash - try event ID first
        let event_key = format!("job:{}", id);
        if let Some(job) = lookup_job(&store, &event_key) {
            Some(job)
        } else {
            // Not found as event ID, try as hash
            let hash_key = format!("hash:{}", id);
            if let Some(event_id) = lookup_hash(&store, &hash_key) {
                let job_key = format!("job:{}", event_id);
                lookup_job(&store, &job_key)
            } else {
                None
            }
        }
    } else {
        return Ok(Response::from_status(StatusCode::BAD_REQUEST)
            .with_body_json(&json!({
                "error": "Invalid ID format",
                "details": "ID must be a Nostr event ID (nevent1..., note1..., or 64-char hex) or SHA256 hash"
            }))?);
    };

    // Return job or 404
    match job {
        Some(j) => Ok(Response::from_status(StatusCode::OK).with_body_json(&j)?),
        None => Ok(
            Response::from_status(StatusCode::NOT_FOUND).with_body_json(&json!({
                "error": "Job not found"
            }))?,
        ),
    }
}
