import { getEffectiveCapacity, getProjectCycleStatus } from '../utils/calculations';
import { DEFAULT_REPORT_CONFIG } from './reportConfig';

/**
 * Generates a structured report from the capacity model.
 * Shared by CSV exporter and Google Sheets exporter.
 */
export function generateReport(model, config = {}) {
  const cfg = { ...DEFAULT_REPORT_CONFIG, ...config };
  const thresholds = cfg.alertThresholds;
  const alerts = [];

  // --- Filter cycles to those with issues ---
  let filteredCycles = model.cycles.filter(
    (c) => c.issueStats && c.issueStats.total > 0
  );
  if (cfg.selectedTeams.length > 0) {
    filteredCycles = filteredCycles.filter((c) =>
      cfg.selectedTeams.includes(c.teamId)
    );
  }
  filteredCycles.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  // --- Filter teams ---
  let filteredTeams =
    cfg.selectedTeams.length > 0
      ? model.teams.filter((t) => cfg.selectedTeams.includes(t.id))
      : model.teams;

  // --- Filter members ---
  const getFilteredMembers = (teamMemberIds) => {
    let memberIds = teamMemberIds;
    if (cfg.selectedPersons.length > 0) {
      memberIds = memberIds.filter((id) => cfg.selectedPersons.includes(id));
    }
    if (cfg.selectedProjects.length > 0) {
      memberIds = memberIds.filter((id) => {
        const mp = model.memberProjects[id];
        return mp && cfg.selectedProjects.some((pid) => mp[pid]);
      });
    }
    return memberIds.map((id) => model.members[id]).filter(Boolean);
  };

  // --- 1. Team Overview ---
  const teamOverview = filteredTeams.map((team) => {
    const tc = model.teamCapacity[team.id];
    const members = getFilteredMembers(team.members);
    const teamAlerts = [];

    // Aggregate across filtered cycles
    let totalLoad = 0;
    let totalCapacity = 0;
    let totalUnplanned = 0;
    let totalBorrowedOut = 0;
    let totalBorrowedIn = 0;
    let cycleCount = 0;

    for (const cycle of filteredCycles) {
      const cd = tc?.cycles[cycle.id];
      if (!cd || cd.load === 0) continue;
      cycleCount++;
      totalLoad += cd.load;
      let effectiveCap = cd.rawCapacity;
      if (cfg.bufferEnabled) {
        effectiveCap = Math.round(effectiveCap * (1 - cfg.bufferPercent / 100));
      }
      totalCapacity += effectiveCap;
      totalUnplanned += cd.unplannedWork;
      totalBorrowedOut += cd.borrowedOut;
      totalBorrowedIn += cd.borrowedIn;
    }

    const avgUtilization =
      totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 100) : 0;
    const unplannedPct =
      totalLoad > 0 ? Math.round((totalUnplanned / totalLoad) * 100) : 0;

    if (avgUtilization >= thresholds.utilizationCritical) {
      const alert = {
        type: 'over_capacity',
        entity: team.name,
        entityType: 'team',
        value: avgUtilization,
        threshold: thresholds.utilizationCritical,
      };
      teamAlerts.push(alert);
      alerts.push(alert);
    }

    if (unplannedPct > thresholds.unplannedWorkMax) {
      const alert = {
        type: 'high_unplanned',
        entity: team.name,
        entityType: 'team',
        value: unplannedPct,
        threshold: thresholds.unplannedWorkMax,
      };
      teamAlerts.push(alert);
      alerts.push(alert);
    }

    return {
      teamName: team.name,
      teamId: team.id,
      memberCount: members.length,
      activeCycles: cycleCount,
      totalLoad,
      totalCapacity,
      avgUtilization,
      unplannedPct,
      borrowedOut: totalBorrowedOut,
      borrowedIn: totalBorrowedIn,
      alerts: teamAlerts,
    };
  });

  // --- 2. Individual Load ---
  const individualLoad = [];
  for (const team of filteredTeams) {
    const members = getFilteredMembers(team.members);
    for (const member of members) {
      // Skip if already added (member on multiple teams)
      if (individualLoad.some((m) => m.memberId === member.id)) continue;

      const cycleBreakdowns = [];
      let peakUtilization = 0;
      const memberAlerts = [];

      for (const cycle of filteredCycles) {
        const cd = member.cycles[cycle.id];
        if (!cd) continue;

        const avail = cfg.availability?.[member.id]?.[cycle.id] ?? 1.0;
        const effectiveCap = getEffectiveCapacity(cd.capacity, {
          bufferEnabled: cfg.bufferEnabled,
          bufferPercent: cfg.bufferPercent,
          availability: avail,
        });
        const utilization =
          effectiveCap > 0
            ? Math.round((cd.totalEstimate / effectiveCap) * 100)
            : 0;
        if (utilization > peakUtilization) peakUtilization = utilization;

        const totalIssues = cd.estimatedIssueCount + cd.unestimatedIssueCount;
        const estCoverage =
          totalIssues > 0
            ? Math.round((cd.estimatedIssueCount / totalIssues) * 100)
            : 100;

        // Collect per-project issues for this person in this cycle
        const issues = [];
        for (const projData of Object.values(cd.byProject)) {
          for (const issue of projData.issues) {
            issues.push({
              title: issue.title,
              estimate: issue.estimate,
              state: issue.state,
              stateType: issue.stateType,
              project: projData.name,
              isUnplanned: issue.isUnplanned,
              labels: issue.labels,
            });
          }
        }

        const memberPtoDays = cfg.ptoDays?.[member.id]?.[cycle.id];

        cycleBreakdowns.push({
          cycleName: cycle.name,
          teamName: cycle.teamName,
          cycleId: cycle.id,
          load: cd.totalEstimate,
          capacity: effectiveCap,
          baseCapacity: cd.capacity,
          availability: avail,
          ptoDays: memberPtoDays ?? null,
          utilization,
          plannedWork: cd.plannedWork,
          unplannedWork: cd.unplannedWork,
          estimatedCount: cd.estimatedIssueCount,
          unestimatedCount: cd.unestimatedIssueCount,
          estimationCoverage: estCoverage,
          issues,
        });
      }

      if (peakUtilization >= thresholds.utilizationCritical) {
        const alert = {
          type: 'over_capacity',
          entity: member.name,
          entityType: 'member',
          value: peakUtilization,
          threshold: thresholds.utilizationCritical,
        };
        memberAlerts.push(alert);
        alerts.push(alert);
      } else if (peakUtilization >= thresholds.utilizationWarning) {
        const alert = {
          type: 'near_capacity',
          entity: member.name,
          entityType: 'member',
          value: peakUtilization,
          threshold: thresholds.utilizationWarning,
        };
        memberAlerts.push(alert);
        alerts.push(alert);
      }

      if (cycleBreakdowns.length > 0) {
        individualLoad.push({
          memberId: member.id,
          name: member.name,
          teams: member.teams
            .map((tid) => member.teamNames[tid])
            .filter(Boolean),
          cycleBreakdowns,
          peakUtilization,
          crossTeamCount: member.crossTeamCount || 0,
          crossProjectCount: member.crossProjectCount || 0,
          alerts: memberAlerts,
        });
      }
    }
  }

  // --- 3. Project Allocation ---
  const projectMap = {};
  for (const member of individualLoad) {
    const mp = model.memberProjects[member.memberId];
    if (!mp) continue;
    for (const [projectId, projData] of Object.entries(mp)) {
      if (projectId === '__no_project__') continue;
      if (
        cfg.selectedProjects.length > 0 &&
        !cfg.selectedProjects.includes(projectId)
      )
        continue;

      if (!projectMap[projectId]) {
        const fullProject = model.projects.find((p) => p.id === projectId);
        projectMap[projectId] = {
          projectName: projData.name,
          projectId,
          startDate: fullProject?.startDate || null,
          targetDate: fullProject?.targetDate || null,
          progress: fullProject?.progress != null
            ? Math.round(fullProject.progress * 100)
            : null,
          totalEstimate: 0,
          members: [],
        };
      }
      projectMap[projectId].totalEstimate += projData.totalEstimate;
      projectMap[projectId].members.push({
        name: member.name,
        estimate: projData.totalEstimate,
      });
    }
  }
  // Enrich projects with metrics, risk, and cycle status
  const now = new Date();
  for (const [projectId, proj] of Object.entries(projectMap)) {
    const pm = model.projectMetrics?.[projectId];
    if (pm) {
      proj.plannedWork = pm.plannedWork;
      proj.unplannedWork = pm.unplannedWork;
      proj.unplannedPct = pm.totalEstimate > 0
        ? Math.round((pm.unplannedWork / pm.totalEstimate) * 100) : 0;
      proj.estimatedIssueCount = pm.estimatedIssueCount;
      proj.unestimatedIssueCount = pm.unestimatedIssueCount;
      proj.totalIssueCount = pm.totalIssueCount;
      proj.estimationCoverage = pm.totalIssueCount > 0
        ? Math.round((pm.estimatedIssueCount / pm.totalIssueCount) * 100) : 100;
      proj.issuesByState = { ...pm.issuesByState };
      proj.issuesByStatePts = { ...pm.issuesByStatePts };
      proj.riskLevel = pm.riskLevel;
      proj.risks = pm.risks || [];
      proj.teamBreakdown = Object.values(pm.teams).map((t) => ({
        name: t.name,
        estimate: t.estimate,
        memberCount: t.memberCount,
      }));
    } else {
      proj.plannedWork = proj.totalEstimate;
      proj.unplannedWork = 0;
      proj.unplannedPct = 0;
      proj.estimatedIssueCount = 0;
      proj.unestimatedIssueCount = 0;
      proj.totalIssueCount = 0;
      proj.estimationCoverage = 100;
      proj.issuesByState = { completed: 0, started: 0, backlog: 0 };
      proj.issuesByStatePts = { completed: 0, started: 0, backlog: 0 };
      proj.riskLevel = 'low';
      proj.risks = [];
      proj.teamBreakdown = [];
    }

    // Cycle status — pass full project for timeline fallback
    const fullProject = model.projects.find((p) => p.id === projectId);
    const cs = getProjectCycleStatus(projectId, model.memberProjects, model.cycles, now, fullProject);
    proj.cycleStatus = cs.cycleStatus;
    proj.activeCycleNames = cs.activeCycleNames;
    proj.cycleCount = cs.cycleCount;

    // Project-level alerts
    if (proj.riskLevel === 'high') {
      alerts.push({
        type: 'project_at_risk',
        entity: proj.projectName,
        entityType: 'project',
        value: proj.risks.length,
        threshold: 3,
        detail: proj.risks.join(', '),
      });
    } else if (proj.riskLevel === 'medium') {
      alerts.push({
        type: 'project_watch',
        entity: proj.projectName,
        entityType: 'project',
        value: proj.risks.length,
        threshold: 1,
        detail: proj.risks.join(', '),
      });
    }

    // Behind schedule: active project where timeline % > completion % + 20
    if (proj.cycleStatus === 'active' && proj.startDate && proj.targetDate && proj.progress != null) {
      const start = new Date(proj.startDate);
      const end = new Date(proj.targetDate);
      const totalDuration = end - start;
      if (totalDuration > 0) {
        const elapsed = now - start;
        const timelinePct = Math.round((elapsed / totalDuration) * 100);
        if (timelinePct > proj.progress + 20) {
          alerts.push({
            type: 'project_behind_schedule',
            entity: proj.projectName,
            entityType: 'project',
            value: proj.progress,
            threshold: timelinePct - 20,
            detail: `${timelinePct}% of timeline elapsed, only ${proj.progress}% complete`,
          });
        }
      }
    }
  }

  const projectAllocation = Object.values(projectMap).sort(
    (a, b) => b.totalEstimate - a.totalEstimate
  );

  // --- 4. Cross-Team Commitments ---
  const crossTeamCommitments = [];
  for (const member of individualLoad) {
    if (member.crossTeamCount < 2) continue;
    const memberObj = model.members[member.memberId];
    if (!memberObj) continue;

    const commitments = [];
    for (const cycle of filteredCycles) {
      const ctc = memberObj.crossTeamCommitments[cycle.id];
      if (!ctc) continue;
      for (const [teamId, data] of Object.entries(ctc)) {
        if (data.isHome) continue;
        commitments.push({
          teamName: data.name || teamId,
          cycleName: cycle.name,
          estimate: data.estimate,
        });
      }
    }
    if (commitments.length > 0) {
      const homeTeam = memberObj.teamNames[memberObj.homeTeamId] || 'Unknown';
      crossTeamCommitments.push({
        memberName: member.name,
        homeTeam,
        commitments,
      });
    }
  }

  // --- 5. Unestimated Issues ---
  const unestimatedIssues = [];
  for (const member of individualLoad) {
    const memberObj = model.members[member.memberId];
    if (!memberObj) continue;
    for (const cycle of filteredCycles) {
      const cd = memberObj.cycles[cycle.id];
      if (!cd || cd.unestimatedIssues.length === 0) continue;
      for (const issue of cd.unestimatedIssues) {
        unestimatedIssues.push({
          memberName: member.name,
          cycleName: cycle.name,
          teamName: cycle.teamName,
          issueTitle: issue.title,
          state: issue.state || 'Unknown',
          project: issue.project || 'No Project',
        });
      }
    }
  }

  // --- 6. Estimation coverage alerts ---
  for (const cycle of filteredCycles) {
    if (
      cycle.estimationCoverage != null &&
      cycle.estimationCoverage < thresholds.estimationCoverageMin &&
      cycle.issueStats.total > 0
    ) {
      alerts.push({
        type: 'low_estimation',
        entity: `${cycle.teamName} - ${cycle.name}`,
        entityType: 'cycle',
        value: cycle.estimationCoverage,
        threshold: thresholds.estimationCoverageMin,
      });
    }
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      filters: {
        teams: cfg.selectedTeams.length > 0
          ? filteredTeams.map((t) => t.name)
          : ['All'],
        persons: cfg.selectedPersons.length > 0
          ? cfg.selectedPersons
              .map((id) => model.members[id]?.name)
              .filter(Boolean)
          : ['All'],
        projects: cfg.selectedProjects.length > 0
          ? cfg.selectedProjects
              .map(
                (id) =>
                  model.projects.find((p) => p.id === id)?.name || id
              )
          : ['All'],
      },
      config: {
        capacity: cfg.capacity,
        bufferEnabled: cfg.bufferEnabled,
        bufferPercent: cfg.bufferPercent,
      },
      alertThresholds: thresholds,
    },
    teamOverview,
    individualLoad,
    projectAllocation,
    crossTeamCommitments,
    unestimatedIssues,
    alerts,
  };
}
