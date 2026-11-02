import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config, Guardrail, Store, LinearApi } from '../src/guardrail.js';
import { GuardrailError, safeMessage } from '../src/errors.js';
import { run } from '../src/cli.js';

const KEY = 'lin_api_SUPERSECRETVALUE';
const SECRET = 'whsec_SUPERSECRETVALUE';
const ENV = { PROTECTED_TEAMS: 'team:label', LINEAR_API_KEY: KEY, WEBHOOK_SECRET: SECRET };
const service = join(dirname(fileURLToPath(import.meta.url)), '..');

async function rejectsSafely(promiseOrFn, code, pattern) {
  let error;
  try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (e) { error = e; }
  assert.ok(error instanceof GuardrailError, `expected GuardrailError ${code}, got ${error}`);
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  const shown = safeMessage(error);
  assert.ok(!shown.includes('SUPERSECRET') && !shown.includes(KEY) && !shown.includes(SECRET), shown);
  return error;
}

test('config errors name the variable, never its value', async () => {
  await rejectsSafely(() => config({ ...ENV, PROTECTED_TEAMS: undefined }), 'config', /PROTECTED_TEAMS is missing/);
  await rejectsSafely(() => config({ ...ENV, PROTECTED_TEAMS: 'REPLACE_WITH_TEAM_UUID:REPLACE_WITH_LABEL_UUID' }), 'config', /PROTECTED_TEAMS still contains/);
  await rejectsSafely(() => config({ ...ENV, PROTECTED_TEAMS: 'team' }), 'config', /<team-uuid>:<label-uuid> pairs/);
  await rejectsSafely(() => config({ ...ENV, PROTECTED_TEAMS: 'team:label,team:other' }), 'config', /more than once/);
  await rejectsSafely(() => config({ ...ENV, WEBHOOK_SECRET: '' }), 'config', /WEBHOOK_SECRET is missing/);
  await rejectsSafely(() => config({ ...ENV, LINEAR_API_KEY: 'REPLACE_WITH_RESTRICTED_TEST_API_KEY' }), 'config', /LINEAR_API_KEY still contains/);
  await rejectsSafely(() => config({ ...ENV, ROLE_APPROVALS: 'TRUE' }), 'config', /ROLE_APPROVALS/);
  await rejectsSafely(() => config({ ...ENV, APPROVAL_GRACE_MS: '90000' }), 'config', /APPROVAL_GRACE_MS/);
  const cfg = config(ENV);
  assert.deepEqual([cfg.dry, cfg.approvals, cfg.graceMs], [true, false, 10000]);
  assert.deepEqual([config({ ...ENV, ROLE_APPROVALS: 'true', APPROVAL_GRACE_MS: '0' }).approvals, config({ ...ENV, APPROVAL_GRACE_MS: '0' }).graceMs], [true, 0]);
});

test('API HTTP, network, GraphQL and team errors are specific but hide response details', async () => {
  const api = (respond, team = 'team') => new LinearApi({ key: KEY, team }, respond);
  const http = status => async () => ({ ok: false, status, json: async () => ({ errors: [{ message: KEY }] }) });
  await rejectsSafely(api(http(401)).team(), 'api-http', /HTTP 401 \(check LINEAR_API_KEY\)/);
  await rejectsSafely(api(http(403)).issues(), 'api-http', /HTTP 403/);
  await rejectsSafely(api(http(503)).team(), 'api-http', /HTTP 503 \(Linear API unavailable/);
  await rejectsSafely(api(async () => { throw new Error(`connect failed ${KEY}`); }).team(), 'api-network', /network/);
  await rejectsSafely(api(async () => ({ ok: true, json: async () => ({ errors: [{ message: `bad key ${KEY}` }] }) })).team(), 'api-graphql', /details hidden/);
  await rejectsSafely(api(async () => ({ ok: true, json: async () => { throw new Error(KEY); } })).team(), 'api-response');
  const team = id => api(async () => ({ ok: true, json: async () => ({ data: { team: { id } } }) }));
  await rejectsSafely(team('other').team(), 'team-mismatch', /PROTECTED_TEAMS/);
  await team('team').team();
});

async function guard(t, rows, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rank-errors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: 'team', label: 'label', dry: true, approvals: false, graceMs: 0, key: KEY, secret: SECRET, ...extra };
  const api = { team: async () => {}, issues: async () => structuredClone(rows), update: async () => { throw new Error('no writes'); } };
  return { cfg, guard: new Guardrail(cfg, api, new Store(cfg)) };
}
const labelled = (id, sortOrder) => ({ id, sortOrder, labels: { nodes: [{ id: 'label' }] } });

test('control errors: pause required, label count, rank collisions, scope mismatch and state lock', async t => {
  let f = await guard(t, []);
  await f.guard.control('pause');
  await rejectsSafely(f.guard.control('publish'), 'label-count', /found 0/);
  await rejectsSafely(f.guard.control('resume'), 'no-baseline');
  f = await guard(t, [labelled('a', 1), labelled('b', 1)]);
  await rejectsSafely(f.guard.control('publish'), 'rank-collision', /share a rank/);
  f = await guard(t, [labelled('a', 1), labelled('b', 2)]);
  await f.guard.control('publish'); await f.guard.control('resume');
  await rejectsSafely(f.guard.control('publish'), 'pause-required', /run pause/);
  await rejectsSafely(new Store({ ...f.cfg, label: 'other' }).load(), 'state-scope', /scope mismatch/);
  await rejectsSafely(f.guard.control('nonsense'), 'usage');
  await writeFile(join(f.cfg.dir, 'state.json'), '{not json');
  await rejectsSafely(f.guard.control('status'), 'state-unreadable');
  const locked = await guard(t, [], { lockTries: 1 });
  await mkdir(join(locked.cfg.dir, 'lock'), { recursive: true });
  await rejectsSafely(locked.guard.control('status'), 'state-lock', /another command or the server/);
});

test('unexpected errors are never echoed', () => {
  const shown = safeMessage(new Error(`fetch failed Authorization: ${KEY}`));
  assert.match(shown, /^unexpected-error: /); assert.ok(!shown.includes(KEY));
});

test('direct CLI commands: status reports modes, check-actor is read-only, bad usage rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rank-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...ENV, STATE_DIR: dir, ROLE_APPROVALS: 'true', DRY_RUN: 'true' };
  const status = await run(['status'], env, () => ({}));
  assert.deepEqual([status.dryRun, status.roleApprovals, status.approvalGraceMs, status.paused], [true, true, 10000, true]);
  assert.ok(!JSON.stringify(status).includes('SUPERSECRET'));
  const requests = [];
  const makeApi = cfg => new LinearApi(cfg, async (_url, opts) => {
    const req = JSON.parse(opts.body); requests.push(req.query);
    const data = req.query.includes('team(id') ? { team: { id: 'team' } }
      : req.query.includes('viewer') ? { viewer: { id: 'bot', organization: { id: 'org' } } }
        : { user: { id: 'u1', active: true, app: false, admin: false, owner: false, organization: { id: 'org' },
          teamMemberships: { nodes: [{ owner: true, archivedAt: null, team: { id: 'team' } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return { ok: true, json: async () => ({ data }) };
  });
  const check = await run(['check-actor', 'u1'], env, makeApi);
  assert.deepEqual([check.allowed, check.reason], [true, 'team-owner']);
  assert.ok(requests.every(q => !q.includes('mutation')));
  await rejectsSafely(run(['check-actor'], env, makeApi), 'usage');
  await rejectsSafely(run(['pause', '--restore'], env, makeApi), 'usage');
  await rejectsSafely(run(['check-actor', 'not a uuid!'], env, makeApi), 'usage');
});

test('CLI process prints the sanitized reason and exits nonzero', async () => {
  const exec = promisify(execFile);
  const env = { PATH: process.env.PATH, LINEAR_API_KEY: KEY, WEBHOOK_SECRET: SECRET };
  const result = await exec(process.execPath, ['src/cli.js', 'status'], { cwd: service, env }).catch(e => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Command failed \(config: PROTECTED_TEAMS is missing/);
  assert.ok(!result.stderr.includes('SUPERSECRET') && !result.stdout.includes('SUPERSECRET'));
});
