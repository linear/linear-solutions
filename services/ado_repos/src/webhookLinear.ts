import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./store.js";
import { syncLinearCommentToAdo, isSyncThreadReply } from "./comments.js";
import { prStoreKey } from "./types.js";
import type { LinearWebhookPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the Linear webhook signature using HMAC-SHA256.
 * Returns true if valid, false otherwise.
 */
export function verifyLinearWebhookSignature(
  body: string,
  signature: string | undefined
): boolean {
  if (!config.linearWebhookSecret) {
    log.warn("webhook.linear.no_secret_configured");
    return true;
  }

  if (!signature) {
    log.warn("webhook.linear.missing_signature");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", config.linearWebhookSecret)
    .update(body)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main Linear webhook handler
// ---------------------------------------------------------------------------

export async function handleLinearWebhook(payload: LinearWebhookPayload): Promise<void> {
  log.info("webhook.linear.received", {
    type: payload.type,
    action: payload.action,
    dataId: payload.data?.id,
  });

  if (payload.type !== "Comment") {
    log.info("webhook.linear.skip_non_comment", { type: payload.type });
    return;
  }

  if (payload.action !== "create" && payload.action !== "update") {
    log.info("webhook.linear.skip_action", { action: payload.action });
    return;
  }

  const { data } = payload;
  if (!data.body || !data.issue) {
    log.info("webhook.linear.skip_no_body_or_issue", { dataId: data.id });
    return;
  }

  // Loop prevention
  if (data.botActor) {
    log.info("comment.skip_bot", { botActor: data.botActor });
    return;
  }
  if (store.isOurLinearComment(data.id)) {
    log.info("comment.skip_loop", { direction: "linear->ado", linearCommentId: data.id });
    return;
  }

  const issueIdentifier = data.issue.identifier;

  // Only sync replies to the synced thread root
  if (!isSyncThreadReply(issueIdentifier, data.parentId)) {
    log.info("comment.skip_not_sync_thread", {
      linearCommentId: data.id,
      issueIdentifier,
      parentId: data.parentId,
      expectedRootId: store.getSyncRoot(issueIdentifier),
    });
    return;
  }

  // Find linked ADO PR
  const prInfo = store.getPrForIssue(issueIdentifier);
  if (!prInfo) {
    log.info("webhook.linear.no_linked_pr", { issueIdentifier });
    return;
  }

  // Find the ADO sync thread
  const adoThreadId = store.getSyncThread(prStoreKey(prInfo));
  if (adoThreadId === undefined) {
    log.warn("webhook.linear.no_sync_thread", { issueIdentifier, prKey: prStoreKey(prInfo) });
    return;
  }

  const userName = data.user?.name ?? payload.actor?.name ?? "Unknown";

  await syncLinearCommentToAdo(
    data.id,
    data.body,
    userName,
    issueIdentifier,
    prInfo,
    adoThreadId
  );
}
