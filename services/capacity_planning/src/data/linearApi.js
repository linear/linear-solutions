const API_URL = 'https://api.linear.app/graphql';

function getApiKey() {
  return import.meta.env.VITE_LINEAR_API_KEY;
}

async function gql(query, variables = {}) {
  const key = getApiKey();
  if (!key || key === 'your_key_here') {
    throw new Error('LINEAR_API_KEY not configured. Add VITE_LINEAR_API_KEY to .env');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: key,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
  return json.data;
}

async function paginateAll(queryFn) {
  let allNodes = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    const data = await queryFn(cursor);
    const connection = Object.values(data)[0];
    allNodes = allNodes.concat(connection.nodes);
    hasMore = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return allNodes;
}

/**
 * Walks a cursor-paginated connection that is not the top-level field of the
 * response, e.g. team(id) { members { ... } }.
 */
async function paginateConnection(queryFn, selectConnection) {
  let allNodes = [];
  let cursor = null;

  for (;;) {
    const data = await queryFn(cursor);
    const connection = selectConnection(data);
    allNodes = allNodes.concat(connection.nodes);
    if (!connection.pageInfo.hasNextPage) return allNodes;
    cursor = connection.pageInfo.endCursor;
  }
}

async function fetchTeamMembers(teamId) {
  return paginateConnection(
    (cursor) =>
      gql(
        `query($teamId: String!, $after: String) {
          team(id: $teamId) {
            members(first: 100, after: $after) {
              nodes { id name email displayName }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { teamId, after: cursor },
      ),
    (data) => data.team.members,
  );
}

export async function fetchTeamsWithMembers() {
  const teams = await paginateConnection(
    (cursor) =>
      gql(
        `query($after: String) {
          teams(first: 50, after: $after) {
            nodes { id name issueEstimationType }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after: cursor },
      ),
    (data) => data.teams,
  );

  // Nested connections cap at 50 regardless of `first`, so each roster must be
  // paginated on its own — otherwise large teams silently lose members and
  // every capacity denominator derived from team size is wrong.
  return Promise.all(
    teams.map(async (team) => ({
      ...team,
      members: { nodes: await fetchTeamMembers(team.id) },
    })),
  );
}

export async function fetchActiveCycles() {
  // Fetch active cycles AND recently completed cycles (past 30 days)
  // so the dashboard has a useful window of data even when cycles end
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [activeData, pastData] = await Promise.all([
    gql(`{
      cycles(filter: { isActive: { eq: true } }) {
        nodes {
          id name number startsAt endsAt
          progress
          team { id name }
        }
      }
    }`),
    gql(`{
      cycles(filter: { isPast: { eq: true }, endsAt: { gte: "${cutoff}" } }) {
        nodes {
          id name number startsAt endsAt
          progress
          team { id name }
        }
      }
    }`),
  ]);

  // Merge and deduplicate by ID
  const seen = new Set();
  const all = [];
  for (const c of [...activeData.cycles.nodes, ...pastData.cycles.nodes]) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      all.push(c);
    }
  }
  return all;
}

export async function fetchProjects() {
  return paginateConnection(
    (cursor) =>
      gql(
        `query($after: String) {
          projects(first: 100, after: $after) {
            nodes {
              id name state startDate targetDate progress
              teams { nodes { id name } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after: cursor },
      ),
    (data) => data.projects,
  );
}

export async function fetchIssuesForCapacity() {
  return paginateAll(async (cursor) => {
    const after = cursor ? `after: "${cursor}"` : '';
    return gql(`{
      issues(first: 50 ${after} filter: { cycle: { null: false } }) {
        nodes {
          id title estimate
          assignee { id name email displayName }
          project { id name }
          cycle { id startsAt endsAt }
          team { id name }
          state { name type }
          labels { nodes { name } }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`);
  });
}

export async function fetchAllData() {
  const [teams, cycles, projects, issues] = await Promise.all([
    fetchTeamsWithMembers(),
    fetchActiveCycles(),
    fetchProjects(),
    fetchIssuesForCapacity(),
  ]);
  return { teams, cycles, projects, issues, timestamp: new Date().toISOString() };
}

export async function loadSnapshot() {
  try {
    const isDemo = new URLSearchParams(window.location.search).get('demo') === 'true';
    const url = isDemo ? '/demo-snapshot.json' : '/workspace-snapshot.json';
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
