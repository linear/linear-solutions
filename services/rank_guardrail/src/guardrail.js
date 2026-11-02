import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export function config(env = process.env) {
  const team = env.TEST_TEAM_ID;
  if (!team || !env.TEST_TEAM_ALLOWLIST?.split(',').map(x => x.trim()).includes(team)) {
    throw new Error('TEST_TEAM_ID must be explicitly allowlisted');
  }
  if (!env.PROTECTED_LABEL_ID || !env.LINEAR_API_KEY || !env.WEBHOOK_SECRET) {
    throw new Error('Missing label, API key, or webhook secret');
  }
  const dir = resolve(env.STATE_DIR || '.state');
  return { team, label: env.PROTECTED_LABEL_ID, key: env.LINEAR_API_KEY,
    secret: env.WEBHOOK_SECRET, dry: env.DRY_RUN !== 'false', dir };
}

export function verify(raw, signature, timestamp, secret, now = Date.now()) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) throw new Error('Signature rejected');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Signature rejected');
  const body = JSON.parse(raw.toString('utf8'));
  // Linear signs the raw body, not the timestamp header. Use its signed millisecond timestamp.
  if (!Number.isSafeInteger(body.webhookTimestamp) || Math.abs(now - body.webhookTimestamp) > 60000) {
    throw new Error('Timestamp rejected');
  }
  if (timestamp !== undefined && timestamp !== String(body.webhookTimestamp)) throw new Error('Timestamp mismatch');
  return body;
}

export class Store {
  constructor(cfg) { this.cfg = cfg; }
  async locked(fn) {
    await mkdir(this.cfg.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.cfg.dir, 'lock');
    for (let tries = 0; ; tries++) {
      try { await mkdir(lock); break; } catch (e) {
        if (e.code !== 'EEXIST' || tries >= 300) throw new Error('State lock unavailable; stop all processes before recovering a stale lock');
        await new Promise(r => setTimeout(r, 100));
      }
    }
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
  async load() {
    let state;
    try { state = JSON.parse(await readFile(join(this.cfg.dir, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!state) state = { version: 1, team: this.cfg.team, label: this.cfg.label, paused: true,
      baseline: [], seen: [], pending: false, failures: 0, tripped: false };
    if (state.version !== 1 || state.team !== this.cfg.team || state.label !== this.cfg.label) {
      throw new Error('State scope mismatch; use a separate STATE_DIR');
    }
    return state;
  }
  async save(state) {
    const temp = join(this.cfg.dir, `state-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, join(this.cfg.dir, 'state.json'));
  }
  async audit(event, fields = {}) {
    await appendFile(join(this.cfg.dir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 });
  }
}

export class LinearApi {
  constructor(cfg, fetcher = fetch) { this.cfg = cfg; this.fetcher = fetcher; }
  async query(query, variables) {
    const res = await this.fetcher('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: this.cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const result = await res.json();
    // Do not expose API errors: they can contain request metadata.
    if (result.errors || !result.data) throw new Error('GraphQL rejected request');
    return result.data;
  }
  async team() {
    const { team } = await this.query('query($id:String!){team(id:$id){id name}}', { id: this.cfg.team });
    if (team.id !== this.cfg.team || !/\btest\b/i.test(team.name)) throw new Error('Team must have TEST in its name and match configured UUID');
  }
  async issues() {
    const rows = []; let after = null;
    do {
      const { issues } = await this.query(`query($team:ID!,$after:String){issues(first:100,after:$after,includeArchived:true,filter:{team:{id:{eq:$team}}}){nodes{id sortOrder archivedAt labels{nodes{id}}} pageInfo{hasNextPage endCursor}}}`, { team: this.cfg.team, after });
      rows.push(...issues.nodes);
      after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
      if (rows.length > 10000 || (issues.pageInfo.hasNextPage && !after)) throw new Error('Unsafe pagination');
    } while (after);
    return rows;
  }
  async update(id, sortOrder) {
    const data = await this.query('mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}', { id, input: { sortOrder } });
    if (!data.issueUpdate.success) throw new Error('Rank update rejected');
  }
}

export function ordered(rows) {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}
export function protectedRows(state, rows) {
  const current = new Map(rows.map(r => [r.id, r]));
  const selected = state.baseline.map(b => current.get(b.id));
  if (selected.some(r => !r || r.archivedAt || !Number.isFinite(r.sortOrder))) {
    throw new Error('Baseline item missing, archived, moved, or invalid; explicit review required');
  }
  return selected;
}
export function inOrder(rows) {
  return rows.every((r, i) => !i || rows[i - 1].sortOrder < r.sortOrder);
}

// Re-space only the protected subset. Snapshot numbers are evidence, not immutable ranks.
export function plan(rows) {
  if (inOrder(rows)) return [];
  const ranks = rows.map(r => r.sortOrder);
  const min = Math.min(...ranks), max = Math.max(...ranks);
  const step = Math.max(1024, (max - min) / Math.max(1, rows.length - 1));
  const result = rows.map((r, i) => ({ id: r.id, sortOrder: min + i * step }));
  if (result.some((r, i) => !Number.isFinite(r.sortOrder) || (i && r.sortOrder <= result[i - 1].sortOrder))) {
    throw new Error('Cannot safely represent ranks');
  }
  return result;
}

export class Guardrail {
  constructor(cfg, api, store = new Store(cfg)) { this.cfg = cfg; this.api = api; this.store = store; }
  async control(command, { restore = false } = {}) {
    return this.store.locked(async () => {
      const s = await this.store.load();
      if (command === 'status') return { ...s, dryRun: this.cfg.dry };
      let dropped = [];
      if (command === 'pause') s.paused = true;
      else if (command === 'publish') {
        if (!s.paused) throw new Error('Pause before publishing');
        await this.api.team();
        const rows = (await this.api.issues()).filter(r => !r.archivedAt && r.labels.nodes.some(l => l.id === this.cfg.label));
        if (!rows.length || rows.length > 100) throw new Error('Publish requires 1–100 protected issues');
        const sorted = ordered(rows);
        if (rows.some(r => !Number.isFinite(r.sortOrder)) || !inOrder(sorted)) throw new Error('Resolve rank collisions before publishing');
        dropped = s.baseline.filter(b => !sorted.some(r => r.id === b.id)).map(b => b.id);
        s.baseline = sorted.map(({ id, sortOrder }) => ({ id, sortOrder }));
        s.publishedAt = new Date().toISOString(); s.tripped = false; s.failures = 0; s.repairHistory = [];
      } else if (command === 'resume') {
        if (!s.baseline.length) throw new Error('Publish a baseline first');
        if (s.tripped) throw new Error('Review audit and publish while paused to reset breaker');
        await this.api.team();
        if (!restore && !inOrder(protectedRows(s, await this.api.issues()))) {
          throw new Error('Order changed while paused: publish intentionally, or resume --restore to restore baseline');
        }
        s.paused = false; s.pending = true;
      } else throw new Error('Unknown command');
      await this.store.audit(command, { count: s.baseline.length, dropped, restore });
      await this.store.save(s);
      return { paused: s.paused, protectedCount: s.baseline.length, dropped, dryRun: this.cfg.dry };
    });
  }
  async accept(body, delivery, digest) {
    if (body.type !== 'Issue' || !['create', 'update', 'remove'].includes(body.action)) return;
    // Out-of-team removals/moves can still concern a baseline ID.
    await this.store.locked(async () => {
      const s = await this.store.load();
      if (body.data?.teamId !== this.cfg.team && !s.baseline.some(b => b.id === body.data?.id)) return;
      // Retry deliveries can have newly signed timestamps. Header dedup is best effort only;
      // raw-body dedup and periodic fresh reads keep correctness independent of this unsigned header.
      const keys = [digest];
      if (typeof delivery === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(delivery)) keys.push(`delivery:${delivery}`);
      if (keys.some(k => s.seen.includes(k))) return;
      s.seen = [...s.seen, ...keys].slice(-4000); s.pending = true;
      await this.store.save(s);
    });
  }
  async reconcile() {
    return this.store.locked(async () => {
      const s = await this.store.load();
      if (s.paused || s.tripped || !s.baseline.length) return;
      try {
        await this.api.team();
        let writes = 0;
        for (let pass = 0; pass < 3; pass++) {
          const rows = protectedRows(s, await this.api.issues());
          if (inOrder(rows)) {
            if (writes || s.pending) await this.store.audit('in-order', { writes });
            s.pending = false; s.failures = 0; await this.store.save(s); return;
          }
          const repairs = plan(rows);
          if (this.cfg.dry) {
            await this.store.audit('would-repair', { repairs });
            s.pending = false; await this.store.save(s); return;
          }
          // One write per fresh read: never replay stale webhook values or an old repair plan.
          const repair = repairs.find((r, i) => r.sortOrder !== rows[i].sortOrder);
          if (!repair || writes >= 3) break;
          s.repairHistory = (s.repairHistory || []).filter(at => at > Date.now() - 600000);
          if (s.repairHistory.length >= 10) {
            s.tripped = true;
            await this.store.audit('breaker', { reason: 'ten-write-ten-minute-budget' });
            await this.store.save(s); return;
          }
          s.repairHistory.push(Date.now());
          // Persist intent/budget before the network call: restarting cannot reset the rate budget.
          await this.store.audit('repair-intent', repair);
          await this.store.save(s);
          await this.api.update(repair.id, repair.sortOrder); writes++;
        }
        // A maximum of three mutations per sweep; large drift requires explicit review, not a loop.
        if (!inOrder(protectedRows(s, await this.api.issues()))) {
          s.tripped = true; await this.store.audit('breaker', { reason: 'repair-budget', writes });
        } else { s.failures = 0; s.pending = false; }
      } catch {
        s.failures++;
        if (s.failures >= 3) s.tripped = true;
        await this.store.audit('reconcile-error', { failures: s.failures, tripped: s.tripped });
      }
      await this.store.save(s);
    });
  }
}
