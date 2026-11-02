import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config, checkLegacyState, Store, LinearApi, Guardrail, verify } from './guardrail.js';
import { GuardrailError, fail, safeMessage } from './errors.js';

// One verified webhook is offered to every team's guardrail. Each one keeps only events for its
// own team (or for an issue in its own baseline that moved away) in its own state.
export function server(cfg, guards) {
  const all = Array.isArray(guards) ? guards : [guards];
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = verify(raw, req.headers['linear-signature'], req.headers['linear-timestamp'], cfg.secret); }
      catch { res.writeHead(401).end(); return; }
      const digest = createHash('sha256').update(raw).digest('hex');
      // Teams have separate locks, so they accept in parallel. If any team fails to persist, Linear
      // retries; teams that already stored the event deduplicate the retry.
      const results = await Promise.allSettled(all.map(g => g.accept(body, req.headers['linear-delivery'], digest)));
      if (results.some(r => r.status === 'rejected')) { res.writeHead(503).end('retry'); return; }
      res.writeHead(200).end('accepted');
    } catch { res.writeHead(503).end('retry'); }
  });
}

const USAGE = 'Usage: status [--team <uuid>] | pause [--team <uuid>] | publish [--team <uuid>] | '
  + 'resume [--team <uuid>] [--restore] | check-actor <user-uuid> [--team <uuid>] | serve';

// Teams are checked one after another; a failure in one team never skips the others.
export async function reconcileAll(guards, log = console.error) {
  for (const guard of guards) {
    try { await guard.reconcile(); }
    catch (e) { log(`Reconcile unavailable for team ${guard.cfg.team} (${safeMessage(e)})`); }
  }
}

export function guardsFor(cfg, makeApi = c => new LinearApi(c)) {
  return cfg.teams.map(team => new Guardrail(team, makeApi(team), new Store(team)));
}

function parseArgs(command, args) {
  const opts = { restore: false, team: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--restore' && command === 'resume') opts.restore = true;
    else if (args[i] === '--team' && i + 1 < args.length && !opts.team) opts.team = args[++i];
    else if (!args[i].startsWith('--')) opts.positional.push(args[i]);
    else fail('usage', USAGE);
  }
  if (opts.positional.length !== (command === 'check-actor' ? 1 : 0)) fail('usage', USAGE);
  return opts;
}

function pick(cfg, guards, team) {
  if (team) {
    const i = cfg.teams.findIndex(t => t.team === team);
    if (i < 0) fail('usage', 'That --team is not listed in PROTECTED_TEAMS');
    return guards[i];
  }
  if (guards.length !== 1) fail('usage', 'Several teams are configured: pass --team <team UUID>');
  return guards[0];
}

// Run a command for every configured team, finishing all of them before reporting failures.
async function forAll(guards, fn) {
  const results = [], failed = [];
  for (const guard of guards) {
    try { results.push(await fn(guard)); }
    catch (e) { failed.push(`${guard.cfg.team} (${e instanceof GuardrailError ? e.code : 'unexpected-error'})`); }
  }
  if (failed.length) fail('teams-incomplete', `Command failed for team(s) ${failed.join(', ')}; the other teams succeeded. Retry with --team`);
  return { teams: results };
}

export async function run(argv, env = process.env, makeApi) {
  const [command, ...args] = argv;
  if (!command) fail('usage', USAGE);
  if (!['status', 'pause', 'publish', 'resume', 'check-actor'].includes(command)) fail('usage', USAGE);
  const opts = parseArgs(command, args);
  const cfg = config(env);
  checkLegacyState(cfg);
  const guards = guardsFor(cfg, makeApi);
  if (command === 'check-actor') return pick(cfg, guards, opts.team).checkActor(opts.positional[0]);
  // status and pause are safe to apply to every team; publish and resume need an explicit team
  // whenever more than one is configured, because each accepts or restores a specific order.
  if (!opts.team && (command === 'status' || command === 'pause')) return forAll(guards, g => g.control(command));
  return pick(cfg, guards, opts.team).control(command, { restore: opts.restore });
}

export async function main() {
  const command = process.argv[2];
  if (command !== 'serve') {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); return;
  }
  if (process.argv.length > 3) fail('usage', USAGE);
  const cfg = config();
  checkLegacyState(cfg);
  const guards = guardsFor(cfg);
  // Never store or print credentials. No HTTP management endpoints.
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('config', 'PORT must be a whole number from 1024 to 65535');
  const http = server(cfg, guards);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileAll(guards); } finally { running = false; }
  };
  // Polling recovers missed events and crashes after acknowledging durable events.
  const timer = setInterval(tick, 5000);
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.listen(port, '127.0.0.1', () => {
    console.log(`Listening on localhost:${port}; teams=${cfg.teams.length}; dryRun=${cfg.dry}; roleApprovals=${cfg.approvals}; approvalGraceMs=${cfg.graceMs}`);
    void tick();
  });
  const stop = () => { clearInterval(timer); http.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`Command failed (${safeMessage(e)})`); process.exitCode = 1; });
}
