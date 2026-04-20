/**
 * Standalone exploration script — NOT part of the service codebase.
 *
 * Tests the Linear slaConfigurations API for a given team.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... TEAM_ID=ADM npx ts-node explore-sla-config.ts
 *
 * TEAM_ID accepts a team key (e.g. "ADM") or a UUID — the API handles both.
 * Requires no changes to src/ — run from the service root directory.
 */

const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error('Error: LINEAR_API_KEY env var is required.');
  process.exit(1);
}

const TEAM_ID = process.env.TEAM_ID;
if (!TEAM_ID) {
  console.error('Error: TEAM_ID env var is required (team key e.g. "ADM" or a UUID).');
  process.exit(1);
}

const AUTH_HEADER = API_KEY.startsWith('lin_api_') || API_KEY.startsWith('Bearer ')
  ? API_KEY
  : `Bearer ${API_KEY}`;

// ── Types matching the API response ──────────────────────────────────────────

interface SlaConfigurationRule {
  id: string;
  name: string;
  sla: number;           // milliseconds
  slaType: string | null;
  removesSla: boolean;
  conditions: Array<{
    issueFilter: {
      and: SlaConditionClause[];
    };
  }>;
}

type SlaConditionClause =
  | { team:     { id:       { in: string[] } } }
  | { priority: { in: number[] } }
  | { labels:   { and: Array<{ or: Array<{ name: { eq: string } } | { parent: { name: { eq: string } } }> }> } };

const PRIORITY_NAMES: Record<number, string> = {
  0: 'No Priority', 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low'
};

// ── GraphQL helper ────────────────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH_HEADER,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  if (json.errors) throw new Error(`GraphQL errors:\n${JSON.stringify(json.errors, null, 2)}`);
  return json.data;
}

// ── Condition parsers ─────────────────────────────────────────────────────────

function extractPriorities(clauses: SlaConditionClause[]): number[] {
  for (const clause of clauses) {
    if ('priority' in clause) return clause.priority.in;
  }
  return [];
}

function extractLabels(clauses: SlaConditionClause[]): string[] {
  const names: string[] = [];
  for (const clause of clauses) {
    if ('labels' in clause) {
      for (const andItem of clause.labels.and) {
        for (const orItem of andItem.or) {
          if ('name' in orItem) names.push(orItem.name.eq);
          else if ('parent' in orItem) names.push(`[parent] ${orItem.parent.name.eq}`);
        }
      }
    }
  }
  return names;
}

function extractTeamIds(clauses: SlaConditionClause[]): string[] {
  for (const clause of clauses) {
    if ('team' in clause) return clause.team.id.in;
  }
  return [];
}

function summariseRule(rule: SlaConfigurationRule): string {
  if (rule.removesSla) {
    return `  ⚠️  removesSla: true — this rule CLEARS the SLA`;
  }

  const hours = rule.sla / 3_600_000;
  const lines: string[] = [`  sla: ${rule.sla}ms = ${hours}h`];

  for (const condition of rule.conditions) {
    const clauses = condition.issueFilter.and;
    const priorities = extractPriorities(clauses).map(p => `${PRIORITY_NAMES[p] ?? p}(${p})`);
    const labels     = extractLabels(clauses);
    const teamIds    = extractTeamIds(clauses);

    if (teamIds.length)    lines.push(`  team UUIDs:  ${teamIds.join(', ')}`);
    if (priorities.length) lines.push(`  priorities:  ${priorities.join(', ')}`);
    if (labels.length)     lines.push(`  labels:      ${labels.join(', ')}`);
  }

  if (rule.slaType) lines.push(`  slaType:     ${rule.slaType}`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nQuerying slaConfigurations for team: ${TEAM_ID}\n`);

  const data = await gql(`
    query($teamId: String!) {
      slaConfigurations(teamId: $teamId) {
        id
        name
        sla
        slaType
        removesSla
        conditions
      }
    }
  `, { teamId: TEAM_ID });

  const rules: SlaConfigurationRule[] = data.slaConfigurations ?? [];
  console.log(`Found ${rules.length} configuration(s)\n`);

  // ── Parsed summary ──────────────────────────────────────────────────────────
  console.log('══ Parsed summary ══\n');
  for (const rule of rules) {
    console.log(`[${rule.id}] "${rule.name}"`);
    console.log(summariseRule(rule));
    console.log();
  }

  // ── Raw JSON ────────────────────────────────────────────────────────────────
  console.log('══ Raw response ══\n');
  console.log(JSON.stringify(data, null, 2));
})().catch((err: any) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
