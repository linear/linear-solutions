import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config, Store, LinearApi, Guardrail, verify } from './guardrail.js';
import { fail, safeMessage } from './errors.js';

export function server(cfg, guard) {
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
      await guard.accept(body, req.headers['linear-delivery'], createHash('sha256').update(raw).digest('hex'));
      res.writeHead(200).end('accepted');
    } catch { res.writeHead(503).end('retry'); }
  });
}

const USAGE = 'Usage: status | pause | publish | resume [--restore] | check-actor <user-uuid> | serve';

export async function run(argv, env = process.env, makeApi = cfg => new LinearApi(cfg)) {
  const [command, ...options] = argv;
  if (!command) fail('usage', USAGE);
  const cfg = config(env), store = new Store(cfg), guard = new Guardrail(cfg, makeApi(cfg), store);
  if (command === 'check-actor') {
    if (options.length !== 1) fail('usage', USAGE);
    return guard.checkActor(options[0]);
  }
  if (!['status', 'pause', 'publish', 'resume'].includes(command)) fail('usage', USAGE);
  if (options.some(o => o !== '--restore') || (options.length && command !== 'resume')) fail('usage', USAGE);
  return guard.control(command, { restore: options.includes('--restore') });
}

export async function main() {
  const command = process.argv[2];
  if (command !== 'serve') {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2)); return;
  }
  const cfg = config(), store = new Store(cfg), guard = new Guardrail(cfg, new LinearApi(cfg), store);
  // Never store or print credentials. No HTTP management endpoints.
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('config', 'PORT must be a whole number from 1024 to 65535');
  const http = server(cfg, guard);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await guard.reconcile(); } catch (e) { console.error(`Reconcile unavailable (${safeMessage(e)})`); }
    finally { running = false; }
  };
  // Polling recovers missed events and crashes after acknowledging durable events.
  const timer = setInterval(tick, 5000);
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.listen(port, '127.0.0.1', () => {
    console.log(`Listening on localhost:${port}; dryRun=${cfg.dry}; roleApprovals=${cfg.approvals}; approvalGraceMs=${cfg.graceMs}`);
    void tick();
  });
  const stop = () => { clearInterval(timer); http.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`Command failed (${safeMessage(e)})`); process.exitCode = 1; });
}
