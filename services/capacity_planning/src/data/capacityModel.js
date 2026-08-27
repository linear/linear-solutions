import { normalizeEstimate } from '../utils/estimationNormalizer';
import { isUnplannedWork, DEFAULT_CONFIG } from '../utils/calculations';

export function buildCapacityModel(rawData, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { teams, cycles, projects, issues } = rawData;

  // Build team estimation type lookup
  const teamEstimationType = {};
  for (const team of teams) {
    teamEstimationType[team.id] = team.issueEstimationType || 'linear';
  }

  // Normalize teams
  const normalizedTeams = teams.map((t) => ({
    id: t.id,
    name: t.name,
    estimationType: t.issueEstimationType,
    members: t.members.nodes.map((m) => m.id),
  }));

  // Build members map from teams
  const members = {};
  for (const team of teams) {
    for (const m of team.members.nodes) {
      if (!members[m.id]) {
        members[m.id] = {
          id: m.id,
          name: m.displayName || m.name,
          email: m.email,
          teams: [],
          teamNames: {},
          cycles: {},
          crossProjectCount: 0,
          // L5: cross-team tracking
          homeTeamId: null,
          crossTeamCommitments: {}, // { cycleId: { teamId: { name, estimate } } }
        };
      }
      if (!members[m.id].teams.includes(team.id)) {
        members[m.id].teams.push(team.id);
        members[m.id].teamNames[team.id] = team.name;
      }
    }
  }

  // Determine home team for each member (team with most members or first listed)
  for (const member of Object.values(members)) {
    member.homeTeamId = member.teams[0] || null;
  }

  // Normalize cycles
  const normalizedCycles = cycles.map((c) => ({
    id: c.id,
    name: c.name || `Cycle ${c.number}`,
    number: c.number,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    teamId: c.team.id,
    teamName: c.team.name,
    progress: c.progress,
  }));

  // Normalize projects
  const normalizedProjects = projects.map((p) => ({
    id: p.id,
    name: p.name,
    state: p.state,
    startDate: p.startDate,
    targetDate: p.targetDate,
    progress: p.progress,
  }));

  // Active cycle IDs
  const activeCycleIds = new Set(cycles.map((c) => c.id));

  // L3: Track total issues per cycle for planned% confidence
  const cycleIssueCounts = {}; // { cycleId: { total: n, assigned: n } }

  // Process issues into member capacity data
  for (const issue of issues) {
    if (!issue.cycle) continue;
    if (!activeCycleIds.has(issue.cycle.id)) continue;

    const cycleId = issue.cycle.id;
    const projectId = issue.project?.id || '__no_project__';
    const projectName = issue.project?.name || 'No Project';
    const teamId = issue.team?.id;
    const estimationType = teamEstimationType[teamId] || 'linear';
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    const estimate = hasEstimate ? normalizeEstimate(issue.estimate, estimationType) : 0;
    const labels = issue.labels?.nodes?.map((l) => l.name) || [];

    // L3: cycle issue tracking
    if (!cycleIssueCounts[cycleId]) {
      cycleIssueCounts[cycleId] = { total: 0, assigned: 0, totalEstimate: 0, estimated: 0, unestimated: 0, assigneeIds: new Set() };
    }
    cycleIssueCounts[cycleId].total++;
    if (issue.assignee) {
      cycleIssueCounts[cycleId].assigned++;
      cycleIssueCounts[cycleId].assigneeIds.add(issue.assignee.id);
    }
    cycleIssueCounts[cycleId].totalEstimate += estimate;
    if (hasEstimate) {
      cycleIssueCounts[cycleId].estimated++;
    } else {
      cycleIssueCounts[cycleId].unestimated++;
    }

    if (!issue.assignee) continue;

    const memberId = issue.assignee.id;

    // Ensure member exists
    if (!members[memberId]) {
      members[memberId] = {
        id: memberId,
        name: issue.assignee.displayName || issue.assignee.name,
        email: issue.assignee.email,
        teams: teamId ? [teamId] : [],
        teamNames: teamId ? { [teamId]: '' } : {},
        cycles: {},
        crossProjectCount: 0,
        homeTeamId: teamId || null,
        crossTeamCommitments: {},
      };
    }

    const member = members[memberId];

    // Ensure this team is tracked on the member (for cross-team visibility)
    if (teamId && !member.teams.includes(teamId)) {
      member.teams.push(teamId);
      const teamObj = normalizedTeams.find((t) => t.id === teamId);
      if (teamObj) member.teamNames[teamId] = teamObj.name;
    }

    // Initialize cycle data
    if (!member.cycles[cycleId]) {
      member.cycles[cycleId] = {
        totalEstimate: 0,
        capacity: cfg.defaultCapacityPerCycle,
        utilization: 0,
        byProject: {},
        // L6A: planned vs unplanned split
        plannedWork: 0,
        unplannedWork: 0,
        unplannedIssues: [],
        // L5: per-team load in this cycle
        byTeam: {},
        // Estimation coverage
        estimatedIssueCount: 0,
        unestimatedIssueCount: 0,
        unestimatedIssues: [],
      };
    }

    const cycleData = member.cycles[cycleId];
    cycleData.totalEstimate += estimate;

    // Track estimation coverage
    if (hasEstimate) {
      cycleData.estimatedIssueCount++;
    } else {
      cycleData.unestimatedIssueCount++;
      cycleData.unestimatedIssues.push({
        id: issue.id,
        title: issue.title,
        state: issue.state?.name,
        stateType: issue.state?.type,
        project: projectName,
      });
    }

    // L6A: unplanned work tracking
    const isUnplanned = isUnplannedWork(labels, cfg.unplannedWorkLabels);
    if (isUnplanned) {
      cycleData.unplannedWork += estimate;
      cycleData.unplannedIssues.push({
        id: issue.id,
        title: issue.title,
        estimate,
        labels,
        state: issue.state?.name,
      });
    } else {
      cycleData.plannedWork += estimate;
    }

    // L5: per-team load tracking
    if (teamId) {
      if (!cycleData.byTeam[teamId]) {
        cycleData.byTeam[teamId] = { estimate: 0, teamName: '' };
      }
      cycleData.byTeam[teamId].estimate += estimate;
      // Try to get team name
      const teamObj = normalizedTeams.find((t) => t.id === teamId);
      if (teamObj) cycleData.byTeam[teamId].teamName = teamObj.name;
    }

    // By project breakdown
    if (!cycleData.byProject[projectId]) {
      cycleData.byProject[projectId] = {
        id: projectId,
        name: projectName,
        estimate: 0,
        issues: [],
      };
    }
    cycleData.byProject[projectId].estimate += estimate;
    cycleData.byProject[projectId].issues.push({
      id: issue.id,
      title: issue.title,
      estimate,
      state: issue.state?.name,
      stateType: issue.state?.type,
      labels,
      isUnplanned,
    });
  }

  // Calculate utilization and cross-project/cross-team counts
  for (const member of Object.values(members)) {
    const allProjects = new Set();
    const allTeamsContributed = new Set();

    for (const [cycleId, cycleData] of Object.entries(member.cycles)) {
      cycleData.utilization =
        cycleData.capacity > 0
          ? Math.round((cycleData.totalEstimate / cycleData.capacity) * 100)
          : 0;
      for (const projId of Object.keys(cycleData.byProject)) {
        if (projId !== '__no_project__') allProjects.add(projId);
      }
      for (const tId of Object.keys(cycleData.byTeam)) {
        allTeamsContributed.add(tId);
      }

      // L5: build cross-team commitments
      member.crossTeamCommitments[cycleId] = {};
      for (const [tId, tData] of Object.entries(cycleData.byTeam)) {
        member.crossTeamCommitments[cycleId][tId] = {
          name: tData.teamName,
          estimate: tData.estimate,
          isHome: tId === member.homeTeamId,
        };
      }
    }
    member.crossProjectCount = allProjects.size;
    member.crossTeamCount = allTeamsContributed.size;
  }

  // L1: Build team-level capacity aggregation
  const teamCapacity = {};
  for (const team of normalizedTeams) {
    teamCapacity[team.id] = {
      teamId: team.id,
      teamName: team.name,
      memberCount: team.members.length,
      cycles: {},
    };

    for (const cycle of normalizedCycles) {
      // Only aggregate for cycles belonging to this team (or all if cross-team)
      let teamLoad = 0;
      let teamUnplanned = 0;
      let activeMemberCount = 0;
      let borrowedOutEstimate = 0;
      let borrowedInEstimate = 0;
      const sharedMembers = [];

      for (const memberId of team.members) {
        const member = members[memberId];
        if (!member) continue;

        const cycleData = member.cycles[cycle.id];
        if (!cycleData) continue;

        activeMemberCount++;

        // Total load from this member
        teamLoad += cycleData.totalEstimate;
        teamUnplanned += cycleData.unplannedWork;

        // L5: Cross-team calculations
        const homeLoad = cycleData.byTeam[team.id]?.estimate || 0;
        const otherLoad = cycleData.totalEstimate - homeLoad;
        if (otherLoad > 0) {
          borrowedOutEstimate += otherLoad;
          const otherTeams = Object.entries(cycleData.byTeam)
            .filter(([tId]) => tId !== team.id)
            .map(([, d]) => d.teamName)
            .filter(Boolean);
          if (otherTeams.length > 0) {
            sharedMembers.push({ name: member.name, teams: otherTeams, estimate: otherLoad });
          }
        }
      }

      // L5: Borrowed-in (non-members contributing to this team's work)
      for (const [memberId, member] of Object.entries(members)) {
        if (team.members.includes(memberId)) continue;
        const cycleData = member.cycles[cycle.id];
        if (!cycleData) continue;
        const inEstimate = cycleData.byTeam[team.id]?.estimate || 0;
        if (inEstimate > 0) borrowedInEstimate += inEstimate;
      }

      const rawCapacity = team.members.length * cfg.defaultCapacityPerCycle;
      const effectiveFTE = team.members.length - (borrowedOutEstimate / cfg.defaultCapacityPerCycle);

      teamCapacity[team.id].cycles[cycle.id] = {
        load: teamLoad,
        rawCapacity,
        utilization: rawCapacity > 0 ? Math.round((teamLoad / rawCapacity) * 100) : 0,
        activeMemberCount,
        unplannedWork: teamUnplanned,
        borrowedOut: borrowedOutEstimate,
        borrowedIn: borrowedInEstimate,
        effectiveFTE: Math.round(effectiveFTE * 10) / 10,
        sharedMembers,
      };
    }
  }

  // Build per-member per-project aggregation (for project view)
  const memberProjects = {};
  for (const [memberId, member] of Object.entries(members)) {
    memberProjects[memberId] = {};
    for (const [cycleId, cycleData] of Object.entries(member.cycles)) {
      for (const [projectId, projData] of Object.entries(cycleData.byProject)) {
        if (!memberProjects[memberId][projectId]) {
          memberProjects[memberId][projectId] = {
            id: projectId,
            name: projData.name,
            totalEstimate: 0,
            issues: [],
            byCycle: {},
          };
        }
        const mp = memberProjects[memberId][projectId];
        mp.totalEstimate += projData.estimate;
        mp.byCycle[cycleId] = {
          estimate: projData.estimate,
          issues: projData.issues,
        };
        mp.issues = mp.issues.concat(projData.issues);
      }
    }
  }

  // Build team-level project aggregation
  const teamProjectCapacity = {};
  for (const team of normalizedTeams) {
    teamProjectCapacity[team.id] = {};
    for (const memberId of team.members) {
      const mp = memberProjects[memberId];
      if (!mp) continue;
      for (const [projectId, projData] of Object.entries(mp)) {
        if (!teamProjectCapacity[team.id][projectId]) {
          teamProjectCapacity[team.id][projectId] = {
            id: projectId,
            name: projData.name,
            totalEstimate: 0,
            memberCount: 0,
          };
        }
        teamProjectCapacity[team.id][projectId].totalEstimate += projData.totalEstimate;
        teamProjectCapacity[team.id][projectId].memberCount++;
      }
    }
  }

  // Build per-project metrics (for project view headers & cells)
  const projectMetrics = {};
  for (const [memberId, mp] of Object.entries(memberProjects)) {
    const member = members[memberId];
    if (!member) continue;
    for (const [projectId, projData] of Object.entries(mp)) {
      if (projectId === '__no_project__') continue;
      if (!projectMetrics[projectId]) {
        projectMetrics[projectId] = {
          totalEstimate: 0,
          memberCount: 0,
          teamCount: 0,
          teams: {},
          plannedWork: 0,
          unplannedWork: 0,
          estimatedIssueCount: 0,
          unestimatedIssueCount: 0,
          totalIssueCount: 0,
          issuesByState: { completed: 0, started: 0, backlog: 0 },
          issuesByStatePts: { completed: 0, started: 0, backlog: 0 },
          _memberIds: new Set(),
          _teamIds: new Set(),
        };
      }
      const pm = projectMetrics[projectId];
      pm.totalEstimate += projData.totalEstimate;
      pm._memberIds.add(memberId);

      // Track teams
      for (const teamId of member.teams) {
        if (!pm._teamIds.has(teamId)) {
          pm._teamIds.add(teamId);
          const teamObj = normalizedTeams.find((t) => t.id === teamId);
          pm.teams[teamId] = { name: teamObj?.name || '', estimate: 0, memberCount: 0 };
        }
      }

      // Aggregate issue-level data
      for (const issue of projData.issues) {
        pm.totalIssueCount++;
        if (issue.isUnplanned) {
          pm.unplannedWork += issue.estimate;
        } else {
          pm.plannedWork += issue.estimate;
        }
        if (issue.estimate > 0) {
          pm.estimatedIssueCount++;
        } else {
          pm.unestimatedIssueCount++;
        }
        const stateType = issue.stateType;
        if (stateType === 'completed') {
          pm.issuesByState.completed++;
          pm.issuesByStatePts.completed += issue.estimate;
        } else if (stateType === 'started') {
          pm.issuesByState.started++;
          pm.issuesByStatePts.started += issue.estimate;
        } else {
          pm.issuesByState.backlog++;
          pm.issuesByStatePts.backlog += issue.estimate;
        }
      }
    }
  }
  // Finalize counts and per-team estimates
  for (const [projectId, pm] of Object.entries(projectMetrics)) {
    pm.memberCount = pm._memberIds.size;
    pm.teamCount = pm._teamIds.size;
    // Compute per-team estimates from memberProjects
    for (const [memberId] of Object.entries(memberProjects)) {
      const member = members[memberId];
      const projData = memberProjects[memberId]?.[projectId];
      if (!member || !projData) continue;
      for (const teamId of member.teams) {
        if (pm.teams[teamId]) {
          pm.teams[teamId].estimate += projData.totalEstimate;
          pm.teams[teamId].memberCount++;
          break; // count member once per primary team
        }
      }
    }
    delete pm._memberIds;
    delete pm._teamIds;

    // Compute risk signals for strategic resource planning
    const risks = [];
    // Single-person dependency (bus factor = 1)
    if (pm.memberCount === 1 && pm.totalIssueCount >= 3) {
      risks.push('single-owner');
    }
    // High unplanned ratio (>40% = scope volatility)
    if (pm.totalEstimate > 0 && pm.unplannedWork / pm.totalEstimate > 0.4) {
      risks.push('high-unplanned');
    }
    // Poor estimation coverage (>30% unestimated = unreliable plan)
    if (pm.totalIssueCount > 0 && pm.unestimatedIssueCount / pm.totalIssueCount > 0.3) {
      risks.push('low-estimation');
    }
    // Stalled progress (has started issues but nothing completed yet, with significant scope)
    if (pm.totalIssueCount >= 5 && pm.issuesByState.completed === 0 && pm.issuesByState.started > 0) {
      risks.push('no-completions');
    }
    // Heavy backlog (>70% of issues still in backlog)
    if (pm.totalIssueCount >= 5 && pm.issuesByState.backlog / pm.totalIssueCount > 0.7) {
      risks.push('heavy-backlog');
    }
    pm.risks = risks;
    pm.riskLevel = risks.length >= 3 ? 'high' : risks.length >= 1 ? 'medium' : 'low';
  }

  // L3: Attach cycle confidence data
  const cyclesWithConfidence = normalizedCycles.map((c) => {
    const stats = cycleIssueCounts[c.id] || { total: 0, assigned: 0, totalEstimate: 0, estimated: 0, unestimated: 0, assigneeIds: new Set() };
    const assigneeCount = stats.assigneeIds?.size || 0;
    return {
      ...c,
      issueStats: { ...stats, assigneeCount },
      plannedPct: stats.total > 0
        ? Math.round((stats.assigned / stats.total) * 100)
        : 0,
      estimationCoverage: stats.total > 0
        ? Math.round((stats.estimated / stats.total) * 100)
        : 0,
    };
  });

  return {
    teams: normalizedTeams,
    members,
    cycles: cyclesWithConfidence,
    projects: normalizedProjects,
    teamCapacity,
    memberProjects,
    teamProjectCapacity,
    projectMetrics,
    config: cfg,
    timestamp: rawData.timestamp,
  };
}

export function recalculateWithCapacity(model, newCapacity) {
  const updated = JSON.parse(JSON.stringify(model));
  updated.config.defaultCapacityPerCycle = newCapacity;

  for (const member of Object.values(updated.members)) {
    for (const cycleData of Object.values(member.cycles)) {
      cycleData.capacity = newCapacity;
      cycleData.utilization =
        newCapacity > 0
          ? Math.round((cycleData.totalEstimate / newCapacity) * 100)
          : 0;
    }
  }

  // Recalculate team capacity
  for (const tc of Object.values(updated.teamCapacity)) {
    for (const cd of Object.values(tc.cycles)) {
      cd.rawCapacity = tc.memberCount * newCapacity;
      cd.utilization = cd.rawCapacity > 0 ? Math.round((cd.load / cd.rawCapacity) * 100) : 0;
      cd.effectiveFTE = tc.memberCount - (cd.borrowedOut / newCapacity);
      cd.effectiveFTE = Math.round(cd.effectiveFTE * 10) / 10;
    }
  }

  return updated;
}
