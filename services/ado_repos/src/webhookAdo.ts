import { matchIssuesForPullRequest, branchFromRef } from "./matchIssues.js";
import * as linear from "./linear.js";
import * as ado from "./ado.js";
import { determineTargetState, shouldAllowTransition } from "./automation.js";
import { createOrUpdateLinkback } from "./linkback.js";
import { ensureSyncThread, syncAdoCommentToLinear, isSyncThread } from "./comments.js";
import { store } from "./store.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import {
  prStoreKey,
  type AdoWebhookPayload,
  type AdoPullRequestResource,
  type AdoPrInfo,
  type LinkedIssue,
  type AttachmentMetadata,
  type LinkKind,
} from "./types.js";

/**
 * Build the user-facing PR URL from ADO resource data.
 */
function buildPrWebUrl(
  resource: AdoPullRequestResource,
  payload: AdoWebhookPayload
): string {
  if (resource._links?.web?.href) {
    return resource._links.web.href;
  }
  const baseUrl =
    payload.resourceContainers?.account?.baseUrl ??
    `https://dev.azure.com/${config.adoOrg}/`;
  const project = resource.repository.project.name;
  const repo = resource.repository.name;
  return `${baseUrl}${project}/_git/${repo}/pullrequest/${resource.pullRequestId}`;
}

/**
 * Build ADO PR info from a webhook payload.
 */
function buildPrInfo(
  resource: AdoPullRequestResource,
  payload: AdoWebhookPayload
): AdoPrInfo {
  return {
    org: config.adoOrg,
    project: resource.repository.project.name,
    repositoryId: resource.repository.id,
    pullRequestId: resource.pullRequestId,
    prUrl: buildPrWebUrl(resource, payload),
    title: resource.title,
  };
}

/**
 * Build attachment metadata from ADO PR resource.
 */
function buildAttachmentMetadata(
  payload: AdoWebhookPayload,
  linkKind: LinkKind
): AttachmentMetadata {
  const resource = payload.resource;
  return {
    status: resource.status,
    pullRequestId: resource.pullRequestId,
    branch: branchFromRef(resource.sourceRefName),
    targetBranch: branchFromRef(resource.targetRefName),
    isDraft: resource.isDraft ?? false,
    mergeStatus: resource.mergeStatus,
    reviewers: resource.reviewers.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      vote: r.vote,
    })),
    createdAt: resource.creationDate,
    updatedAt: payload.createdDate,
    closedAt: resource.closedDate,
    linkKind,
  };
}

// ---------------------------------------------------------------------------
// Per-PR processing lock — serializes concurrent webhooks for the same PR
// so that e.g. a "merged" and "created" arriving simultaneously don't race.
// ---------------------------------------------------------------------------

const prLocks = new Map<string, Promise<void>>();

async function withPrLock(prKey: string, fn: () => Promise<void>): Promise<void> {
  const previous = prLocks.get(prKey) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  prLocks.set(prKey, current);
  try {
    await current;
  } finally {
    // Clean up if this was the last in the chain
    if (prLocks.get(prKey) === current) {
      prLocks.delete(prKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Main ADO webhook handler
// ---------------------------------------------------------------------------

/**
 * For comment events, the PR data is nested under resource.pullRequest.
 * For PR events, the PR data IS the resource. This helper normalizes access.
 */
function getPrResource(payload: AdoWebhookPayload): AdoPullRequestResource | undefined {
  if (payload.eventType === "ms.vss-code.git-pullrequest-comment-event") {
    return payload.resource.pullRequest;
  }
  return payload.resource;
}

export async function handleAdoWebhook(payload: AdoWebhookPayload): Promise<void> {
  const { eventType } = payload;
  const prResource = getPrResource(payload);

  log.info("webhook.ado.received", {
    eventType,
    pullRequestId: prResource?.pullRequestId,
    status: prResource?.status,
    title: prResource?.title,
  });

  const prKey = prResource ? `pr:${prResource.pullRequestId}` : `event:${payload.id}`;

  await withPrLock(prKey, async () => {
    if (eventType === "ms.vss-code.git-pullrequest-comment-event") {
      await handleCommentEvent(payload, prResource);
    } else {
      await handlePrLifecycleEvent(payload);
    }
  });
}

// ---------------------------------------------------------------------------
// PR lifecycle: match issues, create attachments, transition state, linkback
// ---------------------------------------------------------------------------

async function handlePrLifecycleEvent(payload: AdoWebhookPayload): Promise<void> {
  const resource = payload.resource;
  const prInfo = buildPrInfo(resource, payload);
  const prUrl = prInfo.prUrl;

  // Match issues from PR title, description, and branch name
  const matchResult = matchIssuesForPullRequest(
    resource.title,
    resource.description,
    resource.sourceRefName
  );

  const allIdentifiers = [
    ...matchResult.closes.map((id) => ({ identifier: id, linkKind: "closes" as const })),
    ...matchResult.contributes.map((id) => ({ identifier: id, linkKind: "contributes" as const })),
  ];

  if (allIdentifiers.length === 0) {
    log.info("webhook.ado.no_issues_matched", {
      pullRequestId: resource.pullRequestId,
      title: resource.title,
      branch: branchFromRef(resource.sourceRefName),
    });
    return;
  }

  log.info("issue.matched", {
    pullRequestId: resource.pullRequestId,
    closes: matchResult.closes,
    contributes: matchResult.contributes,
    ignores: matchResult.ignores,
  });

  // Resolve each identifier to a Linear issue and process
  const linkedIssues: LinkedIssue[] = [];

  for (const { identifier, linkKind } of allIdentifiers) {
    try {
      const issue = await linear.findIssueByIdentifier(identifier);
      if (!issue) {
        log.warn("issue.not_found", { identifier });
        continue;
      }

      const linkedIssue: LinkedIssue = {
        identifier,
        id: issue.id,
        title: issue.title,
        url: issue.url,
        teamId: (await issue.team)?.id ?? "",
        linkKind,
      };
      linkedIssues.push(linkedIssue);

      // Create/update attachment
      const metadata = buildAttachmentMetadata(payload, linkKind);
      await linear.createOrUpdateAttachment(
        issue.id,
        prUrl,
        `PR #${resource.pullRequestId}: ${resource.title}`,
        metadata
      );

      // Auto-assign PR author to issue
      if (linkKind === "closes") {
        try {
          await linear.autoAssignIssue(issue.id, resource.createdBy.uniqueName);
        } catch (err) {
          log.warn("auto_assign.failed", { issueId: issue.id });
        }
      }

      // Determine and apply state transition
      const automationResult = determineTargetState(
        payload.eventType,
        resource,
        linkKind
      );

      if (automationResult.shouldTransition && automationResult.linearStateName) {
        // With the per-PR lock, concurrent webhooks are serialized, so the
        // issue state we fetch here reflects all prior transitions.
        const currentState = await issue.state;
        const currentStateName = currentState?.name;

        if (shouldAllowTransition(currentStateName, automationResult.targetState)) {
          const targetState = await linear.findStateByName(
            linkedIssue.teamId,
            automationResult.linearStateName
          );

          if (targetState) {
            const success = await linear.transitionIssue(issue.id, targetState.id);
            if (success) {
              log.info("state.transitioned", {
                issueId: issue.id,
                identifier,
                from: currentStateName,
                to: automationResult.linearStateName,
              });
            }
          } else {
            log.warn("state.not_found", {
              teamId: linkedIssue.teamId,
              stateName: automationResult.linearStateName,
            });
          }
        } else {
          log.info("state.skip_backward", {
            identifier,
            currentState: currentStateName,
            targetState: automationResult.linearStateName,
          });
        }
      }
    } catch (err) {
      log.error("webhook.ado.issue_processing_failed", { identifier }, err);
    }
  }

  // Update store with PR<->issue links
  if (linkedIssues.length > 0) {
    store.setIssueLinks(
      prStoreKey(prInfo),
      linkedIssues.map((li) => ({
        identifier: li.identifier,
        issueId: li.id,
        linkKind: li.linkKind,
        title: li.title,
        url: li.url,
        teamId: li.teamId,
      })),
      prInfo
    );

    // Post/update linkback comment on the ADO PR
    await createOrUpdateLinkback(prInfo, linkedIssues);

    // Create synced comment threads for each linked issue (if not already created)
    for (const li of linkedIssues) {
      try {
        await ensureSyncThread(li.identifier, li.id, prInfo);
      } catch (err) {
        log.error("sync_thread.create_failed", { identifier: li.identifier }, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Comment events: sync ADO PR comments to Linear
// ---------------------------------------------------------------------------

async function handleCommentEvent(
  payload: AdoWebhookPayload,
  prResource: AdoPullRequestResource | undefined
): Promise<void> {
  if (!prResource) {
    log.warn("comment.no_pr_data", { eventType: payload.eventType });
    return;
  }

  const prInfo = buildPrInfo(prResource, payload);
  const prUrl = prInfo.prUrl;

  const comment = payload.resource.comment;
  if (!comment) {
    log.warn("comment.no_comment_in_payload", { pullRequestId: prResource.pullRequestId });
    return;
  }

  // Try to get thread ID from the payload (resource.id for comment events),
  // then fall back to fetching all threads from the ADO API.
  let threadId: number | undefined = payload.resource.id;

  if (!threadId) {
    log.info("comment.thread_id_not_in_payload", {
      pullRequestId: prResource.pullRequestId,
      commentId: comment.id,
      resourceKeys: Object.keys(payload.resource).filter(
        (k) => !["pullRequest", "comment"].includes(k)
      ),
    });

    const threads = await ado.getPullRequestThreads(
      prInfo.org,
      prInfo.project,
      prInfo.repositoryId,
      prResource.pullRequestId
    );
    const matchingThread = threads.find((t) =>
      t.comments.some((c) => c.id === comment.id)
    );
    threadId = matchingThread?.id;
  }

  if (!threadId) {
    log.info("comment.no_thread_id", {
      pullRequestId: prResource.pullRequestId,
      commentId: comment.id,
    });
    return;
  }

  const prKey = prStoreKey(prInfo);

  // Only sync comments from the designated sync thread
  if (!isSyncThread(prKey, threadId)) {
    log.info("comment.skip_not_sync_thread", {
      pullRequestId: prResource.pullRequestId,
      threadId,
      expectedThreadId: store.getSyncThread(prKey),
    });
    return;
  }

  // Find linked issues for this PR
  const linkedIssues = store.getIssuesForPr(prKey);
  if (linkedIssues.length === 0) {
    log.info("comment.no_linked_issues", { pullRequestId: prResource.pullRequestId });
    return;
  }

  // Sync to each linked Linear issue's sync thread root
  for (const li of linkedIssues) {
    const rootCommentId = store.getSyncRoot(li.identifier);
    if (!rootCommentId) {
      log.warn("comment.no_sync_root", { identifier: li.identifier });
      continue;
    }

    await syncAdoCommentToLinear(
      comment,
      li.identifier,
      li.issueId,
      rootCommentId,
      prResource.pullRequestId,
      threadId
    );
  }
}
