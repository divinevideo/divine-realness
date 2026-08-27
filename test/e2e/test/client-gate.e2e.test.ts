import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../worker/src/index";
import {
  MOBILE_CLIENT_TAG,
  WEB_VIDEO_CLIENT_TAG,
  WEB_HOSTNAME_CLIENT_TAG,
  REAL_MOBILE_VIDEO_URL,
  TRUSTED_VIDEO_URL,
  CDN_VIDEO_URL,
  UNTRUSTED_VIDEO_URL,
  videoEvent,
} from "./fixtures";

let fetches: string[] = [];

beforeEach(() => {
  fetches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      fetches.push(url);
      // Fail the download after recording that analysis reached the provider path.
      return new Response("x", { status: 500, statusText: "stubbed" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Drives the real exported queue() handler inside the Workers runtime.
 * Returns whether the worker treated the event as needing analysis.
 */
async function runQueue(event: ReturnType<typeof videoEvent>) {
  const acks: string[] = [];
  const batch = {
    queue: "video-detection-queue",
    messages: [
      {
        id: `msg-${event.id}`,
        timestamp: new Date(0),
        attempts: 1,
        body: { event },
        ack: () => acks.push("ack"),
        retry: () => acks.push("retry"),
      },
    ],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as Parameters<typeof worker.queue>[0];

  await worker.queue(batch, env as unknown as Parameters<typeof worker.queue>[1]);

  const testEnv = env as unknown as { DB: D1Database };
  const row = await testEnv.DB.prepare("SELECT event_id FROM jobs WHERE event_id = ?")
    .bind(event.id)
    .first();

  // Every message must be settled exactly once, and settled by ack - a retry
  // here would mean the handler threw rather than reaching a decision.
  expect(acks).toEqual(["ack"]);

  return { analyzed: row !== null, fetches: [...fetches] };
}

// Scope: the trusted-client branch of shouldAnalyzeEvent, and the gates either
// side of it that determine whether it is reached at all.
describe("divine-realness trusted-client gate, end to end in workerd", () => {
  it("FACT: mobile tag element [1] is 'Divine' and does NOT contain 'divine.video'", () => {
    expect(MOBILE_CLIENT_TAG[1]).toBe("Divine");
    expect(MOBILE_CLIENT_TAG[1].includes("divine.video")).toBe(false);
  });

  it("FACT: 'divine.video' occurs ONCE in the mobile tag - in [3] only, not [2]", () => {
    const occurrences = MOBILE_CLIENT_TAG.filter((el) => el.includes("divine.video"));
    expect(occurrences).toEqual(["wss://relay.divine.video"]);
    expect(occurrences).toHaveLength(1);
    // The handler coordinate carries "divine-mobile", not "divine.video".
    expect(MOBILE_CLIENT_TAG[2]).toContain("divine-mobile");
    expect(MOBILE_CLIENT_TAG[2].includes("divine.video")).toBe(false);
  });

  it("BUG: divine-mobile event on an untrusted host IS analyzed (gate misses)", async () => {
    // TODO(#11): Rewrite this expectation when the trusted-client gate is fixed.
    const r = await runQueue(
      videoEvent({ clientTag: MOBILE_CLIENT_TAG, videoUrl: UNTRUSTED_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(true);
    expect(r.fetches[0]).toBe(UNTRUSTED_VIDEO_URL);
  });

  it("BUG: the REAL divine-web video tag ['client','divine-web'] ALSO misses the gate", async () => {
    // TODO(#11): Rewrite this expectation when the trusted-client gate is fixed.
    const r = await runQueue(
      videoEvent({ clientTag: WEB_VIDEO_CLIENT_TAG, videoUrl: UNTRUSTED_VIDEO_URL }),
    );
    // 'divine-web'.includes('divine.video') === false, so the gate never fires
    // for divine-web videos either - not just mobile.
    expect(r.analyzed).toBe(true);
    expect(r.fetches[0]).toBe(UNTRUSTED_VIDEO_URL);
  });

  it("the hostname-fallback tag trips the gate", async () => {
    const r = await runQueue(
      videoEvent({ clientTag: WEB_HOSTNAME_CLIENT_TAG, videoUrl: UNTRUSTED_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(false);
    expect(r.fetches).toHaveLength(0);
  });

  it("CONTROL: no client tag at all is analyzed", async () => {
    const r = await runQueue(videoEvent({ videoUrl: UNTRUSTED_VIDEO_URL }));
    expect(r.analyzed).toBe(true);
  });

  it("IMPACT: divine-mobile video on blossom.divine.video is skipped by the HOST gate", async () => {
    const r = await runQueue(
      videoEvent({ clientTag: MOBILE_CLIENT_TAG, videoUrl: TRUSTED_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(false);
    expect(r.fetches).toHaveLength(0);
  });

  it("IMPACT: divine-mobile video on cdn.divine.video is skipped by the HOST gate", async () => {
    const r = await runQueue(
      videoEvent({ clientTag: MOBILE_CLIENT_TAG, videoUrl: CDN_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(false);
    expect(r.fetches).toHaveLength(0);
  });

  it("ORDERING: the client gate short-circuits BEFORE the report check", async () => {
    // TODO(#11): Rewrite this expectation when the trusted-client gate is fixed.
    const r = await runQueue(
      videoEvent({
        clientTag: WEB_HOSTNAME_CLIENT_TAG,
        videoUrl: UNTRUSTED_VIDEO_URL,
        extraTags: [["report", "nudity"]],
      }),
    );
    // The web client gate returns false BEFORE the report check is reached,
    // so the report never gets a chance to force analysis.
    expect(r.analyzed).toBe(false);
  });

  it("REAL TRAFFIC: mobile event WITHOUT proofmode on media.divine.video IS analyzed", async () => {
    // The residual 3.1%. media.divine.video is not in trustedHosts, so neither
    // the client gate nor the host gate catches these.
    const r = await runQueue(
      videoEvent({ clientTag: MOBILE_CLIENT_TAG, videoUrl: REAL_MOBILE_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(true);
    expect(r.fetches[0]).toBe(REAL_MOBILE_VIDEO_URL);
  });

  it("casing: a hypothetical 'DIVINE.VIDEO' hostname would also miss the gate", async () => {
    const r = await runQueue(
      videoEvent({ clientTag: ["client", "DIVINE.VIDEO"], videoUrl: UNTRUSTED_VIDEO_URL }),
    );
    expect(r.analyzed).toBe(true);
  });
});
