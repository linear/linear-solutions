import { useMemo, useState } from 'react';
import CycleHeader from './CycleHeader';
import PersonDetail from './PersonDetail';
import ProjectDetail from './ProjectDetail';
import TeamDetail from './TeamDetail';
import {
  getUtilizationBgClass,
  getUtilizationEmoji,
  getUtilizationColorHex,
  getEffectiveCapacity,
  getProjectCycleStatus,
  getWorkingDays,
} from '../utils/calculations';

export default function CapacityHeatmap({
  model,
  selectedTeams,
  selectedPersons,
  selectedProjects,
  selectedCycles: selectedCycleIds,
  viewMode,
  sortBy,
  bufferEnabled,
  availability,
  onAvailabilityChange,
  ptoDays,
  onPtoDaysChange,
}) {
  const [expandedCell, setExpandedCell] = useState(null);
  const [collapsedTeams, setCollapsedTeams] = useState({});
  const [expandedTeamId, setExpandedTeamId] = useState(null);
  // 'all' | 'relevant' | 'estimated'
  const [cycleFilterMode, setCycleFilterMode] = useState('relevant');
  // 'in-cycle' | 'upcoming' | 'risk' | 'all'
  const [projectFilterMode, setProjectFilterMode] = useState('in-cycle');

  // Reset expanded cell when view mode changes
  const handleCellClick = (memberId, columnId) => {
    if (expandedCell?.memberId === memberId && expandedCell?.columnId === columnId) {
      setExpandedCell(null);
    } else {
      setExpandedCell({ memberId, columnId });
    }
  };

  // --- CYCLES view columns (all valid cycles before member-based filtering) ---
  // When teams are selected, include cycles owned by those teams AND any cycle
  // where a member of those teams has work (cross-team visibility).
  const allCycles = useMemo(() => {
    if (!model || viewMode !== 'cycles') return [];
    let filtered = model.cycles.filter(
      (c) => c.issueStats && c.issueStats.total > 0
    );

    // Apply explicit cycle filter first
    if (selectedCycleIds.length > 0) {
      filtered = filtered.filter((c) => selectedCycleIds.includes(c.id));
    }

    if (selectedTeams.length > 0) {
      // Collect all members belonging to the selected teams (formal membership)
      const teamMemberIds = new Set();
      for (const team of model.teams) {
        if (selectedTeams.includes(team.id)) {
          team.members.forEach((mid) => teamMemberIds.add(mid));
        }
      }

      filtered = filtered.filter((c) => {
        // Always include cycles owned by selected teams
        if (selectedTeams.includes(c.teamId)) return true;
        // Also include cycles where any selected-team member has work
        for (const mid of teamMemberIds) {
          if (model.members[mid]?.cycles[c.id]) return true;
        }
        return false;
      });
    }

    return [...filtered].sort(
      (a, b) => new Date(a.startsAt) - new Date(b.startsAt)
    );
  }, [model, selectedTeams, selectedCycleIds, viewMode]);

  // --- PROJECTS view columns ---
  const projectColumns = useMemo(() => {
    if (!model || viewMode !== 'projects') return [];

    // Collect projects that have assigned cycle work
    const projectMap = {};
    for (const [memberId, mp] of Object.entries(model.memberProjects)) {
      const member = model.members[memberId];
      if (!member) continue;
      // Filter by team if selected
      if (selectedTeams.length > 0 && !member.teams.some((t) => selectedTeams.includes(t))) continue;
      // Filter by person if selected
      if (selectedPersons.length > 0 && !selectedPersons.includes(memberId)) continue;

      for (const [projectId, projData] of Object.entries(mp)) {
        if (projectId === '__no_project__') continue;
        // Filter by project if selected
        if (selectedProjects.length > 0 && !selectedProjects.includes(projectId)) continue;
        if (!projectMap[projectId]) {
          // Find full project data
          const fullProject = model.projects.find((p) => p.id === projectId);
          projectMap[projectId] = {
            id: projectId,
            name: projData.name,
            startDate: fullProject?.startDate,
            targetDate: fullProject?.targetDate,
            progress: fullProject?.progress,
            totalEstimate: 0,
            memberCount: 0,
          };
        }
        projectMap[projectId].totalEstimate += projData.totalEstimate;
        projectMap[projectId].memberCount++;
      }
    }

    // Also include projects that have no cycle work yet. Limited to in-flight
    // states unless explicitly selected — the full project list includes the
    // entire backlog, which would add hundreds of empty columns.
    const COLUMN_WORTHY_STATES = ['started', 'planned'];
    for (const p of model.projects) {
      if (projectMap[p.id]) continue;
      if (selectedProjects.length > 0 && !selectedProjects.includes(p.id)) continue;
      if (selectedProjects.length === 0 && p.state && !COLUMN_WORTHY_STATES.includes(p.state)) continue;
      projectMap[p.id] = {
        id: p.id,
        name: p.name,
        startDate: p.startDate,
        targetDate: p.targetDate,
        progress: p.progress,
        totalEstimate: 0,
        memberCount: 0,
      };
    }

    // Merge projectMetrics and compute cycle status for each column
    const now = new Date();
    const cols = Object.values(projectMap);
    for (const col of cols) {
      const pm = model.projectMetrics?.[col.id];
      if (pm) {
        col.metrics = pm;
      }

      // Classify: active, upcoming, past, or unplanned (no cycle assignment)
      const fullProject = model.projects.find((p) => p.id === col.id);
      const cs = getProjectCycleStatus(col.id, model.memberProjects, model.cycles, now, fullProject);
      col.cycleStatus = cs.cycleStatus;
      col.activeCycleNames = cs.activeCycleNames;
      col.cycleCount = cs.cycleCount;
    }

    return cols.sort((a, b) => b.totalEstimate - a.totalEstimate);
  }, [model, viewMode, selectedTeams, selectedPersons, selectedProjects]);

  // --- Final visible projects (filtered by projectFilterMode, sorted by risk) ---
  const riskOrder = { high: 0, medium: 1, low: 2 };

  const visibleProjects = useMemo(() => {
    if (viewMode !== 'projects') return projectColumns;

    let filtered = projectColumns;
    if (projectFilterMode === 'in-cycle') {
      // Only projects currently active
      filtered = projectColumns.filter((p) => p.cycleStatus === 'active');
    } else if (projectFilterMode === 'upcoming') {
      // Only projects with upcoming start dates (not yet active)
      filtered = projectColumns.filter((p) => p.cycleStatus === 'upcoming');
    } else if (projectFilterMode === 'risk') {
      // Only show projects with risk signals
      filtered = projectColumns.filter((p) => {
        const rl = p.metrics?.riskLevel;
        return rl === 'high' || rl === 'medium';
      });
    }
    // else 'all' — show everything including unplanned projects

    // Sort: active > upcoming > past > unplanned, then risk, then estimate
    const cycleStatusOrder = { active: 0, upcoming: 1, past: 2, unplanned: 3 };
    return [...filtered].sort((a, b) => {
      const aCycle = cycleStatusOrder[a.cycleStatus] ?? 3;
      const bCycle = cycleStatusOrder[b.cycleStatus] ?? 3;
      if (aCycle !== bCycle) return aCycle - bCycle;
      const aRisk = riskOrder[a.metrics?.riskLevel || 'low'];
      const bRisk = riskOrder[b.metrics?.riskLevel || 'low'];
      if (aRisk !== bRisk) return aRisk - bRisk;
      return b.totalEstimate - a.totalEstimate;
    });
  }, [projectColumns, projectFilterMode, viewMode]);

  // --- Team groups (shared across both views) ---
  const teamGroups = useMemo(() => {
    if (!model) return [];

    let teams = selectedTeams.length === 0
      ? model.teams
      : model.teams.filter((t) => selectedTeams.includes(t.id));

    if (selectedPersons.length > 0) {
      const personTeamIds = new Set();
      for (const pid of selectedPersons) {
        const person = model.members[pid];
        if (person) person.teams.forEach((t) => personTeamIds.add(t));
      }
      teams = teams.filter((t) => personTeamIds.has(t.id));
    }

    // Compute effective utilization for a member across visible cycles
    const getVisibleUtil = (member) => {
      if (viewMode === 'cycles') {
        const utils = [];
        for (const vc of allCycles) {
          const cd = member.cycles[vc.id];
          if (!cd) continue;
          const avail = availability?.[member.id]?.[vc.id] ?? 1.0;
          const eCap = getEffectiveCapacity(cd.capacity, {
            bufferEnabled, bufferPercent: model.config.bufferPercent, availability: avail,
          });
          utils.push(eCap > 0 ? Math.round((cd.totalEstimate / eCap) * 100) : 0);
        }
        return utils;
      }
      // Project view: compute utilization from average cycle load
      const cycleUtils = [];
      for (const cycleData of Object.values(member.cycles)) {
        const eCap = getEffectiveCapacity(cycleData.capacity, {
          bufferEnabled, bufferPercent: model.config.bufferPercent, availability: 1.0,
        });
        if (eCap > 0) cycleUtils.push(Math.round((cycleData.totalEstimate / eCap) * 100));
      }
      return cycleUtils;
    };

    // Compute total project points for a member across visible project columns
    const getMemberProjectPoints = (member) => {
      const mp = model.memberProjects[member.id];
      if (!mp) return 0;
      let total = 0;
      for (const col of visibleProjects) {
        if (mp[col.id]) total += mp[col.id].totalEstimate;
      }
      return total;
    };

    const groups = teams
      .map((team) => {
        // Start with formal team members
        const memberIds = new Set(team.members);

        // Also include cross-team contributors: anyone who has byTeam work
        // for this team in ANY cycle (not just cycles owned by this team)
        for (const [memberId, member] of Object.entries(model.members)) {
          if (memberIds.has(memberId)) continue;
          for (const cycleData of Object.values(member.cycles)) {
            if (cycleData.byTeam?.[team.id]?.estimate > 0) {
              memberIds.add(memberId);
              break;
            }
          }
        }

        let members = [...memberIds]
          .map((mid) => model.members[mid])
          .filter(Boolean);

        if (selectedPersons.length > 0) {
          members = members.filter((m) => selectedPersons.includes(m.id));
        }

        // Filter by project: only show members who have work on selected projects
        if (selectedProjects.length > 0) {
          members = members.filter((m) => {
            const mp = model.memberProjects[m.id];
            return mp && selectedProjects.some((pid) => mp[pid]);
          });
        }

        // In cycle view, only show members who have data in at least one visible cycle
        if (viewMode === 'cycles' && allCycles.length > 0) {
          members = members.filter((m) =>
            allCycles.some((c) => m.cycles[c.id])
          );
        }

        // In project view, filter to members who have project data
        if (viewMode === 'projects') {
          const visibleProjectIds = visibleProjects.map((p) => p.id);
          members = members.filter((m) => {
            const mp = model.memberProjects[m.id];
            if (!mp) return false;
            if (visibleProjectIds.length > 0) {
              return visibleProjectIds.some((pid) => mp[pid]);
            }
            return Object.keys(mp).some((pid) => pid !== '__no_project__');
          });
        }

        if (sortBy === 'utilization') {
          members.sort((a, b) => {
            const aMax = Math.max(0, ...getVisibleUtil(a));
            const bMax = Math.max(0, ...getVisibleUtil(b));
            return bMax - aMax;
          });
        } else if (sortBy === 'bandwidth') {
          members.sort((a, b) => {
            const aUtils = getVisibleUtil(a);
            const bUtils = getVisibleUtil(b);
            const aMin = aUtils.length > 0 ? Math.min(...aUtils) : 100;
            const bMin = bUtils.length > 0 ? Math.min(...bUtils) : 100;
            return aMin - bMin;
          });
        } else if (sortBy === 'points') {
          members.sort((a, b) => getMemberProjectPoints(b) - getMemberProjectPoints(a));
        } else {
          members.sort((a, b) => a.name.localeCompare(b.name));
        }

        return { ...team, memberData: members };
      })
      .filter((t) => t.memberData.length > 0);

    // Sort teams by utilization/bandwidth/points when those sort modes are active
    if (sortBy === 'utilization') {
      groups.sort((a, b) => {
        const aMax = Math.max(0, ...a.memberData.flatMap((m) => getVisibleUtil(m)));
        const bMax = Math.max(0, ...b.memberData.flatMap((m) => getVisibleUtil(m)));
        return bMax - aMax;
      });
    } else if (sortBy === 'bandwidth') {
      groups.sort((a, b) => {
        const aUtils = a.memberData.flatMap((m) => getVisibleUtil(m));
        const bUtils = b.memberData.flatMap((m) => getVisibleUtil(m));
        const aMin = aUtils.length > 0 ? Math.min(...aUtils) : 100;
        const bMin = bUtils.length > 0 ? Math.min(...bUtils) : 100;
        return aMin - bMin;
      });
    } else if (sortBy === 'points') {
      groups.sort((a, b) => {
        const aTotal = a.memberData.reduce((sum, m) => sum + getMemberProjectPoints(m), 0);
        const bTotal = b.memberData.reduce((sum, m) => sum + getMemberProjectPoints(m), 0);
        return bTotal - aTotal;
      });
    }

    return groups;
  }, [model, selectedTeams, selectedPersons, selectedProjects, sortBy, viewMode, allCycles, visibleProjects, bufferEnabled, availability]);

  // --- Final visible cycles (filtered by cycleFilterMode) ---
  const cycles = useMemo(() => {
    if (viewMode !== 'cycles' || cycleFilterMode === 'all') return allCycles;
    const visibleMembers = teamGroups.flatMap((t) => t.memberData);
    if (cycleFilterMode === 'relevant') {
      // Show cycles where at least one visible member has any data
      return allCycles.filter((c) =>
        visibleMembers.some((m) => m.cycles[c.id])
      );
    }
    // 'estimated' — only cycles where at least one visible member has estimated issues
    return allCycles.filter((c) =>
      visibleMembers.some((m) => m.cycles[c.id]?.estimatedIssueCount > 0)
    );
  }, [allCycles, teamGroups, cycleFilterMode, viewMode]);

  const toggleTeam = (teamId) => {
    setCollapsedTeams((prev) => ({ ...prev, [teamId]: !prev[teamId] }));
  };

  const columns = viewMode === 'cycles' ? cycles : visibleProjects;

  if (!model || columns.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--text-muted)]">
        {viewMode === 'cycles'
          ? 'No cycles found. Make sure your workspace has active or upcoming cycles.'
          : 'No projects with assigned work found.'}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white overflow-x-auto shadow-sm">
      {/* Header row */}
      <div className="flex border-b border-[var(--border)] sticky top-0 bg-white z-10">
        <div className="w-56 shrink-0 px-4 py-3 sticky left-0 bg-white z-20">
          <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Team / Person
          </div>
          {viewMode === 'cycles' && allCycles.length > 0 && (
            <div className="mt-1 flex items-center gap-0.5">
              {['estimated', 'relevant', 'all'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => setCycleFilterMode(mode)}
                  className={`text-[9px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                    cycleFilterMode === mode
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-[var(--text-muted)] hover:text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  {mode === 'estimated' ? 'Estimated' : mode === 'relevant' ? 'Relevant' : 'All'}
                </button>
              ))}
              <span className="text-[9px] text-[var(--text-muted)] ml-1">
                ({cycles.length}/{allCycles.length})
              </span>
            </div>
          )}
          {viewMode === 'projects' && projectColumns.length > 0 && (
            <div className="mt-1 flex items-center gap-0.5 flex-wrap">
              {['in-cycle', 'upcoming', 'risk', 'all'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => setProjectFilterMode(mode)}
                  className={`text-[9px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                    projectFilterMode === mode
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-[var(--text-muted)] hover:text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  {mode === 'in-cycle' ? 'In Cycle' : mode === 'upcoming' ? 'Upcoming' : mode === 'risk' ? 'At Risk' : 'All'}
                </button>
              ))}
              <span className="text-[9px] text-[var(--text-muted)] ml-1">
                ({visibleProjects.length}/{projectColumns.length})
              </span>
            </div>
          )}
        </div>
        {viewMode === 'cycles'
          ? cycles.map((c) => <CycleHeader key={c.id} cycle={c} />)
          : visibleProjects.map((p) => <ProjectHeader key={p.id} project={p} />)
        }
      </div>

      {/* Team groups */}
      {teamGroups.map((team) => (
        <div key={team.id}>
          {/* Team summary row */}
          <div className="w-full border-b border-[var(--border)] bg-white hover:bg-[var(--bg-hover)] transition-colors">
            <div className="flex">
              <div className="w-56 shrink-0 flex items-center sticky left-0 bg-inherit z-10">
                <button
                  onClick={() => toggleTeam(team.id)}
                  className="px-2 py-3 flex items-center justify-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  title={collapsedTeams[team.id] ? 'Expand members' : 'Collapse members'}
                >
                  {collapsedTeams[team.id] ? '▶' : '▼'}
                </button>
                <button
                  onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                  className="flex-1 py-3 pr-4 text-left"
                >
                  <span className="text-sm font-bold text-[var(--text-primary)]">{team.name}</span>
                  <TeamFTELabel team={team} model={model} />
                </button>
              </div>

              <button
                onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                className="flex flex-1 min-w-0"
              >
                {viewMode === 'cycles'
                  ? <TeamCycleCells team={team} cycles={cycles} model={model} bufferEnabled={bufferEnabled} availability={availability} />
                  : <TeamProjectCells team={team} projects={visibleProjects} model={model} />
                }
              </button>
            </div>
          </div>

          {/* Team detail panel — always shows full team regardless of person filter */}
          {expandedTeamId === team.id && (
            <TeamDetail
              team={team}
              members={team.members.map((mid) => model.members[mid]).filter(Boolean)}
              cycles={viewMode === 'cycles' ? cycles : model.cycles}
              model={model}
              bufferEnabled={bufferEnabled}
              availability={availability}
            />
          )}

          {/* Member rows */}
          {!collapsedTeams[team.id] &&
            team.memberData.map((member) => (
              viewMode === 'cycles' ? (
                <MemberCycleRow
                  key={member.id}
                  member={member}
                  cycles={cycles}
                  model={model}
                  expandedCell={expandedCell}
                  onCellClick={handleCellClick}
                  bufferEnabled={bufferEnabled}
                  availability={availability}
                  onAvailabilityChange={onAvailabilityChange}
                  ptoDays={ptoDays}
                  onPtoDaysChange={onPtoDaysChange}
                />
              ) : (
                <MemberProjectRow
                  key={member.id}
                  member={member}
                  projects={visibleProjects}
                  model={model}
                  expandedCell={expandedCell}
                  onCellClick={handleCellClick}
                />
              )
            ))}
        </div>
      ))}
    </div>
  );
}

function TeamFTELabel({ team, model }) {
  const teamCap = model.teamCapacity[team.id];
  if (!teamCap) return <div className="text-[10px] text-[var(--text-muted)]">{team.memberData.length} members</div>;

  // Get effective FTE from the first cycle with data
  const firstCycle = Object.values(teamCap.cycles).find((c) => c.load > 0);
  const fte = firstCycle?.effectiveFTE;
  const hasBorrowed = firstCycle && (firstCycle.borrowedOut > 0 || firstCycle.borrowedIn > 0);

  return (
    <div className="text-[10px] text-[var(--text-muted)]">
      {team.memberData.length} members
      {hasBorrowed && fte != null && fte < team.memberData.length && (
        <span className="text-amber-600 font-medium"> · {fte} FTE eff.</span>
      )}
    </div>
  );
}

// ─── Column headers ───

function ProjectHeader({ project }) {
  const formatDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  const start = formatDate(project.startDate);
  const end = formatDate(project.targetDate);
  const pm = project.metrics;

  const riskBadge = pm?.riskLevel === 'high'
    ? { bg: 'bg-red-100', text: 'text-red-700', label: 'At Risk' }
    : pm?.riskLevel === 'medium'
      ? { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Watch' }
      : null;

  const riskTooltip = pm?.risks?.length > 0
    ? pm.risks.map((r) => {
        if (r === 'single-owner') return 'Single contributor (bus factor)';
        if (r === 'high-unplanned') return '>40% unplanned work';
        if (r === 'low-estimation') return '>30% issues unestimated';
        if (r === 'no-completions') return 'No issues completed yet';
        if (r === 'heavy-backlog') return '>70% still in backlog';
        return r;
      }).join('\n')
    : undefined;

  const cycleStatus = project.cycleStatus;
  const isActive = cycleStatus === 'active';
  const isUpcoming = cycleStatus === 'upcoming';
  const isPast = cycleStatus === 'past';
  const isUnplanned = cycleStatus === 'unplanned';

  // Compute timeline progress for active projects with date range
  let timelinePct = null;
  if (isActive && project.startDate && project.targetDate) {
    const s = new Date(project.startDate).getTime();
    const e = new Date(project.targetDate).getTime();
    const now = Date.now();
    if (e > s) timelinePct = Math.min(100, Math.max(0, Math.round(((now - s) / (e - s)) * 100)));
  }

  // Completion % from issue states
  const completionPct = pm && pm.totalIssueCount > 0
    ? Math.round((pm.issuesByState.completed / pm.totalIssueCount) * 100)
    : null;

  // Delivery health: compare completion vs timeline progress
  const behindSchedule = timelinePct != null && completionPct != null && timelinePct > 30 && completionPct < timelinePct - 20;

  return (
    <div className={`text-center px-3 py-3 min-w-[170px] flex flex-col ${isPast || isUnplanned ? 'opacity-50' : ''}`}>
      {/* Row 1: Cycle status badge */}
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        {isActive && (
          <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold">
            In Cycle
          </span>
        )}
        {isUpcoming && (
          <span className="text-[9px] bg-gray-100 text-[var(--text-muted)] px-1.5 py-0.5 rounded-full font-medium">
            Upcoming
          </span>
        )}
        {isPast && (
          <span className="text-[9px] bg-gray-100 text-[var(--text-muted)] px-1.5 py-0.5 rounded-full font-medium">
            Past
          </span>
        )}
        {isUnplanned && (
          <span className="text-[9px] bg-gray-50 text-gray-400 px-1.5 py-0.5 rounded-full font-medium">
            No Cycle
          </span>
        )}
        {riskBadge && (
          <span className={`text-[9px] ${riskBadge.bg} ${riskBadge.text} px-1.5 py-0.5 rounded-full font-semibold`} title={riskTooltip}>
            {riskBadge.label}
          </span>
        )}
      </div>

      {/* Row 2: Name */}
      <div className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[160px] mx-auto" title={project.name}>
        {project.name}
      </div>

      {/* Row 3: Date range + cycle info */}
      {(start || end) && (
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {start || '?'} – {end || '?'}
          {project.cycleCount > 0 && (
            <span className="ml-1">· {project.cycleCount} {project.cycleCount === 1 ? 'cycle' : 'cycles'}</span>
          )}
        </div>
      )}
      {!start && !end && project.cycleCount > 0 && (
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {project.cycleCount} {project.cycleCount === 1 ? 'cycle' : 'cycles'}
          {project.activeCycleNames.length > 0 && (
            <span className="ml-1" title={project.activeCycleNames.join(', ')}>
              ({project.activeCycleNames[0]}{project.activeCycleNames.length > 1 ? ` +${project.activeCycleNames.length - 1}` : ''})
            </span>
          )}
        </div>
      )}

      {/* Row 4: Timeline vs completion progress (active projects) */}
      {isActive && timelinePct != null && (
        <div className="mt-1.5 w-full" title={`Timeline: ${timelinePct}% elapsed · Completed: ${completionPct}%`}>
          <div className="flex items-center justify-between text-[9px] mb-0.5">
            <span className={`font-semibold ${behindSchedule ? 'text-red-600' : 'text-[var(--text-muted)]'}`}>
              {completionPct}% done
            </span>
            <span className="text-[var(--text-muted)]">{timelinePct}% elapsed</span>
          </div>
          <div className="relative w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            {/* Completion bar */}
            <div
              className={`absolute top-0 left-0 h-full rounded-full ${behindSchedule ? 'bg-red-400' : 'bg-green-400'}`}
              style={{ width: `${completionPct}%` }}
            />
            {/* Timeline marker */}
            <div
              className="absolute top-0 h-full w-0.5 bg-gray-500"
              style={{ left: `${timelinePct}%` }}
              title={`${timelinePct}% of timeline elapsed`}
            />
          </div>
        </div>
      )}

      {/* Row 5: Scope summary */}
      {pm && (
        <div className="text-[10px] text-[var(--text-secondary)] mt-1 font-medium">
          {pm.totalEstimate} pts · {pm.totalIssueCount} issues · {pm.memberCount} {pm.memberCount === 1 ? 'person' : 'people'}
        </div>
      )}

      {/* Row 6: Issue state bar + legend (non-active, or active without timeline) */}
      {pm && pm.totalIssueCount > 0 && !(isActive && timelinePct != null) && (
        <div className="mt-1.5">
          <div
            className="w-full h-2 bg-gray-100 rounded-full overflow-hidden"
            title={`Done: ${pm.issuesByState.completed} · In progress: ${pm.issuesByState.started} · Backlog: ${pm.issuesByState.backlog}`}
          >
            <div className="flex h-full">
              {pm.issuesByState.completed > 0 && (
                <div className="h-full bg-green-400" style={{ width: `${Math.round((pm.issuesByState.completed / pm.totalIssueCount) * 100)}%` }} />
              )}
              {pm.issuesByState.started > 0 && (
                <div className="h-full bg-blue-400" style={{ width: `${Math.round((pm.issuesByState.started / pm.totalIssueCount) * 100)}%` }} />
              )}
              {pm.issuesByState.backlog > 0 && (
                <div className="h-full bg-gray-300" style={{ width: `${Math.round((pm.issuesByState.backlog / pm.totalIssueCount) * 100)}%` }} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* State legend (always show if has issues) */}
      {pm && pm.totalIssueCount > 0 && (
        <div className="flex items-center justify-center gap-2 mt-0.5 text-[9px] text-[var(--text-muted)]">
          <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-sm bg-green-400 inline-block" />{pm.issuesByState.completed}</span>
          <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-sm bg-blue-400 inline-block" />{pm.issuesByState.started}</span>
          <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-sm bg-gray-300 inline-block" />{pm.issuesByState.backlog}</span>
          {pm.unplannedWork > 0 && (
            <>
              <span className="text-[var(--text-muted)]">·</span>
              <span title={`${Math.round((pm.unplannedWork / pm.totalEstimate) * 100)}% unplanned`}>
                {Math.round((pm.unplannedWork / pm.totalEstimate) * 100)}% unplanned
              </span>
            </>
          )}
        </div>
      )}

      {/* Warnings */}
      {pm && pm.unestimatedIssueCount > 0 && (
        <div className="text-[9px] text-orange-600 font-medium mt-0.5">
          {pm.unestimatedIssueCount} unestimated
        </div>
      )}
    </div>
  );
}

// ─── Team summary cells ───

function TeamCycleCells({ team, cycles, model, bufferEnabled, availability }) {
  const teamCap = model.teamCapacity[team.id];

  return cycles.map((cycle) => {
    const cd = teamCap?.cycles[cycle.id];
    if (!cd || cd.load === 0) {
      return (
        <div key={cycle.id} className="min-w-[150px] px-2 py-3 flex items-center justify-center">
          <span className="text-xs text-[var(--text-muted)]">—</span>
        </div>
      );
    }

    let effectiveCap = cd.rawCapacity;
    if (bufferEnabled) {
      effectiveCap = Math.round(effectiveCap * (1 - model.config.bufferPercent / 100));
    }
    if (availability) {
      let ptoReduction = 0;
      for (const memberId of team.members) {
        const memberAvail = availability[memberId]?.[cycle.id];
        if (memberAvail != null && memberAvail < 1) {
          ptoReduction += model.config.defaultCapacityPerCycle * (1 - memberAvail);
        }
      }
      effectiveCap = Math.round(effectiveCap - ptoReduction);
    }
    const util = effectiveCap > 0 ? Math.round((cd.load / effectiveCap) * 100) : 0;

    return (
      <div key={cycle.id} className="min-w-[150px] px-2 py-2 flex items-center justify-center mx-1">
        <div className="w-full">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-semibold text-[var(--text-primary)]">{cd.load}/{effectiveCap}</span>
            <span className="font-bold" style={{ color: getUtilizationColorHex(util, model.config.utilizationThresholds) }}>
              {util}%
            </span>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(util, 100)}%`, backgroundColor: getUtilizationColorHex(util, model.config.utilizationThresholds) }}
            />
          </div>
          {effectiveCap > cd.load && (
            <div className="text-[9px] text-green-600 font-medium mt-0.5">
              {effectiveCap - cd.load}pts available
            </div>
          )}
        </div>
      </div>
    );
  });
}

function TeamProjectCells({ team, projects, model }) {
  const tpc = model.teamProjectCapacity[team.id] || {};

  return projects.map((project) => {
    const data = tpc[project.id];
    if (!data || data.totalEstimate === 0) {
      return (
        <div key={project.id} className="min-w-[170px] px-3 py-3 flex items-center justify-center">
          <span className="text-xs text-gray-300">—</span>
        </div>
      );
    }

    const pm = model.projectMetrics?.[project.id];
    const sharePct = pm && pm.totalEstimate > 0
      ? Math.round((data.totalEstimate / pm.totalEstimate) * 100) : null;

    // Compute team-level planned/unplanned from member issues
    let teamPlanned = 0;
    let teamUnplanned = 0;
    for (const memberId of team.members) {
      const projData = model.memberProjects[memberId]?.[project.id];
      if (!projData) continue;
      for (const issue of projData.issues) {
        if (issue.isUnplanned) {
          teamUnplanned += issue.estimate;
        } else {
          teamPlanned += issue.estimate;
        }
      }
    }
    const teamTotal = teamPlanned + teamUnplanned;
    const unplannedPct = teamTotal > 0 ? Math.round((teamUnplanned / teamTotal) * 100) : 0;

    return (
      <div key={project.id} className="min-w-[170px] px-3 py-2 flex items-center justify-center">
        <div className="text-center w-full">
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {data.totalEstimate} pts
            {sharePct != null && sharePct < 100 && (
              <span className="text-[10px] text-[var(--text-muted)] font-normal ml-1">({sharePct}%)</span>
            )}
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">
            {data.memberCount} {data.memberCount === 1 ? 'person' : 'people'}
            {unplannedPct > 0 && (
              <span className="ml-1">· {unplannedPct}% unplanned</span>
            )}
          </div>
        </div>
      </div>
    );
  });
}

// ─── Member rows (cycle view) ───

function MemberCycleRow({
  member, cycles, model, expandedCell, onCellClick,
  bufferEnabled, availability, onAvailabilityChange,
  ptoDays, onPtoDaysChange,
}) {
  const [editingAvail, setEditingAvail] = useState(null);
  const memberAvailability = availability?.[member.id] || {};
  const memberPtoDays = ptoDays?.[member.id] || {};
  const hasReducedAvail = Object.values(memberAvailability).some((v) => v < 1);
  const isOOO = Object.values(memberAvailability).some((v) => v === 0);
  const isCrossTeam = member.crossTeamCount >= 2;

  return (
    <div className={isOOO ? 'opacity-40' : ''}>
      <div className="flex border-b border-gray-100 bg-white hover:bg-[var(--bg-hover)] transition-colors">
        <MemberNameCell member={member} isCrossTeam={isCrossTeam} hasReducedAvail={hasReducedAvail} isOOO={isOOO} memberPtoDays={memberPtoDays} />

        {cycles.map((cycle) => {
          const cycleData = member.cycles[cycle.id];
          const avail = memberAvailability[cycle.id] ?? 1.0;

          if (!cycleData) {
            return (
              <div key={cycle.id} className="min-w-[150px] px-2 py-3 flex items-center justify-center relative group">
                <span className="text-xs text-gray-300">—</span>
                <PtoPopover
                  editing={editingAvail === cycle.id}
                  onToggle={() => setEditingAvail(editingAvail === cycle.id ? null : cycle.id)}
                  value={avail}
                  ptoDaysValue={memberPtoDays[cycle.id]}
                  cycle={cycle}
                  baseCapacity={model.config.defaultCapacityPerCycle}
                  bufferEnabled={bufferEnabled}
                  bufferPercent={model.config.bufferPercent}
                  onAvailChange={(val) => { onAvailabilityChange?.(member.id, cycle.id, val); setEditingAvail(null); }}
                  onPtoDaysChange={(days) => { onPtoDaysChange?.(member.id, cycle.id, days, { startsAt: cycle.startsAt, endsAt: cycle.endsAt }); setEditingAvail(null); }}
                />
              </div>
            );
          }

          const effectiveCap = getEffectiveCapacity(cycleData.capacity, {
            bufferEnabled, bufferPercent: model.config.bufferPercent, availability: avail,
          });
          const util = effectiveCap > 0 ? Math.round((cycleData.totalEstimate / effectiveCap) * 100) : 0;
          const isSelected = expandedCell?.memberId === member.id && expandedCell?.columnId === cycle.id;
          const unplannedPct = cycleData.totalEstimate > 0
            ? Math.round((cycleData.unplannedWork / cycleData.totalEstimate) * 100) : 0;

          return (
            <div key={cycle.id} className="min-w-[150px] px-1 py-2 flex items-center justify-center relative group">
              <button
                onClick={() => onCellClick(member.id, cycle.id)}
                className={`w-full px-2 py-2 flex flex-col items-center justify-center cursor-pointer transition-all duration-500 border rounded-lg ${
                  isSelected
                    ? 'ring-2 ring-blue-600 bg-blue-100 border-blue-500'
                    : getUtilizationBgClass(util, model.config.utilizationThresholds) + ' hover:shadow-md'
                }`}
              >
                <div
                  className="text-sm font-semibold text-[var(--text-primary)]"
                  title={`${cycleData.totalEstimate}pts assigned ÷ ${effectiveCap}pts capacity = ${util}%\nCapacity: ${cycleData.capacity}pts base${avail < 1 ? ` × ${Math.round(avail * 100)}% avail` : ''}${bufferEnabled ? ` × ${100 - model.config.bufferPercent}% buffer` : ''} = ${effectiveCap}pts`}
                >
                  {cycleData.totalEstimate}/{effectiveCap}
                  {avail < 1 && (
                    <span className="text-[9px] text-amber-600 ml-1 font-medium">
                      {memberPtoDays[cycle.id] != null ? `${memberPtoDays[cycle.id]}d off` : `${Math.round(avail * 100)}%`}
                    </span>
                  )}
                </div>
                <div className="text-xs font-medium" style={{ color: getUtilizationColorHex(util, model.config.utilizationThresholds) }}>
                  {util}% {getUtilizationEmoji(util, model.config.utilizationThresholds)}
                </div>
                {unplannedPct > 0 && (
                  <div className="w-full mt-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div className="flex h-full">
                      <div className="h-full bg-blue-300" style={{ width: `${100 - unplannedPct}%` }} />
                      <div className="h-full bg-gray-300" style={{ width: `${unplannedPct}%` }} />
                    </div>
                  </div>
                )}
                {cycleData.unestimatedIssueCount > 0 && (
                  <div className="text-[9px] text-orange-600 font-medium mt-0.5">
                    +{cycleData.unestimatedIssueCount} unestimated
                  </div>
                )}
              </button>
              <PtoPopover
                editing={editingAvail === cycle.id}
                onToggle={() => setEditingAvail(editingAvail === cycle.id ? null : cycle.id)}
                value={avail}
                ptoDaysValue={memberPtoDays[cycle.id]}
                cycle={cycle}
                baseCapacity={cycleData.capacity}
                bufferEnabled={bufferEnabled}
                bufferPercent={model.config.bufferPercent}
                onAvailChange={(val) => { onAvailabilityChange?.(member.id, cycle.id, val); setEditingAvail(null); }}
                onPtoDaysChange={(days) => { onPtoDaysChange?.(member.id, cycle.id, days, { startsAt: cycle.startsAt, endsAt: cycle.endsAt }); setEditingAvail(null); }}
              />
            </div>
          );
        })}
      </div>

      {expandedCell?.memberId === member.id && (
        <PersonDetail
          member={member}
          cycleId={expandedCell.columnId}
          cycle={cycles.find((c) => c.id === expandedCell.columnId)}
          config={model.config}
          bufferEnabled={bufferEnabled}
          availability={memberAvailability[expandedCell.columnId] ?? 1.0}
          ptoDaysValue={memberPtoDays[expandedCell.columnId]}
          allTeams={model.teams}
          allCycles={model.cycles}
        />
      )}
    </div>
  );
}

// ─── Member rows (project view) ───

function MemberProjectRow({ member, projects, model, expandedCell, onCellClick }) {
  const isCrossTeam = member.crossTeamCount >= 2;
  const mp = model.memberProjects[member.id] || {};

  return (
    <div>
      <div className="flex border-b border-gray-100 bg-white hover:bg-[var(--bg-hover)] transition-colors">
        <MemberNameCell member={member} isCrossTeam={isCrossTeam} />

        {projects.map((project) => {
          const projData = mp[project.id];
          const isSelected = expandedCell?.memberId === member.id && expandedCell?.columnId === project.id;

          if (!projData || projData.totalEstimate === 0) {
            return (
              <div key={project.id} className="min-w-[170px] px-3 py-3 flex items-center justify-center">
                <span className="text-xs text-gray-300">—</span>
              </div>
            );
          }

          // How many cycles does this person work on this project?
          const cycleCount = Object.keys(projData.byCycle).length;

          // Compute planned/unplanned/unestimated per member-project
          let memberPlanned = 0;
          let memberUnplanned = 0;
          let memberUnestimated = 0;
          for (const issue of projData.issues) {
            if (issue.isUnplanned) {
              memberUnplanned += issue.estimate;
            } else {
              memberPlanned += issue.estimate;
            }
            if (issue.estimate === 0) memberUnestimated++;
          }
          const memberTotal = memberPlanned + memberUnplanned;
          const memberUnplannedPct = memberTotal > 0 ? Math.round((memberUnplanned / memberTotal) * 100) : 0;

          return (
            <div key={project.id} className="min-w-[170px] px-2 py-2 flex items-center justify-center">
              <button
                onClick={() => onCellClick(member.id, project.id)}
                className={`w-full px-2 py-2 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 border rounded-lg ${
                  isSelected
                    ? 'ring-2 ring-blue-600 bg-blue-100 border-blue-500'
                    : 'bg-blue-100 border-blue-300 hover:shadow-md hover:bg-blue-200'
                }`}
              >
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {projData.totalEstimate} pts
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {projData.issues.length} issues · {cycleCount} {cycleCount === 1 ? 'cycle' : 'cycles'}
                </div>
                {(memberUnplannedPct > 0 || memberUnestimated > 0) && (
                  <div className="flex items-center gap-1.5 mt-1 text-[9px]">
                    {memberUnplannedPct > 0 && (
                      <span className="text-[var(--text-muted)]">{memberUnplannedPct}% unplanned</span>
                    )}
                    {memberUnestimated > 0 && (
                      <span className="text-orange-600 font-medium bg-orange-50 px-1 py-px rounded">
                        {memberUnestimated} unest.
                      </span>
                    )}
                  </div>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {expandedCell?.memberId === member.id && (
        <ProjectDetail
          member={member}
          projectId={expandedCell.columnId}
          projectData={mp[expandedCell.columnId]}
          project={model.projects.find((p) => p.id === expandedCell.columnId)}
          cycles={model.cycles}
        />
      )}
    </div>
  );
}

// ─── Shared components ───

function MemberNameCell({ member, isCrossTeam, hasReducedAvail, isOOO, memberPtoDays }) {
  // Find the max PTO days across cycles for badge display
  const maxPtoDays = memberPtoDays ? Math.max(0, ...Object.values(memberPtoDays).filter((v) => v != null)) : 0;

  return (
    <div className="w-56 shrink-0 px-4 py-3 flex items-center gap-2.5 pl-8 sticky left-0 bg-inherit z-10">
      <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-xs font-semibold text-blue-600">
        {member.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-[var(--text-primary)] flex items-center gap-1.5">
          <span className="truncate font-medium">{member.name}</span>
          {isCrossTeam && (
            <span className="text-[10px] text-blue-600 font-semibold" title={`Contributing to ${member.crossTeamCount} teams`}>↔</span>
          )}
          {hasReducedAvail && !isOOO && (
            <span className="text-[9px] bg-amber-100 text-amber-700 px-1 py-px rounded font-medium">
              {maxPtoDays > 0 ? `${maxPtoDays}d PTO` : 'PTO'}
            </span>
          )}
          {isOOO && (
            <span className="text-[9px] bg-gray-200 text-gray-500 px-1 py-px rounded font-medium">OOO</span>
          )}
        </div>
        {member.crossProjectCount >= 3 && (
          <div className="text-[10px] text-orange-600">{member.crossProjectCount} projects</div>
        )}
      </div>
    </div>
  );
}

function PtoPopover({ editing, onToggle, value, ptoDaysValue, cycle, baseCapacity, bufferEnabled, bufferPercent, onAvailChange, onPtoDaysChange }) {
  const [manualMode, setManualMode] = useState(false);
  const [manualPercent, setManualPercent] = useState('');
  const [localDays, setLocalDays] = useState(ptoDaysValue ?? 0);

  const workingDays = getWorkingDays(cycle?.startsAt, cycle?.endsAt);
  const cycleName = cycle?.name || 'Cycle';
  const remaining = Math.max(0, workingDays - localDays);
  const derivedAvail = workingDays > 0 ? remaining / workingDays : 1;
  const previewCapacity = getEffectiveCapacity(baseCapacity, {
    bufferEnabled,
    bufferPercent,
    availability: derivedAvail,
  });

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); setLocalDays(ptoDaysValue ?? 0); setManualMode(false); }}
        className="absolute top-1 right-2 w-5 h-5 rounded text-[9px] text-[var(--text-muted)] hover:bg-gray-100 flex items-center justify-center opacity-0 group-hover:opacity-100"
        title="Set PTO / availability"
      >
        ⏰
      </button>
      {editing && (
        <div
          className="absolute z-50 top-full right-0 mt-1 bg-white border border-[var(--border)] rounded-xl shadow-lg min-w-[240px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-gray-100">
            <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {cycleName}
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">
              {workingDays} working days
              {cycle?.startsAt && cycle?.endsAt && (
                <span className="ml-1">
                  ({new Date(cycle.startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(cycle.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                </span>
              )}
            </div>
          </div>

          {!manualMode ? (
            <div className="px-3 py-3">
              <label className="text-[10px] font-medium text-[var(--text-secondary)] block mb-1.5">PTO Days</label>
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setLocalDays(Math.max(0, localDays - 1))}
                  className="w-7 h-7 rounded-lg border border-gray-200 text-sm font-medium text-[var(--text-secondary)] hover:bg-gray-50 flex items-center justify-center"
                >
                  -
                </button>
                <input
                  type="number"
                  min={0}
                  max={workingDays}
                  value={localDays}
                  onChange={(e) => setLocalDays(Math.max(0, Math.min(workingDays, Number(e.target.value) || 0)))}
                  className="w-14 text-center border border-gray-200 rounded-lg py-1 text-sm font-medium text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <button
                  onClick={() => setLocalDays(Math.min(workingDays, localDays + 1))}
                  className="w-7 h-7 rounded-lg border border-gray-200 text-sm font-medium text-[var(--text-secondary)] hover:bg-gray-50 flex items-center justify-center"
                >
                  +
                </button>
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mb-3">
                {remaining} working days remaining → <span className="font-semibold text-[var(--text-secondary)]">{previewCapacity} pts capacity</span>
                <span className="ml-1 text-amber-600">({Math.round(derivedAvail * 100)}%)</span>
              </div>
              <button
                onClick={() => onPtoDaysChange(localDays)}
                className="w-full py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
              >
                Apply
              </button>
              <button
                onClick={() => { setManualMode(true); setManualPercent(Math.round(value * 100)); }}
                className="w-full mt-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-center py-1"
              >
                Use manual %
              </button>
            </div>
          ) : (
            <div className="px-3 py-3">
              <label className="text-[10px] font-medium text-[var(--text-secondary)] block mb-1.5">Manual Availability %</label>
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={manualPercent}
                  onChange={(e) => setManualPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  className="w-16 text-center border border-gray-200 rounded-lg py-1 text-sm font-medium text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <span className="text-xs text-[var(--text-muted)]">%</span>
              </div>
              <button
                onClick={() => { onAvailChange(manualPercent / 100); }}
                className="w-full py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
              >
                Apply
              </button>
              <button
                onClick={() => setManualMode(false)}
                className="w-full mt-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-center py-1"
              >
                Back to days
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
