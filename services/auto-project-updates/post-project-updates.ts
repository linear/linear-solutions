#!/usr/bin/env npx tsx
/**
 * Post project updates to Linear based on recent issue activity.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_… npx tsx post-project-updates.ts [--dry-run] [--project <id-or-name>]
 *
 * Without --project, posts updates for all active projects.
 * Schedule with cron for weekly automated updates.
 */

const API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error("Set LINEAR_API_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectFlag = args.indexOf("--project");
const projectFilter = projectFlag !== -1 ? args[projectFlag + 1] : null;

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: API_KEY! },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
  return json.data!;
}

type Project = { id: string; name: string };
type Issue = { title: string; completedAt: string | null; state: { type: string } };
type ProjectUpdate = { health: "onTrack" | "atRisk" | "offTrack" };

async function getProjects(): Promise<Project[]> {
  const data = await gql<{ projects: { nodes: Project[] } }>(`
    query {
      projects(
        filter: { status: { type: { in: ["planned", "started", "paused", "backlog"] } } }
        first: 100
      ) {
        nodes { id name }
      }
    }
  `);
  return data.projects.nodes;
}

async function getIssues(projectId: string): Promise<Issue[]> {
  const data = await gql<{ project: { issues: { nodes: Issue[] } } }>(`
    query($id: String!) {
      project(id: $id) {
        issues(first: 250) {
          nodes { title completedAt state { type } }
        }
      }
    }
  `, { id: projectId });
  return data.project.issues.nodes;
}

async function getLastHealth(projectId: string): Promise<"onTrack" | "atRisk" | "offTrack"> {
  const data = await gql<{ project: { projectUpdates: { nodes: ProjectUpdate[] } } }>(`
    query($id: String!) {
      project(id: $id) {
        projectUpdates(first: 1, orderBy: createdAt) {
          nodes { health }
        }
      }
    }
  `, { id: projectId });
  return data.project.projectUpdates.nodes[0]?.health ?? "onTrack";
}

function composeBody(projectName: string, issues: Issue[]): string {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const recentlyCompleted = issues.filter(
    i => i.completedAt && i.completedAt >= sevenDaysAgo,
  );
  const inProgress = issues.filter(i => i.state.type === "started");
  const unstarted = issues.filter(
    i => i.state.type === "unstarted" || i.state.type === "backlog",
  );

  const lines: string[] = [];

  if (recentlyCompleted.length > 0) {
    const names = recentlyCompleted.slice(0, 5).map(i => i.title);
    lines.push(
      `**Completed this week (${recentlyCompleted.length}):** ${names.join(", ")}` +
        (recentlyCompleted.length > 5 ? `, and ${recentlyCompleted.length - 5} more` : ""),
    );
  } else {
    lines.push("No issues completed this week.");
  }

  if (inProgress.length > 0) {
    const names = inProgress.slice(0, 5).map(i => i.title);
    lines.push(
      `**In progress (${inProgress.length}):** ${names.join(", ")}` +
        (inProgress.length > 5 ? `, and ${inProgress.length - 5} more` : ""),
    );
  }

  lines.push(`**Remaining:** ${unstarted.length} issue${unstarted.length !== 1 ? "s" : ""} in backlog/todo.`);

  return lines.join("\n\n");
}

async function postUpdate(
  projectId: string,
  body: string,
  health: "onTrack" | "atRisk" | "offTrack",
): Promise<boolean> {
  const data = await gql<{ projectUpdateCreate: { success: boolean } }>(`
    mutation($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) { success }
    }
  `, { input: { projectId, body, health } });
  return data.projectUpdateCreate.success;
}

async function main() {
  let projects = await getProjects();

  if (projectFilter) {
    const match = projects.find(
      p => p.id === projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()),
    );
    if (!match) {
      console.error(`No project matching "${projectFilter}"`);
      process.exit(1);
    }
    projects = [match];
  }

  console.log(`Posting updates for ${projects.length} project${projects.length !== 1 ? "s" : ""} (dry-run: ${dryRun})\n`);

  for (const project of projects) {
    const [issues, health] = await Promise.all([
      getIssues(project.id),
      getLastHealth(project.id),
    ]);
    const body = composeBody(project.name, issues);

    console.log(`--- ${project.name} (health: ${health}) ---`);
    console.log(body);
    console.log();

    if (!dryRun) {
      const ok = await postUpdate(project.id, body, health);
      console.log(ok ? "  Posted" : "  Failed");
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
