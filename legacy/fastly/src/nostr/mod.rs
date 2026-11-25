// ABOUTME: Nostr protocol client for fetching events from relays
// ABOUTME: Parses NIP-94 imeta tags to extract video URLs and hashes

pub mod client;
pub mod event;

pub use client::NostrClient;
