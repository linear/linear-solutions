import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config, Store, LinearApi, Guardrail, verify } from './guardrail.js';

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

export async function main() {
  const cfg = config(), store = new Store(cfg), guard = new Guardrail(cfg, new LinearApi(cfg), store);
  const command = process.argv[2];
  if (command !== 'serve') {
    const options = process.argv.slice(3);
    if (options.some(o => o !== '--restore') || (options.length && command !== 'resume')) throw new Error('Invalid arguments');
    console.log(JSON.stringify(await guard.control(command, { restore: options.includes('--restore') }), null, 2)); return;
  }
  // Never store or print credentials. No HTTP management endpoints.
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  const http = server(cfg, guard);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await guard.reconcile(); } catch { console.error('Reconcile unavailable; inspect local state/lock'); }
    finally { running = false; }
  };
  // Polling recovers missed events and crashes after acknowledging durable events.
  const timer = setInterval(tick, 5000);
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.listen(port, '127.0.0.1', () => {
    console.log(`Listening on localhost:${port}; dryRun=${cfg.dry}`);
    void tick();
  });
  const stop = () => { clearInterval(timer); http.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Command failed; check configuration, state, team and API connectivity. No credentials logged.'); process.exitCode = 1; });
}
