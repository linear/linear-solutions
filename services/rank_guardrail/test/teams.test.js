import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { config } from '../src/guardrail.js';
import { GuardrailError } from '../src/errors.js';
import { run, server, guardsFor, reconcileAll } from '../src/cli.js';

// Two teams with ordinary names, protected by the SAME workspace label, so isolation has to come
// from the team, not from the label.
const LABEL = 'label-shared';
const TEAMS = { 'team-a': 'Engineering', 'team-b': 'Design' };
const USERS = {
  ownerA: { id: 'ownerA', active: true, app: false, admin: false, owner: false, organization: { id: 'org' },
    teamMemberships: [{ owner: true, archivedAt: null, team: { id: 'team-a' } }], membershipsComplete: true },
};

async function world(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rank-teams-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let tick = 0;
  const stamp = () => new Date(1_800_000_000_000 + ++tick * 1000).toISOString();
  const rows = {};
  for (const team of Object.keys(TEAMS)) {
    rows[team] = ['1', '2', '3'].map((n, i) => ({ id: `${team}-${n}`, sortOrder: i * 1024, updatedAt: stamp(),
      archivedAt: null, labels: { nodes: [{ id: LABEL }] } }));
  }
  const writes = [];
  const makeApi = cfg => ({
    team: async () => { if (!rows[cfg.team]) throw new Error('unknown team'); },
    issues: async () => structuredClone(rows[cfg.team]),
    viewer: async () => ({ id: 'app-user', organization: { id: 'org' } }),
    user: async id => structuredClone(USERS[id] ?? null),
    update: async (id, sortOrder) => {
      writes.push({ team: cfg.team, id });
      const row = rows[cfg.team].find(r => r.id === id);
      row.sortOrder = sortOrder; row.updatedAt = stamp();
    },
  });
  const env = { PROTECTED_TEAMS: `team-a:${LABEL},team-b:${LABEL}`, LINEAR_API_KEY: 'Bearer mock', WEBHOOK_SECRET: 'team-a-webhook-secret,mock-secret',
    STATE_DIR: dir, DRY_RUN: 'false', ROLE_APPROVALS: 'false', APPROVAL_GRACE_MS: '0', ...extra };
  const cli = argv => run(argv, env, makeApi);
  for (const team of Object.keys(TEAMS)) {
    await cli(['pause', '--team', team]); await cli(['publish', '--team', team]); await cli(['resume', '--team', team]);
  }
  const cfg = config(env);
  const guards = guardsFor(cfg, makeApi);
  const ids = team => [...rows[team]].sort((x, y) => x.sortOrder - y.sortOrder).map(r => r.id);
  const state = async team => JSON.parse(await readFile(join(dir, 'teams', team, 'state.json'), 'utf8'));
  const audit = async team => (await readFile(join(dir, 'teams', team, 'audit.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  // A change made in Linear, returning the webhook Linear would send for it.
  const change = (team, id, sortOrder, actor) => {
    const row = rows[team].find(r => r.id === id);
    const from = row.sortOrder;
    row.sortOrder = sortOrder; row.updatedAt = stamp();
    return { type: 'Issue', action: 'update', webhookTimestamp: Date.now(), actor,
      data: { id, teamId: team, sortOrder, updatedAt: row.updatedAt }, updatedFrom: { sortOrder: from, updatedAt: row.updatedAt } };
  };
  return { dir, env, cfg, cli, guards, rows, writes, ids, state, audit, change, makeApi };
}

test('teams with ordinary names are configured, published and reported separately', async t => {
  const w = await world(t);
  assert.deepEqual(w.cfg.teams.map(x => x.dir), ['team-a', 'team-b'].map(team => join(w.dir, 'teams', team)));
  const { teams } = await w.cli(['status']);
  assert.deepEqual(teams.map(s => [s.team, s.label, s.paused, s.protectedCount]), [['team-a', LABEL, false, 3], ['team-b', LABEL, false, 3]]);
  assert.deepEqual((await w.state('team-a')).baseline.map(b => b.id), ['team-a-1', 'team-a-2', 'team-a-3']);
  assert.deepEqual((await w.state('team-b')).baseline.map(b => b.id), ['team-b-1', 'team-b-2', 'team-b-3']);
  assert.equal((await w.cli(['status', '--team', 'team-b'])).team, 'team-b');
});

test('publish, resume and check-actor need --team when several teams are configured', async t => {
  const w = await world(t);
  for (const argv of [['publish'], ['resume'], ['resume', '--restore'], ['check-actor', 'ownerA']]) {
    await assert.rejects(w.cli(argv), e => e instanceof GuardrailError && e.code === 'usage' && /pass --team/.test(e.message), argv.join(' '));
  }
  await assert.rejects(w.cli(['pause', '--team', 'team-z']), e => e.code === 'usage' && /not listed/.test(e.message));
  await assert.rejects(w.cli(['pause', '--team']), e => e.code === 'usage');
  await assert.rejects(w.cli(['status', '--team', 'team-a', '--team', 'team-b']), e => e.code === 'usage');
  const a = await w.cli(['check-actor', 'ownerA', '--team', 'team-a']);
  const b = await w.cli(['check-actor', 'ownerA', '--team', 'team-b']);
  assert.deepEqual([a.allowed, a.reason, b.allowed, b.reason], [true, 'team-owner', false, 'not-owner-admin-or-team-owner']);
});

test('pausing one team leaves the other running; pause without --team pauses all', async t => {
  const w = await world(t);
  await w.cli(['pause', '--team', 'team-a']);
  assert.deepEqual([(await w.state('team-a')).paused, (await w.state('team-b')).paused], [true, false]);
  w.change('team-a', 'team-a-3', -1024, null);
  w.change('team-b', 'team-b-3', -1024, null);
  await reconcileAll(w.guards);
  assert.deepEqual(w.ids('team-a'), ['team-a-3', 'team-a-1', 'team-a-2'], 'paused team is not repaired');
  assert.deepEqual(w.ids('team-b'), ['team-b-1', 'team-b-2', 'team-b-3'], 'running team is repaired');
  assert.ok(w.writes.every(x => x.team === 'team-b'));
  const { teams } = await w.cli(['pause']);
  assert.deepEqual(teams.map(s => s.paused), [true, true]);
});

test('drift in one team only repairs that team and never touches the other team state', async t => {
  const w = await world(t);
  await reconcileAll(w.guards); // First check after resume settles both teams.
  const before = await readFile(join(w.dir, 'teams', 'team-b', 'state.json'), 'utf8');
  w.change('team-a', 'team-a-3', -1024, null);
  await reconcileAll(w.guards);
  assert.deepEqual(w.ids('team-a'), ['team-a-1', 'team-a-2', 'team-a-3']);
  assert.ok(w.writes.length > 0 && w.writes.every(x => x.team === 'team-a' && x.id.startsWith('team-a-')));
  assert.deepEqual(w.ids('team-b'), ['team-b-1', 'team-b-2', 'team-b-3']);
  assert.equal(await readFile(join(w.dir, 'teams', 'team-b', 'state.json'), 'utf8'), before);
  assert.ok(!(await w.audit('team-b')).some(e => /repair/.test(e.event)));
});

test('a failing team does not stop checks or repairs for the others', async t => {
  const w = await world(t);
  const broken = w.guards[0];
  broken.reconcile = async () => { throw new Error('mock lock failure'); };
  w.change('team-b', 'team-b-3', -1024, null);
  const logged = [];
  await reconcileAll(w.guards, line => logged.push(line));
  assert.deepEqual(w.ids('team-b'), ['team-b-1', 'team-b-2', 'team-b-3']);
  assert.equal(logged.length, 1); assert.match(logged[0], /team team-a \(unexpected-error/);
});

test('webhooks are routed per team: a team owner approves only in their own team', async t => {
  const w = await world(t, { ROLE_APPROVALS: 'true' });
  const http = server(w.cfg, w.guards);
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => http.close(r)));
  const url = `http://127.0.0.1:${http.address().port}/webhook`;
  const send = async event => {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', 'mock-secret').update(body).digest('hex');
    return (await fetch(url, { method: 'POST', body, headers: { 'linear-signature': signature } })).status;
  };
  const ownerA = { id: 'ownerA', type: 'user' };
  assert.equal(await send(w.change('team-a', 'team-a-3', -1024, ownerA)), 200);
  assert.equal(await send(w.change('team-b', 'team-b-3', -1024, ownerA)), 200);
  const [a, b] = [await w.state('team-a'), await w.state('team-b')];
  assert.deepEqual([a.candidates.map(c => c.id), b.candidates.map(c => c.id)], [['team-a-3'], ['team-b-3']]);
  assert.equal(a.seen.length, 1); assert.equal(b.seen.length, 1);

  await reconcileAll(w.guards);
  // Team A: its own team owner's move becomes the approved order, with no writes.
  assert.deepEqual((await w.state('team-a')).baseline.map(x => x.id), ['team-a-3', 'team-a-1', 'team-a-2']);
  assert.deepEqual(w.ids('team-a'), ['team-a-3', 'team-a-1', 'team-a-2']);
  // Team B: owning team A gives no rights in team B, so the move is repaired.
  assert.deepEqual(w.ids('team-b'), ['team-b-1', 'team-b-2', 'team-b-3']);
  assert.deepEqual((await w.state('team-b')).baseline.map(x => x.id), ['team-b-1', 'team-b-2', 'team-b-3']);
  assert.ok(w.writes.every(x => x.team === 'team-b'));
  const rejected = (await w.audit('team-b')).find(e => e.event === 'approval-rejected');
  assert.equal(rejected.reason, 'unauthorized-actor');
});

test('an event claiming another team cannot approve or enter a team it does not belong to', async t => {
  const w = await world(t, { ROLE_APPROVALS: 'true' });
  // Team A event for an issue that is in team B's baseline (for example, moved between teams):
  // team B notes it for a fresh read but never treats it as approval evidence.
  const event = w.change('team-b', 'team-b-3', -1024, { id: 'ownerA', type: 'user' });
  event.data.teamId = 'team-a';
  await Promise.all(w.guards.map(g => g.accept(event, undefined, 'digest-1')));
  const [a, b] = [await w.state('team-a'), await w.state('team-b')];
  assert.equal(a.candidates.length, 0); assert.equal(b.candidates.length, 0);
  assert.equal(b.pending, true);
  await reconcileAll(w.guards);
  assert.deepEqual(w.ids('team-b'), ['team-b-1', 'team-b-2', 'team-b-3']);
});

test('single-team state from earlier versions must be moved before running', async t => {
  const w = await world(t);
  await writeFile(join(w.dir, 'state.json'), '{}');
  await assert.rejects(w.cli(['status']), e => e instanceof GuardrailError && e.code === 'state-migration' && /teams\/<team UUID>/.test(e.message));
  assert.ok(existsSync(join(w.dir, 'state.json')), 'legacy state is left untouched');
});
