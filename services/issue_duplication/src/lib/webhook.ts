import { createHmac, timingSafeEqual } from "crypto";
import type { WebhookPayload, IssueWebhookPayload, IssueData, DuplicationRule } from "../types.js";

/**
 * Verify the webhook signature from Linear
 *
 * Linear signs webhooks using HMAC-SHA256 with the webhook secret.
 * The signature is sent in the 'linear-signature' header.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // Buffers of different lengths will throw
    return false;
  }
}

/**
 * Parse and validate webhook payload
 */
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

/**
 * Type guard to check if payload is an Issue webhook
 */
export function isIssueWebhook(
  payload: WebhookPayload
): payload is IssueWebhookPayload {
  return payload.type === "Issue";
}

/**
 * Get all labels that were just added to an issue
 */
export function getAddedLabels(
  payload: IssueWebhookPayload
): Array<{ id: string; name: string }> {
  // Only process update events
  if (payload.action !== "update") {
    return [];
  }

  // Check if labelIds were changed
  if (!payload.updatedFrom?.labelIds) {
    return [];
  }

  const previousLabelIds = payload.updatedFrom.labelIds as string[];
  const currentLabelIds = payload.data.labelIds;

  // Find all labels that were just added (not in previous, but in current)
  return payload.data.labels.filter(
    (label) =>
      !previousLabelIds.includes(label.id) &&
      currentLabelIds.includes(label.id)
  );
}

/**
 * Result of matching a rule to an issue
 */
export interface MatchedRule {
  rule: DuplicationRule;
  triggerLabel: { id: string; name: string };
}

/**
 * Find all duplication rules that match the issue and added labels
 *
 * A rule matches if:
 * 1. The issue is from the rule's source team
 * 2. One of the added labels matches the rule's trigger label (case-insensitive)
 */
export function findMatchingRules(
  payload: IssueWebhookPayload,
  rules: DuplicationRule[]
): MatchedRule[] {
  const addedLabels = getAddedLabels(payload);
  if (addedLabels.length === 0) {
    return [];
  }

  const issueTeamId = payload.data.teamId;
  const matched: MatchedRule[] = [];

  for (const rule of rules) {
    // Check if issue is from the rule's source team
    if (rule.sourceTeamId !== issueTeamId) {
      continue;
    }

    // Check if any added label matches the rule's trigger label
    const triggerLabel = addedLabels.find(
      (label) =>
        label.name.toLowerCase() === rule.triggerLabelName.toLowerCase()
    );

    if (triggerLabel) {
      matched.push({ rule, triggerLabel });
    }
  }

  return matched;
}

/**
 * Extract issue data from webhook payload
 */
export function getIssueFromPayload(payload: IssueWebhookPayload): IssueData {
  return payload.data;
}
