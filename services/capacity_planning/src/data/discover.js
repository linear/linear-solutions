/**
 * Linear Workspace Discovery Script
 *
 * Run with: node src/data/discover.js
 * Requires LINEAR_API_KEY environment variable
 *
 * Queries the workspace to understand its structure and saves a snapshot.
 */

const API_URL = 'https://api.linear.app/graphql';
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  console.error('ERROR: Set LINEAR_API_KEY environment variable');
  process.exit(1);
}

async function query(graphql, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: API_KEY,
    },
    body: JSON.stringify({ query: graphql, variables }),
  });
  if (!res.ok) throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function discoverTeams() {
  console.log('\n=== TEAMS & MEMBERS ===');
  const data = await query(`{
    teams {
      nodes {
        id name
        issueEstimationType
        members { nodes { id name email } }
      }
    }
  }`);
  for (const team of data.teams.nodes) {
    console.log(`\n  Team: ${team.name} (${team.id})`);
    console.log(`  Estimation: ${team.issueEstimationType}`);
    console.log(`  Members (${team.members.nodes.length}):`);
    for (const m of team.members.nodes) {
      console.log(`    - ${m.name} (${m.email})`);
    }
  }
  return data.teams.nodes;
}

async function discoverCycles() {
  console.log('\n=== ACTIVE & UPCOMING CYCLES ===');
  const data = await query(`{
    cycles(filter: { isActive: { eq: true } }) {
      nodes {
        id name number startsAt endsAt
        progress
        team { id name }
      }
    }
  }`);
  for (const c of data.cycles.nodes) {
    const name = c.name || `Cycle ${c.number}`;
    console.log(`  ${c.team.name} > ${name}: ${c.startsAt?.slice(0, 10)} – ${c.endsAt?.slice(0, 10)} (${Math.round((c.progress || 0) * 100)}% done)`);
  }
  return data.cycles.nodes;
}

async function discoverProjects() {
  console.log('\n=== ACTIVE PROJECTS ===');
  const data = await query(`{
    projects(filter: { state: { eq: "started" } }) {
      nodes {
        id name startDate targetDate progress
        teams { nodes { id name } }
      }
    }
  }`);
  for (const p of data.projects.nodes) {
    const teams = p.teams.nodes.map((t) => t.name).join(', ');
    console.log(`  ${p.name}: ${p.startDate || '?'} – ${p.targetDate || '?'} (${Math.round((p.progress || 0) * 100)}%) [${teams}]`);
  }
  return data.projects.nodes;
}

async function discoverIssues() {
  console.log('\n=== SAMPLE ISSUES WITH ESTIMATES ===');
  const data = await query(`{
    issues(first: 20, filter: { estimate: { gte: 1 } }) {
      nodes {
        id title estimate
        assignee { id name }
        project { id name }
        cycle { id startsAt endsAt }
        team { id name }
        state { name type }
        labels { nodes { name } }
      }
    }
  }`);
  for (const i of data.issues.nodes) {
    const assignee = i.assignee?.name || 'Unassigned';
    const project = i.project?.name || 'No project';
    const labels = i.labels.nodes.map((l) => l.name).join(', ');
    console.log(`  [${i.estimate}pts] ${i.title} → ${assignee} | ${project} | ${i.state.name} ${labels ? `| ${labels}` : ''}`);
  }
  return data.issues.nodes;
}

async function main() {
  console.log('🔍 Linear Workspace Discovery');
  console.log('============================');

  const teams = await discoverTeams();
  const cycles = await discoverCycles();
  const projects = await discoverProjects();
  const sampleIssues = await discoverIssues();

  const snapshot = {
    timestamp: new Date().toISOString(),
    teams,
    cycles,
    projects,
    sampleIssues,
  };

  const fs = await import('fs');
  const path = await import('path');
  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'workspace-snapshot.json');
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Snapshot saved to ${outPath}`);

  console.log('\n=== SUMMARY ===');
  console.log(`  Teams: ${teams.length}`);
  console.log(`  Members: ${new Set(teams.flatMap((t) => t.members.nodes.map((m) => m.id))).size}`);
  console.log(`  Active cycles: ${cycles.length}`);
  console.log(`  Active projects: ${projects.length}`);
  console.log(`  Estimation types: ${[...new Set(teams.map((t) => t.issueEstimationType))].join(', ')}`);
}

main().catch((err) => {
  console.error('Discovery failed:', err.message);
  process.exit(1);
});
