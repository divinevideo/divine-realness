import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputDigest, release } from './release.ts';
import type { Context, Dependencies, ReleaseRecord, Target } from './release.ts';

const sha = 'a'.repeat(40);
const id = '11111111-1111-1111-1111-111111111111';
const target: Target = {
  name: 'test-worker', routes: [{ pattern: 'admin.example.test/*', zone_name: 'example.test' }],
  d1_databases: [{ binding: 'DB', database_id: 'existing-db' }],
  queues: { producers: [{ binding: 'ACTION_QUEUE', queue: 'actions' }], consumers: [{ queue: 'events' }] },
  migrations: [{ tag: 'v2' }],
};
const valid: Context = {
  sha, event: 'push', ref: 'refs/heads/main', enabled: 'true', artifactSha: sha,
  approvedInputs: 'b'.repeat(64), actualInputs: 'b'.repeat(64),
};
function fixture() {
  const replies: Record<string, unknown> = {
    'workers/services/test-worker': { default_environment: { environment: 'production', script: { migration_tag: 'v2' } } },
    'workers/scripts/test-worker/settings': { bindings: [
      { type: 'd1', name: 'DB', id: 'existing-db' },
      { type: 'secret_text', name: 'REALITY_DEFENDER_API_KEY' },
      { type: 'queue', name: 'ACTION_QUEUE', queue_name: 'actions' },
    ] },
    'queues?per_page=100': [{ queue_id: 'q1', queue_name: 'events' }, { queue_id: 'q2', queue_name: 'actions' }],
    // The documented List Queue Consumers response uses script_name.
    'queues/q1/consumers': [{ script_name: 'test-worker', type: 'worker' }],
    '/zones?name=example.test': [{ id: 'zone' }],
    '/zones/zone/workers/routes': [{ pattern: 'admin.example.test/*', script: 'test-worker' }],
    [`workers/scripts/test-worker/versions/${id}`]: {
      id, resources: { bindings: [{ name: 'SOURCE_SHA', type: 'plain_text', text: sha }] },
    },
  };
  const calls: string[] = [];
  const records: ReleaseRecord[] = [];
  const deps: Dependencies = {
    async cf<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.endsWith('/deployments')) return { deployments: [{ id: 'deployment', versions: [
        { version_id: calls.includes('deploy') ? id : 'previous', percentage: 100 },
      ] }] } as T;
      assert.ok(path in replies, `Unexpected test API path ${path}`);
      return replies[path] as T;
    },
    async main() { calls.push('main'); return sha; },
    deploy() { calls.push('deploy'); return id; },
    async health() { calls.push('health'); },
    record(record) { records.push(structuredClone(record)); },
  };
  return { deps, calls, records, replies };
}

test('accepts the queue consumer API response, then verifies health, source, and active 100% version', async () => {
  const f = fixture();
  await release(valid, target, f.deps);
  assert.equal(f.records[0].result, 'success');
  assert.equal(f.records[0].version_id, id);
  assert.equal(f.records[0].previous?.versions[0].version_id, 'previous');
  assert.ok(f.calls.indexOf('deploy') > f.calls.indexOf('health'));
  assert.equal(f.calls.filter(c => c === 'main').length, 2);
  assert.equal(f.calls.filter(c => c === 'health').length, 2);
});

for (const [name, override] of Object.entries({
  'pull request': { event: 'pull_request' }, 'other manual branch': { event: 'workflow_dispatch', ref: 'refs/heads/topic' },
  'not enabled': { enabled: '' }, 'unapproved config': { actualInputs: 'c'.repeat(64) },
  'wrong artifact': { artifactSha: 'c'.repeat(40) }, 'invalid sha': { sha: 'invalid' },
})) {
  test(`refuses ${name} before any provider read or deployment`, async () => {
    const f = fixture();
    await assert.rejects(release({ ...valid, ...override }, target, f.deps));
    assert.deepEqual(f.calls, []);
    assert.equal(f.records[0].result, 'failed');
  });
}

test('explicit replay on main is allowed', async () => {
  const f = fixture();
  await release({ ...valid, event: 'workflow_dispatch' }, target, f.deps);
  assert.equal(f.records[0].result, 'success');
});

test('accepts a legacy queue consumer response using script', async () => {
  const f = fixture();
  f.replies['queues/q1/consumers'] = [{ script: 'test-worker', type: 'worker' }];
  await release(valid, target, f.deps);
  assert.equal(f.records[0].result, 'success');
});

test('accepts consistent queue consumer names when both fields are supplied', async () => {
  const f = fixture();
  f.replies['queues/q1/consumers'] = [{ script_name: 'test-worker', script: 'test-worker', type: 'worker' }];
  await release(valid, target, f.deps);
  assert.equal(f.records[0].result, 'success');
});

for (const when of [1, 2]) {
  test(`refuses stale main at guard ${when} before deploying`, async () => {
    const f = fixture();
    let calls = 0;
    f.deps.main = async () => ++calls === when ? 'c'.repeat(40) : sha;
    await assert.rejects(release(valid, target, f.deps), /stale/);
    assert.ok(!f.calls.includes('deploy'));
  });
}

for (const [name, path, reply] of [
  ['new DO migration', 'workers/services/test-worker', { default_environment: { environment: 'production', script: { migration_tag: 'v1' } } }],
  ['different environment', 'workers/services/test-worker', { default_environment: { environment: 'staging', script: { migration_tag: 'v2' } } }],
  ['missing DB/secret/producer', 'workers/scripts/test-worker/settings', { bindings: [] }],
  ['missing queues', 'queues?per_page=100', []],
  ['another queue consumer', 'queues/q1/consumers', [{ script_name: 'another-worker', type: 'worker' }]],
  ['missing queue consumer name', 'queues/q1/consumers', [{ type: 'worker' }]],
  ['non-Worker queue consumer', 'queues/q1/consumers', [{ script_name: 'test-worker', type: 'http_pull' }]],
  ['another legacy queue consumer', 'queues/q1/consumers', [{ script: 'another-worker', type: 'worker' }]],
  ['non-Worker legacy queue consumer', 'queues/q1/consumers', [{ script: 'test-worker', type: 'http_pull' }]],
  ['conflicting legacy queue consumer name', 'queues/q1/consumers', [{ script_name: 'test-worker', script: 'another-worker', type: 'worker' }]],
  ['conflicting documented queue consumer name', 'queues/q1/consumers', [{ script_name: 'another-worker', script: 'test-worker', type: 'worker' }]],
  ['empty documented queue consumer name', 'queues/q1/consumers', [{ script_name: '', script: 'test-worker', type: 'worker' }]],
  ['missing zone', '/zones?name=example.test', []],
  ['another serving route', '/zones/zone/workers/routes', [{ pattern: 'admin.example.test/*', script: 'another-worker' }]],
] as const) {
  test(`refuses ${name} without deployment`, async () => {
    const f = fixture();
    f.replies[path] = reply;
    await assert.rejects(release(valid, target, f.deps));
    assert.ok(!f.calls.includes('deploy'));
  });
}

test('preflight health/access failure prevents deployment', async () => {
  const f = fixture();
  f.deps.health = async () => { throw new Error('Access rejected'); };
  await assert.rejects(release(valid, target, f.deps));
  assert.ok(!f.calls.includes('deploy'));
});

test('deployment failure is recorded and propagated, never reported successful', async () => {
  const f = fixture();
  f.deps.deploy = () => { throw new Error('deployment failed'); };
  await assert.rejects(release(valid, target, f.deps));
  assert.equal(f.records[0].stage, 'deploy');
  assert.equal(f.records[0].result, 'failed');
});

test('uploaded version with different source cannot pass', async () => {
  const f = fixture();
  f.replies[`workers/scripts/test-worker/versions/${id}`] = { id, resources: { bindings: [] } };
  await assert.rejects(release(valid, target, f.deps), /source SHA/);
  assert.equal(f.records[0].stage, 'verify');
  assert.equal(f.records[0].result, 'failed');
});

test('post-deploy health failure is a failed release, without automatic rollback', async () => {
  const f = fixture();
  let count = 0;
  f.deps.health = async () => { if (++count === 2) throw new Error('health failed'); };
  await assert.rejects(release(valid, target, f.deps));
  assert.equal(f.records[0].result, 'failed');
  assert.equal(f.records[0].version_id, id);
});

test('wrong or split active deployment cannot report success', async () => {
  const f = fixture();
  const original = f.deps.cf;
  f.deps.cf = async <T>(path: string): Promise<T> => path.endsWith('/deployments')
    ? { deployments: [{ id: 'split', versions: [{ version_id: id, percentage: 50 }] }] } as T
    : original<T>(path);
  await assert.rejects(release(valid, target, f.deps), /100%/);
  assert.equal(f.records[0].result, 'failed');
});

test('result receipt excludes actor identities and unselected provider fields', async () => {
  const f = fixture();
  const original = f.deps.cf;
  f.deps.cf = async <T>(path: string): Promise<T> => path.endsWith('/deployments')
    ? { deployments: [{ id: 'deployment', author_email: 'example@example.test', annotations: { extra: 'not-retained' },
      versions: [{ version_id: id, percentage: 100, extra: 'not-retained' }] }] } as T
    : original<T>(path);
  await release(valid, target, f.deps);
  assert.ok(!JSON.stringify(f.records).includes('example@example.test'));
  assert.ok(!JSON.stringify(f.records).includes('not-retained'));
});

test('provider read errors prevent deployment and remain failures', async () => {
  const f = fixture();
  f.deps.cf = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(release(valid, target, f.deps));
  assert.ok(!f.calls.includes('deploy'));
  assert.equal(f.records[0].result, 'failed');
});

test('inputs digest changes with configuration, migration edits, and new migration files', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'realness-inputs-'));
  try {
    mkdirSync(join(root, 'migrations'));
    writeFileSync(join(root, 'wrangler.toml'), 'name = "example"');
    writeFileSync(join(root, 'migrations/001.sql'), 'SELECT 1;');
    const first = inputDigest(root);
    assert.equal(inputDigest(root), first);
    writeFileSync(join(root, 'wrangler.toml'), 'name = "another"');
    const config = inputDigest(root);
    assert.notEqual(first, config);
    writeFileSync(join(root, 'migrations/001.sql'), 'SELECT 2;');
    const migration = inputDigest(root);
    assert.notEqual(config, migration);
    writeFileSync(join(root, 'migrations/002.sql'), 'SELECT 3;');
    assert.notEqual(migration, inputDigest(root));
  } finally {
    rmSync(root, { recursive: true });
  }
});
