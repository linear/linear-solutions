import * as ado from "./ado.js";
import * as linear from "./linear.js";
import { log } from "./logger.js";
import { store } from "./store.js";
import { prStoreKey } from "./types.js";
import type { AdoComment, AdoPrInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Synced thread root creation
// ---------------------------------------------------------------------------

/**
 * Create the synced thread root comment on a Linear issue and the corresponding
 * sync thread on the ADO PR. Only creates once per issue/PR pair.
 * Returns the Linear root comment ID and ADO thread ID.
 */
export async function ensureSyncThread(
  issueIdentifier: string,
  issueId: string,
  prInfo: AdoPrInfo
): Promise<{ rootCommentId: string; adoThreadId: number }> {
  const key = prStoreKey(prInfo);
  let rootCommentId = store.getSyncRoot(issueIdentifier);
  let adoThreadId = store.getSyncThread(key);

  if (!rootCommentId) {
    const body =
      `This comment thread is synced to a corresponding ` +
      `[ADO PR #${prInfo.pullRequestId}](${prInfo.prUrl}). ` +
      `All replies are displayed in both locations.`;

    rootCommentId = await linear.createComment(issueId, body);
    store.setSyncRoot(issueIdentifier, rootCommentId);
    store.markLinearCommentAsOurs(rootCommentId);
    log.info("sync_thread.root_created", {
      issueIdentifier,
      issueId,
      rootCommentId,
    });
  }

  if (adoThreadId === undefined) {
    const threadBody =
      `This thread is synced with Linear issue ${issueIdentifier}. ` +
      `All replies are displayed in both locations.`;

    const thread = await ado.createCommentThread(
      prInfo.org,
      prInfo.project,
      prInfo.repositoryId,
      prInfo.pullRequestId,
      threadBody
    );
    adoThreadId = thread.id;
    store.setSyncThread(key, adoThreadId);

    // Track the initial thread comment as ours
    const initialComment = thread.comments?.[0];
    if (initialComment) {
      store.markAdoCommentAsOurs(adoThreadId, initialComment.id);
    }

    log.info("sync_thread.ado_created", {
      pullRequestId: prInfo.pullRequestId,
      adoThreadId,
    });
  }

  return { rootCommentId, adoThreadId };
}

// ---------------------------------------------------------------------------
// ADO -> Linear direction
// ---------------------------------------------------------------------------

/**
 * Sync a comment from an ADO sync thread to the Linear synced thread root.
 * Only call this for comments in the designated sync thread.
 */
export async function syncAdoCommentToLinear(
  comment: AdoComment,
  issueIdentifier: string,
  issueId: string,
  rootCommentId: string,
  prNumber: number,
  threadId: number
): Promise<void> {
  if (store.isOurAdoComment(threadId, comment.id)) {
    log.info("comment.skip_loop", { direction: "ado->linear", adoCommentId: comment.id });
    return;
  }

  if (comment.commentType !== "text") return;

  const body =
    `**${comment.author.displayName}** (ADO PR #${prNumber}):\n\n` +
    comment.content;

  try {
    const linearCommentId = await linear.createComment(issueId, body, rootCommentId);
    store.markLinearCommentAsOurs(linearCommentId);
    store.setCommentMapping(threadId, comment.id, linearCommentId);
    log.info("comment.synced", {
      direction: "ado->linear",
      issueIdentifier,
      adoCommentId: comment.id,
      linearCommentId,
    });
  } catch (err) {
    log.error(
      "comment.sync_failed",
      { direction: "ado->linear", issueIdentifier, adoCommentId: comment.id },
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Linear -> ADO direction
// ---------------------------------------------------------------------------

/**
 * Sync a comment from the Linear synced thread to the ADO sync thread.
 * Only call this for replies to the synced thread root.
 */
export async function syncLinearCommentToAdo(
  commentId: string,
  commentBody: string,
  userName: string,
  issueIdentifier: string,
  prInfo: AdoPrInfo,
  adoThreadId: number
): Promise<void> {
  if (store.isOurLinearComment(commentId)) {
    log.info("comment.skip_loop", { direction: "linear->ado", linearCommentId: commentId });
    return;
  }

  const content =
    `**${userName}** (Linear ${issueIdentifier}):\n\n` +
    commentBody;

  try {
    const adoComment = await ado.addCommentToThread(
      prInfo.org,
      prInfo.project,
      prInfo.repositoryId,
      prInfo.pullRequestId,
      adoThreadId,
      content
    );
    store.markAdoCommentAsOurs(adoThreadId, adoComment.id);
    store.setCommentMapping(adoThreadId, adoComment.id, commentId);
    log.info("comment.synced", {
      direction: "linear->ado",
      linearCommentId: commentId,
      adoThreadId,
      adoCommentId: adoComment.id,
      pullRequestId: prInfo.pullRequestId,
    });
  } catch (err) {
    log.error(
      "comment.sync_failed",
      { direction: "linear->ado", linearCommentId: commentId, pullRequestId: prInfo.pullRequestId },
      err
    );
  }
}

/**
 * Check if an ADO thread is the designated sync thread for a PR.
 */
export function isSyncThread(prKey: string, threadId: number): boolean {
  return store.getSyncThread(prKey) === threadId;
}

/**
 * Check if a Linear comment is a reply to the sync root for a given issue.
 */
export function isSyncThreadReply(issueIdentifier: string, parentId: string | undefined): boolean {
  if (!parentId) return false;
  return store.getSyncRoot(issueIdentifier) === parentId;
}
