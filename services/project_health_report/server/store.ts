import { average, currentHealth, isHealthDowngrade, isStalled, sevenDayDelta, targetDateChangeDays } from "@/lib/metrics";
import type { DashboardData, Health, ProjectRecord, SnapshotPoint } from "@/lib/types";
import type { LinearProject, LinearTeam } from "./linear";

export async function ensureSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, parent_id TEXT, refreshed_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS projects_current (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, status_type TEXT NOT NULL, lead_name TEXT, reported_health TEXT, completion REAL NOT NULL, weighted_completion REAL, target_date TEXT, latest_update_date TEXT, open_issue_count INTEGER NOT NULL, started_issue_count INTEGER NOT NULL, completed_issue_count INTEGER NOT NULL, blocked_issue_count INTEGER NOT NULL, high_priority_issue_count INTEGER NOT NULL, overdue_milestone_count INTEGER NOT NULL, payload_json TEXT NOT NULL, refreshed_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS projects_current_status_idx ON projects_current(status_type)`,
    `CREATE TABLE IF NOT EXISTS project_teams (project_id TEXT NOT NULL, team_id TEXT NOT NULL, PRIMARY KEY(project_id, team_id))`,
    `CREATE TABLE IF NOT EXISTS project_initiatives (project_id TEXT NOT NULL, initiative_id TEXT NOT NULL, initiative_name TEXT NOT NULL, PRIMARY KEY(project_id, initiative_id))`,
    `CREATE TABLE IF NOT EXISTS project_updates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, health TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS project_updates_project_date_idx ON project_updates(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS project_snapshots (project_id TEXT NOT NULL, snapshot_date TEXT NOT NULL, timestamp TEXT NOT NULL, completion REAL NOT NULL, weighted_completion REAL, current_health TEXT NOT NULL, target_date TEXT, latest_update_date TEXT, open_issue_count INTEGER NOT NULL, started_issue_count INTEGER NOT NULL, completed_issue_count INTEGER NOT NULL, overdue_milestone_count INTEGER NOT NULL, blocked_issue_count INTEGER NOT NULL, PRIMARY KEY(project_id, snapshot_date))`,
    `CREATE INDEX IF NOT EXISTS project_snapshots_date_idx ON project_snapshots(snapshot_date)`,
    `CREATE TABLE IF NOT EXISTS refresh_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, project_count INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  ];
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

function localDate(timestamp: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

export async function saveRefresh(db: D1Database, teams: LinearTeam[], projects: LinearProject[], options: { snapshot: boolean; timezone: string; now?: Date }) {
  await ensureSchema(db);
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const snapshotDate = localDate(now, options.timezone);
  const statements: D1PreparedStatement[] = [];
  for (const team of teams) {
    statements.push(db.prepare(`INSERT INTO teams (id,name,key,parent_id,refreshed_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,key=excluded.key,parent_id=excluded.parent_id,refreshed_at=excluded.refreshed_at`).bind(team.id, team.name, team.key, team.parentId, timestamp));
  }
  for (const project of projects) {
    statements.push(db.prepare(`INSERT INTO projects_current (id,name,url,status,status_type,lead_name,reported_health,completion,weighted_completion,target_date,latest_update_date,open_issue_count,started_issue_count,completed_issue_count,blocked_issue_count,high_priority_issue_count,overdue_milestone_count,payload_json,refreshed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,status=excluded.status,status_type=excluded.status_type,lead_name=excluded.lead_name,reported_health=excluded.reported_health,completion=excluded.completion,weighted_completion=excluded.weighted_completion,target_date=excluded.target_date,latest_update_date=excluded.latest_update_date,open_issue_count=excluded.open_issue_count,started_issue_count=excluded.started_issue_count,completed_issue_count=excluded.completed_issue_count,blocked_issue_count=excluded.blocked_issue_count,high_priority_issue_count=excluded.high_priority_issue_count,overdue_milestone_count=excluded.overdue_milestone_count,payload_json=excluded.payload_json,refreshed_at=excluded.refreshed_at`).bind(
      project.id, project.name, project.url, project.status, project.statusType, project.lead, project.reportedHealth,
      project.completion, project.weightedCompletion, project.targetDate, project.latestUpdateDate, project.openIssueCount,
      project.startedIssueCount, project.completedIssueCount, project.blockedIssueCount, project.highPriorityIssueCount,
      project.overdueMilestoneCount, JSON.stringify({ teams: project.teams, initiatives: project.initiatives }), timestamp,
    ));
    statements.push(db.prepare(`DELETE FROM project_teams WHERE project_id=?`).bind(project.id));
    statements.push(db.prepare(`DELETE FROM project_initiatives WHERE project_id=?`).bind(project.id));
    for (const teamId of project.teamIds) statements.push(db.prepare(`INSERT OR IGNORE INTO project_teams(project_id,team_id) VALUES (?,?)`).bind(project.id, teamId));
    for (const initiative of project.initiativeRecords) statements.push(db.prepare(`INSERT OR IGNORE INTO project_initiatives(project_id,initiative_id,initiative_name) VALUES (?,?,?)`).bind(project.id, initiative.id, initiative.name));
    for (const update of project.updates) statements.push(db.prepare(`INSERT INTO project_updates(id,project_id,health,body,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET health=excluded.health,body=excluded.body,updated_at=excluded.updated_at`).bind(update.id, project.id, update.health, update.body, update.createdAt, update.updatedAt));
    if (options.snapshot) statements.push(db.prepare(`INSERT INTO project_snapshots(project_id,snapshot_date,timestamp,completion,weighted_completion,current_health,target_date,latest_update_date,open_issue_count,started_issue_count,completed_issue_count,overdue_milestone_count,blocked_issue_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,snapshot_date) DO UPDATE SET timestamp=excluded.timestamp,completion=excluded.completion,weighted_completion=excluded.weighted_completion,current_health=excluded.current_health,target_date=excluded.target_date,latest_update_date=excluded.latest_update_date,open_issue_count=excluded.open_issue_count,started_issue_count=excluded.started_issue_count,completed_issue_count=excluded.completed_issue_count,overdue_milestone_count=excluded.overdue_milestone_count,blocked_issue_count=excluded.blocked_issue_count`).bind(
      project.id, snapshotDate, timestamp, project.completion, project.weightedCompletion, project.health, project.targetDate,
      project.latestUpdateDate, project.openIssueCount, project.startedIssueCount, project.completedIssueCount,
      project.overdueMilestoneCount, project.blockedIssueCount,
    ));
  }
  for (let i = 0; i < statements.length; i += 75) await db.batch(statements.slice(i, i + 75));
}

type CurrentRow = {
  id: string; name: string; url: string; status: string; status_type: string; lead_name: string | null;
  reported_health: Exclude<Health, "noUpdate"> | null; completion: number; weighted_completion: number | null;
  target_date: string | null; latest_update_date: string | null; open_issue_count: number; started_issue_count: number;
  completed_issue_count: number; blocked_issue_count: number; high_priority_issue_count: number; overdue_milestone_count: number;
  payload_json: string; refreshed_at: string;
};
type SnapshotRow = { project_id: string; snapshot_date: string; timestamp: string; completion: number; current_health: Health; target_date: string | null; completed_issue_count: number };

export async function loadDashboard(db: D1Database, options: { rootTeam: string; timezone: string; freshnessDays: number; now?: Date }): Promise<DashboardData | null> {
  await ensureSchema(db);
  const now = options.now ?? new Date();
  const current = await db.prepare(`SELECT * FROM projects_current ORDER BY name`).all<CurrentRow>();
  if (!current.results.length) return null;
  const snapshots = await db.prepare(`SELECT project_id,snapshot_date,timestamp,completion,current_health,target_date,completed_issue_count FROM project_snapshots ORDER BY snapshot_date`).all<SnapshotRow>();
  const teams = await db.prepare(`SELECT name FROM teams ORDER BY name`).all<{ name: string }>();
  const byProject = new Map<string, SnapshotRow[]>();
  for (const snapshot of snapshots.results) byProject.set(snapshot.project_id, [...(byProject.get(snapshot.project_id) ?? []), snapshot]);
  const projects: ProjectRecord[] = current.results.map((row) => {
    const history = byProject.get(row.id) ?? [];
    const prior = [...history].filter((point) => new Date(point.timestamp).getTime() <= now.getTime() - 7 * 86_400_000).at(-1);
    const previous = history.at(-2) ?? prior ?? null;
    const payload = JSON.parse(row.payload_json) as { teams: string[]; initiatives: string[] };
    const health = currentHealth(row.reported_health, row.latest_update_date, now, options.freshnessDays);
    return {
      id: row.id, name: row.name, url: row.url, status: row.status === "Unknown" ? "No project status" : row.status, statusType: row.status_type, lead: row.lead_name,
      teams: payload.teams, initiatives: payload.initiatives, health, reportedHealth: row.reported_health,
      completion: row.completion, weightedCompletion: row.weighted_completion, delta7d: sevenDayDelta(row.completion, history, now),
      targetDate: row.target_date, previousTargetDate: previous?.target_date ?? null,
      targetDateChangeDays: targetDateChangeDays(previous?.target_date ?? null, row.target_date), latestUpdateDate: row.latest_update_date,
      openIssueCount: row.open_issue_count, startedIssueCount: row.started_issue_count, completedIssueCount: row.completed_issue_count,
      blockedIssueCount: row.blocked_issue_count, highPriorityIssueCount: row.high_priority_issue_count,
      overdueMilestoneCount: row.overdue_milestone_count, healthDowngrade: previous ? isHealthDowngrade(previous.current_health, health) : false,
      stalled: isStalled(history, now), completedInLast7Days: row.completion === 100 && (prior?.completion ?? 100) < 100,
    };
  });
  const dateGroups = new Map<string, SnapshotRow[]>();
  for (const point of snapshots.results) dateGroups.set(point.snapshot_date, [...(dateGroups.get(point.snapshot_date) ?? []), point]);
  const trends: SnapshotPoint[] = [...dateGroups.entries()].map(([date, points], index, allDates) => {
    const total = points.length || 1;
    const health = (value: Health) => Math.round((points.filter((point) => point.current_health === value).length / total) * 100);
    const priorPoints = index ? allDates[index - 1][1] : [];
    const priorCompleted = new Map(priorPoints.map((point) => [point.project_id, point.completed_issue_count]));
    return {
      date, averageCompletion: average(points.map((point) => point.completion)), onTrack: health("onTrack"),
      atRisk: health("atRisk"), offTrack: health("offTrack"), noUpdate: health("noUpdate"),
      completedProjects: points.filter((point) => point.completion === 100 && (priorCompleted.get(point.project_id) ?? 100) < 100).length,
      targetDateChanges: points.filter((point) => {
        const priorPoint = priorPoints.find((candidate) => candidate.project_id === point.project_id);
        return Boolean(priorPoint && priorPoint.target_date !== point.target_date);
      }).length,
    };
  });
  const unique = (items: (string | null)[]) => [...new Set(items.filter((item): item is string => Boolean(item)))].sort();
  return {
    generatedAt: current.results[0].refreshed_at, timezone: options.timezone, freshnessDays: options.freshnessDays,
    source: "linear", rootTeam: options.rootTeam, teams: teams.results.map((team) => team.name),
    statuses: unique(projects.map((project) => project.status)), initiatives: unique(projects.flatMap((project) => project.initiatives)),
    leads: unique(projects.map((project) => project.lead)), projects, trends,
  };
}
