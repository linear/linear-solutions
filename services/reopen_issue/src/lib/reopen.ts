import type { LinearClientWrapper } from "./linear.js";
import type { CommentData, ProcessResult } from "../types.js";

const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Process a newly created comment and reopen the parent issue if it was
 * posted by an external user (synced thread) on a done issue.
 *
 * Reopening the issue via a state change causes Linear's built-in
 * IssueReopenedProcessor to send an `issueReopened` notification to
 * the current assignee — no extra notification needed.
 */
export async function processComment(
  client: LinearClientWrapper,
  comment: CommentData
): Promise<ProcessResult> {
  if (!comment.externalUserId) {
    return { status: "ignored", reason: "Not from a synced thread (no external user)" };
  }

  const issueId = comment.issueId ?? comment.issue?.id;
  if (!issueId) {
    return { status: "ignored", reason: "Comment has no associated issue" };
  }

  const issue = await client.getIssue(issueId);
  if (!issue) {
    return { status: "error", reason: `Failed to fetch issue ${issueId}` };
  }

  const state = await issue.state;
  if (!state || !DONE_STATE_TYPES.has(state.type)) {
    return {
      status: "ignored",
      reason: `Issue ${issue.identifier} is in "${state?.name ?? "unknown"}" state, not done`,
    };
  }

  const assignee = await issue.assignee;
  if (!assignee) {
    return {
      status: "ignored",
      reason: `Issue ${issue.identifier} has no assignee — skipping reopen`,
    };
  }

  const team = await issue.team;
  if (!team) {
    return { status: "error", reason: `Failed to fetch team for issue ${issue.identifier}` };
  }

  const reopenState = await client.getTeamActiveState(team.id);
  if (!reopenState) {
    return {
      status: "error",
      reason: `No active workflow state found for team ${team.name}`,
    };
  }

  const externalName = comment.externalUser?.name ?? "An external user";
  console.log(
    `Reopening issue ${issue.identifier} — ${externalName} commented on a synced thread while issue was "${state.name}"`
  );

  const success = await client.reopenIssue(issue.id, reopenState.id);
  if (!success) {
    return { status: "error", reason: `Failed to update issue ${issue.identifier} state` };
  }

  console.log(`Issue ${issue.identifier} reopened to "${reopenState.name}"`);

  return {
    status: "reopened",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  };
}
