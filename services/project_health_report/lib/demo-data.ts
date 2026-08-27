import type { DashboardData, Health, ProjectRecord, SnapshotPoint } from "./types";

const today = new Date();
const isoDay = (offset: number) => {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const isoTime = (offset: number) => {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString();
};

const rows: Array<
  [string, string, string, Health, number, number, string | null, number, number, number, number, number]
> = [
  ["Unified chart primitives", "Maya Chen", "Graphing / Core", "onTrack", 78, 8, isoDay(18), 14, 5, 2, 0, 1],
  ["Mobile tooltip fidelity", "Alex Kim", "Graphing / Mobile", "atRisk", 54, 2, isoDay(5), 19, 8, 3, 1, 2],
  ["Realtime data streaming", "Priya Shah", "Graphing / Platform", "offTrack", 42, -5, isoDay(-4), 23, 11, 4, 2, 3],
  ["Chart accessibility audit", "Jordan Lee", "Graphing", "onTrack", 91, 12, isoDay(9), 4, 2, 1, 0, 0],
  ["Canvas render pipeline", "Maya Chen", "Graphing / Core", "noUpdate", 66, 0, isoDay(25), 12, 6, 2, 0, 1],
  ["Annotations v2", "Sam Rivera", "Graphing / Product", "onTrack", 100, 9, isoDay(-2), 0, 0, 0, 0, 0],
  ["Large dataset performance", "Priya Shah", "Graphing / Platform", "atRisk", 38, 0, isoDay(31), 27, 9, 5, 0, 4],
  ["Theme token migration", "Jordan Lee", "Graphing / Product", "noUpdate", 72, 0, isoDay(12), 8, 3, 1, 0, 0],
  ["Export API", "Alex Kim", "Graphing / Core", "onTrack", 84, 6, isoDay(15), 7, 4, 1, 0, 1],
];

const projects: ProjectRecord[] = rows.map((row, index) => {
  const [name, lead, team, health, completion, delta7d, targetDate, open, started, blocked, overdue, high] = row;
  return {
    id: `demo-${index + 1}`,
    name,
    url: `https://linear.app/acme/project/${index + 1}`,
    status: completion === 100 ? "Completed" : "In Progress",
    statusType: completion === 100 ? "completed" : "started",
    lead,
    teams: [team],
    initiatives: [index % 2 ? "2026 Product Quality" : "Graphing Foundations"],
    health,
    reportedHealth: health === "noUpdate" ? "onTrack" : health,
    completion,
    weightedCompletion: Math.min(100, Math.max(0, completion + (index % 3) - 1)),
    delta7d,
    targetDate,
    previousTargetDate: index === 2 ? isoDay(-11) : targetDate,
    targetDateChangeDays: index === 2 ? 7 : 0,
    latestUpdateDate: health === "noUpdate" ? isoTime(-12 - index) : isoTime(-(index % 6)),
    openIssueCount: open,
    startedIssueCount: started,
    completedIssueCount: Math.round((open * completion) / Math.max(1, 100 - completion)),
    blockedIssueCount: blocked,
    highPriorityIssueCount: high,
    overdueMilestoneCount: overdue,
    healthDowngrade: index === 1 || index === 2,
    stalled: delta7d === 0,
    completedInLast7Days: completion === 100,
  };
});

const trends: SnapshotPoint[] = Array.from({ length: 28 }, (_, index) => {
  const progress = index / 27;
  const onTrack = 44 + Math.round(Math.sin(index / 4) * 5);
  const atRisk = 21 + Math.round(Math.cos(index / 5) * 3);
  const offTrack = 10 + Math.round(Math.sin(index / 3) * 2);
  return {
    date: isoDay(index - 27),
    averageCompletion: Math.round((48 + progress * 19 + Math.sin(index / 3) * 1.8) * 10) / 10,
    onTrack,
    atRisk,
    offTrack,
    noUpdate: 100 - onTrack - atRisk - offTrack,
    completedProjects: index % 7 === 6 ? 1 + (index % 3) : 0,
    targetDateChanges: index % 7 === 4 ? 1 + (index % 2) : 0,
  };
});

export function demoDashboard(): DashboardData {
  return {
    generatedAt: new Date().toISOString(),
    timezone: "America/Los_Angeles",
    freshnessDays: 7,
    source: "demo",
    rootTeam: "Graphing",
    teams: ["Graphing", "Graphing / Core", "Graphing / Mobile", "Graphing / Platform", "Graphing / Product"],
    statuses: ["In Progress", "Completed"],
    initiatives: ["Graphing Foundations", "2026 Product Quality"],
    leads: ["Alex Kim", "Jordan Lee", "Maya Chen", "Priya Shah", "Sam Rivera"],
    projects,
    trends,
  };
}
