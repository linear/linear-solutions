import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config, teamConfig, Store, LinearApi, Guardrail, verify } from './guardrail.js';
import { fail, safeMessage } from './errors.js';

// Every signed event is offered to every team's guardrail; each ignores events outside its scope.
export function server(cfg, guards) {
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
      for (const guard of guards) await guard.accept(body, req.headers['linear-delivery'], digest);
      res.writeHead(200).end('accepted');
    } catch { res.writeHead(503).end('retry'); }
  });
}

export function guards(cfg, makeApi = c => new LinearApi(c)) {
  return cfg.teams.map(entry => {
    const teamCfg = teamConfig(cfg, entry);
    return new Guardrail(teamCfg, makeApi(teamCfg), new Store(teamCfg));
  });
}

const USAGE = 'Usage: status | pause | publish | resume [--restore] | check-actor <user-uuid> | serve; add --team <team-uuid> to target one protected team';

export async function run(argv, env = process.env, makeApi) {
  const [command, ...rest] = argv;
  if (!command) fail('usage', USAGE);
  const cfg = config(env);
  let team = null, restore = false; const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--team' && team === null && i + 1 < rest.length) team = rest[++i];
    else if (rest[i] === '--restore' && !restore && command === 'resume') restore = true;
    else args.push(rest[i]);
  }
  const all = guards(cfg, makeApi);
  const targets = team === null ? all : all.filter(g => g.cfg.team === team);
  if (!targets.length) fail('usage', '--team must be one of the team UUIDs in PROTECTED_TEAMS');
  let each;
  if (command === 'check-actor') {
    if (args.length !== 1) fail('usage', USAGE);
    each = guard => guard.checkActor(args[0]);
  } else if (['status', 'pause', 'publish', 'resume'].includes(command)) {
    if (args.length) fail('usage', USAGE);
    if (targets.length > 1 && ['publish', 'resume'].includes(command)) {
      fail('usage', `${command} changes one team at a time when several teams are protected: add --team <team-uuid>`);
    }
    each = guard => guard.control(command, { restore });
  } else fail('usage', USAGE);
  if (targets.length === 1) return each(targets[0]);
  const teams = [];
  for (const guard of targets) teams.push(await each(guard));
  return { teams };
}

export async function main() {
  const command = process.argv[2];
  if (command !== 'serve') {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); return;
  }
  const cfg = config(), all = guards(cfg);
  // Never store or print credentials. No HTTP management endpoints.
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('config', 'PORT must be a whole number from 1024 to 65535');
  const http = server(cfg, all);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Teams are checked one after another; a failure in one team never skips the others.
      for (const guard of all) {
        try { await guard.reconcile(); } catch (e) { console.error(`Reconcile unavailable for team ${guard.cfg.team} (${safeMessage(e)})`); }
      }
    } finally { running = false; }
  };
  // Polling recovers missed events and crashes after acknowledging durable events.
  const timer = setInterval(tick, 5000);
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.listen(port, '127.0.0.1', () => {
    console.log(`Listening on localhost:${port}; teams=${all.length}; dryRun=${cfg.dry}; roleApprovals=${cfg.approvals}; approvalGraceMs=${cfg.graceMs}`);
    void tick();
  });
  const stop = () => { clearInterval(timer); http.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`Command failed (${safeMessage(e)})`); process.exitCode = 1; });
}
