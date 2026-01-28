/**
 * Webhook Receiver Example
 *
 * This guide demonstrates how to:
 * 1. Verify webhook signatures
 * 2. Parse webhook payloads
 * 3. Handle different event types
 *
 * This is a framework-agnostic example. Adapt to your server framework.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_WEBHOOK_SECRET> → The secret from webhook creation
 */

import crypto from "crypto";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Linear webhook payload structure.
 */
interface WebhookPayload {
  /** The action that triggered the webhook */
  action: "create" | "update" | "remove";

  /** The type of resource */
  type: "Issue" | "Comment" | "Project" | "Cycle" | "IssueLabel" | string;

  /** When the event occurred */
  createdAt: string;

  /** The resource data */
  data: Record<string, unknown>;

  /** Previous values for updated fields (only on "update" action) */
  updatedFrom?: Record<string, unknown>;

  /** URL to the resource in Linear */
  url: string;

  /** Organization ID */
  organizationId: string;

  /** Timestamp of the webhook */
  webhookTimestamp: number;

  /** Unique ID for this webhook delivery */
  webhookId: string;
}

// =============================================================================
// SIGNATURE VERIFICATION
// =============================================================================

/**
 * Verify that a webhook request came from Linear.
 *
 * IMPORTANT: Always verify signatures in production to prevent
 * spoofed requests from malicious actors.
 *
 * @param body - Raw request body (string, not parsed JSON)
 * @param signature - Value of the Linear-Signature header
 * @param secret - Your webhook secret from Linear
 */
function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    // Buffers of different lengths throw - signatures don't match
    return false;
  }
}

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

/**
 * Example webhook handler.
 *
 * This is framework-agnostic. Adapt to your server:
 *
 * Express:
 *   app.post("/webhooks/linear", express.text({ type: "*/*" }), (req, res) => {
 *     const result = handleWebhook(req.body, req.headers["linear-signature"]);
 *     res.status(result.status).json(result);
 *   });
 *
 * Hono:
 *   app.post("/webhooks/linear", async (c) => {
 *     const body = await c.req.text();
 *     const signature = c.req.header("linear-signature");
 *     return c.json(handleWebhook(body, signature));
 *   });
 *
 * Note: You need the RAW body (string) for signature verification,
 * not the parsed JSON. Most frameworks have options for this.
 */
function handleWebhook(
  rawBody: string,
  signature: string | undefined
): { status: number; message: string } {
  const secret = "<YOUR_WEBHOOK_SECRET>";

  // 1. Verify signature
  if (!signature) {
    return { status: 401, message: "Missing signature" };
  }

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return { status: 401, message: "Invalid signature" };
  }

  // 2. Parse payload
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "Invalid JSON" };
  }

  // 3. Route by type and action
  console.log(`Received: ${payload.type} ${payload.action}`);

  switch (payload.type) {
    case "Issue":
      handleIssueEvent(payload);
      break;
    case "Comment":
      handleCommentEvent(payload);
      break;
    default:
      console.log(`Unhandled type: ${payload.type}`);
  }

  // 4. Always return 200 for valid webhooks
  // (even if you choose to ignore the event)
  return { status: 200, message: "OK" };
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

/**
 * Handle issue events.
 */
function handleIssueEvent(payload: WebhookPayload) {
  const issue = payload.data as {
    id: string;
    identifier: string;
    title: string;
    stateId: string;
    assigneeId: string | null;
    priority: number;
    labelIds: string[];
  };

  switch (payload.action) {
    case "create":
      console.log(`Issue created: ${issue.identifier} - ${issue.title}`);
      break;

    case "update":
      // Check what changed using updatedFrom
      if (payload.updatedFrom?.stateId) {
        console.log(`Issue ${issue.identifier} changed state`);
      }
      if ("assigneeId" in (payload.updatedFrom || {})) {
        console.log(`Issue ${issue.identifier} assignee changed`);
      }
      if (payload.updatedFrom?.priority !== undefined) {
        console.log(`Issue ${issue.identifier} priority changed`);
      }
      break;

    case "remove":
      console.log(`Issue deleted: ${issue.identifier}`);
      break;
  }
}

/**
 * Handle comment events.
 */
function handleCommentEvent(payload: WebhookPayload) {
  const comment = payload.data as {
    id: string;
    body: string;
    issueId: string;
    userId: string;
  };

  switch (payload.action) {
    case "create":
      console.log(`New comment on issue ${comment.issueId}`);
      break;
    case "update":
      console.log(`Comment edited on issue ${comment.issueId}`);
      break;
    case "remove":
      console.log(`Comment deleted on issue ${comment.issueId}`);
      break;
  }
}

// =============================================================================
// EXAMPLE: EXPRESS SERVER
// =============================================================================

/*
import express from "express";

const app = express();

// IMPORTANT: Use express.text() to get raw body for signature verification
app.post(
  "/webhooks/linear",
  express.text({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["linear-signature"] as string;
    const result = handleWebhook(req.body, signature);
    res.status(result.status).json(result);
  }
);

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
*/
