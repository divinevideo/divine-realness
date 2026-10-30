# Production deployment

The `Test and deploy` workflow builds and tests the exact triggering commit on
pull requests, pushes to `main`, and manual runs. It installs the root lockfile
with `npm ci`, runs the Wrangler dry-run build, typechecks the Worker and release
code, runs the release-safety tests, and runs the existing Docker Compose/workerd
suite. The latter needs Docker Compose on the runner; it is not a Node-only test.
The deploy job downloads that run's checked bundle, rather than building another
commit. Node and action revisions are pinned in the workflow; Wrangler is pinned
by `package-lock.json` (currently 3.114.15).

PRs and manual runs on another branch cannot enter the production job. The
script also refuses them independently. A main run fails visibly if activation
prerequisites are missing; it does not silently claim a successful release.

## Before enabling activation

A maintainer with authority to configure production must verify these
prerequisites. Adding this workflow does not authorize changing infrastructure,
traffic, Access policies, credentials, secrets, or data.

1. Verify the existing Cloudflare account and Worker `divine-ai-detector` serve
   `realness.admin.divine.video/*`. Compare the live D1 `DB` binding, queue
   producer `ACTION_QUEUE`, and both queue consumers with `wrangler.toml`.
   Reuse them; do not create replacements or change routes to make CD pass.
   Preserve the existing `REALITY_DEFENDER_API_KEY` and optional `HIVE_API_KEY`
   runtime secrets. These are **not** GitHub deployment secrets.
2. Configure the GitHub `production` environment with the repository's approved
   production protections and restrict deployment branches to `main`. Preserve
   existing required reviewers/protection rules; do not weaken them. Environment
   setup and its approval policy belong to the maintainers, not this workflow.
   A separate read-only job requires this environment to exist before the
   deploy job can reference it (and thereby accidentally create it). That job
   adds only `actions: read` to its token permissions; failure to read the
   environment blocks activation.
3. Supply environment variable `CLOUDFLARE_ACCOUNT_ID` for that existing account,
   and environment secret `CLOUDFLARE_API_TOKEN`. Use a scoped API token, not a
   global API key: Workers Scripts Edit and Queues Edit for the target account,
   Workers Routes Edit and Zone Read for the serving zone. Allow D1 Read if
   needed for the existing database lookup; CD does not need D1 write access.
   Limit account and zone resources. The GitHub token needs only `contents: read`.
4. Supply environment secrets `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET` for an authorized Cloudflare Access service token
   that can GET this Worker's `/health`. Keep existing Access protections intact.
   The health probe does not follow redirects or send tokens to another host.
   A login redirect, unexpected body, timeout, or non-200 response fails the
   preflight **before** deployment. No analysis, provider, database-write, or
   moderation request is sent as a smoke test.
5. Verify migration ordering below. From the reviewed checkout run
   `npm run release:inputs`. Set environment variable
   `PRODUCTION_INPUTS_SHA256` to the printed 64-character digest of
   `wrangler.toml` and all files in `migrations/`. Update this approval only
   after verifying intentional configuration/schema changes in production.
   Ordinary source-only changes do not need a new digest. The preflight also
   checks that the current Durable Object migration tag already matches the
   last configured tag, so CD cannot apply a new DO migration.
6. Only after these verifications, set environment variable
   `PRODUCTION_CD_ENABLED` to exactly `true`. Validate the first release with a
   controlled main merge or a manual main replay. Inspect both the GitHub
   result artifact and the live deployment. These production acceptance steps
   are not established by local tests or by merging this change alone.

No workflow step creates credentials, uploads runtime secrets, provisions
resources, applies D1 migrations, or configures GitHub environments. Wrangler
deploy updates the existing Worker and re-applies its checked configuration;
the live preflight refuses missing/different bindings, consumers, or routes.
`--keep-vars` preserves dashboard-managed variables and Wrangler preserves
runtime secrets. `SOURCE_SHA` is the one additional plain-text deployment
variable, set to the checked commit for version attribution.

## Ordering, verification, and evidence

The production job uses one concurrency group with `cancel-in-progress: false`:
an active deployment is never cancelled to make room for another. GitHub does
not promise FIFO order. The script therefore reads live `main` both before and
immediately after preflight and refuses stale queued/replayed commits. A main
push during an active deployment can briefly leave production behind main;
its newer job runs afterwards. An old retry cannot overwrite that newer
release. Manual main replays rerun **all** checks and use their own artifact.
Do not deploy concurrently from a laptop, dashboard, or another workflow;
those writers do not participate in GitHub's concurrency lock.

The script takes Wrangler's structured version receipt, reads that exact
provider version back, and checks its `SOURCE_SHA`. It GETs the protected
`/health` endpoint and verifies the control plane shows that version active at
100% before recording success. Health establishes reachability and the safe
handler response, not the full detection/moderation pipeline's correctness.

`release.json` is uploaded as `production-result-<sha>-<attempt>` for 90 days
and summarized in the Actions run. It records source SHA, production environment,
Worker name, result, stage, previous deployment/version, and deployed provider
version. Actor details, bindings, credentials, and API bodies are not retained.
A failed setup records its stage in the artifact; download/setup failures before
the release script starts remain visible in the job log. A failed deployment
or verification fails the job even if a version already became active. Inspect
live state before retrying: there is no automatic rollback or retry of writes.

## Schema changes and rollback

D1 and Durable Object state do not roll back with Worker code. Keep migrations
backward compatible with both the old and new Worker. Apply approved additive
D1 migrations as a separately authorized operation **before** releasing code
that depends on them. Verify their completion before updating the inputs
approval digest. Destructive changes, new DO migrations, resource replacement,
and data backfills need their own review and operational authorization; CD
must remain blocked until the intended state is established. The historical
DO `v2` deletion is not permission to repeat a deletion or introduce another.

For an incident, an authorized operator should:

1. Disable `PRODUCTION_CD_ENABLED` and stop/wait for the exact active production
   job before rolling back; do not race an in-flight activation. Keep the lock
   respected and inspect live state after any cancellation.
2. Inspect `release.json` and live deployments, choose a known-good provider
   version, and verify compatibility with current D1/DO state and bindings.
3. With the repository's locked Wrangler and the existing account credentials,
   run `npx wrangler rollback <known-good-version-id> --message "<reason>"`.
   Confirm the interactive prompt. Do not substitute an old workflow replay:
   stale commits are intentionally refused.
4. Verify the selected version is active at 100% and perform the same authorized
   GET `/health` (expect 200 and `OK`, not an Access redirect). Record the reason,
   selected version, affected source SHA, and result in the incident record.
5. Fix forward through a checked main commit. Re-enable CD only after the
   incident owner approves. No database restore or secret rollback is implied.

References: [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/#deploy),
[version details API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
[rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
