export type Health = "onTrack" | "atRisk" | "offTrack" | "noUpdate";

export type ProjectRecord = {
  id: string;
  name: string;
  url: string;
  status: string;
  statusType: string;
  lead: string | null;
  teams: string[];
  initiatives: string[];
  health: Health;
  reportedHealth: Exclude<Health, "noUpdate"> | null;
  completion: number;
  weightedCompletion: number | null;
  delta7d: number;
  targetDate: string | null;
  previousTargetDate: string | null;
  targetDateChangeDays: number;
  latestUpdateDate: string | null;
  openIssueCount: number;
  startedIssueCount: number;
  completedIssueCount: number;
  blockedIssueCount: number;
  highPriorityIssueCount: number;
  overdueMilestoneCount: number;
  healthDowngrade: boolean;
  stalled: boolean;
  completedInLast7Days: boolean;
};

export type SnapshotPoint = {
  date: string;
  averageCompletion: number;
  onTrack: number;
  atRisk: number;
  offTrack: number;
  noUpdate: number;
  completedProjects: number;
  targetDateChanges: number;
};

export type DashboardData = {
  generatedAt: string;
  timezone: string;
  freshnessDays: number;
  source: "linear" | "demo";
  rootTeam: string;
  teams: string[];
  statuses: string[];
  initiatives: string[];
  leads: string[];
  projects: ProjectRecord[];
  trends: SnapshotPoint[];
};

export type SnapshotInput = {
  projectId: string;
  timestamp: string;
  completion: number;
  weightedCompletion: number | null;
  currentHealth: Health;
  targetDate: string | null;
  latestUpdateDate: string | null;
  openIssueCount: number;
  startedIssueCount: number;
  completedIssueCount: number;
  overdueMilestoneCount: number;
  blockedIssueCount: number;
};
