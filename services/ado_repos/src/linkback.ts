import * as ado from "./ado.js";
import { LINKBACK_MARKER } from "./ado.js";
import { log } from "./logger.js";
import type { AdoPrInfo, LinkedIssue } from "./types.js";

/**
 * Build the markdown content for a linkback comment.
 */
function buildLinkbackContent(issues: LinkedIssue[]): string {
  const lines = issues.map((issue) => {
    const kindLabel = issue.linkKind === "closes" ? "closes" : "contributes to";
    return `- [${issue.identifier}: ${issue.title}](${issue.url}) (${kindLabel})`;
  });

  return `${LINKBACK_MARKER}\n**Linear Issues:**\n${lines.join("\n")}`;
}

/**
 * Create or update a linkback comment on an ADO PR that links to the matched Linear issues.
 * If a linkback thread already exists (identified by the marker), update it.
 * Otherwise, create a new thread.
 */
export async function createOrUpdateLinkback(
  prInfo: AdoPrInfo,
  issues: LinkedIssue[]
): Promise<void> {
  if (issues.length === 0) return;

  const content = buildLinkbackContent(issues);

  try {
    const threads = await ado.getPullRequestThreads(
      prInfo.org,
      prInfo.project,
      prInfo.repositoryId,
      prInfo.pullRequestId
    );

    const existing = ado.findLinkbackThread(threads);

    if (existing) {
      await ado.updateComment(
        prInfo.org,
        prInfo.project,
        prInfo.repositoryId,
        prInfo.pullRequestId,
        existing.thread.id,
        existing.commentId,
        content
      );
      log.info("linkback.updated", {
        pullRequestId: prInfo.pullRequestId,
        threadId: existing.thread.id,
        issueCount: issues.length,
      });
    } else {
      const thread = await ado.createCommentThread(
        prInfo.org,
        prInfo.project,
        prInfo.repositoryId,
        prInfo.pullRequestId,
        content
      );
      log.info("linkback.created", {
        pullRequestId: prInfo.pullRequestId,
        threadId: thread.id,
        issueCount: issues.length,
      });
    }
  } catch (err) {
    log.error(
      "linkback.failed",
      { pullRequestId: prInfo.pullRequestId, issueCount: issues.length },
      err
    );
  }
}
