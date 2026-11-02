import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GuardrailError, fail } from './errors.js';
import { authorize, actorType } from './roles.js';

const ID = /^[A-Za-z0-9-]{1,64}$/;
const CANDIDATE_TTL_MS = 600000;
const INTENT_TTL_MS = 600000;
const MAX_CANDIDATES = 200;
const MAX_CHAIN = 20;

export function config(env = process.env) {
  const team = env.TEST_TEAM_ID;
  if (!team) fail('config', 'TEST_TEAM_ID is missing in .env');
  if (!env.TEST_TEAM_ALLOWLIST?.split(',').map(x => x.trim()).includes(team)) {
    fail('config', 'TEST_TEAM_ID must be explicitly allowlisted: repeat the same team UUID in TEST_TEAM_ALLOWLIST');
  }
  for (const name of ['TEST_TEAM_ID', 'PROTECTED_LABEL_ID', 'LINEAR_API_KEY', 'WEBHOOK_SECRET']) {
    if (!env[name]) fail('config', `${name} is missing in .env`);
    if (env[name].startsWith('REPLACE_WITH_')) fail('config', `${name} still contains its REPLACE_WITH_ placeholder`);
  }
  if (env.ROLE_APPROVALS !== undefined && !['', 'true', 'false'].includes(env.ROLE_APPROVALS)) {
    fail('config', 'ROLE_APPROVALS must be exactly true or false (lower case)');
  }
  const graceRaw = env.APPROVAL_GRACE_MS;
  const graceMs = graceRaw === undefined || graceRaw === '' ? 10000 : Number(graceRaw);
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60000) {
    fail('config', 'APPROVAL_GRACE_MS must be a whole number of milliseconds from 0 to 60000');
  }
  const dir = resolve(env.STATE_DIR || '.state');
  return { team, label: env.PROTECTED_LABEL_ID, key: env.LINEAR_API_KEY,
    secret: env.WEBHOOK_SECRET, dry: env.DRY_RUN !== 'false', approvals: env.ROLE_APPROVALS === 'true', graceMs, dir };
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
    const maxTries = this.cfg.lockTries ?? 300;
    for (let tries = 0; ; tries++) {
      try { await mkdir(lock); break; } catch (e) {
        if (e.code !== 'EEXIST' || tries >= maxTries) {
          fail('state-lock', 'State lock unavailable: another command or the server holds it. Wait and retry; after an unclean kill, stop every process using this STATE_DIR before removing a confirmed stale lock directory');
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
  async load() {
    let state;
    try { state = JSON.parse(await readFile(join(this.cfg.dir, 'state.json'), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') fail('state-unreadable', 'state.json could not be read or parsed; stop all processes and preserve it for review');
    }
    if (!state) state = { version: 1, team: this.cfg.team, label: this.cfg.label, paused: true,
      baseline: [], seen: [], pending: false, failures: 0, tripped: false };
    if (state.version !== 1 || state.team !== this.cfg.team || state.label !== this.cfg.label) {
      fail('state-scope', 'State scope mismatch: this STATE_DIR belongs to a different team or label; use a separate STATE_DIR');
    }
    // Fields added with role-aware approvals; older version-1 state files load unchanged.
    state.candidates ??= [];
    state.intents ??= [];
    state.driftSince ??= null;
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

const HTTP_HINTS = { 400: 'check team/label UUIDs', 401: 'check LINEAR_API_KEY; OAuth app tokens expire and must be renewed', 403: 'the token lacks access to this team or operation',
  429: 'rate limited; wait before retrying' };

const USER_QUERY = `query($id:String!,$after:String){user(id:$id){id active app admin owner organization{id}
teamMemberships(first:100,after:$after,includeArchived:false){nodes{owner archivedAt team{id}} pageInfo{hasNextPage endCursor}}}}`;

// OAuth app tokens (recommended) need the Bearer scheme; personal API keys (lin_api_) are sent as-is.
export function authorization(key) {
  return key.startsWith('lin_api_') || key.startsWith('Bearer ') ? key : `Bearer ${key}`;
}

export class LinearApi {
  constructor(cfg, fetcher = fetch) { this.cfg = cfg; this.fetcher = fetcher; }
  async query(query, variables) {
    let res;
    try {
      res = await this.fetcher('https://api.linear.app/graphql', {
        method: 'POST', headers: { Authorization: authorization(this.cfg.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
      });
    } catch {
      fail('api-network', 'Linear API unreachable or timed out (network error); check connectivity and retry');
    }
    if (!res.ok) {
      const status = Number.isInteger(res.status) ? res.status : 0;
      const hint = HTTP_HINTS[status] ?? (status >= 500 ? 'Linear API unavailable; retry later' : 'unexpected response');
      fail('api-http', `Linear API returned HTTP ${status} (${hint})`);
    }
    let result;
    try { result = await res.json(); } catch { fail('api-response', 'Linear API returned an unreadable response'); }
    // Do not expose API errors: they can contain request metadata.
    if (result?.errors || !result?.data) {
      fail('api-graphql', 'Linear API rejected the request; check team/label UUIDs and API key permissions (details hidden)');
    }
    return result.data;
  }
  async team() {
    const { team } = await this.query('query($id:String!){team(id:$id){id name}}', { id: this.cfg.team });
    if (!team || team.id !== this.cfg.team) fail('team-mismatch', 'Linear returned a different team than TEST_TEAM_ID; check the team UUID');
    if (!/\btest\b/i.test(team.name)) {
      fail('team-name', 'The configured team name must contain TEST as a separate word, for example "Rank Guardrail TEST" ("Testing" or "MyTest" do not qualify)');
    }
  }
  async issues() {
    const rows = []; let after = null;
    do {
      const { issues } = await this.query(`query($team:ID!,$after:String){issues(first:100,after:$after,includeArchived:true,filter:{team:{id:{eq:$team}}}){nodes{id sortOrder updatedAt archivedAt labels{nodes{id}}} pageInfo{hasNextPage endCursor}}}`, { team: this.cfg.team, after });
      rows.push(...issues.nodes);
      after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
      if (rows.length > 10000 || (issues.pageInfo.hasNextPage && !after)) {
        fail('api-pagination', 'Team issue list exceeds 10,000 issues or returned an unsafe page; use a smaller dedicated TEST team');
      }
    } while (after);
    return rows;
  }
  async viewer() {
    const { viewer } = await this.query('query{viewer{id organization{id}}}');
    return viewer;
  }
  // Read-only role lookup. Unknown/inaccessible users resolve to null (denied), not errors.
  async user(id) {
    const memberships = []; let after = null, user = null;
    for (let page = 0; page < 10; page++) {
      let data;
      try { data = await this.query(USER_QUERY, { id, after }); }
      catch (e) { if (e instanceof GuardrailError && e.code === 'api-graphql') return null; throw e; }
      if (!data.user || (user && data.user.id !== user.id)) return null;
      const { teamMemberships, ...fields } = data.user;
      user ??= fields;
      memberships.push(...(teamMemberships?.nodes ?? []));
      after = teamMemberships?.pageInfo?.hasNextPage ? teamMemberships.pageInfo.endCursor : null;
      if (!after) return { ...user, teamMemberships: memberships, membershipsComplete: !teamMemberships?.pageInfo?.hasNextPage };
    }
    return { ...user, teamMemberships: memberships, membershipsComplete: false };
  }
  async update(id, sortOrder) {
    const data = await this.query('mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}', { id, input: { sortOrder } });
    if (!data.issueUpdate.success) fail('api-graphql', 'Linear API rejected the rank update');
  }
}

export function ordered(rows) {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}
export function protectedRows(state, rows) {
  const current = new Map(rows.map(r => [r.id, r]));
  const selected = state.baseline.map(b => current.get(b.id));
  if (selected.some(r => !r || r.archivedAt || !Number.isFinite(r.sortOrder))) {
    fail('baseline-missing', 'Baseline item missing, archived, moved, or invalid; explicit review required');
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
    fail('rank-unrepresentable', 'Cannot safely represent ranks');
  }
  return result;
}

// A signed Issue update that changed sortOrder, reduced to the fields needed for approval.
// Status/cycle/assignee-only updates carry no updatedFrom.sortOrder and are never candidates.
export function candidateFrom(body, team, receivedAt) {
  if (body?.type !== 'Issue' || body.action !== 'update') return null;
  const from = body.updatedFrom?.sortOrder, to = body.data?.sortOrder;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  const { id, teamId, updatedAt } = body.data;
  if (typeof id !== 'string' || !ID.test(id) || teamId !== team) return null;
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return null;
  const actorId = typeof body.actor?.id === 'string' && ID.test(body.actor.id) ? body.actor.id : null;
  return { id, from, to, updatedAt, actorType: actorType(body.actor), actorId,
    webhookTimestamp: body.webhookTimestamp, receivedAt };
}

const sameInstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);

// Follow authorized-or-not webhook steps from the trusted anchor to the fresh rank. The last
// step must also carry the fresh updatedAt, proving no later unseen update touched the issue.
export function chainFor(row, anchor, candidates) {
  const mine = candidates.filter(c => c.id === row.id)
    .sort((a, b) => a.webhookTimestamp - b.webhookTimestamp || a.receivedAt - b.receivedAt);
  const links = []; let rank = anchor;
  while (links.length < MAX_CHAIN) {
    const next = mine.find(c => !links.includes(c) && c.from === rank);
    if (!next) return null;
    links.push(next); rank = next.to;
    if (rank === row.sortOrder && sameInstant(next.updatedAt, row.updatedAt)) return links;
  }
  return null;
}

function prune(s, now) {
  s.candidates = s.candidates.filter(c => c.receivedAt > now - CANDIDATE_TTL_MS);
  s.intents = s.intents.filter(i => i.at > now - INTENT_TTL_MS);
}

export class Guardrail {
  constructor(cfg, api, store = new Store(cfg), clock = Date.now) {
    this.cfg = cfg; this.api = api; this.store = store; this.clock = clock;
  }
  async control(command, { restore = false } = {}) {
    return this.store.locked(async () => {
      const s = await this.store.load();
      if (command === 'status') return this.status(s);
      let dropped = [];
      if (command === 'pause') s.paused = true;
      else if (command === 'publish') {
        if (!s.paused) fail('pause-required', 'Publish requires pause: run pause, wait for "paused": true, then publish');
        await this.api.team();
        const rows = (await this.api.issues()).filter(r => !r.archivedAt && r.labels.nodes.some(l => l.id === this.cfg.label));
        if (!rows.length || rows.length > 100) {
          fail('label-count', `Publish requires 1-100 non-archived issues with PROTECTED_LABEL_ID in the TEST team; found ${rows.length}`);
        }
        const sorted = ordered(rows);
        if (rows.some(r => !Number.isFinite(r.sortOrder)) || !inOrder(sorted)) {
          fail('rank-collision', 'Two or more protected issues share a rank or have no numeric rank; while paused, drag them into a distinct manual order and publish again');
        }
        dropped = s.baseline.filter(b => !sorted.some(r => r.id === b.id)).map(b => b.id);
        s.baseline = sorted.map(({ id, sortOrder }) => ({ id, sortOrder }));
        s.publishedAt = new Date().toISOString(); s.tripped = false; s.failures = 0; s.repairHistory = [];
        s.candidates = []; s.driftSince = null;
      } else if (command === 'resume') {
        if (!s.baseline.length) fail('no-baseline', 'Publish a baseline first (pause, then publish)');
        if (s.tripped) fail('breaker-tripped', 'Safety breaker is tripped: review the audit, then publish while paused to reset it');
        await this.api.team();
        if (!restore && !inOrder(protectedRows(s, await this.api.issues()))) {
          fail('order-changed', 'Order changed while paused: publish intentionally, or resume --restore to restore baseline');
        }
        // Webhook evidence from before the pause is not reused for approvals.
        s.paused = false; s.pending = true; s.candidates = []; s.driftSince = null;
      } else fail('usage', 'Unknown command');
      await this.store.audit(command, { count: s.baseline.length, dropped, restore });
      await this.store.save(s);
      return { paused: s.paused, protectedCount: s.baseline.length, dropped, dryRun: this.cfg.dry, roleApprovals: this.cfg.approvals };
    });
  }
  status(s) {
    return { paused: s.paused, tripped: s.tripped, failures: s.failures, pending: s.pending,
      dryRun: this.cfg.dry, roleApprovals: this.cfg.approvals, approvalGraceMs: this.cfg.graceMs,
      protectedCount: s.baseline.length, baseline: s.baseline, publishedAt: s.publishedAt ?? null,
      driftSince: s.driftSince, pendingApprovalEvents: s.candidates.length, ownWriteIntents: s.intents.length,
      recentRepairWrites: (s.repairHistory || []).length, seenDeliveryKeys: s.seen.length };
  }
  // Read-only: explains whether a user would be allowed to approve a reorder.
  async checkActor(userId) {
    if (typeof userId !== 'string' || !ID.test(userId)) fail('usage', 'check-actor requires a user UUID');
    await this.api.team();
    const [viewer, user] = await Promise.all([this.api.viewer(), this.api.user(userId)]);
    return { userId, team: this.cfg.team, ...authorize({ actor: { type: 'user', id: userId }, user, viewer, team: this.cfg.team }),
      roleApprovals: this.cfg.approvals };
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
      if (this.cfg.approvals && !s.paused) {
        const now = this.clock();
        prune(s, now);
        const candidate = candidateFrom(body, this.cfg.team, now);
        if (candidate && s.baseline.some(b => b.id === candidate.id)) {
          if (s.intents.some(i => i.id === candidate.id && i.sortOrder === candidate.to)) {
            await this.store.audit('own-callback', { id: candidate.id });
          } else {
            s.candidates = [...s.candidates, candidate].slice(-MAX_CANDIDATES);
          }
        }
      }
      await this.store.save(s);
    });
  }
  // Decide whether out-of-order protected ranks are a provable authorized reorder.
  // Returns 'approved' (baseline replaced), 'waiting' (bounded grace), or 'rejected' (repair).
  async review(s, rows) {
    const now = this.clock();
    const anchors = new Map(s.baseline.map(b => [b.id, b.sortOrder]));
    const changed = rows.filter(r => r.sortOrder !== anchors.get(r.id));
    if (!changed.length) return 'rejected';
    const own = new Set(s.intents.map(i => `${i.id}:${i.sortOrder}`));
    const usable = s.candidates.filter(c => !own.has(`${c.id}:${c.to}`));
    const chains = changed.map(row => ({ row, links: chainFor(row, anchors.get(row.id), usable) }));
    const unexplained = chains.filter(c => !c.links).map(c => c.row.id);
    if (unexplained.length) {
      s.driftSince ??= now;
      if (now - s.driftSince < this.cfg.graceMs) {
        await this.store.audit('approval-wait', { ids: unexplained, graceMs: this.cfg.graceMs });
        s.pending = true;
        return 'waiting';
      }
      await this.store.audit('approval-rejected', { reason: 'unexplained-rank-change', ids: unexplained });
      return 'rejected';
    }
    const viewer = await this.api.viewer();
    const decisions = new Map(), approved = [], denied = [];
    for (const { row, links } of chains) {
      for (const link of links) {
        const key = `${link.actorType}:${link.actorId}`;
        if (!decisions.has(key)) {
          const user = link.actorType === 'user' && link.actorId ? await this.api.user(link.actorId) : null;
          decisions.set(key, authorize({ actor: { type: link.actorType, id: link.actorId }, user, viewer, team: this.cfg.team }));
        }
        const { allowed, reason } = decisions.get(key);
        (allowed ? approved : denied).push({ id: row.id, actorId: link.actorId, reason });
      }
    }
    if (denied.length) {
      await this.store.audit('approval-rejected', { reason: 'unauthorized-actor', denied });
      return 'rejected';
    }
    const sequence = ordered(rows);
    if (!inOrder(sequence)) {
      await this.store.audit('approval-rejected', { reason: 'rank-collision', ids: changed.map(r => r.id) });
      return 'rejected';
    }
    const used = new Set(chains.flatMap(c => c.links));
    const before = s.baseline.map(b => b.id);
    // Same membership, new relative order and anchors. Only local state changes: no Linear writes.
    s.baseline = sequence.map(({ id, sortOrder }) => ({ id, sortOrder }));
    s.candidates = s.candidates.filter(c => !used.has(c));
    s.driftSince = null; s.pending = false; s.failures = 0;
    await this.store.audit('approved-move', { moved: changed.map(r => r.id), approvals: approved, before,
      after: s.baseline.map(b => b.id), dryRun: this.cfg.dry });
    return 'approved';
  }
  async reconcile() {
    return this.store.locked(async () => {
      const s = await this.store.load();
      if (s.paused || s.tripped || !s.baseline.length) return;
      try {
        await this.api.team();
        prune(s, this.clock());
        let writes = 0, repairs = null, observed = null;
        for (let pass = 0; pass < 3; pass++) {
          const rows = protectedRows(s, await this.api.issues());
          if (inOrder(rows)) {
            if (writes || s.pending) await this.store.audit('in-order', { writes });
            this.settle(s, rows); await this.store.save(s); return;
          }
          if (pass === 0 && this.cfg.approvals && !writes) {
            const outcome = await this.review(s, rows);
            if (outcome !== 'rejected') { await this.store.save(s); return; }
          }
          // Keep one plan per sweep so partial progress converges instead of re-spacing around its
          // own writes. Any rank that is neither as first read nor as planned is a concurrent edit:
          // re-plan from this fresh read rather than continue with a stale plan.
          if (!repairs || rows.some((r, i) => r.sortOrder !== observed[i] && r.sortOrder !== repairs[i].sortOrder)) {
            repairs = plan(rows); observed = rows.map(r => r.sortOrder);
          }
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
          // Persist intent/budget before the network call: restarting cannot reset the rate budget,
          // and the resulting webhook callback is recognised as our own write, never an approval.
          s.intents = [...s.intents, { id: repair.id, sortOrder: repair.sortOrder, at: this.clock() }].slice(-100);
          await this.store.audit('repair-intent', repair);
          await this.store.save(s);
          await this.api.update(repair.id, repair.sortOrder); writes++;
        }
        // A maximum of three mutations per sweep; large drift requires explicit review, not a loop.
        const rows = protectedRows(s, await this.api.issues());
        if (!inOrder(rows)) {
          s.tripped = true; await this.store.audit('breaker', { reason: 'repair-budget', writes });
        } else this.settle(s, rows);
      } catch (e) {
        s.failures++;
        if (s.failures >= 3) s.tripped = true;
        const code = e instanceof GuardrailError ? e.code : 'unexpected-error';
        await this.store.audit('reconcile-error', { code, failures: s.failures, tripped: s.tripped });
      }
      await this.store.save(s);
    });
  }
  // Fresh ranks in the approved relative order become the trusted anchors for later approvals.
  settle(s, rows) {
    s.baseline = rows.map(({ id, sortOrder }) => ({ id, sortOrder }));
    s.pending = false; s.failures = 0; s.driftSince = null;
  }
}
