import { createServer, IncomingMessage, ServerResponse } from "http";
import { getConfig } from "./lib/config.js";
import { getLinearClient } from "./lib/linear.js";
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  isIssueWebhook,
  findMatchingRules,
  getIssueFromPayload,
} from "./lib/webhook.js";
import { duplicateIssueForRule, shouldProcessIssue, type DuplicationResult } from "./lib/duplication.js";

/**
 * Read the raw body from an incoming request
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response
 */
function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: Record<string, unknown>
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Handle incoming webhook requests
 */
async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const config = getConfig();

  // Read and verify the webhook payload
  const rawBody = await readBody(req);
  const signature = req.headers["linear-signature"] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature, config.linearWebhookSecret)) {
    console.warn("Invalid webhook signature");
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  // Parse the payload
  let payload;
  try {
    payload = parseWebhookPayload(rawBody);
  } catch (error) {
    console.error("Failed to parse webhook payload:", error);
    sendJson(res, 400, { error: "Invalid payload" });
    return;
  }

  console.log(`Received webhook: ${payload.type} ${payload.action}`);

  // Only process Issue webhooks
  if (!isIssueWebhook(payload)) {
    sendJson(res, 200, { status: "ignored", reason: "Not an Issue webhook" });
    return;
  }

  // Find matching rules based on added labels and source team
  const matchedRules = findMatchingRules(payload, config.duplicationRules);
  
  if (matchedRules.length === 0) {
    sendJson(res, 200, {
      status: "ignored",
      reason: "No matching duplication rules",
    });
    return;
  }

  console.log(
    `Found ${matchedRules.length} matching rule(s): ${matchedRules
      .map((m) => `"${m.rule.name}" (label: ${m.triggerLabel.name})`)
      .join(", ")}`
  );

  // Get issue data
  const issue = getIssueFromPayload(payload);

  // Check if we should process this issue
  if (!shouldProcessIssue(issue)) {
    sendJson(res, 200, {
      status: "ignored",
      reason: "Issue does not meet processing criteria (is a sub-issue)",
    });
    return;
  }

  // Process each matching rule
  const client = getLinearClient(config);
  const results: DuplicationResult[] = [];

  for (const { rule, triggerLabel } of matchedRules) {
    console.log(
      `Processing rule "${rule.name}" triggered by label "${triggerLabel.name}" on issue ${issue.identifier}`
    );
    const result = await duplicateIssueForRule(client, issue, rule);
    results.push(result);
  }

  // Aggregate results
  const allSkipped = results.every((r) => r.skipped);
  const allSuccess = results.every((r) => r.success);
  const totalCreated = results.flatMap((r) => r.createdIssues);

  if (allSkipped) {
    sendJson(res, 200, {
      status: "skipped",
      rules: results.map((r) => ({ name: r.ruleName, reason: r.reason })),
    });
    return;
  }

  if (allSuccess) {
    sendJson(res, 200, {
      status: "success",
      rules: results.map((r) => ({
        name: r.ruleName,
        skipped: r.skipped,
        reason: r.reason,
        createdIssues: r.createdIssues,
      })),
      totalCreated,
    });
  } else {
    sendJson(res, 500, {
      status: "partial_failure",
      rules: results.map((r) => ({
        name: r.ruleName,
        success: r.success,
        skipped: r.skipped,
        reason: r.reason,
        createdIssues: r.createdIssues,
      })),
      totalCreated,
      error: "Some sub-issues failed to create",
    });
  }
}

/**
 * Handle health check requests
 */
function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Main request router
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/issue-duplication") {
      await handleWebhook(req, res);
    } else if (req.method === "GET" && url.pathname === "/health") {
      handleHealth(res);
    } else if (req.method === "GET" && url.pathname === "/") {
      const config = getConfig();
      sendJson(res, 200, {
        name: "Linear Issue Duplication Agent",
        version: "1.0.0",
        endpoints: {
          webhook: "POST /issue-duplication",
          health: "GET /health",
        },
        rulesConfigured: config.duplicationRules.length,
      });
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    console.error("Request error:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * Start the server
 */
function main(): void {
  // Load and validate config first
  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("Failed to load configuration:", error);
    process.exit(1);
  }

  console.log("Configuration loaded successfully");
  console.log(`  ${config.duplicationRules.length} duplication rule(s) configured:`);
  for (const rule of config.duplicationRules) {
    console.log(`    - "${rule.name}"`);
    console.log(`      Source team: ${rule.sourceTeamId}`);
    console.log(`      Trigger label: "${rule.triggerLabelName}"`);
    console.log(`      Target teams: ${rule.targetTeams.map((t) => t.name).join(", ")}`);
  }

  const server = createServer(handleRequest);

  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`  Webhook endpoint: http://localhost:${config.port}/issue-duplication`);
    console.log(`  Health check: http://localhost:${config.port}/health`);
  });

  // Graceful shutdown
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
