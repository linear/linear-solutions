import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Guardrail, Store, LinearApi, inOrder } from '../src/guardrail.js';
import { authorize } from '../src/roles.js';

const TEAM = 'roadmap-team';
const member = (owner, team = TEAM, archivedAt = null) => ({ owner, archivedAt, team: { id: team } });
const base = { active: true, app: false, admin: false, owner: false, organization: { id: 'org' }, teamMemberships: [], membershipsComplete: true };
const USERS = {
  owner: { ...base, id: 'owner', owner: true },
  admin: { ...base, id: 'admin', admin: true },
  teamOwner: { ...base, id: 'teamOwner', teamMemberships: [member(false, 'other'), member(true)] },
  otherTeamOwner: { ...base, id: 'otherTeamOwner', teamMemberships: [member(true, 'other'), member(false)] },
  archivedTeamOwner: { ...base, id: 'archivedTeamOwner', teamMemberships: [member(true, TEAM, '2026-01-01T00:00:00.000Z')] },
  member: { ...base, id: 'member', teamMemberships: [member(false)] },
  inactiveAdmin: { ...base, id: 'inactiveAdmin', admin: true, active: false },
  appAdmin: { ...base, id: 'appAdmin', admin: true, app: true },
  foreignAdmin: { ...base, id: 'foreignAdmin', admin: true, organization: { id: 'elsewhere' } },
  partialMember: { ...base, id: 'partialMember', teamMemberships: [member(false)], membershipsComplete: false },
  bot: { ...base, id: 'bot', admin: true }, // The guardrail API key's own user.
};
const VIEWER = { id: 'bot', organization: { id: 'org' } };
const ALLOWED = ['owner', 'admin', 'teamOwner'];
const DENIED = ['otherTeamOwner', 'archivedTeamOwner', 'member', 'inactiveAdmin', 'appAdmin', 'foreignAdmin', 'partialMember', 'bot', 'missing'];

test('role policy: workspace owners, admins and exact team owners only', () => {
  const check = (id, actor = { type: 'user', id }) => authorize({ actor, user: USERS[id] ?? null, viewer: VIEWER, team: TEAM });
  assert.deepEqual(ALLOWED.map(id => check(id).reason), ['workspace-owner', 'workspace-admin', 'team-owner']);
  for (const id of DENIED) assert.equal(check(id).allowed, false, id);
  assert.equal(check('bot').reason, 'guardrail-api-key-user');
  assert.equal(check('missing').reason, 'unknown-user');
  assert.equal(check('inactiveAdmin').reason, 'inactive-user');
  assert.equal(check('appAdmin').reason, 'app-user');
  assert.equal(check('foreignAdmin').reason, 'other-organization');
  // Non-user actors are denied even if their ID belongs to an admin.
  for (const type of ['integration', 'oauthClient', 'externalUser', 'somethingNew']) {
    assert.equal(check('admin', { type, id: 'admin' }).allowed, false, type);
  }
  assert.equal(check('admin', null).reason, 'actor-type-none');
  assert.equal(check('admin', { type: 'user', id: 'owner' }).reason, 'unknown-user'); // Lookup must match actor.
  assert.equal(authorize({ actor: { type: 'user', id: 'admin' }, user: USERS.admin, viewer: null, team: TEAM }).allowed, false);
});

test('user lookup is read-only, paginates memberships, and denies unknown users', async () => {
  const requests = [];
  const pages = [
    { id: 'u', active: true, app: false, admin: false, owner: false, organization: { id: 'org' },
      teamMemberships: { nodes: [member(false, 'other')], pageInfo: { hasNextPage: true, endCursor: 'p2' } } },
    { id: 'u', active: true, app: false, admin: false, owner: false, organization: { id: 'org' },
      teamMemberships: { nodes: [member(true)], pageInfo: { hasNextPage: false, endCursor: null } } },
  ];
  const api = new LinearApi({ key: 'mock', team: TEAM }, async (_url, opts) => {
    const req = JSON.parse(opts.body); requests.push(req);
    if (req.variables?.id === 'gone') return { ok: true, json: async () => ({ errors: [{ message: 'Entity not found' }] }) };
    return { ok: true, json: async () => ({ data: { user: pages[req.variables.after ? 1 : 0] } }) };
  });
  const user = await api.user('u');
  assert.equal(user.membershipsComplete, true);
  assert.equal(user.teamMemberships.length, 2);
  assert.equal(authorize({ actor: { type: 'user', id: 'u' }, user, viewer: VIEWER, team: TEAM }).reason, 'team-owner');
  assert.equal(await api.user('gone'), null);
  assert.ok(requests.every(r => r.query.startsWith('query(') && r.query.includes('user(id:$id)')));
  assert.ok(requests.every(r => !/mutation/.test(r.query)));
});

async function fixture(t, { approvals = true, dry = false, graceMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rank-roles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: TEAM, label: 'label', dry, approvals, graceMs, secret: 'mock-secret' };
  let now = 1_800_000_000_000, tick = 0;
  const stamp = () => new Date(1_800_000_000_000 + ++tick * 1000).toISOString();
  const rows = ['a', 'b', 'c'].map((id, i) => ({ id, sortOrder: i * 1024, updatedAt: stamp(),
    labels: { nodes: [{ id: 'label' }] }, stateId: 'todo', cycleId: 'cycle-1', assigneeId: 'person' }));
  const calls = [], own = [], lookups = [];
  // A change made in Linear, returning the webhook Linear would send for it.
  const change = (id, fields, actor) => {
    const row = rows.find(r => r.id === id);
    const updatedFrom = Object.fromEntries(Object.keys(fields).map(k => [k, row[k]]));
    Object.assign(row, fields); row.updatedAt = stamp();
    updatedFrom.updatedAt = row.updatedAt;
    return { type: 'Issue', action: 'update', webhookTimestamp: now, actor,
      data: { id, teamId: TEAM, sortOrder: row.sortOrder, updatedAt: row.updatedAt, stateId: row.stateId, cycleId: row.cycleId },
      updatedFrom };
  };
  const api = {
    team: async () => {}, issues: async () => structuredClone(rows), viewer: async () => VIEWER,
    user: async id => { lookups.push(id); return USERS[id] ? structuredClone(USERS[id]) : null; },
    update: async (id, sortOrder) => {
      calls.push({ id, sortOrder });
      own.push(change(id, { sortOrder }, { id: 'bot', type: 'user' }));
    },
  };
  const clock = () => now;
  const guard = new Guardrail(cfg, api, new Store(cfg), clock);
  await guard.control('publish'); await guard.control('resume');
  const deliver = (body, g = guard) => g.accept(body, undefined, randomUUID());
  const user = id => ({ id, type: 'user' });
  return { cfg, rows, calls, own, lookups, api, guard, clock, change, deliver, user,
    store: new Store(cfg), advance: ms => { now += ms; },
    restart: () => new Guardrail(cfg, api, new Store(cfg), clock),
    ids: () => [...rows].sort((x, y) => x.sortOrder - y.sortOrder).map(r => r.id),
    audit: async () => (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)) };
}

const baselineIds = async f => (await f.store.load()).baseline.map(b => b.id);

test('owners, admins and exact team owners can reorder; polling and restart keep the approved order', async t => {
  for (const actor of ALLOWED) {
    const f = await fixture(t);
    await f.deliver(f.change('c', { sortOrder: -1024 }, f.user(actor)));
    await f.guard.reconcile(); await f.guard.reconcile();
    await f.restart().reconcile();
    assert.equal(f.calls.length, 0, actor);
    assert.deepEqual(f.ids(), ['c', 'a', 'b']);
    assert.deepEqual(await baselineIds(f), ['c', 'a', 'b'], actor);
    const approved = (await f.audit()).find(e => e.event === 'approved-move');
    assert.deepEqual(approved.moved, ['c']); assert.equal(approved.approvals[0].actorId, actor);
    // Membership is unchanged by approval; the approved order is now what gets protected.
    assert.equal((await f.store.load()).baseline.length, 3);
    f.change('b', { sortOrder: -5000 }, f.user('member'));
    await f.guard.reconcile();
    assert.deepEqual(f.ids(), ['c', 'a', 'b'], `${actor}: later non-admin drift repaired to approved order`);
  }
});

test('other-team owners, members, inactive, app, foreign, unknown and non-user actors are repaired', async t => {
  const actors = [...DENIED.filter(id => id !== 'bot').map(id => ({ id, type: 'user' })),
    { id: 'admin', type: 'integration' }, { id: 'admin', type: 'oauthClient' }, { id: 'admin', type: 'externalUser' }, null];
  for (const actor of actors) {
    const f = await fixture(t);
    await f.deliver(f.change('c', { sortOrder: -1024 }, actor));
    await f.guard.reconcile();
    assert.ok(f.calls.length > 0, JSON.stringify(actor));
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
    assert.ok((await f.audit()).some(e => e.event === 'approval-rejected' && e.reason === 'unauthorized-actor'));
  }
});

test('admin status-only or cycle-only event cannot approve concurrent non-admin drift', async t => {
  for (const fields of [{ stateId: 'done' }, { cycleId: 'cycle-2' }]) {
    const f = await fixture(t);
    f.change('c', { sortOrder: -1024 }, f.user('member')); // Webhook missed.
    await f.deliver(f.change('c', fields, f.user('admin')));
    await f.deliver(f.change('a', fields, f.user('owner')));
    await f.guard.reconcile();
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
    assert.equal((await f.store.load()).candidates.length, 0, 'non-rank events are never approval evidence');
    const row = f.rows.find(r => r.id === 'c');
    assert.deepEqual([row.stateId, row.cycleId], [fields.stateId ?? 'todo', fields.cycleId ?? 'cycle-1']);
  }
});

test('cycle-only change is neither a violation nor an approval', async t => {
  const f = await fixture(t);
  await f.deliver(f.change('b', { cycleId: 'cycle-2' }, f.user('member')));
  await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
  assert.ok(!(await f.audit()).some(e => /approval|repair/.test(e.event)));
});

test('combined rank and status changes: admin approved, non-admin repaired; only sortOrder is written', async t => {
  const f = await fixture(t);
  await f.deliver(f.change('c', { sortOrder: -1024, stateId: 'in-progress', cycleId: 'cycle-2' }, f.user('admin')));
  await f.guard.reconcile();
  assert.equal(f.calls.length, 0); assert.deepEqual(await baselineIds(f), ['c', 'a', 'b']);

  await f.deliver(f.change('a', { sortOrder: 9000, stateId: 'done', cycleId: 'cycle-3', assigneeId: 'someone' }, f.user('member')));
  await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['c', 'a', 'b']);
  assert.ok(f.calls.length > 0 && f.calls.every(c => Object.keys(c).join() === 'id,sortOrder'));
  const a = f.rows.find(r => r.id === 'a');
  assert.deepEqual([a.stateId, a.cycleId, a.assigneeId], ['done', 'cycle-3', 'someone']);
});

test('own repair callbacks are recognised and never approve, even though the key user is an admin', async t => {
  const f = await fixture(t);
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('member')));
  await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  const writes = f.calls.length;
  for (const body of f.own) await f.deliver(body);
  await f.guard.reconcile(); await f.restart().reconcile();
  assert.equal(f.calls.length, writes);
  const s = await f.store.load();
  assert.ok(s.candidates.every(c => c.actorId !== 'bot')); assert.ok(s.intents.length >= writes);
  assert.equal(s.tripped, false);
  assert.ok((await f.audit()).some(e => e.event === 'own-callback'));
  // Rank changes made with the key user's identity outside an intent are denied, not approved.
  await f.deliver(f.change('c', { sortOrder: -2048 }, f.user('bot')));
  await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  assert.ok((await f.audit()).some(e => e.denied?.[0]?.reason === 'guardrail-api-key-user'));
});

test('mixed concurrent admin and non-admin drift is not laundered', async t => {
  for (const memberEvent of [false, true]) {
    const f = await fixture(t);
    await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
    const drift = f.change('a', { sortOrder: 5000 }, f.user('member'));
    if (memberEvent) await f.deliver(drift);
    await f.guard.reconcile();
    assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
    assert.deepEqual(f.ids(), ['a', 'b', 'c']);
    const rejection = (await f.audit()).find(e => e.event === 'approval-rejected');
    assert.equal(rejection.reason, memberEvent ? 'unauthorized-actor' : 'unexplained-rank-change');
  }
});

test('missed webhook: bounded grace, then repair; a late admin event cannot approve', async t => {
  const f = await fixture(t, { graceMs: 10000 });
  const late = f.change('c', { sortOrder: -1024 }, f.user('admin'));
  await f.guard.reconcile(); f.advance(5000); await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  assert.ok((await f.audit()).some(e => e.event === 'approval-wait'));
  f.advance(5001); await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  await f.deliver(late); await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
});

test('webhook arriving within the grace window approves without writes', async t => {
  const f = await fixture(t, { graceMs: 10000 });
  const event = f.change('c', { sortOrder: -1024 }, f.user('teamOwner'));
  await f.guard.reconcile(); f.advance(3000);
  await f.deliver(event); await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await baselineIds(f), ['c', 'a', 'b']);
  assert.equal((await f.store.load()).driftSince, null);
});

test('stale, anchor-mismatched and colliding rank events are rejected', async t => {
  // Stale: a later update (by anyone) changed the issue after the admin's rank event.
  let f = await fixture(t);
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
  f.change('c', { stateId: 'done' }, f.user('member'));
  await f.guard.reconcile();
  assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']); assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  assert.equal(f.rows.find(r => r.id === 'c').stateId, 'done');

  // Previous rank does not match the trusted anchor.
  f = await fixture(t);
  const event = f.change('c', { sortOrder: -1024 }, f.user('admin'));
  event.updatedFrom.sortOrder = 777;
  await f.deliver(event); await f.guard.reconcile();
  assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);

  // Rank collision with another protected issue.
  f = await fixture(t);
  await f.deliver(f.change('c', { sortOrder: 1024 }, f.user('admin')));
  await f.guard.reconcile();
  assert.deepEqual(await baselineIds(f), ['a', 'b', 'c']);
  assert.ok((await f.audit()).some(e => e.reason === 'rank-collision'));
});

test('several admin moves, including chained moves of one issue, are approved together', async t => {
  const f = await fixture(t);
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
  await f.deliver(f.change('c', { sortOrder: 512 }, f.user('owner')));
  await f.deliver(f.change('a', { sortOrder: 4096 }, f.user('teamOwner')));
  await f.guard.reconcile(); await f.restart().reconcile();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await baselineIds(f), ['c', 'b', 'a']);
  assert.equal((await f.store.load()).candidates.length, 0);
});

test('approvals are opt-in: default config repairs admin moves and keeps no approval evidence', async t => {
  const f = await fixture(t, { approvals: false });
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('owner')));
  await f.guard.reconcile();
  assert.deepEqual(f.ids(), ['a', 'b', 'c']);
  assert.equal((await f.store.load()).candidates.length, 0);
  assert.equal(f.lookups.length, 0);
});

test('dry run: approvals change only local baseline; unauthorized drift logs would-repair', async t => {
  const f = await fixture(t, { dry: true });
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
  await f.guard.reconcile();
  assert.deepEqual(await baselineIds(f), ['c', 'a', 'b']);
  assert.equal((await f.audit()).find(e => e.event === 'approved-move').dryRun, true);
  await f.deliver(f.change('b', { sortOrder: -9000 }, f.user('member')));
  await f.guard.reconcile(); await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await baselineIds(f), ['c', 'a', 'b']);
  assert.ok((await f.audit()).some(e => e.event === 'would-repair'));
});

test('events received while paused are ignored and resume starts without stale evidence', async t => {
  const f = await fixture(t);
  await f.guard.control('pause');
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
  assert.equal((await f.store.load()).candidates.length, 0);
  await assert.rejects(f.guard.control('resume'), /Order changed/);
  await f.guard.control('publish'); await f.guard.control('resume');
  assert.deepEqual(await baselineIds(f), ['c', 'a', 'b']);
});

test('API failure during role lookup fails closed without writes or approval', async t => {
  const f = await fixture(t);
  f.api.user = async () => { throw new Error('mock outage'); };
  await f.deliver(f.change('c', { sortOrder: -1024 }, f.user('admin')));
  await f.guard.reconcile();
  assert.equal(f.calls.length, 0);
  const s = await f.store.load();
  assert.deepEqual(s.baseline.map(b => b.id), ['a', 'b', 'c']); assert.equal(s.failures, 1);
  assert.ok(!inOrder(s.baseline.map(b => f.rows.find(r => r.id === b.id))));
});
