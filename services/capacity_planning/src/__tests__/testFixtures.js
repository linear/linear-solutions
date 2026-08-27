/**
 * Test fixtures simulating Linear API data for the capacity model.
 *
 * Scenario:
 * - 3 teams: Rider App (T1), Core Services (T2), Android (T3)
 * - 5 people:
 *   - Luke (M1): formal member of Rider App, cross-team work on Core Services
 *   - Gino (M2): formal member of Rider App only
 *   - Craig (M3): formal member of both Core Services and Android
 *   - Melissa (M4): formal member of Core Services only
 *   - Aaron (M5): formal member of Android, has unplanned bug work
 * - 3 cycles:
 *   - Cycle 31 (C1): Rider App team, active
 *   - Cycle 11 (C2): Core Services team, active
 *   - Cycle 11 (C3): Android team, active (same name, different team)
 * - 2 projects:
 *   - Support Local Payments (P1)
 *   - Mexico Launch (P2)
 */

export const TEAMS = [
  {
    id: 'T1',
    name: 'Rider App',
    issueEstimationType: 'linear',
    members: {
      nodes: [
        { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
        { id: 'M2', displayName: 'Gino', name: 'Gino', email: 'gino@test.com' },
      ],
    },
  },
  {
    id: 'T2',
    name: 'Core Services',
    issueEstimationType: 'linear',
    members: {
      nodes: [
        { id: 'M3', displayName: 'Craig', name: 'Craig', email: 'craig@test.com' },
        { id: 'M4', displayName: 'Melissa', name: 'Melissa', email: 'melissa@test.com' },
      ],
    },
  },
  {
    id: 'T3',
    name: 'Android',
    issueEstimationType: 'linear',
    members: {
      nodes: [
        { id: 'M3', displayName: 'Craig', name: 'Craig', email: 'craig@test.com' },
        { id: 'M5', displayName: 'Aaron', name: 'Aaron', email: 'aaron@test.com' },
      ],
    },
  },
];

export const CYCLES = [
  {
    id: 'C1',
    name: 'Cycle 31',
    number: 31,
    startsAt: '2026-02-16T00:00:00Z',
    endsAt: '2026-03-02T00:00:00Z',
    team: { id: 'T1', name: 'Rider App' },
    progress: 0.6,
  },
  {
    id: 'C2',
    name: 'Cycle 11',
    number: 11,
    startsAt: '2026-02-16T00:00:00Z',
    endsAt: '2026-03-02T00:00:00Z',
    team: { id: 'T2', name: 'Core Services' },
    progress: 0.3,
  },
  {
    id: 'C3',
    name: 'Cycle 11',
    number: 11,
    startsAt: '2026-02-16T00:00:00Z',
    endsAt: '2026-03-02T00:00:00Z',
    team: { id: 'T3', name: 'Android' },
    progress: 0.4,
  },
];

export const PROJECTS = [
  {
    id: 'P1',
    name: 'Support Local Payments',
    startDate: '2026-01-15',
    targetDate: '2026-04-01',
    progress: 0.45,
  },
  {
    id: 'P2',
    name: 'Mexico Launch',
    startDate: '2026-02-01',
    targetDate: '2026-05-01',
    progress: 0.2,
  },
];

export const ISSUES = [
  // --- Luke (M1) issues ---
  // Rider App Cycle 31: 15pts on Payments project (estimated)
  {
    id: 'I1',
    title: 'Payment gateway integration',
    estimate: 8,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
    project: { id: 'P1', name: 'Support Local Payments' },
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [] },
  },
  {
    id: 'I2',
    title: 'Payment error handling',
    estimate: 5,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
    project: { id: 'P1', name: 'Support Local Payments' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },
  {
    id: 'I3',
    title: 'Rider app Mexico config',
    estimate: 2,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },
  // CROSS-TEAM: Luke works on Core Services Cycle 11: 10pts
  {
    id: 'I4',
    title: 'API endpoint for payment service',
    estimate: 5,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
    project: { id: 'P1', name: 'Support Local Payments' },
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [] },
  },
  {
    id: 'I5',
    title: 'Core auth service update',
    estimate: 5,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M1', displayName: 'Luke', name: 'Luke', email: 'luke@test.com' },
    project: { id: 'P1', name: 'Support Local Payments' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },

  // --- Gino (M2) issues ---
  // Rider App Cycle 31: 12pts, 1 unestimated
  {
    id: 'I6',
    title: 'Mexico UI localization',
    estimate: 8,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M2', displayName: 'Gino', name: 'Gino', email: 'gino@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [] },
  },
  {
    id: 'I7',
    title: 'App store listing MX',
    estimate: 4,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M2', displayName: 'Gino', name: 'Gino', email: 'gino@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },
  // Unestimated issue for Gino
  {
    id: 'I8',
    title: 'Fix crash on Mexico locale',
    estimate: null,
    cycle: { id: 'C1' },
    team: { id: 'T1' },
    assignee: { id: 'M2', displayName: 'Gino', name: 'Gino', email: 'gino@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [{ name: 'bug' }] },
  },

  // --- Craig (M3) issues ---
  // Core Services Cycle 11: 7pts
  {
    id: 'I9',
    title: 'Database migration scripts',
    estimate: 4,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M3', displayName: 'Craig', name: 'Craig', email: 'craig@test.com' },
    project: { id: 'P1', name: 'Support Local Payments' },
    state: { name: 'Done', type: 'completed' },
    labels: { nodes: [] },
  },
  {
    id: 'I10',
    title: 'Config service refactor',
    estimate: 3,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M3', displayName: 'Craig', name: 'Craig', email: 'craig@test.com' },
    project: null,
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [] },
  },
  // Android Cycle 11: 5pts
  {
    id: 'I11',
    title: 'Android SDK update',
    estimate: 5,
    cycle: { id: 'C3' },
    team: { id: 'T3' },
    assignee: { id: 'M3', displayName: 'Craig', name: 'Craig', email: 'craig@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },

  // --- Melissa (M4) issues ---
  // Core Services Cycle 11: 3pts + 1 unestimated
  {
    id: 'I12',
    title: 'API docs update',
    estimate: 3,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M4', displayName: 'Melissa', name: 'Melissa', email: 'melissa@test.com' },
    project: null,
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [] },
  },
  {
    id: 'I13',
    title: 'Investigate logging issue',
    estimate: null,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: { id: 'M4', displayName: 'Melissa', name: 'Melissa', email: 'melissa@test.com' },
    project: null,
    state: { name: 'Triage', type: 'triage' },
    labels: { nodes: [{ name: 'ops' }] },
  },

  // --- Aaron (M5) issues ---
  // Android Cycle 11: 18pts (unplanned bug), over capacity
  {
    id: 'I14',
    title: 'Fix Android ANR crash',
    estimate: 8,
    cycle: { id: 'C3' },
    team: { id: 'T3' },
    assignee: { id: 'M5', displayName: 'Aaron', name: 'Aaron', email: 'aaron@test.com' },
    project: null,
    state: { name: 'In Progress', type: 'started' },
    labels: { nodes: [{ name: 'bug' }] },
  },
  {
    id: 'I15',
    title: 'Android memory leak fix',
    estimate: 5,
    cycle: { id: 'C3' },
    team: { id: 'T3' },
    assignee: { id: 'M5', displayName: 'Aaron', name: 'Aaron', email: 'aaron@test.com' },
    project: null,
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [{ name: 'bug' }] },
  },
  {
    id: 'I16',
    title: 'Mexico launch Android build',
    estimate: 5,
    cycle: { id: 'C3' },
    team: { id: 'T3' },
    assignee: { id: 'M5', displayName: 'Aaron', name: 'Aaron', email: 'aaron@test.com' },
    project: { id: 'P2', name: 'Mexico Launch' },
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
  },

  // Unassigned issue in Cycle C2 (no assignee)
  {
    id: 'I17',
    title: 'Backlog: core refactor',
    estimate: 3,
    cycle: { id: 'C2' },
    team: { id: 'T2' },
    assignee: null,
    project: null,
    state: { name: 'Backlog', type: 'backlog' },
    labels: { nodes: [] },
  },
];

export function buildRawData() {
  return {
    teams: TEAMS,
    cycles: CYCLES,
    projects: PROJECTS,
    issues: ISSUES,
    timestamp: '2026-03-01T12:00:00Z',
  };
}
