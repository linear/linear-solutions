import { createHmac, timingSafeEqual } from "crypto";
import type { WebhookPayload, CommentWebhookPayload } from "../types.js";

/**
 * Verify the webhook signature from Linear.
 * Linear signs webhooks using HMAC-SHA256 with the webhook secret.
 * The signature is sent in the 'linear-signature' header.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;

  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

export function parseWebhookPayload(rawBody: string): WebhookPayload {
  try {
    const payload = JSON.parse(rawBody) as WebhookPayload;

    if (!payload.type || !payload.action) {
      throw new Error("Invalid webhook payload: missing type or action");
    }

    return payload;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid webhook payload: not valid JSON");
    }
    throw error;
  }
}

export function isCommentCreateWebhook(
  payload: WebhookPayload
): payload is CommentWebhookPayload {
  return payload.type === "Comment" && payload.action === "create";
}
