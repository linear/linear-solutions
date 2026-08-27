import type { Health, ProjectRecord, SnapshotInput } from "./types";

export type MetricIssue = {
  stateType: string;
  estimate: number | null;
  priority?: number;
  blocked?: boolean;
};

export function calculateCompletion(issues: MetricIssue[]) {
  const eligible = issues.filter((issue) => issue.stateType !== "canceled");
  if (!eligible.length) return { completion: 0, weightedCompletion: null };

  const completed = eligible.filter((issue) => issue.stateType === "completed");
  const completion = roundPercent(completed.length / eligible.length);
  const estimated = eligible.filter(
    (issue): issue is MetricIssue & { estimate: number } =>
      typeof issue.estimate === "number" && issue.estimate > 0,
  );
  const estimateTotal = estimated.reduce((sum, issue) => sum + issue.estimate, 0);
  const estimateDone = estimated
    .filter((issue) => issue.stateType === "completed")
    .reduce((sum, issue) => sum + issue.estimate, 0);

  return {
    completion,
    weightedCompletion: estimateTotal
      ? roundPercent(estimateDone / estimateTotal)
      : null,
  };
}

export function currentHealth(
  reportedHealth: Exclude<Health, "noUpdate"> | null,
  latestUpdateDate: string | null,
  now: Date,
  freshnessDays: number,
): Health {
  if (!reportedHealth || !latestUpdateDate) return "noUpdate";
  const age = now.getTime() - new Date(latestUpdateDate).getTime();
  return age > freshnessDays * 86_400_000 ? "noUpdate" : reportedHealth;
}

const healthRank: Record<Health, number> = {
  onTrack: 0,
  atRisk: 1,
  offTrack: 2,
  noUpdate: -1,
};

export function isHealthDowngrade(previous: Health, current: Health) {
  if (previous === "noUpdate" || current === "noUpdate") return false;
  return healthRank[current] > healthRank[previous];
}

export function targetDateChangeDays(
  previous: string | null,
  current: string | null,
) {
  if (!previous || !current) return 0;
  return Math.round(
    (new Date(`${current}T00:00:00Z`).getTime() -
      new Date(`${previous}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

export function isTargetDateSlip(previous: string | null, current: string | null) {
  return targetDateChangeDays(previous, current) > 0;
}

export function isStalled(
  snapshots: Pick<SnapshotInput, "timestamp" | "completion">[],
  now: Date,
  days = 14,
) {
  const cutoff = now.getTime() - days * 86_400_000;
  const recent = snapshots
    .filter((snapshot) => new Date(snapshot.timestamp).getTime() >= cutoff)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return recent.length >= 2 && recent.every((point) => point.completion === recent[0].completion);
}

export function sevenDayDelta(
  current: number,
  snapshots: Pick<SnapshotInput, "timestamp" | "completion">[],
  now: Date,
) {
  const target = now.getTime() - 7 * 86_400_000;
  const prior = [...snapshots]
    .filter((snapshot) => new Date(snapshot.timestamp).getTime() <= target)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return roundOne(current - (prior?.completion ?? current));
}

export function average(values: number[]) {
  if (!values.length) return 0;
  return roundOne(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function countByHealth(projects: ProjectRecord[]) {
  return projects.reduce(
    (counts, project) => {
      counts[project.health] += 1;
      return counts;
    },
    { onTrack: 0, atRisk: 0, offTrack: 0, noUpdate: 0 },
  );
}

function roundPercent(value: number) {
  return Math.round(value * 1000) / 10;
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10;
}
