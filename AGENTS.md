# Repository Guidelines

## Project Structure & Module Organization
- Worker code lives in `src/`.
- D1 schema changes live in `migrations/`.
- Project metadata and scripts live in `package.json`; deployment config lives in `wrangler.toml`.
- Keep request routing, provider integration, queue handling, and persistence logic separated where practical instead of expanding a single large Worker module.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start the Worker locally with Wrangler.
- `npm test`: run the test suite when tests are present and configured.
- `npm run deploy`: deploy the Worker through Wrangler.
- If schema or provider behavior changes, validate them against the D1 migrations and relevant API paths before opening a PR.

## Coding Style & Naming Conventions
- Use TypeScript throughout and keep request, queue, and persistence shapes explicit.
- Prefer focused helpers and endpoint-specific logic over broad shared utility buckets.
- Keep PRs tightly scoped. Do not mix unrelated cleanup, formatting churn, or speculative refactors into the same change.
- Temporary or transitional code must include `TODO(#issue):` with the tracking issue for removal.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it afterward.
- If a PR title changes after opening, verify that the semantic PR title check reruns successfully.
- PR descriptions must include a short summary, motivation, linked issue, and manual test plan.
- Changes to public endpoints, provider webhooks, queue behavior, or moderation actions should include representative payloads or request examples when helpful.

## Security & Sensitive Information
- Do not commit API keys, webhook secrets, private moderation payloads, or sensitive customer data.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
