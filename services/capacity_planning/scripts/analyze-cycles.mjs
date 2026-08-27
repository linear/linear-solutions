const API_URL = 'https://api.linear.app/graphql';
const API_KEY = process.env.LINEAR_API_KEY;

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
  // Get all active cycles
  const cycleData = await gql(`{
    cycles(filter: { isActive: { eq: true } }) {
      nodes { id name number startsAt endsAt progress team { id name } }
    }
  }`);
  const cycles = cycleData.cycles.nodes;

  // Get all issues with estimates (paginated)
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

  const cycleLookup = {};
  for (const c of cycles) cycleLookup[c.id] = c;

  // Which cycles have the most in-cycle assigned issues?
  const cycleStats = {};
  for (const i of allIssues) {
    if (!i.cycle || !cycleLookup[i.cycle.id]) continue;
    const cid = i.cycle.id;
    if (!cycleStats[cid]) cycleStats[cid] = { cycle: cycleLookup[cid], total: 0, assigned: 0, pts: 0, people: new Set(), projects: new Set(), labels: new Set() };
    cycleStats[cid].total++;
    if (i.assignee) {
      cycleStats[cid].assigned++;
      cycleStats[cid].pts += (i.estimate || 0);
      cycleStats[cid].people.add(i.assignee.displayName || i.assignee.name);
    }
    if (i.project) cycleStats[cid].projects.add(i.project.name);
    for (const l of (i.labels?.nodes || [])) cycleStats[cid].labels.add(l.name);
  }

  console.log('=== ALL CYCLES RANKED BY ISSUE COUNT ===');
  const sorted = Object.values(cycleStats).sort((a, b) => b.total - a.total);
  for (const s of sorted) {
    const c = s.cycle;
    console.log(`\n  ${c.team.name} > ${c.name || 'Cycle ' + c.number}`);
    console.log(`    Dates: ${c.startsAt?.slice(0, 10)} to ${c.endsAt?.slice(0, 10)} | Progress: ${Math.round((c.progress || 0) * 100)}%`);
    console.log(`    Issues: ${s.total} total, ${s.assigned} assigned, ${s.pts}pts`);
    console.log(`    People (${s.people.size}): ${[...s.people].join(', ')}`);
    console.log(`    Projects: ${[...s.projects].join(', ') || '(none)'}`);
    if (s.labels.size > 0) console.log(`    Labels: ${[...s.labels].join(', ')}`);
  }

  // Cycles with 0 issues
  const emptyCycles = cycles.filter(c => !cycleStats[c.id]);
  console.log(`\n=== EMPTY CYCLES (no issues): ${emptyCycles.length} ===`);
  for (const c of emptyCycles) {
    console.log(`  ${c.team.name} > ${c.name || 'Cycle ' + c.number} (${c.startsAt?.slice(0, 10)} to ${c.endsAt?.slice(0, 10)}, ${Math.round((c.progress || 0) * 100)}%)`);
  }

  // Top 5 individuals detail: which cycles are they in?
  const top5 = ['luke', 'jack', 'craig', 'gino', 'lauren'];
  console.log('\n=== TOP 5 INDIVIDUALS - CYCLE BREAKDOWN ===');
  for (const name of top5) {
    const issues = allIssues.filter(i => {
      const n = (i.assignee?.displayName || i.assignee?.name || '').toLowerCase();
      return n === name;
    });
    const inCycle = issues.filter(i => i.cycle && cycleLookup[i.cycle.id]);
    console.log(`\n  ${name}: ${issues.length} total issues, ${inCycle.length} in active cycles`);

    // Group by cycle
    const byCycle = {};
    for (const i of inCycle) {
      const c = cycleLookup[i.cycle.id];
      const key = `${c.team.name} > ${c.name || 'Cycle ' + c.number}`;
      if (!byCycle[key]) byCycle[key] = { issues: [], pts: 0 };
      byCycle[key].issues.push(i);
      byCycle[key].pts += (i.estimate || 0);
    }
    for (const [key, d] of Object.entries(byCycle)) {
      console.log(`    ${key}: ${d.issues.length} issues, ${d.pts}pts`);
      for (const i of d.issues) {
        const labels = i.labels?.nodes?.map(l => l.name).join(', ') || '';
        console.log(`      - [${i.estimate}pts] ${i.title} (${i.state.name}) ${labels ? '| ' + labels : ''}`);
      }
    }
  }

  // Top 3 projects
  console.log('\n=== TOP 3 PROJECTS - DETAIL ===');
  const projectIssues = {};
  for (const i of allIssues.filter(ii => ii.cycle && cycleLookup[ii.cycle.id] && ii.project)) {
    const p = i.project.name;
    if (!projectIssues[p]) projectIssues[p] = [];
    projectIssues[p].push(i);
  }
  const topProjects = Object.entries(projectIssues)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  for (const [name, issues] of topProjects) {
    const pts = issues.reduce((s, i) => s + (i.estimate || 0), 0);
    const teams = [...new Set(issues.map(i => i.team?.name).filter(Boolean))];
    const people = [...new Set(issues.filter(i => i.assignee).map(i => i.assignee.displayName || i.assignee.name))];
    console.log(`\n  ${name}: ${issues.length} issues, ${pts}pts`);
    console.log(`    Teams: ${teams.join(', ')}`);
    console.log(`    People: ${people.join(', ') || 'none assigned'}`);
    for (const i of issues) {
      const assignee = i.assignee ? (i.assignee.displayName || i.assignee.name) : 'Unassigned';
      const labels = i.labels?.nodes?.map(l => l.name).join(', ') || '';
      console.log(`    - [${i.estimate}pts] ${i.title} → ${assignee} (${i.state.name}) ${labels ? '| ' + labels : ''}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
