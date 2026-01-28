/**
 * Updating Issues - Raw GraphQL
 *
 * This guide demonstrates how to:
 * 1. Find an issue by identifier or UUID
 * 2. Update issue fields
 * 3. Manage labels (add/remove)
 * 4. Batch update multiple issues
 *
 * Using raw GraphQL queries against Linear's API.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 */

// =============================================================================
// GRAPHQL CLIENT
// =============================================================================

async function linearQuery<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: "<YOUR_ACCESS_TOKEN>",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }

  return result.data;
}

// =============================================================================
// 1. FIND AN ISSUE
// =============================================================================

/**
 * Query to find an issue.
 *
 * The `id` parameter accepts either:
 * - UUID: "a1b2c3d4-..."
 * - Identifier: "ENG-123"
 */
const FIND_ISSUE = `
  query FindIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      state {
        id
        name
        type
      }
      assignee {
        id
        name
      }
      labels {
        nodes {
          id
          name
        }
      }
    }
  }
`;

async function findIssue(idOrIdentifier: string) {
  const result = await linearQuery<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      description: string;
      priority: number;
      state: { id: string; name: string; type: string };
      assignee: { id: string; name: string } | null;
      labels: { nodes: { id: string; name: string }[] };
    };
  }>(FIND_ISSUE, { id: idOrIdentifier });

  return result.issue;
}

// =============================================================================
// 2. UPDATE AN ISSUE
// =============================================================================

/**
 * Mutation to update an issue.
 *
 * This is a PARTIAL update—only fields included in `input` are modified.
 * Omitted fields remain unchanged.
 *
 * The `id` parameter accepts either UUID or identifier (e.g., "ENG-123").
 */
const UPDATE_ISSUE = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        title
        url
      }
    }
  }
`;

/**
 * Update issue fields.
 *
 * Common fields:
 * - title: String
 * - description: String (markdown supported)
 * - stateId: String (workflow state UUID)
 * - assigneeId: String (user UUID, null to unassign)
 * - priority: Int (0=none, 1=urgent, 2=high, 3=medium, 4=low)
 * - estimate: Int (story points)
 * - dueDate: String ("YYYY-MM-DD", null to clear)
 * - labelIds: [String!] (replaces all labels)
 * - projectId: String (null to remove from project)
 * - cycleId: String (null to remove from cycle)
 */
async function updateIssue(
  issueId: string,
  input: Record<string, unknown>
) {
  const result = await linearQuery<{
    issueUpdate: {
      success: boolean;
      issue: { id: string; identifier: string; title: string; url: string };
    };
  }>(UPDATE_ISSUE, { id: issueId, input });

  return result.issueUpdate;
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
  const issue = await findIssue(issueId);
  const currentLabelIds = issue.labels.nodes.map((l) => l.id);

  // Skip if already has this label
  if (currentLabelIds.includes(labelId)) {
    return { alreadyHasLabel: true };
  }

  // Update with new label added
  return updateIssue(issueId, {
    labelIds: [...currentLabelIds, labelId],
  });
}

/**
 * Remove a label from an issue.
 */
async function removeLabel(issueId: string, labelId: string) {
  // Get current labels
  const issue = await findIssue(issueId);
  const currentLabelIds = issue.labels.nodes.map((l) => l.id);

  // Skip if doesn't have this label
  if (!currentLabelIds.includes(labelId)) {
    return { didNotHaveLabel: true };
  }

  // Update with label removed
  return updateIssue(issueId, {
    labelIds: currentLabelIds.filter((id) => id !== labelId),
  });
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
 *
 * NOTE: Use [UUID!]! for the ids parameter - identifiers are not supported.
 */
const BATCH_UPDATE = `
  mutation IssueBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
    issueBatchUpdate(ids: $ids, input: $input) {
      success
      issues {
        id
        identifier
      }
    }
  }
`;

async function batchUpdate(
  issueIds: string[], // Must be UUIDs, not identifiers
  input: Record<string, unknown>
) {
  const result = await linearQuery<{
    issueBatchUpdate: {
      success: boolean;
      issues: { id: string; identifier: string }[];
    };
  }>(BATCH_UPDATE, { ids: issueIds, input });

  return result.issueBatchUpdate;
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

  // 2. Update fields (partial update)
  await updateIssue(issue.id, {
    title: "Updated title",
    priority: 2, // High priority
    description: "Updated description with **markdown** support",
  });

  // 3. Add a label (you'd need a real label ID)
  // await addLabel(issue.id, "<LABEL_UUID>");

  // 4. Remove a label
  // await removeLabel(issue.id, "<LABEL_UUID>");

  // 5. Batch update multiple issues (requires UUIDs)
  // await batchUpdate(
  //   ["uuid-1", "uuid-2", "uuid-3"],
  //   { priority: 1 }
  // );
}
