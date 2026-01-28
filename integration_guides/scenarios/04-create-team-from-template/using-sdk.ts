/**
 * Creating a Team from Another Team's Settings - Linear SDK
 *
 * This guide demonstrates how to:
 * 1. Find a source team to copy from
 * 2. Create a new team with copied settings
 * 3. Verify the team was created
 *
 * Using the @linear/sdk package.
 *
 * BEFORE USING: Replace these placeholders with your values:
 * - <YOUR_ACCESS_TOKEN> → Your OAuth token (lin_oauth_...) or API key (lin_api_...)
 * - <SOURCE_TEAM_KEY> → Key of team to copy from (e.g., "ENG")
 */

import { LinearClient } from "@linear/sdk";

// =============================================================================
// SETUP
// =============================================================================

const linear = new LinearClient({
  accessToken: "<YOUR_ACCESS_TOKEN>",
});

// =============================================================================
// 1. FIND SOURCE TEAM
// =============================================================================

/**
 * Find a team by its key (e.g., "ENG") or UUID.
 *
 * Returns the UUID needed for copySettingsFromTeamId.
 */
async function findTeam(keyOrId: string) {
  const team = await linear.team(keyOrId);

  return {
    id: team.id,
    key: team.key,
    name: team.name,
  };
}

/**
 * List all teams in the workspace.
 *
 * Useful for finding which team to copy from.
 */
async function listTeams() {
  const teams = await linear.teams();

  return teams.nodes.map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
  }));
}

// =============================================================================
// 2. CREATE TEAM WITH COPIED SETTINGS
// =============================================================================

/**
 * Create a new team that copies settings from an existing team.
 *
 * This copies:
 * - Workflow states
 * - Labels (including groups)
 * - Templates
 * - Cycle settings
 * - Git automation states
 * - Other team settings (timezone, estimation, etc.)
 *
 * This does NOT copy:
 * - Team members
 * - Issues, projects, cycles
 * - Slack notification settings
 */
async function createTeamFromTemplate(params: {
  name: string;
  key?: string;
  description?: string;
  copyFromTeamId: string;
}) {
  // The SDK's createTeam method doesn't directly support copySettingsFromTeamId,
  // so we use the raw GraphQL client
  const result = await linear.client.rawRequest(
    `
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
  `,
    {
      input: {
        name: params.name,
        key: params.key,
        description: params.description,
      },
      copySettingsFromTeamId: params.copyFromTeamId,
    }
  );

  const data = (result as any).data.teamCreate;
  if (!data.success) {
    throw new Error("Failed to create team");
  }

  return data.team;
}

/**
 * Create a sub-team under a parent team.
 *
 * Sub-teams automatically inherit settings from their parent.
 * No need to specify copySettingsFromTeamId.
 */
async function createSubTeam(params: {
  name: string;
  key?: string;
  parentTeamId: string;
}) {
  const result = await linear.createTeam({
    name: params.name,
    key: params.key,
    parentId: params.parentTeamId,
  });

  const team = await result.team;
  if (!team) {
    throw new Error("Failed to create sub-team");
  }

  return {
    id: team.id,
    key: team.key,
    name: team.name,
  };
}

// =============================================================================
// 3. VERIFY TEAM SETTINGS
// =============================================================================

/**
 * Verify that settings were copied correctly.
 *
 * Fetches the new team's workflow states and labels to confirm
 * they match the source team.
 */
async function verifyTeamSettings(teamId: string) {
  const team = await linear.team(teamId);

  // Get workflow states
  const states = await team.states();
  const stateNames = states.nodes.map((s) => s.name);

  // Get labels
  const labels = await team.labels();
  const labelNames = labels.nodes.map((l) => l.name);

  // Get templates
  const templates = await team.templates();
  const templateNames = templates.nodes.map((t) => t.name);

  return {
    team: {
      id: team.id,
      key: team.key,
      name: team.name,
    },
    workflowStates: stateNames,
    labels: labelNames,
    templates: templateNames,
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

  console.log(`Created sub-team: ${subTeam.name} (${subTeam.key})`);
}
