// Byte-exact client tags captured from the shipping first-party clients.
//
// divine-web:    divine-web/src/hooks/useNostrPublish.ts:19
//                tags.push(["client", location.hostname])
// divine-mobile: divine-mobile/mobile/packages/nostr_client/lib/src/
//                nip89_client_tag.dart:37-42

export const MOBILE_HANDLER_PUBKEY =
  "d95aa8fc0eff8e488952495b8064991d27fb96ed8652f12cdedc5a4e8b5ae540";

export const MOBILE_CLIENT_TAG: string[] = [
  "client",
  "Divine",
  `31990:${MOBILE_HANDLER_PUBKEY}:divine-mobile`,
  "wss://relay.divine.video",
];

// What divine-web ACTUALLY puts on a video event (kind 34236).
// divine-web/src/hooks/usePublishVideo.ts:74 -> tags.push(['client', 'divine-web'])
// useNostrPublish only appends the hostname tag when none exists yet
// (useNostrPublish.ts:18), so this is the tag that ships on videos.
export const WEB_VIDEO_CLIENT_TAG: string[] = ["client", "divine-web"];

// The hostname-fallback tag, which only lands on publishes that set no client
// tag of their own. No video event takes this path.
export const WEB_HOSTNAME_CLIENT_TAG: string[] = ["client", "divine.video"];

// The host that ACTUALLY carries divine-mobile video, measured on
// wss://relay.divine.video: 2990/3000 kind-34236 events, 2026-08-22..27.
// Note it is NOT in divine-realness's trustedHosts list.
export const REAL_MOBILE_VIDEO_URL = "https://media.divine.video/abc123.mp4";

export const TRUSTED_VIDEO_URL = "https://blossom.divine.video/abc123.mp4";
export const CDN_VIDEO_URL = "https://cdn.divine.video/abc123.mp4";
export const UNTRUSTED_VIDEO_URL = "https://media.example.com/abc123.mp4";

let counter = 0;

export function videoEvent(opts: {
  clientTag?: string[];
  videoUrl?: string;
  extraTags?: string[][];
  kind?: number;
}) {
  counter += 1;
  const tags: string[][] = [];
  if (opts.videoUrl) tags.push(["imeta", `url ${opts.videoUrl}`, "m video/mp4"]);
  if (opts.clientTag) tags.push(opts.clientTag);
  if (opts.extraTags) tags.push(...opts.extraTags);

  return {
    id: `e2e${String(counter).padStart(60, "0")}`,
    pubkey: "a".repeat(64),
    created_at: 1735689600,
    kind: opts.kind ?? 22,
    tags,
    content: "",
    sig: "b".repeat(128),
  };
}
