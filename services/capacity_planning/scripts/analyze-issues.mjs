const API_URL = 'https://api.linear.app/graphql';
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  console.error('Set LINEAR_API_KEY env var');
  process.exit(1);
}

async function gql(query) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  let allIssues = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const data = await gql(`{
      issues(first: 100${after}, filter: { estimate: { gte: 0 } }) {
        nodes {
          id title estimate
          assignee { id name displayName }
          project { id name }
          cycle { id }
          team { id name }
          state { name type }
          labels { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`);
    allIssues = allIssues.concat(data.issues.nodes);
    hasMore = data.issues.pageInfo.hasNextPage;
    cursor = data.issues.pageInfo.endCursor;
  }

  console.log(`Total issues with estimates: ${allIssues.length}`);

  const withCycle = allIssues.filter(i => i.cycle);
  const withAssignee = allIssues.filter(i => i.assignee);
  const withBoth = allIssues.filter(i => i.cycle && i.assignee);
  console.log(`With cycle: ${withCycle.length}`);
  console.log(`With assignee: ${withAssignee.length}`);
  console.log(`With both cycle + assignee: ${withBoth.length}`);

  // Team breakdown
  const teamIssues = {};
  for (const i of withCycle) {
    const t = i.team?.name || 'Unknown';
    if (!teamIssues[t]) teamIssues[t] = { total: 0, assigned: 0, pts: 0, assignees: new Set() };
    teamIssues[t].total++;
    if (i.assignee) {
      teamIssues[t].assigned++;
      teamIssues[t].pts += (i.estimate || 0);
      teamIssues[t].assignees.add(i.assignee.displayName || i.assignee.name);
    }
  }
  console.log('\n=== TEAMS WITH IN-CYCLE ISSUES ===');
  for (const [t, d] of Object.entries(teamIssues).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${t}: ${d.total} issues (${d.assigned} assigned, ${d.pts}pts) | People: ${[...d.assignees].join(', ') || 'none'}`);
  }

  // Individual breakdown
  const personIssues = {};
  for (const i of withBoth) {
    const name = i.assignee.displayName || i.assignee.name;
    if (!personIssues[name]) personIssues[name] = { count: 0, pts: 0, teams: new Set(), projects: new Set(), labels: new Set() };
    personIssues[name].count++;
    personIssues[name].pts += (i.estimate || 0);
    if (i.team) personIssues[name].teams.add(i.team.name);
    if (i.project) personIssues[name].projects.add(i.project.name);
    for (const l of (i.labels?.nodes || [])) personIssues[name].labels.add(l.name);
  }
  console.log('\n=== INDIVIDUALS WITH IN-CYCLE ASSIGNED ISSUES ===');
  for (const [name, d] of Object.entries(personIssues).sort((a, b) => b[1].pts - a[1].pts)) {
    console.log(`  ${name}: ${d.count} issues, ${d.pts}pts`);
    console.log(`    Teams: ${[...d.teams].join(', ')}`);
    console.log(`    Projects: ${[...d.projects].join(', ') || '(none)'}`);
    if (d.labels.size > 0) console.log(`    Labels: ${[...d.labels].join(', ')}`);
  }

  // Project breakdown for in-cycle issues
  const projectIssues = {};
  for (const i of withCycle) {
    const p = i.project?.name || '(No Project)';
    if (!projectIssues[p]) projectIssues[p] = { total: 0, assigned: 0, pts: 0, teams: new Set() };
    projectIssues[p].total++;
    if (i.assignee) { projectIssues[p].assigned++; projectIssues[p].pts += (i.estimate || 0); }
    if (i.team) projectIssues[p].teams.add(i.team.name);
  }
  console.log('\n=== PROJECTS WITH IN-CYCLE ISSUES ===');
  for (const [p, d] of Object.entries(projectIssues).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${p}: ${d.total} issues (${d.assigned} assigned, ${d.pts}pts) | Teams: ${[...d.teams].join(', ')}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
