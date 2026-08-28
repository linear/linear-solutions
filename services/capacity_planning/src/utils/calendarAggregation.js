import { getWorkingDays } from './calculations';

export const STANDARD_CYCLE_WORKDAYS = 10;

function startOfDay(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(value) {
  const date = startOfDay(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(value, days) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + days);
  return date;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function formatMonthInput(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function parseMonthInput(value) {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

export function getPeriodBounds(anchor, mode) {
  const date = new Date(anchor);
  if (mode === 'quarter') {
    const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
    return {
      start: new Date(date.getFullYear(), quarterStartMonth, 1),
      end: endOfDay(new Date(date.getFullYear(), quarterStartMonth + 3, 0)),
      label: `Q${Math.floor(quarterStartMonth / 3) + 1} ${date.getFullYear()}`,
    };
  }

  return {
    start: new Date(date.getFullYear(), date.getMonth(), 1),
    end: endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
    label: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  };
}

export function buildCalendarBuckets(anchor, mode) {
  const period = getPeriodBounds(anchor, mode);

  if (mode === 'quarter') {
    const buckets = [];
    let cursor = new Date(period.start);
    while (cursor <= period.end) {
      const start = new Date(cursor);
      const end = endOfDay(new Date(start.getFullYear(), start.getMonth() + 1, 0));
      buckets.push({
        id: formatMonthInput(start),
        label: start.toLocaleDateString('en-US', { month: 'long' }),
        shortLabel: start.toLocaleDateString('en-US', { month: 'short' }),
        start,
        end: minDate(end, period.end),
      });
      cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    }
    return buckets;
  }

  const buckets = [];
  let cursor = new Date(period.start);
  while (cursor <= period.end) {
    const start = new Date(cursor);
    const daysUntilSunday = 7 - (start.getDay() || 7);
    const end = minDate(endOfDay(addDays(start, daysUntilSunday)), period.end);
    const sameDay = start.toDateString() === end.toDateString();
    buckets.push({
      id: `${formatMonthInput(start)}-${String(start.getDate()).padStart(2, '0')}`,
      label: sameDay
        ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      shortLabel: `Week ${buckets.length + 1}`,
      start,
      end,
    });
    cursor = addDays(end, 1);
  }
  return buckets;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return startOfDay(aStart) <= endOfDay(bEnd) && endOfDay(aEnd) >= startOfDay(bStart);
}

export function getOverlapWorkingDays(aStart, aEnd, bStart, bEnd) {
  if (!rangesOverlap(aStart, aEnd, bStart, bEnd)) return 0;
  const start = maxDate(startOfDay(aStart), startOfDay(bStart));
  const end = minDate(endOfDay(aEnd), endOfDay(bEnd));
  return getWorkingDays(start, end);
}

export function getCoveredWorkingDays(cycles, bucket) {
  const covered = new Set();

  for (const cycle of cycles) {
    if (!rangesOverlap(cycle.startsAt, cycle.endsAt, bucket.start, bucket.end)) continue;
    const start = maxDate(startOfDay(cycle.startsAt), startOfDay(bucket.start));
    const end = minDate(endOfDay(cycle.endsAt), endOfDay(bucket.end));
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) {
        covered.add(`${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`);
      }
    }
  }

  return covered.size;
}

function selectedProjectLoad(cycleData, selectedProjectIds) {
  if (selectedProjectIds.length === 0) return cycleData.totalEstimate;
  return selectedProjectIds.reduce(
    (sum, projectId) => sum + (cycleData.byProject?.[projectId]?.estimate || 0),
    0,
  );
}

export function aggregateMemberBucket({
  member,
  cycles,
  bucket,
  selectedProjectIds = [],
  capacityPerCycle,
  bufferEnabled = false,
  bufferPercent = 0,
  availability = {},
  ptoDays = {},
}) {
  let load = 0;
  let issueCount = 0;
  let unestimatedIssueCount = 0;
  let unavailableDays = 0;
  const contributingCycles = [];
  const teamLoads = {};
  const projectLoads = {};

  for (const cycle of cycles) {
    const cycleData = member.cycles[cycle.id];
    if (!cycleData) continue;

    const overlapDays = getOverlapWorkingDays(
      cycle.startsAt,
      cycle.endsAt,
      bucket.start,
      bucket.end,
    );
    if (overlapDays === 0) continue;

    const cycleWorkingDays = getWorkingDays(cycle.startsAt, cycle.endsAt);
    if (cycleWorkingDays === 0) continue;
    const overlapRatio = overlapDays / cycleWorkingDays;
    const cycleLoad = selectedProjectLoad(cycleData, selectedProjectIds);
    if (selectedProjectIds.length > 0 && cycleLoad === 0) continue;

    load += cycleLoad * overlapRatio;
    issueCount +=
      (cycleData.estimatedIssueCount + cycleData.unestimatedIssueCount) * overlapRatio;
    unestimatedIssueCount += cycleData.unestimatedIssueCount * overlapRatio;

    const cyclePtoDays = ptoDays[member.id]?.[cycle.id];
    const cycleAvailability = availability[member.id]?.[cycle.id];
    const cycleUnavailable =
      cyclePtoDays != null
        ? cyclePtoDays * overlapRatio
        : cycleAvailability != null
          ? (1 - cycleAvailability) * overlapDays
          : 0;
    // Availability is person-level. Use the largest overlapping reduction so
    // PTO entered on two parallel team cycles is not counted twice.
    unavailableDays = Math.max(unavailableDays, cycleUnavailable);

    const teamEntries = Object.entries(cycleData.byTeam || {});
    for (const [teamId, teamData] of teamEntries) {
      const share =
        cycleData.totalEstimate > 0 ? teamData.estimate / cycleData.totalEstimate : 0;
      const teamLoad = cycleLoad * share * overlapRatio;
      const teamName = teamData.teamName || cycle.teamName || teamId;
      teamLoads[teamName] = (teamLoads[teamName] || 0) + teamLoad;
    }

    for (const [projectId, projectData] of Object.entries(cycleData.byProject || {})) {
      if (selectedProjectIds.length > 0 && !selectedProjectIds.includes(projectId)) continue;
      projectLoads[projectData.name] =
        (projectLoads[projectData.name] || 0) + projectData.estimate * overlapRatio;
    }

    contributingCycles.push({
      id: cycle.id,
      name: cycle.name,
      teamName: cycle.teamName,
      load: round1(cycleLoad * overlapRatio),
      overlapDays,
    });
  }

  const coveredDays = getCoveredWorkingDays(cycles, bucket);
  const availableDays = Math.max(0, coveredDays - unavailableDays);
  const dailyCapacity = capacityPerCycle / STANDARD_CYCLE_WORKDAYS;
  let effectiveCapacity = dailyCapacity * availableDays;
  if (bufferEnabled) effectiveCapacity *= 1 - bufferPercent / 100;

  const roundedLoad = round1(load);
  const roundedCapacity = round1(effectiveCapacity);
  return {
    load: roundedLoad,
    capacity: roundedCapacity,
    utilization:
      roundedCapacity > 0 ? Math.round((roundedLoad / roundedCapacity) * 100) : 0,
    ptoDays: round1(unavailableDays),
    coveredDays,
    totalBucketWorkingDays: getWorkingDays(bucket.start, bucket.end),
    issueCount: round1(issueCount),
    unestimatedIssueCount: round1(unestimatedIssueCount),
    contributingCycles,
    teamLoads: Object.fromEntries(
      Object.entries(teamLoads)
        .map(([name, value]) => [name, round1(value)])
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1]),
    ),
    projectLoads: Object.fromEntries(
      Object.entries(projectLoads)
        .map(([name, value]) => [name, round1(value)])
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1]),
    ),
  };
}
