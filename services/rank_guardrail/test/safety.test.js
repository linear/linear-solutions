import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Guardrail, Store, LinearApi, inOrder } from '../src/guardrail.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rank-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = { dir, team: 't', label: 'l', dry: false };
  const rows = [{ id: 'a', sortOrder: 0, labels: { nodes: [{ id: 'l' }] } }, { id: 'b', sortOrder: 1024, labels: { nodes: [{ id: 'l' }] } }];
  let writes = 0;
  const api = { team: async () => {}, issues: async () => structuredClone(rows), update: async (id, rank) => { writes++; rows.find(r => r.id === id).sortOrder = rank; } };
  const store = new Store(cfg), guard = new Guardrail(cfg, api, store);
  await guard.control('publish');
  return { cfg, rows, api, store, guard, writes: () => writes };
}

test('resume refuses unpublished order; restore is explicit', async t => {
  const f = await setup(t); f.rows[0].sortOrder = 2048;
  await assert.rejects(f.guard.control('resume'), /Order changed/);
  assert.equal((await f.store.load()).paused, true);
  await f.guard.control('resume', { restore: true }); await f.guard.reconcile();
  assert.ok(inOrder(f.rows));
});

test('sustained drift budget persists across restart and blocks next mutation', async t => {
  const f = await setup(t); await f.guard.control('resume');
  await f.store.locked(async () => {
    const s = await f.store.load(); s.repairHistory = Array(10).fill(Date.now()); await f.store.save(s);
  });
  f.rows[0].sortOrder = 2048;
  const restarted = new Guardrail(f.cfg, f.api, new Store(f.cfg));
  await restarted.reconcile();
  assert.equal(f.writes(), 0); assert.equal((await f.store.load()).tripped, true);
});

test('publish explicitly reports label-removed items being dropped', async t => {
  const f = await setup(t); f.rows[0].labels.nodes = [];
  const result = await f.guard.control('publish');
  assert.deepEqual(result.dropped, ['a']);
});

test('state cannot be reused with another team or label', async t => {
  const f = await setup(t);
  await assert.rejects(new Store({ ...f.cfg, team: 'other' }).load(), /scope mismatch/);
  await assert.rejects(new Store({ ...f.cfg, label: 'other' }).load(), /scope mismatch/);
});

test('configured team requires exact identity, whatever its name', async () => {
  const cfg = { team: 'team', key: 'mock' };
  const fake = team => async () => ({ ok: true, json: async () => ({ data: { team } }) });
  await assert.rejects(new LinearApi(cfg, fake({ id: 'other' })).team());
  await assert.rejects(new LinearApi(cfg, fake(null)).team());
  await new LinearApi(cfg, fake({ id: 'team', name: 'Production' })).team();
});
