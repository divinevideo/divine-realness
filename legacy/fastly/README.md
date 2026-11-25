# Legacy Fastly AI service

This is the recovered Rust source for the existing legacy Fastly deployment. It is independent of the Cloudflare Worker in the repository root; restoring this folder does not enable, replace or deploy that Worker.

The original source writes and successful edits were replayed through the recorded version53 deployment. The historical public manifest identifies this service: https://github.com/divinevideo/divine-realness/blob/be25fe576ba7df52eff1c1cf3e091b5e1240b5f3/fastly.toml. No historical Cargo.lock or bit-for-bit deployed-binary comparison is available. See source-provenance.json for the source-set fingerprint and limits.

The restored build pins Fastly SDK0.13.3 with url2.5.9 to address RUSTSEC-2026-0592. Both outbound GET paths explicitly retain the earlier zero stale-if-error window. Application routes, provider logic and store/backend names are preserved. Rust formatting and a standalone Cargo workspace support maintaining the recovered source.

From this directory, use `cargo build --locked --release --target wasm32-wasip1`, then `python3 tests/smoke.py --wasm target/wasm32-wasip1/release/divine-ai-detector.wasm --viceroy /path/to/viceroy`. Viceroy0.22 or newer is required. The smoke harness uses empty temporary stores and loopback-only backends; it never reads production stores or invokes provider APIs. Its landing-page fingerprint was recorded from the original live service.

Deployment is separate and requires approval for this legacy target. Preserve the existing jobs KV, Secret Store and backend links; do not create or rebind stores for an SDK rebuild. The recovered manifest's local-only store files are intentionally absent; use the isolated harness for validation.
