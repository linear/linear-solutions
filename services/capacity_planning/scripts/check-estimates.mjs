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

async function paginate(buildQuery) {
  let all = [];
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const data = await gql(buildQuery(cursor));
    const conn = Object.values(data)[0];
    all = all.concat(conn.nodes);
    hasMore = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }
  return all;
}

async function main() {
  // Fetch ALL issues in active cycles (no estimate filter)
  const allIssues = await paginate((cursor) => {
    const after = cursor ? `, after: "${cursor}"` : '';
    return `{
      issues(first: 100${after}, filter: { cycle: { null: false } }) {
        nodes {
          id title estimate
          assignee { id name displayName }
          project { id name }
          cycle { id }
          team { id name }
          state { name type }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  });

  console.log(`Total issues in any cycle: ${allIssues.length}`);

  const withEstimate = allIssues.filter(i => i.estimate != null && i.estimate > 0);
  const zeroEstimate = allIssues.filter(i => i.estimate === 0);
  const nullEstimate = allIssues.filter(i => i.estimate == null);

  console.log(`  With estimate (>0): ${withEstimate.length}`);
  console.log(`  Zero estimate: ${zeroEstimate.length}`);
  console.log(`  Null/missing estimate: ${nullEstimate.length}`);
  console.log(`  Missing estimate %: ${Math.round((nullEstimate.length + zeroEstimate.length) / allIssues.length * 100)}%`);

  // Break down by team
  const byTeam = {};
  for (const i of allIssues) {
    const t = i.team?.name || 'Unknown';
    if (!byTeam[t]) byTeam[t] = { total: 0, estimated: 0, unestimated: 0, names: [] };
    byTeam[t].total++;
    if (i.estimate != null && i.estimate > 0) {
      byTeam[t].estimated++;
    } else {
      byTeam[t].unestimated++;
      byTeam[t].names.push(i.title);
    }
  }

  console.log('\n=== BY TEAM: ESTIMATED vs UNESTIMATED ===');
  for (const [t, d] of Object.entries(byTeam).sort((a, b) => b[1].total - a[1].total)) {
    const pct = d.total > 0 ? Math.round((d.unestimated / d.total) * 100) : 0;
    console.log(`  ${t}: ${d.total} total, ${d.estimated} estimated, ${d.unestimated} unestimated (${pct}% missing)`);
    if (d.unestimated > 0 && d.unestimated <= 10) {
      for (const name of d.names) {
        console.log(`    - [NO EST] ${name}`);
      }
    }
  }

  // Break down by person (assigned, in cycle)
  const byPerson = {};
  for (const i of allIssues) {
    if (!i.assignee) continue;
    const name = i.assignee.displayName || i.assignee.name;
    if (!byPerson[name]) byPerson[name] = { total: 0, estimated: 0, unestimated: 0, estimatedPts: 0, unestimatedTitles: [] };
    byPerson[name].total++;
    if (i.estimate != null && i.estimate > 0) {
      byPerson[name].estimated++;
      byPerson[name].estimatedPts += i.estimate;
    } else {
      byPerson[name].unestimated++;
      byPerson[name].unestimatedTitles.push(i.title);
    }
  }

  console.log('\n=== BY PERSON: ESTIMATED vs UNESTIMATED (in-cycle, assigned) ===');
  for (const [name, d] of Object.entries(byPerson).sort((a, b) => b[1].total - a[1].total)) {
    const pct = d.total > 0 ? Math.round((d.unestimated / d.total) * 100) : 0;
    console.log(`  ${name}: ${d.total} issues (${d.estimated} estimated = ${d.estimatedPts}pts, ${d.unestimated} unestimated, ${pct}% missing)`);
    for (const title of d.unestimatedTitles) {
      console.log(`    - [NO EST] ${title}`);
    }
  }

  // Our top 5 picks specifically
  console.log('\n=== TOP 5 DEMO PICKS — ESTIMATE CHECK ===');
  const top5 = ['luke', 'gino', 'craig', 'melissa', 'aaron'];
  for (const name of top5) {
    const issues = allIssues.filter(i => {
      const n = (i.assignee?.displayName || i.assignee?.name || '').toLowerCase();
      return n === name;
    });
    const est = issues.filter(i => i.estimate != null && i.estimate > 0);
    const unest = issues.filter(i => i.estimate == null || i.estimate === 0);
    console.log(`  ${name}: ${issues.length} in-cycle issues, ${est.length} estimated (${est.reduce((s,i) => s + i.estimate, 0)}pts), ${unest.length} MISSING estimates`);
    for (const i of unest) {
      console.log(`    - [NO EST] "${i.title}" (${i.team?.name}, ${i.state?.name})`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
