# Trusted-client gate end-to-end harness

Runs the **real** Worker in the **real** Workers runtime (workerd, via Miniflare)
and drives its exported `queue()` handler with byte-exact `client` tags captured
from the shipping first-party clients.

Nothing here re-implements `shouldAnalyzeEvent` — the shipped function decides,
so the suite cannot drift from the code it is meant to pin.

## Running

```bash
npm run test:e2e          # from the repo root; rebuilds the image each run
# or
docker compose -f test/e2e/docker-compose.yml run --build --rm gate-e2e
```

## How it establishes what it claims

- **Real source.** The repo is bind-mounted read-only at `/repo`; the entrypoint
  copies `src/index.ts` and `migrations/` out of it and prints the sha256 plus the
  gate's own lines before each run. A run cannot modify the tree it is testing.
- **No egress.** The container runs with `network_mode: none`, so no provider API
  is reachable and any "analysis was attempted" signal must originate in the
  Worker's own code.
- **Two independent observables.** `analyzeFromQueue` always writes a `jobs` row to
  D1, and submission begins by fetching the video URL. A skipped event produces
  neither; an analysed event produces both.

## Why the fixtures look the way they do

`test/fixtures.ts` carries the literal tags emitted by each client, with the
source location that produces them. Two are easy to get wrong:

- divine-mobile sends `Divine` as the display name — the handler coordinate that
  follows it contains `divine-mobile`, not `divine.video`.
- divine-web **video** publishing sends `divine-web`, not the page hostname. The
  hostname tag is only appended when no `client` tag already exists, which is
  never the case for a video event.

The video host in the fixtures is `media.divine.video`, which is what live
kind-34236 traffic actually carries.

## Scope

This suite covers the trusted-client branch of `shouldAnalyzeEvent` and the gates
either side of it that determine whether it is reached. The remaining branches of
that function are not covered here.
