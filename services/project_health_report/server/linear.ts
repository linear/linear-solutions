import { calculateCompletion, currentHealth } from "@/lib/metrics";
import type { Health, ProjectRecord } from "@/lib/types";

const ENDPOINT = "https://api.linear.app/graphql";
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type TeamNode = { id: string; name: string; key: string; displayName: string; parent: { id: string } | null };
type UpdateNode = { id: string; health: Exclude<Health, "noUpdate">; body: string; createdAt: string; updatedAt: string };

export type LinearTeam = { id: string; name: string; key: string; parentId: string | null };
export type LinearProject = ProjectRecord & {
  teamIds: string[];
  initiativeRecords: { id: string; name: string }[];
  updates: UpdateNode[];
};

async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear API returned ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
  if (!payload.data) throw new Error("Linear API returned no data");
  return payload.data;
}

async function allTeams(apiKey: string) {
  const nodes: TeamNode[] = [];
  let after: string | null = null;
  do {
    const data: { teams: { nodes: TeamNode[]; pageInfo: PageInfo } } = await graphql(apiKey, `
      query HealthTeams($after: String) {
        teams(first: 100, after: $after) {
          nodes { id name key displayName parent { id } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { after });
    nodes.push(...data.teams.nodes);
    after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

function resolveHierarchy(teams: TeamNode[], rootName: string) {
  const matches = teams.filter((team) => team.name.toLowerCase() === rootName.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? `Multiple teams are named ${rootName}` : `Team ${rootName} was not found`);
  const ids = new Set([matches[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const team of teams) {
      if (team.parent?.id && ids.has(team.parent.id) && !ids.has(team.id)) {
        ids.add(team.id);
        changed = true;
      }
    }
  }
  return teams.filter((team) => ids.has(team.id));
}

async function projectIdsForTeam(apiKey: string, teamId: string) {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const data: { team: { projects: { nodes: { id: string }[]; pageInfo: PageInfo } } } = await graphql(apiKey, `
      query TeamHealthProjects($teamId: String!, $after: String) {
        team(id: $teamId) { projects(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
      }`, { teamId, after });
    ids.push(...data.team.projects.nodes.map((project) => project.id));
    after = data.team.projects.pageInfo.hasNextPage ? data.team.projects.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

async function projectMetadata(apiKey: string, projectId: string) {
  type Metadata = {
    id: string; name: string; url: string; targetDate: string | null;
    status: { name: string; type: string } | null; lead: { name: string } | null;
    teams: { nodes: { id: string; displayName: string; name: string }[] };
    initiatives: { nodes: { id: string; name: string }[] };
    projectMilestones: { nodes: { targetDate: string | null; progress: number; status: string }[] };
  };
  const data: { project: Metadata } = await graphql(apiKey, `
    query HealthProjectMetadata($id: String!) {
      project(id: $id) {
        id name url targetDate status { name type } lead { name }
        teams(first: 100) { nodes { id displayName name } }
        initiatives(first: 100) { nodes { id name } }
        projectMilestones(first: 250) { nodes { targetDate progress status } }
      }
    }`, { id: projectId });
  return data.project;
}

async function projectIssues(apiKey: string, projectId: string) {
  type Issue = { id: string; estimate: number | null; priority: number; state: { type: string }; inverseRelations: { nodes: { type: string }[] } };
  const issues: Issue[] = [];
  let after: string | null = null;
  do {
    const data: { project: { issues: { nodes: Issue[]; pageInfo: PageInfo } } } = await graphql(apiKey, `
      query HealthProjectIssues($id: String!, $after: String) {
        project(id: $id) {
          issues(first: 100, after: $after) {
            nodes { id estimate priority state { type } inverseRelations(first: 50) { nodes { type } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`, { id: projectId, after });
    issues.push(...data.project.issues.nodes);
    after = data.project.issues.pageInfo.hasNextPage ? data.project.issues.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

async function projectUpdates(apiKey: string, projectId: string) {
  const updates: UpdateNode[] = [];
  let after: string | null = null;
  do {
    const data: { project: { projectUpdates: { nodes: UpdateNode[]; pageInfo: PageInfo } } } = await graphql(apiKey, `
      query HealthProjectUpdates($id: String!, $after: String) {
        project(id: $id) { projectUpdates(first: 250, after: $after) { nodes { id health body createdAt updatedAt } pageInfo { hasNextPage endCursor } } }
      }`, { id: projectId, after });
    updates.push(...data.project.projectUpdates.nodes);
    after = data.project.projectUpdates.pageInfo.hasNextPage ? data.project.projectUpdates.pageInfo.endCursor : null;
  } while (after);
  return updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function fetchLinearHierarchy(options: { apiKey: string; rootTeamName: string; freshnessDays: number; now?: Date }) {
  const now = options.now ?? new Date();
  const all = await allTeams(options.apiKey);
  const hierarchy = resolveHierarchy(all, options.rootTeamName);
  const projectIdGroups = await Promise.all(hierarchy.map((team) => projectIdsForTeam(options.apiKey, team.id)));
  const projectIds = [...new Set(projectIdGroups.flat())];
  const projects: LinearProject[] = [];

  for (const projectId of projectIds) {
    const [metadata, issues, updates] = await Promise.all([
      projectMetadata(options.apiKey, projectId), projectIssues(options.apiKey, projectId), projectUpdates(options.apiKey, projectId),
    ]);
    const metricIssues = issues.map((issue) => ({
      stateType: issue.state.type, estimate: issue.estimate, priority: issue.priority,
      blocked: issue.inverseRelations.nodes.some((relation) => relation.type === "blocks"),
    }));
    const { completion, weightedCompletion } = calculateCompletion(metricIssues);
    const latest = updates[0] ?? null;
    const reportedHealth = latest?.health ?? null;
    const health = currentHealth(reportedHealth, latest?.createdAt ?? null, now, options.freshnessDays);
    const openIssues = metricIssues.filter((issue) => !["completed", "canceled"].includes(issue.stateType));
    const overdueMilestoneCount = metadata.projectMilestones.nodes.filter((milestone) =>
      Boolean(milestone.targetDate && milestone.targetDate < now.toISOString().slice(0, 10) && milestone.progress < 1),
    ).length;
    const initiativeRecords = metadata.initiatives.nodes;
    projects.push({
      id: metadata.id, name: metadata.name, url: metadata.url, status: metadata.status?.name ?? "No project status",
      statusType: metadata.status?.type ?? "unknown", lead: metadata.lead?.name ?? null,
      teams: metadata.teams.nodes.map((team) => team.displayName || team.name), teamIds: metadata.teams.nodes.map((team) => team.id),
      initiatives: initiativeRecords.map((initiative) => initiative.name), initiativeRecords, health, reportedHealth,
      completion, weightedCompletion, delta7d: 0, targetDate: metadata.targetDate, previousTargetDate: null, targetDateChangeDays: 0,
      latestUpdateDate: latest?.createdAt ?? null, openIssueCount: openIssues.length,
      startedIssueCount: openIssues.filter((issue) => issue.stateType === "started").length,
      completedIssueCount: metricIssues.filter((issue) => issue.stateType === "completed").length,
      blockedIssueCount: openIssues.filter((issue) => issue.blocked).length,
      highPriorityIssueCount: openIssues.filter((issue) => issue.priority === 1 || issue.priority === 2).length,
      overdueMilestoneCount, healthDowngrade: false, stalled: false, completedInLast7Days: false, updates,
    });
  }
  return {
    teams: hierarchy.map((team) => ({ id: team.id, name: team.displayName || team.name, key: team.key, parentId: team.parent?.id ?? null })),
    projects,
  };
}
