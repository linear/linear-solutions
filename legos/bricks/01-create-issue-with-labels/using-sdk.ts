/**
 * Creating Issues with Labels - Linear SDK
 *
 * This guide demonstrates how to:
 * 1. Find or create label groups and labels
 * 2. Look up workflow states
 * 3. Create an issue with labels
 *
 * Using the @linear/sdk package.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 * - <YOUR_TEAM_ID> → Target team's UUID (use team key like "ENG" with team() query to find it)
 */

import { LinearClient } from "@linear/sdk";

// =============================================================================
// SETUP
// =============================================================================

/**
 * Initialize the Linear client.
 *
 * OAuth (recommended for integrations):
 *   new LinearClient({ accessToken: "lin_oauth_..." })
 *
 * API Key (for personal scripts):
 *   new LinearClient({ apiKey: "lin_api_..." })
 */
const linear = new LinearClient({
  accessToken: "<YOUR_ACCESS_TOKEN>",
  // Or: apiKey: "<YOUR_API_KEY>"
});

// =============================================================================
// 1. FIND OR CREATE LABELS
// =============================================================================

/**
 * Ensures a label group exists, creating it if needed.
 *
 * Label groups are labels with `isGroup: true`. They appear as
 * expandable sections in Linear's label picker.
 *
 * WORKSPACE vs TEAM labels:
 * - Omit teamId → workspace label (available to all teams)
 * - Include teamId → team label (only visible in that team)
 *
 * NOTE: The SDK types don't include `isGroup` but the API accepts it.
 * We use type casts to work around this.
 */
async function ensureLabelGroup(name: string): Promise<string> {
  // Query existing labels to find the group
  const labels = await linear.issueLabels({
    filter: {
      name: { eq: name },
      isGroup: { eq: true },
    } as any,
  });

  const existing = labels.nodes[0];
  if (existing) {
    return existing.id;
  }

  // Create the group (workspace-level, no teamId)
  const result = await linear.createIssueLabel({
    name,
    isGroup: true,
    // teamId: "..." // Add this for team-scoped labels
  } as any);

  const created = await result.issueLabel;
  if (!created) throw new Error(`Failed to create label group: ${name}`);

  return created.id;
}

/**
 * Ensures a label exists within a group, creating it if needed.
 *
 * Child labels have `parentId` pointing to their group.
 */
async function ensureLabel(name: string, groupId: string): Promise<string> {
  // Query for label with this name and parent
  const labels = await linear.issueLabels({
    filter: {
      name: { eq: name },
      parent: { id: { eq: groupId } },
    },
  });

  const existing = labels.nodes[0];
  if (existing) {
    return existing.id;
  }

  // Create the label in the group
  const result = await linear.createIssueLabel({
    name,
    parentId: groupId,
    // teamId: "..." // Add for team-scoped labels
  });

  const created = await result.issueLabel;
  if (!created) throw new Error(`Failed to create label: ${name}`);

  return created.id;
}

/**
 * Handle race conditions when creating labels.
 *
 * If two processes try to create the same label simultaneously,
 * one will fail with a duplicate error. Catch it and re-query.
 */
async function ensureLabelSafe(name: string, groupId: string): Promise<string> {
  try {
    return await ensureLabel(name, groupId);
  } catch (error) {
    // If duplicate, re-query to get the ID
    if (error instanceof Error && error.message.includes("already exists")) {
      const labels = await linear.issueLabels({
        filter: { name: { eq: name }, parent: { id: { eq: groupId } } },
      });
      if (labels.nodes[0]) return labels.nodes[0].id;
    }
    throw error;
  }
}

// =============================================================================
// 2. FIND WORKFLOW STATE
// =============================================================================

/**
 * Finds a workflow state for a team.
 *
 * Workflow states are TEAM-SPECIFIC. Each team has its own workflow.
 * Common state types: triage, backlog, unstarted, started, completed, canceled.
 *
 * This example looks for Triage first—a common pattern for programmatically-
 * created issues since it gives teams an inbox to review before backlog.
 * Adjust the logic to find whatever state fits your use case.
 *
 * TIP: Filter by state.type rather than name for reliability,
 * since teams may rename their states.
 */
async function findTriageState(teamId: string): Promise<string | undefined> {
  const states = await linear.workflowStates({
    filter: {
      team: { id: { eq: teamId } },
    },
  });

  // Prefer type-based matching (more reliable than name)
  const triageByType = states.nodes.find((s) => s.type === "triage");
  if (triageByType) return triageByType.id;

  // Fallback to name matching
  const triageByName = states.nodes.find(
    (s) => s.name.toLowerCase() === "triage"
  );
  if (triageByName) return triageByName.id;

  // Last resort: use first backlog state
  const backlog = states.nodes.find((s) => s.type === "backlog");
  return backlog?.id;
}

// =============================================================================
// 3. CREATE ISSUE
// =============================================================================

/**
 * Creates an issue with labels.
 *
 * IMPORTANT - Label validation rules:
 * 1. All labelIds must be valid and accessible
 * 2. Cannot include group labels (isGroup: true) - only child labels
 * 3. Only one child per label group allowed
 * 4. If ANY validation fails, the entire mutation fails
 *
 * Linear won't create the issue without labels as a fallback.
 */
async function createIssue(params: {
  teamId: string;
  title: string;
  description?: string;
  labelIds: string[];
  stateId?: string;
}) {
  const result = await linear.createIssue({
    teamId: params.teamId,
    title: params.title,
    description: params.description,
    labelIds: params.labelIds,
    stateId: params.stateId,

    // Other common fields:
    // assigneeId: "user-uuid",
    // priority: 2,              // 1=urgent, 2=high, 3=normal, 4=low
    // projectId: "project-uuid",
    // estimate: 3,              // Story points
    // dueDate: "2024-12-31",
  });

  const issue = await result.issue;
  if (!issue) throw new Error("Failed to create issue");

  return {
    id: issue.id,
    identifier: issue.identifier, // e.g., "ENG-123"
    url: issue.url,
  };
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/**
 * Example showing the full flow.
 *
 * The label names ("Platform", "Issue Type", "iOS", "Bug") are just examples.
 * Labels are generic—use whatever structure fits your workflow.
 */
async function example() {
  const teamId = "<YOUR_TEAM_ID>";

  // 1. Ensure labels exist (these are example label names)
  const platformGroupId = await ensureLabelGroup("Platform");
  const issueTypeGroupId = await ensureLabelGroup("Issue Type");

  const iosLabelId = await ensureLabelSafe("iOS", platformGroupId);
  const bugLabelId = await ensureLabelSafe("Bug", issueTypeGroupId);

  // 2. Find Triage state
  const triageStateId = await findTriageState(teamId);

  // 3. Create issue
  const issue = await createIssue({
    teamId,
    title: "App crashes on checkout",
    description: "User reported crash when completing purchase...",
    labelIds: [iosLabelId, bugLabelId],
    stateId: triageStateId,
  });

  console.log(`Created: ${issue.identifier} - ${issue.url}`);
}
