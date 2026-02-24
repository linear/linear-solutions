import http from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { handleAdoWebhook } from "./webhookAdo.js";
import { handleLinearWebhook, verifyLinearWebhookSignature } from "./webhookLinear.js";
import type { AdoWebhookPayload, LinearWebhookPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// ADO webhook secret verification
// ---------------------------------------------------------------------------

function verifyAdoWebhookSecret(req: http.IncomingMessage, url: URL): boolean {
  if (!config.webhookSecret) return true;

  // Support secret as query parameter or Authorization header
  const querySecret = url.searchParams.get("secret");
  if (querySecret === config.webhookSecret) return true;

  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${config.webhookSecret}`) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleAdoRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!verifyAdoWebhookSecret(req, url)) {
    log.warn("webhook.ado.auth_failed");
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const rawBody = await readBody(req);
  let payload: AdoWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as AdoWebhookPayload;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  // Respond immediately to prevent ADO timeout/retries
  sendJson(res, 200, { ok: true });

  // Process asynchronously
  handleAdoWebhook(payload).catch((err) => {
    log.error("webhook.ado.unhandled_error", { eventType: payload.eventType }, err);
  });
}

async function handleLinearRoute(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const rawBody = await readBody(req);

  // Verify webhook signature
  const signature = req.headers["linear-signature"] as string | undefined;
  if (!verifyLinearWebhookSignature(rawBody, signature)) {
    log.warn("webhook.linear.signature_invalid");
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  // Respond immediately
  sendJson(res, 200, { ok: true });

  // Process asynchronously
  handleLinearWebhook(payload).catch((err) => {
    log.error("webhook.linear.unhandled_error", { type: payload.type }, err);
  });
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    if (path === "/ado-webhook") {
      await handleAdoRoute(req, res, url);
    } else if (path === "/linear-webhook") {
      await handleLinearRoute(req, res);
    } else if (path === "/health" && req.method === "GET") {
      handleHealth(req, res);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (err) {
    log.error("server.request_error", { path, method: req.method }, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(config.port, () => {
  log.info("server.started", { port: config.port });
  console.log(`ADO-Linear integration server running on port ${config.port}`);
  console.log(`  ADO webhook:    POST /ado-webhook`);
  console.log(`  Linear webhook: POST /linear-webhook`);
  console.log(`  Health check:   GET  /health`);
});

// Graceful shutdown
function shutdown(signal: string) {
  log.info("server.shutdown", { signal });
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
