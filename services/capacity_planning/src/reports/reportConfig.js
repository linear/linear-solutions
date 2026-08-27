export const DEFAULT_ALERT_THRESHOLDS = {
  utilizationWarning: 85,
  utilizationCritical: 100,
  estimationCoverageMin: 50,
  unplannedWorkMax: 30,
};

export const REPORT_SECTIONS = [
  'teamOverview',
  'individualLoad',
  'projectAllocation',
  'crossTeamCommitments',
  'unestimatedIssues',
  'alerts',
];

export const ALERT_LABELS = {
  over_capacity: 'OVER CAPACITY',
  near_capacity: 'Near Capacity',
  high_unplanned: 'High Unplanned Work',
  low_estimation: 'Low Estimation Coverage',
  project_at_risk: 'PROJECT AT RISK',
  project_watch: 'Project Watch',
  project_behind_schedule: 'Behind Schedule',
};

export const DEFAULT_REPORT_CONFIG = {
  selectedTeams: [],
  selectedPersons: [],
  selectedProjects: [],
  capacity: 20,
  bufferEnabled: false,
  bufferPercent: 20,
  availability: {},
  alertThresholds: { ...DEFAULT_ALERT_THRESHOLDS },
};
