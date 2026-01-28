/**
 * Updating Issues - Linear SDK
 *
 * This guide demonstrates how to:
 * 1. Find an issue by identifier or UUID
 * 2. Update issue fields
 * 3. Manage labels (add/remove)
 * 4. Batch update multiple issues
 *
 * Using the @linear/sdk package.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 */

import { LinearClient } from "@linear/sdk";

// =============================================================================
// SETUP
// =============================================================================

const linear = new LinearClient({
  accessToken: "<YOUR_ACCESS_TOKEN>",
});

// =============================================================================
// 1. FIND AN ISSUE
// =============================================================================

/**
 * Find an issue by its identifier (e.g., "ENG-123") or UUID.
 *
 * The SDK's issue() method accepts either format.
 */
async function findIssue(idOrIdentifier: string) {
  const issue = await linear.issue(idOrIdentifier);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    // Get related data
    labels: await issue.labels(),
    state: await issue.state,
    assignee: await issue.assignee,
  };
}

// =============================================================================
// 2. UPDATE AN ISSUE
// =============================================================================

/**
 * Update issue fields.
 *
 * This is a PARTIAL update—only fields you include are modified.
 * Omitted fields remain unchanged.
 */
async function updateIssue(
  issueId: string,
  updates: {
    title?: string;
    description?: string;
    stateId?: string;
    assigneeId?: string | null; // null to unassign
    priority?: number; // 0=none, 1=urgent, 2=high, 3=medium, 4=low
    estimate?: number | null;
    dueDate?: string | null; // "YYYY-MM-DD" or null to clear
    labelIds?: string[];
    projectId?: string | null;
    cycleId?: string | null;
  }
) {
  const result = await linear.updateIssue(issueId, updates);

  const issue = await result.issue;
  if (!issue) throw new Error("Failed to update issue");

  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
  };
}

// =============================================================================
// 3. MANAGE LABELS
// =============================================================================

/**
 * Add a label to an issue.
 *
 * Since labelIds replaces all labels, we must:
 * 1. Fetch current labels
 * 2. Add the new one
 * 3. Send the complete array
 */
async function addLabel(issueId: string, labelId: string) {
  // Get current labels
  const issue = await linear.issue(issueId);
  const currentLabels = await issue.labels();
  const currentLabelIds = currentLabels.nodes.map((l) => l.id);

  // Skip if already has this label
  if (currentLabelIds.includes(labelId)) {
    return { alreadyHasLabel: true };
  }

  // Update with new label added
  const result = await linear.updateIssue(issueId, {
    labelIds: [...currentLabelIds, labelId],
  });

  return { success: (await result.issue) !== undefined };
}

/**
 * Remove a label from an issue.
 */
async function removeLabel(issueId: string, labelId: string) {
  // Get current labels
  const issue = await linear.issue(issueId);
  const currentLabels = await issue.labels();
  const currentLabelIds = currentLabels.nodes.map((l) => l.id);

  // Skip if doesn't have this label
  if (!currentLabelIds.includes(labelId)) {
    return { didNotHaveLabel: true };
  }

  // Update with label removed
  const result = await linear.updateIssue(issueId, {
    labelIds: currentLabelIds.filter((id) => id !== labelId),
  });

  return { success: (await result.issue) !== undefined };
}

// =============================================================================
// 4. BATCH UPDATE
// =============================================================================

/**
 * Update multiple issues at once.
 *
 * Useful for bulk operations like:
 * - Assigning multiple issues to someone
 * - Changing priority of a set of issues
 * - Moving issues to a different state
 */
async function batchUpdate(
  issueIds: string[],
  updates: {
    stateId?: string;
    assigneeId?: string | null;
    priority?: number;
    labelIds?: string[];
  }
) {
  // The SDK doesn't have a direct batchUpdate method,
  // so we use the underlying GraphQL client
  const result = await linear.client.rawRequest(
    `
    mutation IssueBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
      issueBatchUpdate(ids: $ids, input: $input) {
        success
        issues {
          id
          identifier
        }
      }
    }
  `,
    {
      ids: issueIds,
      input: updates,
    }
  );

  return (result as any).data.issueBatchUpdate;
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/**
 * Example showing various update operations.
 *
 * Replace the issue identifier with a real one from your workspace.
 */
async function example() {
  const issueIdentifier = "<YOUR_ISSUE_ID>"; // e.g., "ENG-123"

  // 1. Find the issue
  const issue = await findIssue(issueIdentifier);
  console.log(`Found: ${issue.identifier} - ${issue.title}`);

  // 2. Update fields
  await updateIssue(issue.id, {
    title: "Updated title",
    priority: 2, // High priority
    description: "Updated description with **markdown** support",
  });

  // 3. Add a label (you'd need a real label ID)
  // await addLabel(issue.id, "<LABEL_UUID>");

  // 4. Remove a label
  // await removeLabel(issue.id, "<LABEL_UUID>");

  // 5. Batch update multiple issues
  // await batchUpdate(
  //   ["uuid-1", "uuid-2", "uuid-3"],
  //   { priority: 1 }
  // );
}
