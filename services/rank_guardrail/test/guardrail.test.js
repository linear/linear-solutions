import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { config, verify, Store, Guardrail, LinearApi, plan, inOrder } from '../src/guardrail.js';
import { server } from '../src/cli.js';

async function fixture(t, dry = false) {
  const dir = await mkdtemp(join(tmpdir(), 'guardrail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: 'test-team', label: 'label', dry, secret: 'mock-secret' };
  let rows = ['a', 'b', 'c'].map((id, i) => ({ id, sortOrder: i * 1024,
    labels: { nodes: [{ id: 'label' }] }, status: 'Todo', cycle: 'cycle', assignee: 'person' }));
  const calls = [];
  const api = { team: async () => {}, issues: async () => structuredClone(rows),
    update: async (id, sortOrder) => { calls.push({ id, sortOrder }); rows.find(r => r.id === id).sortOrder = sortOrder; } };
  const store = new Store(cfg), guard = new Guardrail(cfg, api, store);
  await guard.control('publish'); await guard.control('resume');
  return { cfg, store, guard, api, calls, rows, setRows: next => { rows = next; } };
}

test('explicit TEST allowlist and dry-run fail closed', () => {
  assert.throws(() => config({}));
  const env = { TEST_TEAM_ID: 't', TEST_TEAM_ALLOWLIST: 't', PROTECTED_LABEL_ID: 'l', LINEAR_API_KEY: 'key', WEBHOOK_SECRET: 'secret' };
  assert.equal(config(env).dry, true);
  assert.equal(config({ ...env, DRY_RUN: 'FALSE' }).dry, true);
  assert.equal(config({ ...env, DRY_RUN: 'false' }).dry, false);
  assert.throws(() => config({ ...env, TEST_TEAM_ID: 'other' }));
});

test('raw HMAC, signed timestamp age/future and optional matching header', () => {
  const now = 1700000000000;
  const raw = Buffer.from(JSON.stringify({ webhookTimestamp: now, type: 'Issue' }));
  const sig = createHmac('sha256', 'secret').update(raw).digest('hex');
  assert.equal(verify(raw, sig, String(now), 'secret', now).type, 'Issue');
  assert.equal(verify(raw, sig, undefined, 'secret', now).type, 'Issue');
  for (const args of [[Buffer.concat([raw, Buffer.from(' ')]), sig, String(now), 'secret', now],
    [raw, sig, String(now + 1), 'secret', now], [raw, sig, undefined, 'wrong', now],
    [raw, sig, undefined, 'secret', now + 60001], [raw, sig, undefined, 'secret', now - 60001],
    [raw, 'x', undefined, 'secret', now]]) assert.throws(() => verify(...args));
});

test('fresh repair preserves status cycle assignee; own callbacks converge without writes', async t => {
  const f = await fixture(t);
  f.rows[0].sortOrder = 3000;
  f.rows[1].status = 'Done'; f.rows[1].cycle = 'new-cycle'; f.rows[1].assignee = 'new-person';
  await f.guard.reconcile();
  assert.ok(inOrder(f.rows)); assert.ok(f.calls.length > 0 && f.calls.length <= 3);
  assert.equal(f.rows[1].status, 'Done'); assert.equal(f.rows[1].cycle, 'new-cycle'); assert.equal(f.rows[1].assignee, 'new-person');
  const count = f.calls.length;
  await f.guard.accept({ type: 'Issue', action: 'update', data: { id: 'a' } }, 'own', 'digest');
  await f.guard.reconcile(); await f.guard.reconcile();
  assert.equal(f.calls.length, count);
});

test('dry run plans without mutation', async t => {
  const f = await fixture(t, true); f.rows[0].sortOrder = 5000;
  await f.guard.reconcile(); assert.equal(f.calls.length, 0);
  assert.match(await readFile(join(f.cfg.dir, 'audit.jsonl'), 'utf8'), /would-repair/);
});

test('label removal remains protected, new labels are not silently enrolled', async t => {
  const f = await fixture(t); f.rows[0].labels.nodes = []; f.rows[0].sortOrder = 5000;
  f.rows.push({ id: 'new', sortOrder: -1, labels: { nodes: [{ id: 'label' }] } });
  await f.guard.reconcile(); assert.ok(inOrder(f.rows.slice(0, 3)));
  assert.equal(f.rows[3].sortOrder, -1); assert.equal((await f.store.load()).baseline.length, 3);
});

test('pause/publish/resume and restart preserve intentionally accepted order', async t => {
  const f = await fixture(t);
  await assert.rejects(f.guard.control('publish'));
  await f.guard.control('pause'); f.rows[0].sortOrder = 5000;
  await f.guard.reconcile(); assert.equal(f.calls.length, 0);
  await f.guard.control('publish'); await f.guard.control('resume');
  const restarted = new Guardrail(f.cfg, f.api, new Store(f.cfg));
  await restarted.reconcile(); assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.store.load()).baseline.map(x => x.id), ['b', 'c', 'a']);
});

test('dedup persists across restart and pending events recover', async t => {
  const f = await fixture(t);
  const event = { type: 'Issue', action: 'update', data: { id: 'a' } };
  await f.guard.accept(event, 'one', 'same-bytes');
  const restarted = new Guardrail(f.cfg, f.api, new Store(f.cfg));
  await restarted.accept(event, 'different-header', 'same-bytes');
  assert.deepEqual((await f.store.load()).seen, ['same-bytes', 'delivery:one']);
  await restarted.accept(event, 'one', 'fresh-timestamp-bytes');
  assert.equal((await f.store.load()).seen.length, 2);
  f.rows[0].sortOrder = 5000; await restarted.reconcile(); assert.ok(inOrder(f.rows));
});

test('missing/archived/moved baseline item fails closed and trips after three failures', async t => {
  const f = await fixture(t); f.rows.pop();
  for (let i = 0; i < 4; i++) await f.guard.reconcile();
  const s = await f.store.load(); assert.equal(s.tripped, true); assert.equal(s.failures, 3); assert.equal(f.calls.length, 0);
  await assert.rejects(f.guard.control('resume'));
});

test('issue moved out of the team between repairs is not written from the prior snapshot', async t => {
  const f = await fixture(t); f.rows[0].sortOrder = 5000;
  const update = f.api.update;
  f.api.update = async (...args) => {
    await update(...args);
    f.rows.splice(1, 1); // The next baseline issue is no longer in the team-scoped response.
  };
  await f.guard.reconcile();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.load()).failures, 1);
});

test('API failures retry a bounded number of sweeps', async t => {
  const f = await fixture(t); let reads = 0;
  f.api.issues = async () => { reads++; throw new Error('mock outage'); };
  for (let i = 0; i < 5; i++) await f.guard.reconcile();
  assert.equal(reads, 3); assert.equal((await f.store.load()).tripped, true);
});

test('adversarial concurrent writer trips mutation budget', async t => {
  const f = await fixture(t); f.rows[0].sortOrder = 5000;
  f.api.update = async (id, sortOrder) => { f.calls.push({ id, sortOrder }); };
  await f.guard.reconcile(); assert.equal(f.calls.length, 3); assert.equal((await f.store.load()).tripped, true);
  await f.guard.reconcile(); assert.equal(f.calls.length, 3);
});

test('same-state CLI pause waits for ongoing repair and prevents subsequent writes', async t => {
  const f = await fixture(t); f.rows[0].sortOrder = 5000;
  let entered; const started = new Promise(r => { entered = r; });
  let release; const gate = new Promise(r => { release = r; });
  const update = f.api.update;
  f.api.update = async (...args) => { entered(); await gate; await update(...args); };
  const sweep = f.guard.reconcile(); await started;
  let paused = false;
  const other = new Guardrail(f.cfg, f.api, new Store(f.cfg));
  const pause = other.control('pause').then(() => { paused = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(paused, false);
  release(); await sweep; await pause;
  const count = f.calls.length; f.rows[0].sortOrder = 9000; await f.guard.reconcile();
  assert.equal(f.calls.length, count);
});

test('numeric collision repaired and unsafe floating point fails closed', () => {
  assert.ok(inOrder(plan([{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 1 }])));
  assert.throws(() => plan([{ id: 'a', sortOrder: 1e308 }, { id: 'b', sortOrder: 1e308 }]));
});

test('API paginates and only ever sends sortOrder as mutation input', async () => {
  const requests = [];
  const api = new LinearApi({ key: 'mock', team: 't' }, async (_url, opts) => {
    const req = JSON.parse(opts.body); requests.push(req);
    return { ok: true, json: async () => ({ data: req.query.startsWith('mutation') ? { issueUpdate: { success: true } } :
      { issues: { nodes: [{ id: req.variables.after || 'first' }], pageInfo: { hasNextPage: !req.variables.after, endCursor: 'next' } } } }) };
  });
  assert.equal((await api.issues()).length, 2); await api.update('a', 42);
  assert.deepEqual(requests[2].variables, { id: 'a', input: { sortOrder: 42 } });
});

test('HTTP rejects unsigned events; signed event acknowledged only after acceptance', async t => {
  let accepted = 0;
  const cfg = { secret: 'mock-secret' };
  const http = server(cfg, { accept: async () => { accepted++; } });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => http.close(r)));
  const url = `http://127.0.0.1:${http.address().port}/webhook`;
  const body = JSON.stringify({ webhookTimestamp: Date.now(), type: 'Issue', action: 'update', data: { id: 'a' } });
  assert.equal((await fetch(url.replace('/webhook', '//@'), { method: 'POST', body })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  const signature = createHmac('sha256', cfg.secret).update(body).digest('hex');
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'linear-signature': signature } })).status, 200);
  assert.equal(accepted, 1);
});
