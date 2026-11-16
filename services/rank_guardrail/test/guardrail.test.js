import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { config, teamConfig, verify, Store, Guardrail, LinearApi, plan, inOrder } from '../src/guardrail.js';
import { server, guards, run } from '../src/cli.js';

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
  await guard.reconcile();
  return { cfg, store, guard, api, calls, rows, setRows: next => { rows = next; } };
}

test('protected teams are explicit team:label pairs and dry-run fails closed', () => {
  assert.throws(() => config({}));
  const env = { PROTECTED_TEAMS: 't:l', LINEAR_API_KEY: 'key', WEBHOOK_SECRET: 'secret' };
  assert.equal(config(env).dry, true);
  assert.equal(config({ ...env, DRY_RUN: 'FALSE' }).dry, true);
  assert.equal(config({ ...env, DRY_RUN: 'false' }).dry, false);
  assert.equal(config(env).key, 'Bearer key');
  assert.equal(config({ ...env, LINEAR_API_KEY: 'Bearer key' }).key, 'Bearer key');
  assert.equal(config({ ...env, LINEAR_API_KEY: 'lin_api_key' }).key, 'lin_api_key');
  // Portable: no hardcoded POSIX path, so the expectation holds on Windows as well.
  const stateDir = join(tmpdir(), 'rank-state');
  const cfg = config({ ...env, PROTECTED_TEAMS: ' t1:l1, t2 : l1 ,t3:l3', STATE_DIR: stateDir });
  assert.deepEqual(cfg.teams, [{ team: 't1', label: 'l1' }, { team: 't2', label: 'l1' }, { team: 't3', label: 'l3' }]);
  assert.deepEqual(teamConfig(cfg, cfg.teams[1]), { ...cfg, team: 't2', label: 'l1', dir: join(resolve(stateDir), 't2') });
  for (const PROTECTED_TEAMS of ['t', 't:', ':l', 't:l:x', 't:l,', 't:l,t:other', '../x:l']) {
    assert.throws(() => config({ ...env, PROTECTED_TEAMS }), PROTECTED_TEAMS);
  }
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

test('label changes update membership without a publish; new issues join where they are', async t => {
  const f = await fixture(t); f.rows[0].labels.nodes = []; f.rows[0].sortOrder = 5000;
  f.rows.push({ id: 'new', sortOrder: 1500, labels: { nodes: [{ id: 'label' }] } });
  await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.store.load()).baseline.map(x => x.id), ['b', 'new', 'c']);
  assert.match(await readFile(join(f.cfg.dir, 'audit.jsonl'), 'utf8'), /"membership","added":\["new"\],"dropped":\["a"\]/);
  // The new member is protected like the others.
  f.rows[3].sortOrder = 9000; await f.guard.reconcile();
  assert.deepEqual(f.rows.slice(1).toSorted((x, y) => x.sortOrder - y.sortOrder).map(r => r.id), ['b', 'new', 'c']);
});

test('relabelling every issue, and a large labeled set has no cap', async t => {
  const f = await fixture(t);
  for (const r of f.rows) r.labels.nodes = [];
  await f.guard.reconcile(); assert.equal((await f.store.load()).baseline.length, 0);
  f.rows[2].labels.nodes = [{ id: 'label' }]; await f.guard.reconcile();
  assert.deepEqual((await f.store.load()).baseline.map(x => x.id), ['c']);
  f.setRows(Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, sortOrder: i, labels: { nodes: [{ id: 'label' }] } })));
  await f.guard.reconcile();
  const s = await f.store.load(); assert.equal(s.tripped, false); assert.equal(s.baseline.length, 500);
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

test('archived or moved-out issues leave the protected set; a missing rank fails closed', async t => {
  const f = await fixture(t); f.rows.pop(); f.rows[0].archivedAt = '2026-01-01T00:00:00.000Z';
  await f.guard.reconcile();
  let s = await f.store.load(); assert.deepEqual(s.baseline.map(x => x.id), ['b']); assert.equal(s.failures, 0);
  f.rows[1].sortOrder = null;
  for (let i = 0; i < 4; i++) await f.guard.reconcile();
  s = await f.store.load(); assert.equal(s.tripped, true); assert.equal(s.failures, 3); assert.equal(f.calls.length, 0);
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
  const s = await f.store.load(); assert.equal(s.failures, 0); assert.equal(s.pending, true);
  await f.guard.reconcile(); assert.ok(inOrder(f.rows));
});

test('API failures retry a bounded number of sweeps', async t => {
  const f = await fixture(t); let reads = 0;
  f.api.issues = async () => { reads++; throw new Error('mock outage'); };
  for (let i = 0; i < 5; i++) await f.guard.reconcile();
  assert.equal(reads, 3); assert.equal((await f.store.load()).tripped, true);
});

test('a tripped breaker retries on its own after ten minutes against the last approved order', async t => {
  const f = await fixture(t); let now = Date.now(), fail = true;
  f.guard.clock = () => now;
  const issues = f.api.issues;
  f.api.issues = async () => { if (fail) throw new Error('mock outage'); return issues(); };
  for (let i = 0; i < 3; i++) await f.guard.reconcile();
  assert.equal((await f.store.load()).tripped, true);
  fail = false; f.rows[0].sortOrder = 5000;
  now += 599999; await f.guard.reconcile(); assert.equal(f.calls.length, 0);
  now += 1; await f.guard.reconcile();
  const s = await f.store.load(); assert.equal(s.tripped, false); assert.equal(s.failures, 0);
  assert.ok(inOrder(f.rows)); assert.deepEqual(s.baseline.map(x => x.id), ['a', 'b', 'c']);
  assert.match(await readFile(join(f.cfg.dir, 'audit.jsonl'), 'utf8'), /"breaker-retry"/);
});

test('a new team needs no CLI: the first check adopts the labeled order; old unpublished state starts too', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guardrail-new-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: 'test-team', label: 'label', dry: false, secret: 'mock-secret' };
  const rows = ['x', 'y'].map((id, i) => ({ id, sortOrder: (2 - i) * 1024, labels: { nodes: [{ id: 'label' }] } }));
  const api = { team: async () => {}, issues: async () => structuredClone(rows), update: async () => { throw new Error('no writes'); } };
  const guard = new Guardrail(cfg, api, new Store(cfg));
  assert.equal((await guard.control('status')).paused, false);
  await guard.reconcile();
  assert.deepEqual((await guard.control('status')).baseline.map(x => x.id), ['y', 'x']);
  // State written by older versions, which waited paused for a first publish.
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, team: 'test-team', label: 'label', paused: true,
    baseline: [], seen: [], pending: false, failures: 0, tripped: false }));
  await guard.reconcile();
  const s = await guard.control('status'); assert.equal(s.paused, false); assert.equal(s.protectedCount, 2);
  // An explicit pause still holds.
  await guard.control('pause'); assert.equal((await guard.control('status')).paused, true);
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

// Rows in approved order with the given current ranks; anchors are the ranks before the drift.
const rowsOf = ranks => ranks.map((sortOrder, i) => ({ id: `i${String(i).padStart(2, '0')}`, sortOrder }));
const anchorsOf = ranks => new Map(ranks.map((r, i) => [`i${String(i).padStart(2, '0')}`, r]));
const apply = (rows, repairs) => rows.map(r => ({ ...r, sortOrder: repairs.find(x => x.id === r.id)?.sortOrder ?? r.sortOrder }));
const spaced = n => Array.from({ length: n }, (_, i) => i * 1024);

test('numeric collision repaired with one write and unsafe floating point fails closed', () => {
  const tie = [{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 1 }];
  assert.equal(plan(tie).length, 1); assert.ok(inOrder(apply(tie, plan(tie))));
  assert.throws(() => plan([{ id: 'a', sortOrder: 1e308 }, { id: 'b', sortOrder: 1e308 }]), e => e.code === 'rank-unrepresentable');
  // No representable rank strictly between two adjacent doubles.
  const tight = [{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 5 }, { id: 'c', sortOrder: 1 + Number.EPSILON }];
  assert.throws(() => plan(tight, new Map([['a', 1], ['b', 0], ['c', 1 + Number.EPSILON]])), e => e.code === 'rank-unrepresentable');
});

test('minimal-movement plan: one drag among 19+ issues is one write back to its anchor', () => {
  for (const n of [19, 25, 60]) {
    const anchors = spaced(n);
    for (const [from, to] of [[n - 4, 0], [2, n - 1], [5, 11], [0, n - 1], [n - 1, 0]]) {
      // Drag issue `from` to sit just before or after the issue at `to`.
      const ranks = [...anchors];
      ranks[from] = to === 0 ? anchors[0] - 1024 : to === n - 1 ? anchors[n - 1] + 1024 : anchors[to] + 512;
      const rows = rowsOf(ranks), repairs = plan(rows, anchorsOf(anchors));
      assert.deepEqual(repairs, [{ id: rows[from].id, sortOrder: anchors[from] }], `${n}: ${from}->${to}`);
      assert.ok(inOrder(apply(rows, repairs)));
    }
  }
});

test('minimal-movement plan: small sets, rotations and rank edges', () => {
  const cases = [
    // [current ranks, anchors, expected write count]
    [[1024, 0], [0, 1024], 1], // two-issue swap
    [[0, 2048, 1024], [0, 1024, 2048], 1], // adjacent swap at the tail
    [[1024, 2048, 0], [0, 1024, 2048], 1], // rotation: last dragged to the top
    [[-5000, -4000, -6000], [-6000, -5000, -4000], 1], // negative ranks
    [[0, 0, 0], [0, 0, 0], 2], // full collision
    [[3000, 1024, 2048], [0, 1024, 2048], 1], // head moved, anchor still fits
    [[3000, -2048, -1024], [0, 1024, 2048], 1], // head moved, neighbours re-ranked: anchor no longer fits
    [[0, 1024, -1], [0, 1024, 2048], 1], // tail moved below everything
    [[0, 10, 5, 1024], [0, 512, 1, 1024], 1], // tight gap: midpoint between kept neighbours
    [[4096, 3072, 2048, 1024, 0], spaced(5), 4], // full reversal
  ];
  for (const [ranks, anchors, writes] of cases) {
    const rows = rowsOf(ranks), repairs = plan(rows, anchorsOf(anchors));
    assert.equal(repairs.length, writes, JSON.stringify(ranks));
    assert.ok(inOrder(apply(rows, repairs)), JSON.stringify(ranks));
    // Kept issues are never written.
    assert.ok(repairs.every(r => rows.find(x => x.id === r.id).sortOrder !== r.sortOrder));
  }
  // Ambiguous swap where Linear re-ranked both issues: either is a valid single write.
  const both = rowsOf([2000, 1000]);
  assert.equal(plan(both, anchorsOf([0, 1024])).length, 1);
  assert.ok(inOrder(apply(both, plan(both, anchorsOf([0, 1024])))));
  assert.deepEqual(plan(rowsOf(spaced(19)), anchorsOf(spaced(19))), []);
});

// A team with n protected issues, a controllable clock, and an API that applies writes.
async function large(t, n) {
  const dir = await mkdtemp(join(tmpdir(), 'guardrail-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: 'test-team', label: 'label', dry: false, secret: 'mock-secret' };
  const rows = rowsOf(spaced(n)).map(r => ({ ...r, labels: { nodes: [{ id: 'label' }] }, status: 'Todo' }));
  rows.push({ id: 'unlabeled', sortOrder: 512, labels: { nodes: [] } });
  const calls = [];
  const api = { team: async () => {}, issues: async () => structuredClone(rows),
    update: async (id, sortOrder) => { calls.push({ id, sortOrder }); rows.find(r => r.id === id).sortOrder = sortOrder; } };
  let now = Date.now();
  const guard = new Guardrail(cfg, api, new Store(cfg), () => now);
  await guard.reconcile();
  const ids = () => rows.filter(r => r.labels.nodes.length).toSorted((x, y) => x.sortOrder - y.sortOrder).map(r => r.id);
  const drag = (i, sortOrder) => { rows.find(r => r.id === `i${String(i).padStart(2, '0')}`).sortOrder = sortOrder; };
  const audit = async () => (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  return { cfg, rows, calls, guard, ids, drag, audit, original: ids(), advance: ms => { now += ms; },
    state: () => new Store(cfg).load() };
}

test('19 labeled issues: a single drag is repaired with one write and the right order', async t => {
  const f = await large(t, 19);
  const ranks = new Map(f.rows.map(r => [r.id, r.sortOrder]));
  f.drag(15, -1024); // Drag the 16th issue to the top.
  await f.guard.reconcile();
  assert.deepEqual(f.calls, [{ id: 'i15', sortOrder: 15 * 1024 }]);
  assert.deepEqual(f.ids(), f.original);
  // Every other issue, protected or not, keeps its rank.
  assert.ok(f.rows.every(r => r.sortOrder === ranks.get(r.id)));
  const s = await f.state(); assert.equal(s.tripped, false); assert.equal(s.repairHistory.length, 1);
});

test('19 labeled issues: repeated drags cost one write each until the 10-minute budget', async t => {
  const f = await large(t, 19);
  for (let i = 0; i < 10; i++) {
    f.drag(i % 2 ? 3 : 17, i % 2 ? 99999 : -99999);
    await f.guard.reconcile();
    assert.equal(f.calls.length, i + 1, `drag ${i + 1}`);
    assert.deepEqual(f.ids(), f.original);
    assert.equal((await f.state()).tripped, false);
    f.advance(30000);
  }
  // An eleventh drag inside the same ten minutes trips the budget before any write.
  f.drag(8, -99999);
  await f.guard.reconcile();
  assert.equal(f.calls.length, 10);
  const s = await f.state(); assert.equal(s.tripped, true);
  assert.ok((await f.audit()).some(e => e.event === 'breaker' && e.reason === 'ten-write-ten-minute-budget'));
  // Once the window has passed, the breaker retry repairs it with one write.
  f.advance(600000); await f.guard.reconcile();
  assert.equal(f.calls.length, 11); assert.deepEqual(f.ids(), f.original);
});

test('a repair that needs more writes than one sweep allows is not started', async t => {
  const f = await large(t, 19);
  const ranks = f.rows.map(r => r.sortOrder);
  for (const i of [2, 6, 10, 14]) f.drag(i, -5000 - i); // Four independent displacements.
  const before = f.rows.map(r => r.sortOrder);
  await f.guard.reconcile();
  assert.equal(f.calls.length, 0, 'no partial repair');
  assert.deepEqual(f.rows.map(r => r.sortOrder), before);
  const s = await f.state(); assert.equal(s.tripped, true); assert.deepEqual(s.repairHistory ?? [], []);
  const trip = (await f.audit()).find(e => e.event === 'breaker');
  assert.equal(trip.reason, 'repair-too-large'); assert.equal(trip.needed, 4);
  assert.deepEqual((await f.state()).baseline.map(b => b.sortOrder), ranks.slice(0, 19));
  // Three displacements fit in one sweep.
  const g = await large(t, 19);
  for (const i of [2, 6, 10]) g.drag(i, -5000 - i);
  await g.guard.reconcile();
  assert.equal(g.calls.length, 3); assert.deepEqual(g.ids(), g.original);
  assert.equal((await g.state()).tripped, false);
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
  const http = server(cfg, [{ accept: async () => { accepted++; } }, { accept: async () => { accepted++; } }]);
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => http.close(r)));
  const url = `http://127.0.0.1:${http.address().port}/webhook`;
  const body = JSON.stringify({ webhookTimestamp: Date.now(), type: 'Issue', action: 'update', data: { id: 'a' } });
  assert.equal((await fetch(url.replace('/webhook', '//@'), { method: 'POST', body })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  const signature = createHmac('sha256', cfg.secret).update(body).digest('hex');
  assert.equal((await fetch(url, { method: 'POST', body, headers: { 'linear-signature': signature } })).status, 200);
  assert.equal(accepted, 2); // Offered to every team's guardrail.
});

// Two protected teams sharing one STATE_DIR, each with its own mocked team-scoped issue list.
async function teams(t) {
  const dir = await mkdtemp(join(tmpdir(), 'guardrail-teams-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = config({ PROTECTED_TEAMS: 'team-a:label-a,team-b:label-b', LINEAR_API_KEY: 'key', WEBHOOK_SECRET: 'mock-secret',
    DRY_RUN: 'false', ROLE_APPROVALS: 'false', STATE_DIR: dir });
  const rows = {}, calls = { 'team-a': [], 'team-b': [] };
  for (const { team, label } of cfg.teams) {
    rows[team] = ['1', '2', '3'].map((n, i) => ({ id: `${team}-${n}`, sortOrder: i * 1024, labels: { nodes: [{ id: label }] } }));
  }
  const makeApi = c => ({ team: async () => {}, issues: async () => structuredClone(rows[c.team]),
    update: async (id, sortOrder) => { calls[c.team].push({ id, sortOrder }); rows[c.team].find(r => r.id === id).sortOrder = sortOrder; } });
  const env = { PROTECTED_TEAMS: 'team-a:label-a,team-b:label-b', LINEAR_API_KEY: 'key', WEBHOOK_SECRET: 'mock-secret', DRY_RUN: 'false', ROLE_APPROVALS: 'false', STATE_DIR: dir };
  const cli = (...argv) => run(argv, env, makeApi);
  const [a, b] = guards(cfg, makeApi);
  await a.reconcile(); await b.reconcile();
  return { dir, rows, calls, a, b, cli };
}

test('multiple teams: each team keeps its own state directory, baseline and label', async t => {
  const f = await teams(t);
  const status = await f.cli('status');
  assert.deepEqual(status.teams.map(s => [s.team, s.label, s.paused, s.baseline.map(x => x.id)]), [
    ['team-a', 'label-a', false, ['team-a-1', 'team-a-2', 'team-a-3']],
    ['team-b', 'label-b', false, ['team-b-1', 'team-b-2', 'team-b-3']]]);
  assert.equal((await f.cli('status', '--team', 'team-b')).team, 'team-b');
  assert.match(await readFile(join(f.dir, 'team-a', 'audit.jsonl'), 'utf8'), /"membership"/);
  assert.match(await readFile(join(f.dir, 'team-b', 'state.json'), 'utf8'), /"label-b"/);
});

test('multiple teams: drift is repaired only in its own team; pause and breaker are per team', async t => {
  const f = await teams(t);
  f.rows['team-a'][0].sortOrder = 5000;
  f.rows['team-b'][0].sortOrder = 5000;
  await f.cli('pause', '--team', 'team-b');
  await f.a.reconcile(); await f.b.reconcile();
  assert.ok(inOrder(f.rows['team-a'])); assert.ok(f.calls['team-a'].length > 0);
  assert.equal(f.calls['team-b'].length, 0); assert.ok(!inOrder(f.rows['team-b']));
  // A failing team trips only its own breaker.
  f.rows['team-a'][0].sortOrder = null;
  for (let i = 0; i < 3; i++) await f.a.reconcile();
  await f.cli('publish', '--team', 'team-b'); await f.cli('resume', '--team', 'team-b');
  f.rows['team-b'][1].sortOrder = 9000; await f.b.reconcile();
  const [a, b] = (await f.cli('status')).teams;
  assert.equal(a.tripped, true); assert.equal(b.tripped, false);
  assert.deepEqual(f.rows['team-b'].toSorted((x, y) => x.sortOrder - y.sortOrder).map(r => r.id), b.baseline.map(x => x.id));
  assert.deepEqual(b.baseline.map(x => x.id), ['team-b-2', 'team-b-3', 'team-b-1']); assert.ok(f.calls['team-b'].length > 0);
  assert.ok(f.calls['team-b'].every(c => c.id.startsWith('team-b-')));
});

test('multiple teams: webhooks reach only the team that owns the issue', async t => {
  const f = await teams(t);
  const event = { type: 'Issue', action: 'update', data: { id: 'team-b-2', teamId: 'team-b' } };
  for (const guard of [f.a, f.b]) await guard.accept(event, 'delivery-1', 'digest-1');
  const [a, b] = (await f.cli('status')).teams;
  assert.equal(a.seenDeliveryKeys, 0); assert.equal(b.seenDeliveryKeys, 2);
});

test('multiple teams: pause and status cover every team; publish and resume need --team', async t => {
  const f = await teams(t);
  assert.deepEqual((await f.cli('pause')).teams.map(r => [r.team, r.paused]), [['team-a', true], ['team-b', true]]);
  await assert.rejects(f.cli('publish'), /add --team/);
  await assert.rejects(f.cli('resume', '--restore'), /add --team/);
  await assert.rejects(f.cli('status', '--team', 'team-c'), /PROTECTED_TEAMS/);
  await assert.rejects(f.cli('status', '--team'), /Usage/);
  assert.equal((await f.cli('resume', '--team', 'team-a', '--restore')).paused, false);
});
