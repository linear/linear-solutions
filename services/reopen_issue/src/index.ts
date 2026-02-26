import { createServer, IncomingMessage, ServerResponse } from "http";
import { getConfig } from "./lib/config.js";
import { getLinearClient } from "./lib/linear.js";
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  isCommentCreateWebhook,
} from "./lib/webhook.js";
import { processComment } from "./lib/reopen.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: Record<string, unknown>
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const config = getConfig();

  const rawBody = await readBody(req);
  const signature = req.headers["linear-signature"] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature, config.linearWebhookSecret)) {
    console.warn("Invalid webhook signature");
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  let payload;
  try {
    payload = parseWebhookPayload(rawBody);
  } catch (error) {
    console.error("Failed to parse webhook payload:", error);
    sendJson(res, 400, { error: "Invalid payload" });
    return;
  }

  console.log(`Received webhook: ${payload.type} ${payload.action}`);

  if (!isCommentCreateWebhook(payload)) {
    sendJson(res, 200, { status: "ignored", reason: "Not a Comment create event" });
    return;
  }

  const client = getLinearClient(config);
  const result = await processComment(client, payload.data);

  console.log(`Result: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`);

  const statusCode = result.status === "error" ? 500 : 200;
  sendJson(res, statusCode, { ...result });
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/reopen-issue") {
      await handleWebhook(req, res);
    } else if (req.method === "GET" && url.pathname === "/health") {
      handleHealth(res);
    } else if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        name: "Linear Reopen Issue Agent",
        version: "1.0.0",
        endpoints: {
          webhook: "POST /reopen-issue",
          health: "GET /health",
        },
      });
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    console.error("Request error:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

function main(): void {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error);
    process.exit(1);
  }

  console.log("Configuration loaded successfully");

  const server = createServer(handleRequest);

  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`  Webhook endpoint: http://localhost:${config.port}/reopen-issue`);
    console.log(`  Health check: http://localhost:${config.port}/health`);
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
}

main();
