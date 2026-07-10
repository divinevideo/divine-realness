# divine-realness

AI-generated video detection for Divine. This Cloudflare Worker is the enforcement side of Divine's "No slop. All human." promise: it checks uploaded video for signs of AI generation and issues moderation actions on anything that fails.

## What it does

- Consumes Nostr events from a detection queue and pulls the referenced video.
- Runs each video through one or more detection providers (Reality Defender, Hive, Sensity).
- Stores jobs and results in D1.
- Emits moderation actions (ban, review, age-restrict, or mark safe) onto a queue for the rest of the pipeline to act on.
- Serves a small admin dashboard and JSON API at `realness.admin.divine.video`.

## Development

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm test          # run the test suite (vitest)
npm run deploy    # deploy the Worker through Wrangler
```

Configuration lives in `wrangler.toml`. Provider API keys are set as Wrangler secrets (`REALITY_DEFENDER_API_KEY`, `HIVE_API_KEY`, `SENSITY_API_KEY`). D1 schema changes go in `migrations/`.

See [AGENTS.md](AGENTS.md) for repository conventions and contribution guardrails.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
