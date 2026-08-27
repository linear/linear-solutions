export const DEFAULT_CONFIG = {
  defaultCapacityPerCycle: 20,
  unplannedWorkLabels: ['bug', 'ops', 'support', 'incident', 'maintenance', 'tech-debt', 'architecture-review'],
  utilizationThresholds: { green: 60, yellow: 85, orange: 100 },
  bufferPercent: 20,
};

export function getUtilizationPercent(assigned, capacity) {
  if (capacity <= 0) return 0;
  return Math.round((assigned / capacity) * 100);
}

export function getUtilizationColor(percent, thresholds = DEFAULT_CONFIG.utilizationThresholds) {
  if (percent <= thresholds.green) return 'green';
  if (percent <= thresholds.yellow) return 'yellow';
  if (percent <= thresholds.orange) return 'orange';
  return 'red';
}

export function getUtilizationColorHex(percent, thresholds) {
  const color = getUtilizationColor(percent, thresholds);
  const map = {
    green: '#15803d',
    yellow: '#a16207',
    orange: '#c2410c',
    red: '#b91c1c',
  };
  return map[color];
}

export function getUtilizationBgClass(percent, thresholds) {
  const color = getUtilizationColor(percent, thresholds);
  const map = {
    green: 'bg-green-100 border-green-300 text-green-800',
    yellow: 'bg-amber-200 border-amber-400 text-amber-800',
    orange: 'bg-orange-200 border-orange-400 text-orange-800',
    red: 'bg-red-200 border-red-400 text-red-800',
  };
  return map[color];
}

export function getUtilizationEmoji(percent, thresholds) {
  const color = getUtilizationColor(percent, thresholds);
  const map = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' };
  return map[color];
}

/**
 * Stacked effective capacity: base × availability × (1 - bufferPct)
 */
export function getEffectiveCapacity(baseCapacity, { bufferEnabled = false, bufferPercent = DEFAULT_CONFIG.bufferPercent, availability = 1.0 } = {}) {
  let effective = baseCapacity * availability;
  if (bufferEnabled) {
    effective *= (1 - bufferPercent / 100);
  }
  return Math.round(effective);
}

/**
 * Compute cycle status for a project based on which cycles its issues appear in,
 * falling back to the project's own startDate/targetDate when no cycle data exists.
 * Returns { cycleStatus, activeCycleNames, cycleCount }.
 */
export function getProjectCycleStatus(projectId, memberProjects, cycles, now = new Date(), project) {
  // Collect cycle IDs that contain issues for this project
  const cycleIds = new Set();
  for (const mp of Object.values(memberProjects)) {
    const projData = mp[projectId];
    if (!projData?.byCycle) continue;
    for (const cid of Object.keys(projData.byCycle)) cycleIds.add(cid);
  }
  const projectCycles = cycles.filter((c) => cycleIds.has(c.id));

  if (projectCycles.length === 0) {
    // Fall back to project timeline dates when no cycle-assigned issues exist
    if (project?.startDate || project?.targetDate) {
      const start = project.startDate ? new Date(project.startDate) : null;
      const end = project.targetDate ? new Date(project.targetDate) : null;
      if (start && now < start) {
        return { cycleStatus: 'upcoming', activeCycleNames: [], cycleCount: 0 };
      }
      if (start && end && now >= start && now <= end) {
        return { cycleStatus: 'active', activeCycleNames: [], cycleCount: 0 };
      }
      if (end && now > end) {
        return { cycleStatus: 'past', activeCycleNames: [], cycleCount: 0 };
      }
      // Has startDate but no targetDate and already started
      if (start && now >= start) {
        return { cycleStatus: 'active', activeCycleNames: [], cycleCount: 0 };
      }
    }
    return { cycleStatus: 'unplanned', activeCycleNames: [], cycleCount: 0 };
  }

  let hasActiveCycle = false;
  let hasUpcomingCycle = false;
  const activeCycleNames = [];
  for (const c of projectCycles) {
    const start = c.startsAt ? new Date(c.startsAt) : null;
    const end = c.endsAt ? new Date(c.endsAt) : null;
    if (start && end && now >= start && now <= end) {
      hasActiveCycle = true;
      activeCycleNames.push(c.name || `Cycle ${c.number}`);
    } else if (start && now < start) {
      hasUpcomingCycle = true;
    }
  }

  const cycleStatus = hasActiveCycle ? 'active' : hasUpcomingCycle ? 'upcoming' : 'past';
  return { cycleStatus, activeCycleNames, cycleCount: projectCycles.length };
}

/**
 * Count Mon-Fri weekdays between two ISO date strings (inclusive).
 */
export function getWorkingDays(startsAt, endsAt) {
  if (!startsAt || !endsAt) return 0;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

export function isUnplannedWork(labels, unplannedLabels = DEFAULT_CONFIG.unplannedWorkLabels) {
  return labels.some((l) =>
    unplannedLabels.some((ul) => l.toLowerCase().includes(ul.toLowerCase()))
  );
}
