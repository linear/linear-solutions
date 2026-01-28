/**
 * Creating a Team from Another Team's Settings - Raw GraphQL
 *
 * This guide demonstrates how to:
 * 1. Find a source team to copy from
 * 2. Create a new team with copied settings
 * 3. Verify the team was created
 *
 * Using raw GraphQL queries against Linear's API.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 * - <SOURCE_TEAM_KEY> → Key of team to copy from (e.g., "ENG")
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
// 1. FIND SOURCE TEAM
// =============================================================================

/**
 * Query to find a team by key or UUID.
 *
 * The `id` parameter accepts either:
 * - Team key: "ENG"
 * - UUID: "a1b2c3d4-..."
 */
const FIND_TEAM = `
  query FindTeam($id: String!) {
    team(id: $id) {
      id
      key
      name
      description
    }
  }
`;

async function findTeam(keyOrId: string) {
  const result = await linearQuery<{
    team: { id: string; key: string; name: string; description: string };
  }>(FIND_TEAM, { id: keyOrId });

  return result.team;
}

/**
 * Query to list all teams.
 */
const LIST_TEAMS = `
  query ListTeams {
    teams {
      nodes {
        id
        key
        name
      }
    }
  }
`;

async function listTeams() {
  const result = await linearQuery<{
    teams: { nodes: { id: string; key: string; name: string }[] };
  }>(LIST_TEAMS);

  return result.teams.nodes;
}

// =============================================================================
// 2. CREATE TEAM WITH COPIED SETTINGS
// =============================================================================

/**
 * Mutation to create a team with settings copied from another team.
 *
 * copySettingsFromTeamId copies:
 * - Workflow states (replaces defaults)
 * - Labels (including groups and hierarchy)
 * - Templates (issue and project templates)
 * - Cycle settings (duration, start day, etc.)
 * - Git automation states
 * - Other settings (timezone, estimation, auto-archive)
 *
 * Does NOT copy:
 * - Team members
 * - Issues, projects, cycles
 * - Slack notification settings
 */
const CREATE_TEAM = `
  mutation CreateTeam($input: TeamCreateInput!, $copySettingsFromTeamId: String) {
    teamCreate(input: $input, copySettingsFromTeamId: $copySettingsFromTeamId) {
      success
      team {
        id
        key
        name
        description
      }
    }
  }
`;

/**
 * Create a new team that copies settings from an existing team.
 */
async function createTeamFromTemplate(params: {
  name: string;
  key?: string;
  description?: string;
  copyFromTeamId: string;
}) {
  const result = await linearQuery<{
    teamCreate: {
      success: boolean;
      team: { id: string; key: string; name: string; description: string };
    };
  }>(CREATE_TEAM, {
    input: {
      name: params.name,
      key: params.key,
      description: params.description,
    },
    copySettingsFromTeamId: params.copyFromTeamId,
  });

  if (!result.teamCreate.success) {
    throw new Error("Failed to create team");
  }

  return result.teamCreate.team;
}

/**
 * Mutation to create a sub-team.
 *
 * Sub-teams automatically inherit settings from their parent.
 * No need to specify copySettingsFromTeamId.
 */
const CREATE_SUB_TEAM = `
  mutation CreateSubTeam($input: TeamCreateInput!) {
    teamCreate(input: $input) {
      success
      team {
        id
        key
        name
        parent {
          id
          name
        }
      }
    }
  }
`;

async function createSubTeam(params: {
  name: string;
  key?: string;
  parentTeamId: string;
}) {
  const result = await linearQuery<{
    teamCreate: {
      success: boolean;
      team: {
        id: string;
        key: string;
        name: string;
        parent: { id: string; name: string };
      };
    };
  }>(CREATE_SUB_TEAM, {
    input: {
      name: params.name,
      key: params.key,
      parentId: params.parentTeamId,
    },
  });

  if (!result.teamCreate.success) {
    throw new Error("Failed to create sub-team");
  }

  return result.teamCreate.team;
}

// =============================================================================
// 3. VERIFY TEAM SETTINGS
// =============================================================================

/**
 * Query to verify team settings were copied.
 */
const VERIFY_TEAM = `
  query VerifyTeam($teamId: String!) {
    team(id: $teamId) {
      id
      key
      name
      states {
        nodes {
          id
          name
          type
        }
      }
      labels {
        nodes {
          id
          name
          isGroup
        }
      }
      templates {
        nodes {
          id
          name
          type
        }
      }
    }
  }
`;

async function verifyTeamSettings(teamId: string) {
  const result = await linearQuery<{
    team: {
      id: string;
      key: string;
      name: string;
      states: { nodes: { id: string; name: string; type: string }[] };
      labels: { nodes: { id: string; name: string; isGroup: boolean }[] };
      templates: { nodes: { id: string; name: string; type: string }[] };
    };
  }>(VERIFY_TEAM, { teamId });

  return {
    team: {
      id: result.team.id,
      key: result.team.key,
      name: result.team.name,
    },
    workflowStates: result.team.states.nodes.map((s) => s.name),
    labels: result.team.labels.nodes.map((l) => l.name),
    labelGroups: result.team.labels.nodes
      .filter((l) => l.isGroup)
      .map((l) => l.name),
    templates: result.team.templates.nodes.map((t) => t.name),
  };
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/**
 * Example showing the full flow.
 *
 * Replace the source team key with a real team from your workspace.
 */
async function example() {
  // 1. Find the source team to copy from
  const sourceTeam = await findTeam("<SOURCE_TEAM_KEY>"); // e.g., "ENG"
  console.log(`Source team: ${sourceTeam.name} (${sourceTeam.id})`);

  // 2. Create new team with copied settings
  const newTeam = await createTeamFromTemplate({
    name: "New Platform Team",
    key: "PLAT",
    description: "Platform engineering team",
    copyFromTeamId: sourceTeam.id,
  });
  console.log(`Created team: ${newTeam.name} (${newTeam.key})`);

  // 3. Verify settings were copied
  const settings = await verifyTeamSettings(newTeam.id);
  console.log(`Workflow states: ${settings.workflowStates.join(", ")}`);
  console.log(`Labels: ${settings.labels.join(", ")}`);
  console.log(`Label groups: ${settings.labelGroups.join(", ")}`);
  console.log(`Templates: ${settings.templates.join(", ")}`);
}

// =============================================================================
// ALTERNATIVE: CREATE SUB-TEAM
// =============================================================================

/**
 * Example: Creating a sub-team that inherits from parent.
 */
async function exampleSubTeam() {
  const parentTeam = await findTeam("<PARENT_TEAM_KEY>"); // e.g., "ENG"

  const subTeam = await createSubTeam({
    name: "Mobile",
    key: "MOBILE",
    parentTeamId: parentTeam.id,
  });

  console.log(`Created sub-team: ${subTeam.name} under ${subTeam.parent.name}`);
}
