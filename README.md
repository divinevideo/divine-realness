# Divine Realness

AI-generated video detection for Divine. This Cloudflare Worker is the enforcement side of Divine's "No slop. All human." promise: it checks video posted to Divine for signs of AI generation, records the results, and lets moderators issue enforcement actions on anything that fails.

## What it does

- Consumes Nostr video events from a detection queue and pulls the referenced video.
- Runs each video through one or more detection providers and normalizes their output to a 0–1 AI-likelihood score plus a verdict.
- Stores jobs and provider results in D1.
- Emits moderation actions (permanent ban, review, age-restrict, or mark safe) onto a queue for the rest of the pipeline to enforce, and consumes the results those actions produce.
- Serves an admin dashboard and JSON API at `realness.admin.divine.video`.

## Features

### Detection providers

- **Reality Defender** — asynchronous. The Worker submits the video, then collects the result via the provider webhook or by polling. A `finalScore` (0–100) is normalized to 0–1.
- **Hive** — synchronous. The Worker calls Hive's task API and reads the AI-generated class score directly from the response.

Each provider result carries a score and a verdict: `authentic` (score < 0.3), `likely_ai` (score > 0.7), or `uncertain` in between. A `SENSITY_API_KEY` slot exists in the configuration for a future provider, but no Sensity integration is currently wired in.

### Selective analysis

Not every video is sent to the detectors. `shouldAnalyzeEvent` skips work that isn't needed and focuses spend on untrusted content:

- **Skipped:** events with a proofmode/proof tag (verified camera capture), events from the `divine.video` client, and videos hosted on trusted Divine servers (`blossom.divine.video`, `cdn.divine.video`).
- **Analyzed:** reported events (NIP-56 kind 1984) and videos from untrusted sources.

### Moderation actions

Detection results are advisory: the automatic queue path stores scores but does not enforce on its own. A moderator issues an action from the admin console (`POST /api/moderate/:eventId`), which places a `PERMANENT_BAN`, `REVIEW`, `AGE_RESTRICTED`, or `SAFE` message (keyed by the media SHA-256) onto the moderation action queue. The Worker also consumes action-result messages coming back from that pipeline and updates the corresponding job.

## Architecture

Single Cloudflare Worker (`src/index.ts`) with three entry points wired in `wrangler.toml`:

**Detection pipeline (queue consumer, `video-detection-queue`)**
1. A Nostr video event arrives on the queue.
2. The video URL is extracted from the event's `imeta` tag (NIP-92), a `media`/`video` tag, or a video URL in the content.
3. `shouldAnalyzeEvent` decides whether the video needs checking.
4. New events are submitted to Reality Defender and (if configured) Hive; a job row is written to D1, deduplicated by `event_id`.

**HTTP API and admin dashboard (fetch handler)**
- `GET /` — admin dashboard.
- `GET /health` — health check.
- `POST /analyze`, `POST /api/analyze` — submit a video for detection.
- `GET /api/jobs`, `GET /api/jobs/:eventId` — list and inspect jobs.
- `DELETE /api/jobs/:eventId` — delete a job.
- `POST /api/moderate/:eventId` — issue a moderation action.
- `POST /webhook/:provider` — receive provider callbacks (e.g. Reality Defender).
- `POST /api/poll` — poll pending asynchronous provider results.

**Nostr integration**
Divine's relay side feeds video events onto `video-detection-queue`; Realness reads them, so detection follows the same Nostr events users publish rather than a separate ingestion path.

**How it fits Divine trust & safety**
Realness is one input to Divine's moderation pipeline. It scores content and surfaces it to moderators; the actions a moderator issues flow out over `moderation-actions-queue` to the services that enforce them (for example, relay-level bans), and the outcomes flow back over `moderation-action-results-queue`.

Persistence is a single D1 database (`realness-db`). The `jobs` table stores the event id, media hash, video URL, status, provider results (as JSON), and moderation tracking columns. Schema is managed under `migrations/`.

## Getting started

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm run deploy    # deploy the Worker through Wrangler
```

A `test` script is defined (`vitest`) but no test suite is checked in yet.

## Configuration

Bindings and routes live in `wrangler.toml`:

- **D1:** `DB` → `realness-db`.
- **Route:** `realness.admin.divine.video/*`.
- **Queue consumers:** `video-detection-queue` (incoming video events) and `moderation-action-results-queue` (action outcomes).
- **Queue producer:** `ACTION_QUEUE` → `moderation-actions-queue`.

Provider API keys are set as Wrangler secrets:

```bash
wrangler secret put REALITY_DEFENDER_API_KEY   # required
wrangler secret put HIVE_API_KEY               # optional; Hive is skipped if unset
wrangler secret put SENSITY_API_KEY            # optional; reserved, not yet used
```

D1 schema changes go in `migrations/`.

## Deployment

Deploy with `npm run deploy` (`wrangler deploy`). There is no deploy workflow in CI; the only GitHub Action is a semantic PR-title check. See [AGENTS.md](AGENTS.md) for repository conventions and contribution guardrails.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
