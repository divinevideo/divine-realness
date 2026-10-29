import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import TOML from '@iarna/toml';

export interface Target {
  name: string;
  routes: { pattern: string; zone_name: string }[];
  d1_databases: { binding: string; database_id: string }[];
  queues: { producers: { binding: string; queue: string }[]; consumers: { queue: string }[] };
  migrations: { tag: string }[];
}
interface Binding { name: string; type: string; id?: string; queue_name?: string; text?: string }
interface Deployment { id: string; versions: { version_id: string; percentage: number }[] }
interface Version { id: string; resources: { bindings: Binding[] } }
interface Service { default_environment: { environment: string; script: { migration_tag: string } } }
interface Queue { queue_id: string; queue_name: string }
export interface Context {
  event: string; ref: string; sha: string; enabled: string;
  approvedInputs: string; actualInputs: string; artifactSha: string;
}
export interface Dependencies {
  cf<T>(path: string): Promise<T>;
  main(): Promise<string>;
  deploy(): string;
  health(): Promise<void>;
  record(record: ReleaseRecord): void;
}
export interface ReleaseRecord {
  source_sha: string; environment: 'production'; worker: string;
  result: 'failed' | 'success'; stage: string; version_id?: string;
  previous?: Deployment; deployment?: Deployment;
}

export function inputDigest(root = '.'): string {
  const hash = createHash('sha256');
  for (const path of ['wrangler.toml', ...readdirSync(`${root}/migrations`).sort().map(p => `migrations/${p}`)]) {
    hash.update(path + '\0').update(readFileSync(`${root}/${path}`)).update('\0');
  }
  return hash.digest('hex');
}

class ReleaseError extends Error {}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReleaseError(message);
}

function deploymentReceipt(deployment: Deployment): Deployment {
  return { id: deployment.id, versions: deployment.versions.map(v => ({
    version_id: v.version_id, percentage: v.percentage,
  })) };
}

export async function release(context: Context, target: Target, deps: Dependencies): Promise<void> {
  const record: ReleaseRecord = {
    source_sha: context.sha, environment: 'production', worker: target.name,
    result: 'failed', stage: 'guards',
  };
  try {
    requireThat(['push', 'workflow_dispatch'].includes(context.event) && context.ref === 'refs/heads/main',
      'Only main pushes or explicit main replays may deploy');
    requireThat(/^[a-f0-9]{40}$/.test(context.sha) && context.artifactSha === context.sha,
      'Build artifact must identify the checked source SHA');
    requireThat(context.enabled === 'true', 'Production activation has not been enabled; see docs/deployment.md');
    requireThat(/^[a-f0-9]{64}$/.test(context.approvedInputs) && context.approvedInputs === context.actualInputs,
      'Configuration/migrations need operator verification before deployment');
    requireThat(await deps.main() === context.sha, 'Refusing stale main run');

    record.stage = 'preflight';
    const script = `workers/scripts/${target.name}`;
    const service = await deps.cf<Service>(`workers/services/${target.name}`);
    requireThat(service.default_environment.environment === 'production', 'Unexpected Worker environment');
    requireThat(target.migrations.at(-1)?.tag === service.default_environment.script.migration_tag,
      'Durable Object migration is not already applied; CD never applies a new migration');
    const settings = await deps.cf<{ bindings: Binding[] }>(`${script}/settings`);
    for (const db of target.d1_databases) {
      requireThat(settings.bindings.some(b => b.type === 'd1' && b.name === db.binding && b.id === db.database_id),
        'Existing D1 binding differs from the checked configuration');
    }
    requireThat(settings.bindings.some(b => b.type === 'secret_text' && b.name === 'REALITY_DEFENDER_API_KEY'),
      'Required runtime secret is missing');
    // Resolve only existing queues. Refuse an incomplete listing rather than provision replacements.
    const queues = await deps.cf<Queue[]>('queues?per_page=100');
    for (const producer of target.queues.producers) {
      requireThat(queues.some(q => q.queue_name === producer.queue) && settings.bindings.some(
        b => b.type === 'queue' && b.name === producer.binding && b.queue_name === producer.queue),
      'Existing producer binding differs from the checked configuration');
    }
    for (const consumer of target.queues.consumers) {
      const queue = queues.find(q => q.queue_name === consumer.queue);
      requireThat(queue, 'Configured consumer queue was not found');
      const consumers = await deps.cf<{ script: string; type: string }[]>(`queues/${queue.queue_id}/consumers`);
      requireThat(consumers.some(c => c.type === 'worker' && c.script === target.name),
        'Existing queue consumer does not point at this Worker');
    }
    // Zone reads use the same authenticated API, but are not account-relative.
    for (const route of target.routes) {
      const zones = await deps.cf<{ id: string }[]>(`/zones?name=${encodeURIComponent(route.zone_name)}`);
      requireThat(zones.length === 1, 'Serving zone is missing or ambiguous');
      const routes = await deps.cf<{ pattern: string; script: string }[]>(`/zones/${zones[0].id}/workers/routes`);
      requireThat(routes.some(r => r.pattern === route.pattern && r.script === target.name),
        'Existing serving route differs from the checked configuration');
    }
    const current = await deps.cf<{ deployments: Deployment[] }>(`${script}/deployments`);
    requireThat(current.deployments[0], 'No existing deployment; CD must not create a replacement service');
    record.previous = deploymentReceipt(current.deployments[0]);
    // Verify Access authentication and read-only health before taking any deployment effect.
    await deps.health();
    requireThat(await deps.main() === context.sha, 'Main changed during preflight; refusing stale run');
    record.stage = 'deploy';
    record.version_id = deps.deploy();
    record.stage = 'verify';
    const version = await deps.cf<Version>(`${script}/versions/${record.version_id}`);
    requireThat(version.id === record.version_id && version.resources.bindings.some(
      b => b.type === 'plain_text' && b.name === 'SOURCE_SHA' && b.text === context.sha),
    'Provider version does not identify the checked source SHA');
    await deps.health();
    const active = await deps.cf<{ deployments: Deployment[] }>(`${script}/deployments`);
    record.deployment = active.deployments[0] && deploymentReceipt(active.deployments[0]);
    requireThat(record.deployment?.versions.length === 1 &&
      record.deployment.versions[0].version_id === record.version_id &&
      record.deployment.versions[0].percentage === 100, 'Expected version is not active at 100%');
    record.stage = 'complete';
    record.result = 'success';
  } finally {
    deps.record(record);
  }
}

function env(name: string): string {
  const value = process.env[name];
  requireThat(value, `Missing required ${name}; see docs/deployment.md`);
  return value;
}

async function run(): Promise<void> {
  if (process.argv[2] === 'inputs') {
    console.log(inputDigest());
    return;
  }
  requireThat(process.argv[2] === 'deploy', 'Expected inputs or deploy');
  writeFileSync('release.json', JSON.stringify({
    source_sha: process.env.GITHUB_SHA, environment: 'production', result: 'failed', stage: 'setup',
  }, null, 2) + '\n');
  const target = TOML.parse(readFileSync('wrangler.toml', 'utf8')) as unknown as Target;
  const account = env('CLOUDFLARE_ACCOUNT_ID');
  requireThat(/^[a-f0-9]{32}$/.test(account), 'Invalid Cloudflare account ID');
  const apiToken = env('CLOUDFLARE_API_TOKEN');
  const ghToken = env('GH_TOKEN');
  const accessId = env('CF_ACCESS_CLIENT_ID');
  const accessSecret = env('CF_ACCESS_CLIENT_SECRET');
  const sha = env('GITHUB_SHA');
  const context: Context = {
    event: env('GITHUB_EVENT_NAME'), ref: env('GITHUB_REF'), sha,
    enabled: process.env.PRODUCTION_CD_ENABLED ?? '',
    approvedInputs: process.env.PRODUCTION_INPUTS_SHA256 ?? '', actualInputs: inputDigest(),
    artifactSha: readFileSync('dist/source-sha', 'utf8').trim(),
  };
  const api = 'https://api.cloudflare.com/client/v4';
  await release(context, target, {
    async cf<T>(path: string): Promise<T> {
      const response = await fetch(path.startsWith('/') ? api + path : `${api}/accounts/${account}/${path}`, {
        headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      requireThat(response.ok, `Cloudflare read failed (${response.status})`);
      const body = await response.json() as { success: boolean; result: T };
      requireThat(body.success, 'Cloudflare read failed');
      return body.result;
    },
    async main() {
      const response = await fetch('https://api.github.com/repos/divinevideo/divine-realness/git/ref/heads/main', {
        headers: { Authorization: `Bearer ${ghToken}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      requireThat(response.ok, `Main reference read failed (${response.status})`);
      return ((await response.json()) as { object: { sha: string } }).object.sha;
    },
    deploy() {
      const output = '.wrangler-deploy.jsonl';
      rmSync(output, { force: true });
      const result = spawnSync('node_modules/.bin/wrangler', [
        'deploy', 'dist/index.js', '--no-bundle', '--keep-vars', '--var', `SOURCE_SHA:${sha}`,
        '--experimental-auto-create=false',
      ], {
        stdio: 'inherit', timeout: 180_000,
        env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output, WRANGLER_SEND_METRICS: 'false' },
      });
      requireThat(!result.error && result.status === 0, 'Wrangler deploy failed; inspect provider state before retrying');
      const records = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as
        { type: string; version: number; worker_name: string; version_id: string }[];
      const receipt = records.find(r => r.type === 'deploy' && r.version === 1 && r.worker_name === target.name);
      requireThat(receipt && /^[a-f0-9-]{36}$/.test(receipt.version_id), 'Missing Wrangler version receipt');
      return receipt.version_id;
    },
    async health() {
      const response = await fetch('https://realness.admin.divine.video/health', {
        headers: { 'CF-Access-Client-Id': accessId, 'CF-Access-Client-Secret': accessSecret },
        signal: AbortSignal.timeout(30_000), redirect: 'manual', cache: 'no-store',
      });
      requireThat(response.status === 200 && (await response.text()).trim() === 'OK',
        'Health check failed (including Access redirects); no analysis or moderation traffic was sent');
    },
    record(record) {
      // Never persist provider response bodies, bindings, credentials, or actor identities.
      const json = JSON.stringify(record, null, 2) + '\n';
      writeFileSync('release.json', json);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Production deployment\n```json\n' + json + '```\n');
      }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    if (error instanceof ReleaseError) console.error(error.message);
    console.error('Production deployment failed. Inspect the failed step and release.json; do not assume rollback.');
    process.exitCode = 1;
  });
}
