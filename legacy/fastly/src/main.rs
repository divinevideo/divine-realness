// ABOUTME: Main entry point for Nostr AI Video Detector Fastly Compute service
// ABOUTME: Routes requests to handlers for dashboard, analysis, webhooks, and API

mod handlers;
mod nostr;
mod providers;

use fastly::http::{Method, StatusCode};
use fastly::{Error, Request, Response};

/// Main entry point for the Fastly Compute service
#[fastly::main]
fn main(req: Request) -> Result<Response, Error> {
    let path = req.get_path().to_string();
    let method = req.get_method().clone();

    match (method, path.as_str()) {
        // Dashboard UI
        (Method::GET, "/") => handlers::dashboard::handle(req),

        // Submit event for analysis
        (Method::POST, "/analyze") => handlers::analyze::handle(req),

        // Provider webhooks
        (Method::POST, path) if path.starts_with("/webhook/") => {
            let provider = path.strip_prefix("/webhook/").unwrap_or("");
            handlers::webhook::handle(req, provider)
        }

        // API endpoints
        (Method::GET, "/api/jobs") => handlers::api::list_jobs(req),
        (Method::GET, path) if path.starts_with("/api/jobs/") => {
            let id = path.strip_prefix("/api/jobs/").unwrap_or("");
            handlers::api::get_job(req, id)
        }

        // Health check
        (Method::GET, "/health") => {
            Ok(Response::from_status(StatusCode::OK).with_body_text_plain("OK"))
        }

        // 404 for everything else
        _ => Ok(Response::from_status(StatusCode::NOT_FOUND).with_body_text_plain("Not Found")),
    }
}
