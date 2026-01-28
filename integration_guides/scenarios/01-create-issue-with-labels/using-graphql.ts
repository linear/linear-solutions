/**
 * Creating Issues with Labels - Raw GraphQL
 *
 * This guide demonstrates how to:
 * 1. Find or create label groups and labels
 * 2. Look up workflow states
 * 3. Create an issue with labels
 *
 * Using raw GraphQL queries against Linear's API.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 * - <YOUR_TEAM_ID> → Target team's UUID (use team key like "ENG" with team() query to find it)
 */

// =============================================================================
// GRAPHQL CLIENT
// =============================================================================

/**
 * Execute a GraphQL query against Linear's API.
 *
 * Authentication:
 * - OAuth token: "lin_oauth_..." (recommended for integrations)
 * - API key: "lin_api_..." (for personal scripts)
 *
 * Both are passed in the Authorization header.
 */
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
// 1. FIND OR CREATE LABELS
// =============================================================================

/**
 * Query to find a label group by name.
 *
 * Label groups have `isGroup: true`.
 */
const FIND_LABEL_GROUP = `
  query FindLabelGroup($name: String!) {
    issueLabels(filter: { name: { eq: $name }, isGroup: { eq: true } }) {
      nodes {
        id
        name
      }
    }
  }
`;

/**
 * Mutation to create a label group.
 *
 * WORKSPACE vs TEAM labels:
 * - Omit teamId → workspace label (available to all teams)
 * - Include teamId → team label (only visible in that team)
 *
 * The `isGroup: true` flag makes this a group, not a regular label.
 */
const CREATE_LABEL_GROUP = `
  mutation CreateLabelGroup($name: String!) {
    issueLabelCreate(input: {
      name: $name
      isGroup: true
      # teamId: "..." # Add for team-scoped labels
    }) {
      success
      issueLabel {
        id
        name
      }
    }
  }
`;

async function ensureLabelGroup(name: string): Promise<string> {
  // Check if group exists
  const existing = await linearQuery<{
    issueLabels: { nodes: { id: string }[] };
  }>(FIND_LABEL_GROUP, { name });

  if (existing.issueLabels.nodes[0]) {
    return existing.issueLabels.nodes[0].id;
  }

  // Create the group
  const result = await linearQuery<{
    issueLabelCreate: { issueLabel: { id: string } };
  }>(CREATE_LABEL_GROUP, { name });

  return result.issueLabelCreate.issueLabel.id;
}

/**
 * Query to find a label within a group.
 *
 * NOTE: Use ID! type (not String!) for the groupId variable
 * when filtering by parent.id.
 */
const FIND_LABEL = `
  query FindLabel($name: String!, $groupId: ID!) {
    issueLabels(filter: {
      name: { eq: $name }
      parent: { id: { eq: $groupId } }
    }) {
      nodes {
        id
        name
      }
    }
  }
`;

/**
 * Mutation to create a label within a group.
 *
 * The `parentId` links this label to its group.
 * NOTE: Use ID! type (not String!) for the parentId variable.
 */
const CREATE_LABEL = `
  mutation CreateLabel($name: String!, $parentId: ID!) {
    issueLabelCreate(input: {
      name: $name
      parentId: $parentId
      # teamId: "..." # Add for team-scoped labels
    }) {
      success
      issueLabel {
        id
        name
      }
    }
  }
`;

async function ensureLabel(name: string, groupId: string): Promise<string> {
  // Check if label exists
  const existing = await linearQuery<{
    issueLabels: { nodes: { id: string }[] };
  }>(FIND_LABEL, { name, groupId });

  if (existing.issueLabels.nodes[0]) {
    return existing.issueLabels.nodes[0].id;
  }

  // Create the label
  const result = await linearQuery<{
    issueLabelCreate: { issueLabel: { id: string } };
  }>(CREATE_LABEL, { name, parentId: groupId });

  return result.issueLabelCreate.issueLabel.id;
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
      const existing = await linearQuery<{
        issueLabels: { nodes: { id: string }[] };
      }>(FIND_LABEL, { name, groupId });
      if (existing.issueLabels.nodes[0]) {
        return existing.issueLabels.nodes[0].id;
      }
    }
    throw error;
  }
}

// =============================================================================
// 2. FIND WORKFLOW STATE
// =============================================================================

/**
 * Query workflow states for a team.
 *
 * Workflow states are TEAM-SPECIFIC. Each team has its own states.
 * State types: triage, backlog, unstarted, started, completed, canceled.
 *
 * This example looks for Triage first—a common pattern for programmatically-
 * created issues since it gives teams an inbox to review before backlog.
 * Adjust the logic to find whatever state fits your use case.
 *
 * TIP: Filter by state.type rather than name for reliability,
 * since teams may rename their states.
 *
 * NOTE: Use ID! type (not String!) for the teamId variable
 * when filtering by team.id.
 */
const FIND_WORKFLOW_STATES = `
  query FindWorkflowStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes {
        id
        name
        type
      }
    }
  }
`;

async function findTriageState(teamId: string): Promise<string | undefined> {
  const result = await linearQuery<{
    workflowStates: { nodes: { id: string; name: string; type: string }[] };
  }>(FIND_WORKFLOW_STATES, { teamId });

  const states = result.workflowStates.nodes;

  // Prefer type-based matching (more reliable than name)
  const triageByType = states.find((s) => s.type === "triage");
  if (triageByType) return triageByType.id;

  // Fallback to name matching
  const triageByName = states.find((s) => s.name.toLowerCase() === "triage");
  if (triageByName) return triageByName.id;

  // Last resort: use first backlog state
  const backlog = states.find((s) => s.type === "backlog");
  return backlog?.id;
}

// =============================================================================
// 3. CREATE ISSUE
// =============================================================================

/**
 * Mutation to create an issue.
 *
 * IMPORTANT - Label validation rules:
 * 1. All labelIds must be valid and accessible
 * 2. Cannot include group labels (isGroup: true) - only child labels
 * 3. Only one child per label group allowed
 * 4. If ANY validation fails, the entire mutation fails
 *
 * Linear won't create the issue without labels as a fallback.
 *
 * Common IssueCreateInput fields:
 * - teamId: String!       (required)
 * - title: String!        (required)
 * - description: String   (markdown supported)
 * - stateId: String       (workflow state)
 * - labelIds: [String!]   (must all be valid child labels)
 * - assigneeId: String
 * - priority: Int         (1=urgent, 2=high, 3=normal, 4=low)
 * - projectId: String
 * - estimate: Int
 * - dueDate: TimelessDate (YYYY-MM-DD)
 */
const CREATE_ISSUE = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
      }
    }
  }
`;

async function createIssue(params: {
  teamId: string;
  title: string;
  description?: string;
  labelIds: string[];
  stateId?: string;
}) {
  const result = await linearQuery<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string };
    };
  }>(CREATE_ISSUE, {
    input: {
      teamId: params.teamId,
      title: params.title,
      description: params.description,
      labelIds: params.labelIds,
      stateId: params.stateId,
    },
  });

  return result.issueCreate.issue;
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
