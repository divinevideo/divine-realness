// ABOUTME: Cloudflare Worker for Realness AI video detection
// ABOUTME: Handles Nostr event analysis, job management, and provider webhooks

export interface Env {
  DB: D1Database;
  REALITY_DEFENDER_API_KEY: string;
  HIVE_API_KEY?: string;
  SENSITY_API_KEY?: string;
  ACTION_QUEUE: Queue<ModerationAction>;
}

// Moderation action types
interface ModerationAction {
  type: 'moderation-action';
  sha256: string;
  action: 'PERMANENT_BAN' | 'REVIEW' | 'AGE_RESTRICTED' | 'SAFE';
  reason: string;
  source: string;
  requestId: string;
}

interface ActionResult {
  type: string;
  sha256: string;
  action: string;
  status: string;
  reason?: string;
  error?: string;
  processedAt?: string;
  requestId?: string;
}

// Nostr event structure from queue
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface QueueMessage {
  event: NostrEvent;
  relays?: string[];
}

interface Job {
  id?: number;
  event_id: string;
  media_hash: string;
  video_url: string;
  status: 'pending' | 'complete' | 'error';
  submitted_at: string;
  completed_at?: string;
  results: Record<string, DetectionResult>;
  error?: string;
  webhook_url?: string;
  webhook_called?: boolean;
  moderation_action?: string;
  moderation_status?: string;
  moderation_request_id?: string;
  moderation_error?: string;
  moderation_processed_at?: string;
}

interface JobRow {
  id: number;
  event_id: string;
  media_hash: string;
  video_url: string;
  status: string;
  submitted_at: string;
  completed_at: string | null;
  error: string | null;
  webhook_url: string | null;
  webhook_called: number;
  results: string | null;
  moderation_action: string | null;
  moderation_status: string | null;
  moderation_request_id: string | null;
  moderation_error: string | null;
  moderation_processed_at: string | null;
}

interface DetectionResult {
  provider: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  requestId?: string;
  score?: number;
  verdict?: 'authentic' | 'uncertain' | 'likely_ai';
  raw?: unknown;
  error?: string;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    event_id: row.event_id,
    media_hash: row.media_hash,
    video_url: row.video_url,
    status: row.status as Job['status'],
    submitted_at: row.submitted_at,
    completed_at: row.completed_at || undefined,
    error: row.error || undefined,
    webhook_url: row.webhook_url || undefined,
    webhook_called: row.webhook_called === 1,
    results: row.results ? JSON.parse(row.results) : {},
    moderation_action: row.moderation_action || undefined,
    moderation_status: row.moderation_status || undefined,
    moderation_request_id: row.moderation_request_id || undefined,
    moderation_error: row.moderation_error || undefined,
    moderation_processed_at: row.moderation_processed_at || undefined,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers - must echo specific origin when credentials (CF Access cookies) are involved
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = [
      'https://relay.admin.divine.video',
      'https://divine-relay-admin.pages.dev',
    ];
    const isAllowedOrigin = allowedOrigins.includes(origin) ||
      origin.endsWith('.divine-relay-admin.pages.dev') ||
      origin.startsWith('http://localhost:');

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': isAllowedOrigin ? origin : allowedOrigins[0],
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route handling
      if (path === '/' && request.method === 'GET') {
        return serveDashboard();
      }

      if (path === '/health') {
        return new Response('OK', { headers: corsHeaders });
      }

      if (path === '/analyze' && request.method === 'POST') {
        return handleAnalyze(request, env, ctx);
      }

      if (path === '/api/analyze' && request.method === 'POST') {
        return handleApiAnalyze(request, env, ctx);
      }

      if (path === '/api/jobs' && request.method === 'GET') {
        return handleListJobs(env, request);
      }

      if (path.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = path.replace('/api/jobs/', '');
        return handleGetJob(jobId, env);
      }

      if (path.startsWith('/api/jobs/') && request.method === 'DELETE') {
        const jobId = path.replace('/api/jobs/', '');
        return handleDeleteJob(jobId, env);
      }

      // Moderation action endpoint: POST /api/moderate/:jobId
      if (path.startsWith('/api/moderate/') && request.method === 'POST') {
        const jobId = path.replace('/api/moderate/', '');
        return handleModerateJob(jobId, request, env);
      }

      if (path.startsWith('/webhook/') && request.method === 'POST') {
        const provider = path.replace('/webhook/', '');
        return handleWebhook(provider, request, env);
      }

      if (path === '/api/poll' && request.method === 'POST') {
        return handlePollResults(request, env, ctx);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  // Queue handler for both video detection and action results
  async queue(batch: MessageBatch<QueueMessage | ActionResult>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as unknown as Record<string, unknown>;

        // Check if this is an action result message
        if (body.type === 'moderation-action-result' || body.status !== undefined) {
          await handleActionResult(body as unknown as ActionResult, env);
          msg.ack();
          continue;
        }

        // Otherwise, treat as video detection message
        const queueMsg = body as unknown as QueueMessage;
        const event = queueMsg.event;
        if (!event) {
          console.log(`[Queue] Unknown message type:`, body);
          msg.ack();
          continue;
        }

        console.log(`[Queue] Processing event ${event.id} kind=${event.kind}`);

        // Check if we should analyze this video
        if (!shouldAnalyzeEvent(event)) {
          console.log(`[Queue] Skipping event ${event.id} - does not need analysis`);
          msg.ack();
          continue;
        }

        // Extract video URL from imeta tag
        const videoUrl = extractVideoUrl(event);
        if (!videoUrl) {
          console.log(`[Queue] No video URL found in event ${event.id}`);
          msg.ack();
          continue;
        }

        // Check if we already analyzed this event
        const existingRow = await env.DB.prepare(
          'SELECT id FROM jobs WHERE event_id = ?'
        ).bind(event.id).first();

        if (existingRow) {
          console.log(`[Queue] Event ${event.id} already analyzed`);
          msg.ack();
          continue;
        }

        // Submit for analysis
        console.log(`[Queue] Submitting event ${event.id} for analysis: ${videoUrl}`);
        await analyzeFromQueue(event, videoUrl, env);
        msg.ack();
      } catch (error) {
        console.error(`[Queue] Error processing message:`, error);
        msg.retry();
      }
    }
  },
};

// Handle action result from moderation queue
async function handleActionResult(result: ActionResult, env: Env): Promise<void> {
  console.log(`[ActionResult] Received: sha256=${result.sha256} action=${result.action} status=${result.status}`);

  // Update jobs that match this sha256 (media_hash)
  await env.DB.prepare(
    `UPDATE jobs SET
      moderation_action = ?,
      moderation_status = ?,
      moderation_error = ?,
      moderation_processed_at = ?
    WHERE media_hash = ?`
  ).bind(
    result.action,
    result.status,
    result.error || null,
    result.processedAt || new Date().toISOString(),
    result.sha256
  ).run();

  console.log(`[ActionResult] Updated job with sha256=${result.sha256}`);
}

async function handleAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.json() as { eventId: string; videoUrl: string; mediaHash?: string };

  if (!body.videoUrl) {
    return new Response(JSON.stringify({ error: 'Missing videoUrl' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const eventId = body.eventId;
  const videoUrl = body.videoUrl;
  const mediaHash = body.mediaHash || await hashString(videoUrl);

  // Check for existing job
  const existingRow = await env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ?'
  ).bind(eventId).first<JobRow>();

  if (existingRow) {
    const job = rowToJob(existingRow);
    return new Response(JSON.stringify({
      jobId: eventId,
      status: job.status,
      videoUrl: job.video_url,
      message: 'Job already exists',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create new job
  const results: Record<string, DetectionResult> = {};

  // Submit to Reality Defender
  const baseUrl = new URL(request.url).origin;

  try {
    const rdResult = await submitToRealityDefender(videoUrl, `${baseUrl}/webhook/reality_defender`, env);
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'pending',
      requestId: rdResult.requestId,
    };
  } catch (error) {
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'error',
      error: String(error),
    };
  }

  // Submit to Hive AI (synchronous API)
  if (env.HIVE_API_KEY) {
    try {
      const hiveResult = await submitToHive(videoUrl, env);
      results['hive'] = {
        provider: 'hive',
        status: 'complete',
        score: hiveResult.score,
        verdict: hiveResult.verdict,
        raw: hiveResult.raw,
      };
    } catch (error) {
      results['hive'] = {
        provider: 'hive',
        status: 'error',
        error: String(error),
      };
    }
  }

  // Insert job into D1
  await env.DB.prepare(
    `INSERT INTO jobs (event_id, media_hash, video_url, status, submitted_at, results)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).bind(
    eventId,
    mediaHash,
    videoUrl,
    new Date().toISOString(),
    JSON.stringify(results)
  ).run();

  return new Response(JSON.stringify({
    jobId: eventId,
    status: 'pending',
    videoUrl: videoUrl,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function submitToRealityDefender(
  videoUrl: string,
  webhookUrl: string,
  env: Env
): Promise<{ requestId: string }> {
  const RD_API_BASE = 'https://api.prd.realitydefender.xyz';

  // Verify we have an API key
  if (!env.REALITY_DEFENDER_API_KEY) {
    throw new Error('REALITY_DEFENDER_API_KEY is not configured');
  }

  // API key loaded from secrets (never log keys, even partially)

  // Step 1: Download the video
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to fetch video: ${videoResponse.status}`);
  }
  const videoBlob = await videoResponse.blob();
  let filename = videoUrl.split('/').pop() || 'video.mp4';
  // Ensure filename has a video extension (Reality Defender requires it)
  if (!filename.match(/\.(mp4|mov|avi|webm|mkv)$/i)) {
    filename = filename + '.mp4';
  }

  // Step 2: Get presigned URL from Reality Defender
  const presignedResponse = await fetch(`${RD_API_BASE}/api/files/aws-presigned`, {
    method: 'POST',
    headers: {
      'X-API-KEY': env.REALITY_DEFENDER_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Divine-AI-Detector/1.0',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ fileName: filename }),
  });

  if (!presignedResponse.ok) {
    const errorText = await presignedResponse.text();
    throw new Error(`Failed to get presigned URL: ${presignedResponse.status} - ${errorText}`);
  }

  const presignedData = await presignedResponse.json() as {
    response: { signedUrl: string };
    requestId: string;
    mediaId: string;
  };

  // Step 3: Upload video to the presigned S3 URL
  const uploadResponse = await fetch(presignedData.response.signedUrl, {
    method: 'PUT',
    body: videoBlob,
  });

  if (!uploadResponse.ok) {
    const uploadError = await uploadResponse.text();
    throw new Error(`Failed to upload to S3: ${uploadResponse.status} - ${uploadError}`);
  }

  return { requestId: presignedData.requestId };
}

async function submitToHive(
  videoUrl: string,
  env: Env
): Promise<{ score: number; verdict: 'authentic' | 'uncertain' | 'likely_ai'; raw: unknown }> {
  const formData = new FormData();
  formData.append('url', videoUrl);

  const response = await fetch('https://api.thehive.ai/api/v2/task/sync', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'authorization': `token ${env.HIVE_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hive API error: ${response.status} - ${errorText}`);
  }

  interface HiveClass {
    class: string;
    score: number;
  }
  interface HiveResult {
    status: Array<{
      status: { code?: string; message?: string };
      response: {
        input: unknown;
        output: Array<{
          classes: HiveClass[];
        }>;
      };
    }>;
  }

  const data = await response.json() as HiveResult;

  // Extract AI-generated score from Hive response
  // Hive response structure: status[0].response.output[].classes[]
  let aiScore = 0;
  const outputs = data.status?.[0]?.response?.output;

  console.log('[Hive] Response received, outputs count:', outputs?.length ?? 0);

  if (outputs && outputs.length > 0) {
    for (const output of outputs) {
      if (output.classes) {
        // Log all classes for debugging
        const relevantClasses = output.classes.filter(c => c.score > 0.1);
        console.log('[Hive] Classes with score > 0.1:', relevantClasses.map(c => `${c.class}:${c.score.toFixed(3)}`));

        const aiClass = output.classes.find(c =>
          c.class === 'ai_generated' || c.class === 'deepfake' || c.class === 'yes_deepfake'
        );
        if (aiClass) {
          console.log('[Hive] Found AI class:', aiClass.class, 'score:', aiClass.score);
          aiScore = Math.max(aiScore, aiClass.score);
        }
      }
    }
  } else {
    console.log('[Hive] No outputs found. Raw data keys:', Object.keys(data));
  }

  let verdict: 'authentic' | 'uncertain' | 'likely_ai' = 'uncertain';
  if (aiScore < 0.3) verdict = 'authentic';
  else if (aiScore > 0.7) verdict = 'likely_ai';

  // Warn if score is suspiciously zero - likely means we're parsing wrong
  if (aiScore === 0 && outputs && outputs.length > 0) {
    console.warn('[Hive] WARNING: aiScore is 0 despite having outputs. Check response parsing.',
      JSON.stringify(data).substring(0, 500));
  }

  console.log('[Hive] Final score:', aiScore, 'verdict:', verdict);
  return { score: aiScore, verdict, raw: data };
}

async function handleListJobs(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM jobs').first<{ count: number }>();
  const total = countResult?.count || 0;
  const totalPages = Math.ceil(total / limit);

  // Get paginated jobs
  const { results: rows } = await env.DB.prepare(
    'SELECT * FROM jobs ORDER BY submitted_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all<JobRow>();

  const jobs = rows.map(rowToJob);

  return new Response(JSON.stringify({
    jobs,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleGetJob(jobId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ?'
  ).bind(jobId).first<JobRow>();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(rowToJob(row)), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleDeleteJob(jobId: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    'DELETE FROM jobs WHERE event_id = ?'
  ).bind(jobId).run();

  if (result.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[Delete] Deleted job ${jobId}`);
  return new Response(JSON.stringify({ success: true, deleted: jobId }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Handle moderation action request
async function handleModerateJob(jobId: string, request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { action: string; reason?: string };
  const action = body.action?.toUpperCase() as ModerationAction['action'];

  if (!['PERMANENT_BAN', 'REVIEW', 'AGE_RESTRICTED', 'SAFE'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action. Must be PERMANENT_BAN, REVIEW, AGE_RESTRICTED, or SAFE' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get the job to find the media_hash
  const row = await env.DB.prepare(
    'SELECT media_hash, video_url FROM jobs WHERE event_id = ?'
  ).bind(jobId).first<{ media_hash: string; video_url: string }>();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const requestId = crypto.randomUUID();
  const message: ModerationAction = {
    type: 'moderation-action',
    sha256: row.media_hash,
    action: action,
    reason: body.reason || `AI detection triggered ${action}`,
    source: 'realness-admin',
    requestId: requestId,
  };

  // Send to the action queue
  await env.ACTION_QUEUE.send(message);

  // Update local job with pending action
  await env.DB.prepare(
    `UPDATE jobs SET
      moderation_action = ?,
      moderation_status = 'pending',
      moderation_request_id = ?
    WHERE event_id = ?`
  ).bind(action, requestId, jobId).run();

  console.log(`[Moderate] Sent ${action} action for job ${jobId} (sha256: ${row.media_hash})`);

  return new Response(JSON.stringify({
    success: true,
    jobId: jobId,
    action: action,
    sha256: row.media_hash,
    requestId: requestId,
    status: 'pending',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleWebhook(provider: string, request: Request, env: Env): Promise<Response> {
  const payload = await request.json() as Record<string, unknown>;
  console.log(`Webhook from ${provider}:`, payload);

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handlePollResults(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = await request.json() as { jobId: string };
  const row = await env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ?'
  ).bind(body.jobId).first<JobRow>();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const job = rowToJob(row);
  const rdResult = job.results['reality_defender'];

  if (rdResult?.status === 'pending' && rdResult.requestId) {
    try {
      const result = await pollRealityDefender(rdResult.requestId, env);
      if (result) {
        job.results['reality_defender'] = {
          ...rdResult,
          status: 'complete',
          score: result.score,
          verdict: result.verdict,
          raw: result.raw,
        };
        job.status = 'complete';
        job.completed_at = new Date().toISOString();

        // Update job in D1
        await env.DB.prepare(
          `UPDATE jobs SET status = ?, completed_at = ?, results = ?, updated_at = ?
           WHERE event_id = ?`
        ).bind(
          job.status,
          job.completed_at,
          JSON.stringify(job.results),
          new Date().toISOString(),
          body.jobId
        ).run();

        // Call webhook if configured
        if (job.webhook_url && !job.webhook_called && ctx) {
          ctx.waitUntil(callWebhook(job, env));
        }
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }

  return new Response(JSON.stringify(job), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleApiAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.json() as { nevent: string; webhookUrl: string };

  if (!body.nevent) {
    return new Response(JSON.stringify({ error: 'Missing nevent' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.webhookUrl) {
    return new Response(JSON.stringify({ error: 'Missing webhookUrl' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const eventId = body.nevent;

  // Check for existing job
  const existingRow = await env.DB.prepare(
    'SELECT * FROM jobs WHERE event_id = ?'
  ).bind(eventId).first<JobRow>();

  if (existingRow) {
    const job = rowToJob(existingRow);
    // If job is complete and has results, call webhook immediately
    if (job.status === 'complete' && !job.webhook_called) {
      ctx.waitUntil(callWebhook(job, env));
    }
    return new Response(JSON.stringify({
      jobId: eventId,
      status: job.status,
      message: 'Job already exists',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch the Nostr event to get video URL
  let hexEventId = eventId;
  try {
    hexEventId = decodeNevent(eventId);
  } catch {
    // Assume it's already a hex ID if decoding fails
    if (!/^[0-9a-fA-F]{64}$/.test(eventId)) {
      return new Response(JSON.stringify({ error: 'Invalid event ID format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Fetch from Nostr gateway
  const gatewayUrl = `https://cleanly-resolved-tetra.edgecompute.app/event/${hexEventId}`;
  const eventResp = await fetch(gatewayUrl);
  if (!eventResp.ok) {
    return new Response(JSON.stringify({ error: 'Failed to fetch Nostr event' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  interface NostrEvent {
    events: Array<{
      tags: string[][];
    }>;
  }

  const eventData = await eventResp.json() as NostrEvent;
  if (!eventData.events?.length) {
    return new Response(JSON.stringify({ error: 'Event not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const event = eventData.events[0];
  const imetaTag = event.tags.find(t => t[0] === 'imeta');
  if (!imetaTag) {
    return new Response(JSON.stringify({ error: 'No video metadata in event' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse imeta tag (NIP-71/NIP-94 format)
  let videoUrl: string | null = null;
  let mediaHash: string | null = null;
  for (let i = 1; i < imetaTag.length; i++) {
    const part = imetaTag[i];
    if (part.startsWith('url ')) videoUrl = part.substring(4);
    else if (part.startsWith('x ')) mediaHash = part.substring(2);
    else if (part === 'url' && i + 1 < imetaTag.length) videoUrl = imetaTag[++i];
    else if (part === 'x' && i + 1 < imetaTag.length) mediaHash = imetaTag[++i];
  }

  if (!videoUrl) {
    return new Response(JSON.stringify({ error: 'No video URL in event metadata' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results: Record<string, DetectionResult> = {};

  // Submit to Reality Defender
  const baseUrl = new URL(request.url).origin;

  try {
    const rdResult = await submitToRealityDefender(videoUrl, `${baseUrl}/webhook/reality_defender`, env);
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'pending',
      requestId: rdResult.requestId,
    };
  } catch (error) {
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'error',
      error: String(error),
    };
  }

  // Submit to Hive AI (synchronous API)
  if (env.HIVE_API_KEY) {
    try {
      const hiveResult = await submitToHive(videoUrl, env);
      results['hive'] = {
        provider: 'hive',
        status: 'complete',
        score: hiveResult.score,
        verdict: hiveResult.verdict,
        raw: hiveResult.raw,
      };
    } catch (error) {
      results['hive'] = {
        provider: 'hive',
        status: 'error',
        error: String(error),
      };
    }
  }

  // Check if job is already complete (Hive done, Reality Defender errored)
  const allComplete = Object.values(results).every(r => r.status === 'complete' || r.status === 'error');
  const status = allComplete ? 'complete' : 'pending';
  const completedAt = allComplete ? new Date().toISOString() : null;

  // Insert job into D1
  await env.DB.prepare(
    `INSERT INTO jobs (event_id, media_hash, video_url, status, submitted_at, completed_at, webhook_url, results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    eventId,
    mediaHash || await hashString(videoUrl),
    videoUrl,
    status,
    new Date().toISOString(),
    completedAt,
    body.webhookUrl,
    JSON.stringify(results)
  ).run();

  // Call webhook if already complete
  if (allComplete) {
    const job: Job = {
      event_id: eventId,
      media_hash: mediaHash || await hashString(videoUrl),
      video_url: videoUrl,
      status: 'complete',
      submitted_at: new Date().toISOString(),
      completed_at: completedAt || undefined,
      results,
      webhook_url: body.webhookUrl,
      webhook_called: false,
    };
    ctx.waitUntil(callWebhook(job, env));
  }

  return new Response(JSON.stringify({
    jobId: eventId,
    status,
    message: 'Analysis started',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function decodeNevent(nevent: string): string {
  const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const str = nevent.toLowerCase();
  const sepIdx = str.lastIndexOf('1');
  if (sepIdx < 1) throw new Error('Invalid bech32');
  const hrp = str.slice(0, sepIdx);
  const dataStr = str.slice(sepIdx + 1);
  const data: number[] = [];
  for (const c of dataStr) {
    const idx = BECH32_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Invalid character');
    data.push(idx);
  }
  const values = data.slice(0, -6);
  let acc = 0, bits = 0;
  const bytes: number[] = [];
  for (const v of values) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  const byteArray = new Uint8Array(bytes);

  // For note1..., it's just the 32-byte event ID
  if (hrp === 'note') {
    return Array.from(byteArray.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // For nevent1..., parse TLV structure
  let i = 0;
  while (i < byteArray.length) {
    const type = byteArray[i];
    const len = byteArray[i + 1];
    if (type === 0 && len === 32) {
      return Array.from(byteArray.slice(i + 2, i + 2 + 32)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    i += 2 + len;
  }
  throw new Error('No event ID found in nevent');
}

async function callWebhook(job: Job, env: Env): Promise<void> {
  if (!job.webhook_url || job.webhook_called) return;

  try {
    const response = await fetch(job.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Realness/1.0',
      },
      body: JSON.stringify({
        eventId: job.event_id,
        status: job.status,
        videoUrl: job.video_url,
        mediaHash: job.media_hash,
        submitted: job.submitted_at,
        completed: job.completed_at,
        results: job.results,
      }),
    });

    if (response.ok) {
      await env.DB.prepare(
        'UPDATE jobs SET webhook_called = 1, updated_at = ? WHERE event_id = ?'
      ).bind(new Date().toISOString(), job.event_id).run();
    } else {
      console.error(`Webhook failed: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
}

async function pollRealityDefender(
  requestId: string,
  env: Env
): Promise<{ score: number; verdict: 'authentic' | 'uncertain' | 'likely_ai'; raw: unknown } | null> {
  const RD_API_BASE = 'https://api.prd.realitydefender.xyz';

  const response = await fetch(`${RD_API_BASE}/api/media/users/${requestId}`, {
    method: 'GET',
    headers: {
      'X-API-KEY': env.REALITY_DEFENDER_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Divine-AI-Detector/1.0',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to poll results: ${response.status}`);
  }

  interface RDResult {
    requestId?: string;
    filename?: string;
    mediaType?: string;
    resultsSummary?: {
      status?: 'AUTHENTIC' | 'FAKE' | 'SUSPICIOUS' | 'NOT_APPLICABLE' | 'UNABLE_TO_EVALUATE';
      metadata?: {
        finalScore?: number;
        languages?: string[];
      };
      error?: {
        code?: string;
        message?: string;
      };
      reasons?: Array<{
        code?: string;
        message?: string;
      }>;
    };
    models?: Array<{
      name: string;
      status: string;
      data?: { score?: number };
      finalScore?: number;
    }>;
  }

  const data = await response.json() as RDResult;

  // Log the raw response structure to debug parsing issues
  console.log('[RealityDefender] Raw response keys:', Object.keys(data));
  console.log('[RealityDefender] resultsSummary:', JSON.stringify(data.resultsSummary));

  // Check if results are ready - status is in resultsSummary.status, not overallStatus
  const rdStatus = data.resultsSummary?.status;
  if (!rdStatus) {
    console.log('[RealityDefender] Still processing, no resultsSummary.status yet');
    return null; // Still processing
  }

  // Extract score from resultsSummary (0-100 scale)
  const finalScore = data.resultsSummary?.metadata?.finalScore ?? 0;
  let score = finalScore / 100; // Normalize to 0-1

  // Map Reality Defender status to our verdict
  let verdict: 'authentic' | 'uncertain' | 'likely_ai' = 'uncertain';
  if (rdStatus === 'AUTHENTIC') {
    verdict = 'authentic';
    // If status says authentic but no score, use a low score
    if (score === 0) score = 0.1;
  } else if (rdStatus === 'FAKE') {
    verdict = 'likely_ai';
    // If status says FAKE but finalScore is missing, use high score
    if (score === 0) score = 0.95;
  } else if (rdStatus === 'SUSPICIOUS') {
    verdict = 'likely_ai';
    if (score === 0) score = 0.7;
  } else if (rdStatus === 'NOT_APPLICABLE' || rdStatus === 'UNABLE_TO_EVALUATE') {
    verdict = 'uncertain';
  }

  console.log('[RealityDefender] Status:', rdStatus, 'FinalScore:', finalScore, 'ComputedScore:', score, 'Verdict:', verdict);

  return { score, verdict, raw: data };
}

async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Queue helper functions

function shouldAnalyzeEvent(event: NostrEvent): boolean {
  // Trusted divine.video server hosts - no need to check these
  const trustedHosts = ['blossom.divine.video', 'cdn.divine.video'];

  // Check for proofmode tags (verified camera capture)
  const hasProofmode = event.tags.some(t => t[0] === 'proofmode' || t[0] === 'proof');
  if (hasProofmode) {
    console.log(`[Queue] Event has proofmode - skipping`);
    return false;
  }

  // Check if from divine.video client (trusted source)
  const clientTag = event.tags.find(t => t[0] === 'client');
  if (clientTag && clientTag[1]?.includes('divine.video')) {
    console.log(`[Queue] Event from divine.video client - skipping`);
    return false;
  }

  // Extract video URL to check hosting
  const videoUrl = extractVideoUrl(event);
  if (videoUrl) {
    try {
      const url = new URL(videoUrl);
      if (trustedHosts.includes(url.hostname)) {
        console.log(`[Queue] Video hosted on trusted server ${url.hostname} - skipping`);
        return false;
      }
    } catch {
      // Invalid URL, continue to analyze
    }
  }

  // Check if event has a report (NIP-56 kind 1984)
  const hasReportTag = event.tags.some(t => t[0] === 'report' || (t[0] === 'e' && t[3] === 'report'));
  if (hasReportTag) {
    console.log(`[Queue] Event has report - should analyze`);
    return true;
  }

  // Default: analyze videos from untrusted sources
  console.log(`[Queue] Event from untrusted source - should analyze`);
  return true;
}

function extractVideoUrl(event: NostrEvent): string | null {
  // Look for imeta tag (NIP-92)
  const imetaTag = event.tags.find(t => t[0] === 'imeta');
  if (imetaTag) {
    for (let i = 1; i < imetaTag.length; i++) {
      const part = imetaTag[i];
      if (part.startsWith('url ')) return part.substring(4);
      if (part === 'url' && i + 1 < imetaTag.length) return imetaTag[++i];
    }
  }

  // Look for video/media tag
  const mediaTag = event.tags.find(t => t[0] === 'media' || t[0] === 'video');
  if (mediaTag && mediaTag[1]) return mediaTag[1];

  // Look for URL in content that looks like a video
  const videoRegex = /(https?:\/\/[^\s]+\.(mp4|mov|webm|avi|mkv)(\?[^\s]*)?)/i;
  const match = event.content.match(videoRegex);
  if (match) return match[1];

  return null;
}

async function analyzeFromQueue(event: NostrEvent, videoUrl: string, env: Env): Promise<void> {
  const mediaHash = await hashString(videoUrl);
  const results: Record<string, DetectionResult> = {};

  // Submit to Reality Defender
  try {
    const rdResult = await submitToRealityDefender(videoUrl, '', env);
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'pending',
      requestId: rdResult.requestId,
    };
  } catch (error) {
    console.error('[Queue] Reality Defender error:', error);
    results['reality_defender'] = {
      provider: 'reality_defender',
      status: 'error',
      error: String(error),
    };
  }

  // Submit to Hive AI (synchronous)
  if (env.HIVE_API_KEY) {
    try {
      const hiveResult = await submitToHive(videoUrl, env);
      results['hive'] = {
        provider: 'hive',
        status: 'complete',
        score: hiveResult.score,
        verdict: hiveResult.verdict,
        raw: hiveResult.raw,
      };
    } catch (error) {
      console.error('[Queue] Hive error:', error);
      results['hive'] = {
        provider: 'hive',
        status: 'error',
        error: String(error),
      };
    }
  }

  // Check if all providers are done
  const allComplete = Object.values(results).every(r => r.status === 'complete' || r.status === 'error');
  const status = allComplete ? 'complete' : 'pending';
  const completedAt = allComplete ? new Date().toISOString() : null;

  // Insert job into D1
  await env.DB.prepare(
    `INSERT INTO jobs (event_id, media_hash, video_url, status, submitted_at, completed_at, results)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    event.id,
    mediaHash,
    videoUrl,
    status,
    new Date().toISOString(),
    completedAt,
    JSON.stringify(results)
  ).run();

  console.log(`[Queue] Job created for event ${event.id}, status: ${status}`);
}

function serveDashboard(): Response {
  const html = getDashboardHtml();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Realness</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@300;400;500;600&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: #0a0a0a;
            color: #f5f5f5;
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        header {
            text-align: center;
            margin-bottom: 60px;
            padding: 40px 20px;
            position: relative;
        }
        header::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 400px;
            height: 400px;
            background: radial-gradient(circle, rgba(212,175,55,0.15) 0%, transparent 70%);
            pointer-events: none;
        }
        h1 {
            font-family: 'Playfair Display', serif;
            font-size: 5rem;
            font-weight: 900;
            background: linear-gradient(135deg, #d4af37 0%, #f4e4a6 25%, #d4af37 50%, #aa8c2c 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            margin-bottom: 16px;
            text-shadow: 0 0 80px rgba(212,175,55,0.3);
        }
        .tagline {
            font-size: 1.1rem;
            font-weight: 300;
            color: #888;
            letter-spacing: 0.3em;
            text-transform: uppercase;
        }
        .tagline em {
            font-style: normal;
            color: #d4af37;
        }
        .submit-section {
            background: linear-gradient(135deg, rgba(212,175,55,0.05) 0%, rgba(0,0,0,0.3) 100%);
            border-radius: 2px;
            padding: 40px;
            margin-bottom: 60px;
            border: 1px solid rgba(212,175,55,0.2);
            position: relative;
        }
        .submit-section::before {
            content: '';
            position: absolute;
            top: -1px;
            left: 20%;
            right: 20%;
            height: 1px;
            background: linear-gradient(90deg, transparent, #d4af37, transparent);
        }
        .input-group { display: flex; gap: 12px; margin-bottom: 12px; }
        input[type="text"] {
            flex: 1;
            padding: 16px 20px;
            background: rgba(0,0,0,0.5);
            border: 1px solid rgba(212,175,55,0.3);
            border-radius: 2px;
            color: #f5f5f5;
            font-size: 1rem;
            font-family: 'Inter', sans-serif;
            transition: all 0.3s ease;
        }
        input:focus { outline: none; border-color: #d4af37; box-shadow: 0 0 20px rgba(212,175,55,0.1); }
        input::placeholder { color: #555; }
        button {
            padding: 16px 40px;
            background: linear-gradient(135deg, #d4af37 0%, #aa8c2c 100%);
            border: none;
            border-radius: 2px;
            color: #0a0a0a;
            font-weight: 600;
            font-size: 0.9rem;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        button:hover { box-shadow: 0 0 30px rgba(212,175,55,0.3); transform: translateY(-1px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
        .help-text { color: #555; font-size: 0.85rem; letter-spacing: 0.05em; }
        .error-message {
            background: rgba(200,50,50,0.1);
            border: 1px solid rgba(200,50,50,0.3);
            color: #e57373;
            padding: 14px;
            border-radius: 2px;
            margin-top: 16px;
            display: none;
            font-size: 0.9rem;
        }
        .error-message.visible { display: block; }
        .section-title {
            font-family: 'Playfair Display', serif;
            font-size: 1.5rem;
            color: #d4af37;
            margin-bottom: 30px;
            letter-spacing: 0.1em;
        }
        .job-card {
            background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(0,0,0,0.2) 100%);
            border-radius: 2px;
            padding: 30px;
            margin-bottom: 24px;
            border: 1px solid rgba(255,255,255,0.08);
            transition: all 0.3s ease;
        }
        .job-card:hover { border-color: rgba(212,175,55,0.3); }
        .job-card.highlighted {
            border-color: #d4af37;
            box-shadow: 0 0 30px rgba(212,175,55,0.3);
            animation: highlight-pulse 2s ease-out;
        }
        @keyframes highlight-pulse {
            0% { box-shadow: 0 0 40px rgba(212,175,55,0.5); }
            100% { box-shadow: 0 0 30px rgba(212,175,55,0.3); }
        }
        .job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .job-id { font-family: 'SF Mono', Monaco, monospace; color: #888; font-size: 0.8rem; display: flex; align-items: center; gap: 10px; }
        .job-id-text { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .copy-btn {
            background: transparent;
            border: 1px solid rgba(212,175,55,0.3);
            color: #d4af37;
            padding: 4px 10px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 0.7rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            transition: all 0.2s ease;
        }
        .copy-btn:hover { background: rgba(212,175,55,0.1); }
        .copy-btn.copied { background: rgba(212,175,55,0.2); border-color: #d4af37; }
        .rerun-btn {
            background: transparent;
            border: 1px solid rgba(232,130,180,0.4);
            color: #e882b4;
            padding: 4px 10px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 0.7rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            transition: all 0.2s ease;
            margin-left: 8px;
        }
        .rerun-btn:hover { background: rgba(232,130,180,0.15); }
        .rerun-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .job-status {
            padding: 6px 16px;
            border-radius: 2px;
            font-size: 0.7rem;
            font-weight: 600;
            letter-spacing: 0.15em;
            text-transform: uppercase;
        }
        .status-pending { background: rgba(212,175,55,0.15); color: #d4af37; border: 1px solid rgba(212,175,55,0.3); }
        .status-complete { background: rgba(80,200,120,0.15); color: #50c878; border: 1px solid rgba(80,200,120,0.3); }
        .status-error { background: rgba(200,50,50,0.15); color: #e57373; border: 1px solid rgba(200,50,50,0.3); }
        .job-content { display: flex; gap: 30px; align-items: flex-start; flex-wrap: wrap; }
        .video-preview { flex-shrink: 0; }
        .video-preview video { background: #000; border: 1px solid rgba(255,255,255,0.1); }
        .provider-grid { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; min-width: 250px; }
        .provider-card {
            background: rgba(0,0,0,0.4);
            border-radius: 2px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.05);
            text-align: center;
        }
        .provider-name {
            font-size: 0.75rem;
            font-weight: 500;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: #666;
            margin-bottom: 12px;
        }
        .provider-score { font-size: 2.5rem; font-weight: 300; }
        .verdict {
            font-size: 0.8rem;
            letter-spacing: 0.15em;
            text-transform: uppercase;
            margin-top: 8px;
        }
        .score-authentic { color: #50c878; }
        .score-uncertain { color: #d4af37; }
        .score-likely_ai { color: #e57373; }
        .empty-state {
            text-align: center;
            padding: 80px 40px;
            color: #444;
            font-size: 1.1rem;
            letter-spacing: 0.05em;
        }
        .empty-state span { color: #d4af37; }
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 16px;
            margin-top: 40px;
            padding: 20px;
        }
        .pagination button {
            padding: 10px 24px;
            background: transparent;
            border: 1px solid rgba(212,175,55,0.3);
            color: #d4af37;
            font-size: 0.8rem;
        }
        .pagination button:hover:not(:disabled) {
            background: rgba(212,175,55,0.1);
            box-shadow: none;
            transform: none;
        }
        .pagination button:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        .pagination-info {
            color: #666;
            font-size: 0.85rem;
            letter-spacing: 0.05em;
        }
        .pagination-info span { color: #d4af37; }

        /* Modal styles */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.9);
            z-index: 1000;
            overflow-y: auto;
        }
        .modal-overlay.visible { display: flex; justify-content: center; padding: 40px 20px; }
        .modal {
            background: #0d0d0d;
            border: 1px solid rgba(212,175,55,0.3);
            border-radius: 8px;
            max-width: 700px;
            width: 100%;
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px 28px;
            border-bottom: 1px solid rgba(212,175,55,0.15);
        }
        .modal-header h2 {
            font-family: 'Playfair Display', serif;
            color: #d4af37;
            font-size: 1.4rem;
            margin: 0;
            font-style: italic;
        }
        .modal-close {
            background: none; border: none; color: #666;
            font-size: 1.8rem; cursor: pointer; padding: 0; line-height: 1;
        }
        .modal-close:hover { color: #d4af37; }
        .modal-body { padding: 28px; }

        .detector-grid {
            display: flex;
            gap: 16px;
            flex: 1;
            min-width: 320px;
        }
        .detector-card {
            background: rgba(255,255,255,0.02);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 6px;
            padding: 16px 20px;
            text-align: center;
            flex: 1;
            min-width: 140px;
        }
        .detector-card h3 {
            color: #777;
            font-size: 0.65rem;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            margin: 0 0 12px 0;
            font-weight: 600;
        }
        .score-ring {
            width: 80px; height: 80px;
            margin: 0 auto 10px;
            position: relative;
        }
        .score-ring svg { transform: rotate(-90deg); }
        .score-ring circle {
            fill: none;
            stroke-width: 6;
        }
        .score-ring .bg { stroke: rgba(255,255,255,0.08); }
        .score-ring .fg { stroke-linecap: round; transition: stroke-dashoffset 0.5s ease; }
        .score-ring .fg.fake { stroke: #e57373; }
        .score-ring .fg.authentic { stroke: #81c784; }
        .score-ring .fg.uncertain { stroke: #d4af37; }
        .score-value {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            font-size: 1.3rem;
            font-weight: 700;
            color: #fff;
        }
        .verdict-label {
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 12px;
        }
        .verdict-label.fake { color: #e57373; }
        .verdict-label.authentic { color: #81c784; }
        .verdict-label.uncertain { color: #d4af37; }

        .detail-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-top: 1px solid rgba(255,255,255,0.04);
            font-size: 0.7rem;
        }
        .detail-item:first-of-type { border-top: none; margin-top: 8px; }
        .detail-item .label { color: #555; }
        .detail-item .value { color: #aaa; font-weight: 500; }

        .source-tag {
            display: inline-block;
            background: rgba(212,175,55,0.15);
            border: 1px solid rgba(212,175,55,0.3);
            color: #d4af37;
            padding: 4px 10px;
            border-radius: 3px;
            font-size: 0.65rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 8px;
        }

        .no-data {
            color: #444;
            font-size: 0.75rem;
            padding: 20px 0;
        }

        /* Moderation action buttons */
        .moderation-actions {
            display: flex;
            gap: 8px;
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid rgba(255,255,255,0.06);
            flex-wrap: wrap;
        }
        .action-btn {
            padding: 8px 14px;
            border-radius: 3px;
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            cursor: pointer;
            transition: all 0.2s ease;
            border: 1px solid;
        }
        .action-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .action-btn.ban {
            background: rgba(229,115,115,0.15);
            border-color: rgba(229,115,115,0.4);
            color: #e57373;
        }
        .action-btn.ban:hover:not(:disabled) {
            background: rgba(229,115,115,0.25);
        }
        .action-btn.review {
            background: rgba(212,175,55,0.15);
            border-color: rgba(212,175,55,0.4);
            color: #d4af37;
        }
        .action-btn.review:hover:not(:disabled) {
            background: rgba(212,175,55,0.25);
        }
        .action-btn.age {
            background: rgba(255,183,77,0.15);
            border-color: rgba(255,183,77,0.4);
            color: #ffb74d;
        }
        .action-btn.age:hover:not(:disabled) {
            background: rgba(255,183,77,0.25);
        }
        .action-btn.safe {
            background: rgba(129,199,132,0.15);
            border-color: rgba(129,199,132,0.4);
            color: #81c784;
        }
        .action-btn.safe:hover:not(:disabled) {
            background: rgba(129,199,132,0.25);
        }
        .moderation-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.75rem;
            padding: 8px 12px;
            border-radius: 3px;
            background: rgba(0,0,0,0.3);
        }
        .moderation-status.pending { color: #d4af37; }
        .moderation-status.success { color: #81c784; }
        .moderation-status.error { color: #e57373; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Realness</h1>
            <p class="tagline">The children are <em>watching</em></p>
        </header>

        <div class="submit-section">
            <div class="input-group">
                <input type="text" id="eventInput" placeholder="Enter nevent or note ID to read..." />
                <button id="submitBtn" onclick="submitEvent()">Read</button>
            </div>
            <p class="help-text">Drop a Nostr video event and let the judges deliberate</p>
            <div id="errorMessage" class="error-message"></div>
        </div>

        <div class="jobs-section">
            <h2 class="section-title">The Runway</h2>
            <div id="jobsList"></div>
        </div>
    </div>

    <script>
        const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

        function bech32Decode(str) {
            str = str.toLowerCase();
            const sepIdx = str.lastIndexOf('1');
            if (sepIdx < 1) throw new Error('Invalid bech32');
            const hrp = str.slice(0, sepIdx);
            const dataStr = str.slice(sepIdx + 1);
            const data = [];
            for (const c of dataStr) {
                const idx = BECH32_ALPHABET.indexOf(c);
                if (idx === -1) throw new Error('Invalid character');
                data.push(idx);
            }
            const values = data.slice(0, -6);
            let acc = 0, bits = 0;
            const bytes = [];
            for (const v of values) {
                acc = (acc << 5) | v;
                bits += 5;
                while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
            }
            return { hrp, bytes: new Uint8Array(bytes) };
        }

        function decodeNevent(nevent) {
            const { hrp, bytes } = bech32Decode(nevent);
            if (hrp === 'note') return Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
            let i = 0;
            while (i < bytes.length) {
                const type = bytes[i], len = bytes[i + 1];
                if (type === 0 && len === 32) return Array.from(bytes.slice(i + 2, i + 2 + 32)).map(b => b.toString(16).padStart(2, '0')).join('');
                i += 2 + len;
            }
            throw new Error('No event ID found');
        }

        async function submitEvent() {
            const input = document.getElementById('eventInput');
            const eventId = input.value.trim();
            const submitBtn = document.getElementById('submitBtn');
            const errorMsg = document.getElementById('errorMessage');
            errorMsg.classList.remove('visible');

            if (!eventId) { showError('Please enter an event ID'); return; }

            const isNevent = eventId.startsWith('nevent1') || eventId.startsWith('note1');
            const isHex = /^[0-9a-fA-F]{64}$/.test(eventId);
            if (!isNevent && !isHex) { showError('Invalid event ID format'); return; }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Fetching...';

            try {
                let hexEventId = eventId;
                if (isNevent) hexEventId = decodeNevent(eventId);

                const gatewayUrl = \`https://cleanly-resolved-tetra.edgecompute.app/event/\${hexEventId}\`;
                const eventResp = await fetch(gatewayUrl);
                const data = await eventResp.json();
                if (!data.events?.length) throw new Error('Event not found');

                const event = data.events[0];
                const imetaTag = event.tags.find(t => t[0] === 'imeta');
                if (!imetaTag) throw new Error('No video metadata');

                let videoUrl = null, mediaHash = null;
                for (let i = 1; i < imetaTag.length; i++) {
                    const part = imetaTag[i];
                    if (part.startsWith('url ')) videoUrl = part.substring(4);
                    else if (part.startsWith('x ')) mediaHash = part.substring(2);
                    else if (part === 'url' && i + 1 < imetaTag.length) videoUrl = imetaTag[++i];
                    else if (part === 'x' && i + 1 < imetaTag.length) mediaHash = imetaTag[++i];
                }
                if (!videoUrl) throw new Error('No video URL found');

                submitBtn.textContent = 'Analyzing...';
                const response = await fetch('/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eventId, videoUrl, mediaHash }),
                });
                if (!response.ok) throw new Error(await response.text());

                input.value = '';
                loadJobs();
            } catch (error) {
                showError(error.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Analyze Event';
            }
        }

        function showError(msg) {
            const el = document.getElementById('errorMessage');
            el.textContent = msg;
            el.classList.add('visible');
        }

        function copyToClipboard(text, btn) {
            navigator.clipboard.writeText(text).then(() => {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = 'Copy';
                    btn.classList.remove('copied');
                }, 2000);
            });
        }

        async function rerunJob(eventId, videoUrl) {
            const btn = event.target;
            const originalText = btn.textContent;
            btn.textContent = 'Sashaying...';
            btn.disabled = true;

            try {
                // Delete the old job
                const deleteRes = await fetch('/api/jobs/' + eventId, { method: 'DELETE' });
                if (!deleteRes.ok) {
                    throw new Error('Failed to clear old reading');
                }

                // Resubmit for analysis
                const analyzeRes = await fetch('/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eventId: eventId, videoUrl: videoUrl })
                });

                if (!analyzeRes.ok) {
                    throw new Error('Failed to resubmit');
                }

                btn.textContent = 'Werking...';
                lastJobsHash = ''; // Force refresh
                loadJobs(currentPage);

                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }, 2000);
            } catch (err) {
                btn.textContent = 'Choked!';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }, 2000);
                console.error('Rerun failed:', err);
            }
        }

        let currentPage = 1;
        let pagination = null;
        let lastJobsHash = '';

        async function loadJobs(page = 1) {
            try {
                const response = await fetch(\`/api/jobs?page=\${page}&limit=20\`);
                const data = await response.json();
                const jobs = data.jobs || [];
                pagination = data.pagination;
                currentPage = page;

                // Only re-render if data actually changed (prevents video reload)
                const jobsHash = JSON.stringify(jobs);
                if (jobsHash !== lastJobsHash) {
                    lastJobsHash = jobsHash;
                    renderJobs(jobs);
                    renderPagination();
                }
                cacheJobs(jobs); // Always cache for detail modal

                // Poll for results on pending jobs
                for (const job of jobs) {
                    if (job.status === 'pending' && job.results?.reality_defender?.requestId) {
                        pollJob(job.event_id);
                    }
                }
            } catch (e) { console.error(e); }
        }

        function renderPagination() {
            let paginationEl = document.getElementById('pagination');
            if (!paginationEl) {
                paginationEl = document.createElement('div');
                paginationEl.id = 'pagination';
                paginationEl.className = 'pagination';
                document.querySelector('.jobs-section').appendChild(paginationEl);
            }

            if (!pagination || pagination.total === 0) {
                paginationEl.innerHTML = '';
                return;
            }

            paginationEl.innerHTML = \`
                <button onclick="loadJobs(\${currentPage - 1})" \${!pagination.hasPrev ? 'disabled' : ''}>Previous</button>
                <span class="pagination-info">Page <span>\${pagination.page}</span> of <span>\${pagination.totalPages}</span> &middot; \${pagination.total} total</span>
                <button onclick="loadJobs(\${currentPage + 1})" \${!pagination.hasNext ? 'disabled' : ''}>Next</button>
            \`;
        }

        async function pollJob(jobId) {
            try {
                await fetch('/api/poll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId }),
                });
            } catch (e) { console.error('Poll error:', e); }
        }

        async function rerunJob(eventId, videoUrl, btn) {
            const originalText = btn.textContent;
            btn.textContent = 'Walking...';
            btn.disabled = true;
            try {
                // Delete the old job first
                const delResp = await fetch(\`/api/jobs/\${eventId}\`, { method: 'DELETE' });
                if (!delResp.ok) {
                    throw new Error('Failed to delete old job: ' + await delResp.text());
                }
                // Resubmit
                const analyzeResp = await fetch('/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eventId, videoUrl }),
                });
                if (!analyzeResp.ok) {
                    throw new Error('Failed to resubmit: ' + await analyzeResp.text());
                }
                // Small delay to ensure DB write completes
                await new Promise(r => setTimeout(r, 500));
                lastJobsHash = ''; // Force re-render
                await loadJobs(currentPage);
                // Poll immediately for pending jobs
                pollJob(eventId);
            } catch (e) {
                console.error('Rerun error:', e);
                alert('Rerun failed: ' + e.message);
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }

        function renderJobs(jobs) {
            const el = document.getElementById('jobsList');
            if (!jobs.length) {
                el.innerHTML = '<div class="empty-state"><p>The runway is empty.<br><span>Submit an event to begin the reading.</span></p></div>';
                return;
            }
            el.innerHTML = jobs.map(job => \`
                <div class="job-card" data-event-id="\${job.event_id}">
                    <div class="job-header">
                        <span class="job-id">
                            <span class="job-id-text" title="\${job.event_id}">\${job.event_id}</span>
                            <button class="copy-btn" onclick="copyToClipboard('\${job.event_id}', this)">Copy</button>
                        </span>
                        <button class="rerun-btn" onclick="rerunJob('\${job.event_id}', '\${job.video_url.replace(/'/g, "\\\\'")}', this)">Walk Again</button>
                        <span class="job-status status-\${job.status}">\${getStatusLabel(job.status)}</span>
                    </div>
                    <div class="job-content">
                        <div class="video-preview">
                            <video src="\${job.video_url}" controls preload="metadata" style="max-width: 300px; max-height: 200px; border-radius: 2px;"></video>
                            <div style="margin-top: 10px; font-size: 0.7rem; color: #555; word-break: break-all;">
                                <a href="\${job.video_url}" target="_blank" style="color: #888; text-decoration: none; border-bottom: 1px solid #333;">\${job.video_url.substring(0, 50)}...</a>
                            </div>
                        </div>
                        <div class="detector-grid">
                            \${renderDetectorCard('Reality Defender', job.results?.reality_defender)}
                            \${renderDetectorCard('Hive AI', job.results?.hive)}
                        </div>
                    </div>
                    \${renderModerationSection(job)}
                </div>
            \`).join('');
        }

        function getStatusLabel(status) {
            if (status === 'pending') return 'Deliberating';
            if (status === 'complete') return 'Read';
            if (status === 'error') return 'Chopped';
            return status;
        }

        function getVerdictLabel(verdict) {
            if (verdict === 'authentic') return 'Serving Realness';
            if (verdict === 'uncertain') return 'Questionable';
            if (verdict === 'likely_ai') return 'Category Is: Fake';
            return verdict || 'Unknown';
        }

        function renderProvider(name, result) {
            if (!result) return \`<div class="provider-card"><div class="provider-name">\${name}</div><div style="color:#444;">—</div></div>\`;
            if (result.status === 'error') return \`<div class="provider-card"><div class="provider-name">\${name}</div><div style="color:#e57373;font-size:0.8rem;">Chopped</div></div>\`;
            if (result.status === 'pending') return \`<div class="provider-card"><div class="provider-name">\${name}</div><div style="color:#d4af37;font-size:0.9rem;">Deliberating...</div></div>\`;
            const score = (result.score || 0) * 100;
            const verdictClass = result.verdict ? 'score-' + result.verdict : (score > 50 ? 'score-likely_ai' : 'score-authentic');
            return \`<div class="provider-card">
                <div class="provider-name">\${name}</div>
                <div class="provider-score \${verdictClass}">\${score.toFixed(0)}%</div>
                <div class="verdict \${verdictClass}">\${getVerdictLabel(result.verdict)}</div>
            </div>\`;
        }

        let jobsCache = {};

        function cacheJobs(jobs) {
            jobs.forEach(job => { jobsCache[job.event_id] = job; });
        }

        function showDetails(eventId) {
            const job = jobsCache[eventId];
            if (!job) return;

            const modal = document.getElementById('detailModal');
            const body = document.getElementById('modalBody');

            body.innerHTML = renderDetailedResults(job);
            modal.classList.add('visible');
        }

        function closeModal() {
            document.getElementById('detailModal').classList.remove('visible');
        }

        function renderDetailedResults(job) {
            const hive = job.results?.hive;
            const rd = job.results?.reality_defender;

            if (!hive && !rd) {
                return '<div class="no-data">The judges are still deliberating...</div>';
            }

            return '<div class="detector-grid">' +
                renderDetectorCard('Hive AI', hive) +
                renderDetectorCard('Reality Defender', rd) +
            '</div>';
        }

        function renderScoreRing(score, verdictClass) {
            const radius = 34;
            const circumference = 2 * Math.PI * radius;
            const offset = circumference - (score / 100) * circumference;
            return '<div class="score-ring">' +
                '<svg width="80" height="80">' +
                    '<circle class="bg" cx="40" cy="40" r="' + radius + '"/>' +
                    '<circle class="fg ' + verdictClass + '" cx="40" cy="40" r="' + radius + '" ' +
                        'stroke-dasharray="' + circumference + '" ' +
                        'stroke-dashoffset="' + offset + '"/>' +
                '</svg>' +
                '<div class="score-value">' + Math.round(score) + '%</div>' +
            '</div>';
        }

        function renderDetectorCard(name, result) {
            if (!result || result.status === 'pending') {
                return '<div class="detector-card"><h3>' + name + '</h3><div class="no-data">Deliberating...</div></div>';
            }
            if (result.status === 'error') {
                return '<div class="detector-card"><h3>' + name + '</h3><div class="no-data">Chopped</div></div>';
            }

            const score = (result.score || 0) * 100;
            const verdictClass = result.verdict === 'likely_ai' ? 'fake' : result.verdict === 'authentic' ? 'authentic' : 'uncertain';
            const verdictText = result.verdict === 'likely_ai' ? 'Category Is: Fake' : result.verdict === 'authentic' ? 'Serving Realness' : 'Questionable';

            let html = '<div class="detector-card">';
            html += '<h3>' + name + '</h3>';
            html += renderScoreRing(score, verdictClass);
            html += '<div class="verdict-label ' + verdictClass + '">' + verdictText + '</div>';

            // Provider-specific details
            if (name === 'Hive AI') {
                html += renderHiveExtras(result);
            } else {
                html += renderRDExtras(result);
            }

            html += '</div>';
            return html;
        }

        function renderHiveExtras(hive) {
            let html = '';
            const raw = hive.raw;

            if (raw?.status?.[0]?.response?.output) {
                const outputs = raw.status[0].response.output;
                let topSource = null;
                let deepfakeScore = 0;
                let frameCount = outputs.length;

                // Aggregate across all frames
                for (const output of outputs) {
                    if (output.classes) {
                        // Find top source model
                        const models = output.classes
                            .filter(c => c.score > 0.5 && !['ai_generated', 'not_ai_generated', 'deepfake', 'no_deepfake', 'yes_deepfake', 'none'].includes(c.class))
                            .sort((a, b) => b.score - a.score);
                        if (models.length > 0 && (!topSource || models[0].score > topSource.score)) {
                            topSource = models[0];
                        }

                        // Get deepfake score
                        const df = output.classes.find(c => c.class === 'yes_deepfake');
                        if (df && df.score > deepfakeScore) deepfakeScore = df.score;
                    }
                }

                if (topSource) {
                    html += '<div class="source-tag">Source: ' + topSource.class + '</div>';
                }

                html += '<div class="detail-item"><span class="label">Deepfake</span><span class="value">' + (deepfakeScore * 100).toFixed(1) + '%</span></div>';
                if (frameCount > 1) {
                    html += '<div class="detail-item"><span class="label">Frames analyzed</span><span class="value">' + frameCount + '</span></div>';
                }
            }

            return html;
        }

        function renderRDExtras(rd) {
            let html = '';
            const raw = rd.raw;

            if (raw?.resultsSummary?.status) {
                html += '<div class="detail-item"><span class="label">Status</span><span class="value">' + raw.resultsSummary.status + '</span></div>';
            }

            if (raw?.models && raw.models.length > 0) {
                html += '<div class="detail-item"><span class="label">Models run</span><span class="value">' + raw.models.length + '</span></div>';
            }

            return html;
        }

        function renderModerationSection(job) {
            // If moderation action is pending or complete, show status
            if (job.moderation_status) {
                const statusClass = job.moderation_status === 'success' ? 'success' :
                                   job.moderation_status === 'pending' ? 'pending' : 'error';
                const actionLabel = getModerationLabel(job.moderation_action);
                const statusText = job.moderation_status === 'success' ? 'Applied' :
                                   job.moderation_status === 'pending' ? 'Pending...' : 'Failed';
                return '<div class="moderation-actions">' +
                    '<div class="moderation-status ' + statusClass + '">' +
                        '<span>' + actionLabel + '</span>' +
                        '<span style="opacity:0.6">•</span>' +
                        '<span>' + statusText + '</span>' +
                        (job.moderation_error ? '<span style="opacity:0.6">(' + job.moderation_error + ')</span>' : '') +
                    '</div>' +
                '</div>';
            }

            // Show action buttons only if detection is complete
            if (job.status !== 'complete') {
                return '';
            }

            return '<div class="moderation-actions">' +
                '<button class="action-btn ban" onclick="takeAction(\\'' + job.event_id + '\\', \\'PERMANENT_BAN\\', this)">' +
                    '🚫 Ban' +
                '</button>' +
                '<button class="action-btn review" onclick="takeAction(\\'' + job.event_id + '\\', \\'REVIEW\\', this)">' +
                    '👀 Review' +
                '</button>' +
                '<button class="action-btn age" onclick="takeAction(\\'' + job.event_id + '\\', \\'AGE_RESTRICTED\\', this)">' +
                    '🔞 Age Restrict' +
                '</button>' +
                '<button class="action-btn safe" onclick="takeAction(\\'' + job.event_id + '\\', \\'SAFE\\', this)">' +
                    '✓ Safe' +
                '</button>' +
            '</div>';
        }

        function getModerationLabel(action) {
            switch (action) {
                case 'PERMANENT_BAN': return '🚫 Banned';
                case 'REVIEW': return '👀 In Review';
                case 'AGE_RESTRICTED': return '🔞 Age Restricted';
                case 'SAFE': return '✓ Marked Safe';
                default: return action || 'Unknown';
            }
        }

        async function takeAction(jobId, action, btn) {
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Sending...';

            try {
                const res = await fetch('/api/moderate/' + jobId, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: action })
                });

                const data = await res.json();

                if (!res.ok) {
                    throw new Error(data.error || 'Failed to send action');
                }

                // Refresh the job list to show the new status
                loadJobs(currentPage);
            } catch (e) {
                console.error('Action error:', e);
                alert('Action failed: ' + e.message);
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }

        // Check for deep link parameter
        const urlParams = new URLSearchParams(window.location.search);
        const targetEventId = urlParams.get('event');

        async function initPage() {
            await loadJobs();

            // If we have a target event, scroll to and highlight it
            if (targetEventId) {
                const card = document.querySelector(\`[data-event-id="\${targetEventId}"]\`);
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.classList.add('highlighted');
                }
            }
        }

        initPage();
        setInterval(() => loadJobs(currentPage), 5000);
    </script>

    <!-- Detail Modal -->
    <div id="detailModal" class="modal-overlay" onclick="if(event.target === this) closeModal()">
        <div class="modal">
            <div class="modal-header">
                <h2>The Reading</h2>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body" id="modalBody"></div>
        </div>
    </div>
</body>
</html>`;
}
