// ABOUTME: AI detection provider integrations
// ABOUTME: Reality Defender, HiveAI, and Sensity provider implementations

pub mod hive;
pub mod reality_defender;
pub mod sensity;

use serde::{Deserialize, Serialize};

/// Normalized detection result from any provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub provider: String,
    pub status: ResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResultStatus {
    Pending,
    Processing,
    Complete,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Authentic,
    Uncertain,
    LikelyAi,
}

impl Verdict {
    /// Determine verdict from a 0-1 normalized score
    pub fn from_score(score: f64) -> Self {
        if score < 0.3 {
            Verdict::Authentic
        } else if score < 0.7 {
            Verdict::Uncertain
        } else {
            Verdict::LikelyAi
        }
    }
}

/// Reference to a submitted job at a provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobReference {
    pub provider: String,
    pub job_id: String,
}
