import { useMemo, useState } from 'react';
import { getEffectiveCapacity, getUtilizationColorHex } from '../utils/calculations';

export default function SummaryStats({ model, bufferEnabled, availability, onPersonSelect, onTeamSelect }) {
  const [activeCard, setActiveCard] = useState(null);

  const stats = useMemo(() => {
    if (!model) return null;

    const memberList = Object.values(model.members);
    const totalMembers = memberList.length;
    const thresholds = model.config.utilizationThresholds;

    const overCapacity = [];
    const withBandwidth = [];
    const unplannedMembers = [];
    let totalUtil = 0;
    let utilCount = 0;
    let totalUnplanned = 0;
    let totalPlanned = 0;

    // Team-level over-capacity
    const overCapacityTeams = [];
    const activeTeamsList = model.teams.filter((t) => t.members.length > 0);
    for (const team of activeTeamsList) {
      const tc = model.teamCapacity[team.id];
      if (!tc) continue;
      let peakUtil = 0;
      let peakCycleName = '';
      const teamCycleBreakdowns = [];
      for (const [cycleId, cd] of Object.entries(tc.cycles)) {
        if (cd.load === 0) continue;
        let effectiveCap = cd.rawCapacity;
        if (bufferEnabled) {
          effectiveCap = Math.round(effectiveCap * (1 - model.config.bufferPercent / 100));
        }
        const util = effectiveCap > 0 ? Math.round((cd.load / effectiveCap) * 100) : 0;
        const cycle = model.cycles.find((c) => c.id === cycleId);
        teamCycleBreakdowns.push({
          cycleId,
          cycleName: cycle?.name || 'Cycle',
          load: cd.load,
          capacity: effectiveCap,
          utilization: util,
          memberCount: cd.activeMemberCount,
          unplannedWork: cd.unplannedWork,
          borrowedOut: cd.borrowedOut,
          borrowedIn: cd.borrowedIn,
        });
        if (util > peakUtil) {
          peakUtil = util;
          peakCycleName = cycle?.name || 'Cycle';
        }
      }
      if (peakUtil > thresholds.orange) {
        overCapacityTeams.push({
          id: team.id,
          name: team.name,
          maxUtil: peakUtil,
          peakCycleName,
          memberCount: team.members.length,
          cycleBreakdowns: teamCycleBreakdowns.sort((a, b) => b.utilization - a.utilization),
        });
      }
    }
    overCapacityTeams.sort((a, b) => b.maxUtil - a.maxUtil);

    for (const member of memberList) {
      let maxUtil = 0;
      let maxCycleId = null;
      let hasCycleData = false;
      let memberUnplanned = 0;
      let memberTotal = 0;

      const cycleBreakdowns = [];

      for (const [cycleId, cycleData] of Object.entries(member.cycles)) {
        hasCycleData = true;
        const avail = availability?.[member.id]?.[cycleId] ?? 1.0;
        const effectiveCap = getEffectiveCapacity(cycleData.capacity, {
          bufferEnabled,
          bufferPercent: model.config.bufferPercent,
          availability: avail,
        });
        const util = effectiveCap > 0 ? Math.round((cycleData.totalEstimate / effectiveCap) * 100) : 0;

        const cycle = model.cycles.find((c) => c.id === cycleId);
        cycleBreakdowns.push({
          cycleId,
          cycleName: cycle?.name || 'Cycle',
          totalEstimate: cycleData.totalEstimate,
          effectiveCap,
          utilization: util,
          plannedWork: cycleData.plannedWork,
          unplannedWork: cycleData.unplannedWork,
          projects: Object.values(cycleData.byProject).map((p) => ({
            name: p.name,
            estimate: p.estimate,
            issueCount: p.issues.length,
          })),
        });

        if (util > maxUtil) {
          maxUtil = util;
          maxCycleId = cycleId;
        }
        totalUnplanned += cycleData.unplannedWork;
        totalPlanned += cycleData.plannedWork;
        memberUnplanned += cycleData.unplannedWork;
        memberTotal += cycleData.totalEstimate;
      }

      if (hasCycleData) {
        const memberDetail = {
          id: member.id,
          name: member.name,
          maxUtil,
          maxCycleId,
          teams: member.teams.map((tid) => member.teamNames[tid] || tid).filter(Boolean),
          cycleBreakdowns: cycleBreakdowns.sort((a, b) => b.utilization - a.utilization),
        };

        if (maxUtil > thresholds.orange) overCapacity.push(memberDetail);
        if (maxUtil <= thresholds.green) withBandwidth.push(memberDetail);
        if (memberUnplanned > 0) {
          unplannedMembers.push({
            ...memberDetail,
            unplannedPts: memberUnplanned,
            totalPts: memberTotal,
            unplannedPct: memberTotal > 0 ? Math.round((memberUnplanned / memberTotal) * 100) : 0,
          });
        }
        totalUtil += maxUtil;
        utilCount++;
      }
    }

    overCapacity.sort((a, b) => b.maxUtil - a.maxUtil);
    withBandwidth.sort((a, b) => a.maxUtil - b.maxUtil);
    unplannedMembers.sort((a, b) => b.unplannedPct - a.unplannedPct);

    const avgUtil = utilCount > 0 ? Math.round(totalUtil / utilCount) : 0;
    const totalWork = totalPlanned + totalUnplanned;
    const unplannedPct = totalWork > 0 ? Math.round((totalUnplanned / totalWork) * 100) : 0;

    // Estimation coverage across all cycles
    let totalIssues = 0;
    let estimatedIssues = 0;
    const lowCoverageCycles = [];
    for (const cycle of model.cycles) {
      if (!cycle.issueStats || cycle.issueStats.total === 0) continue;
      totalIssues += cycle.issueStats.total;
      estimatedIssues += (cycle.issueStats.estimated || 0);
      const coverage = cycle.issueStats.total > 0
        ? Math.round(((cycle.issueStats.estimated || 0) / cycle.issueStats.total) * 100)
        : 0;
      if (coverage < 50) {
        lowCoverageCycles.push({
          name: cycle.name,
          teamName: cycle.teamName,
          total: cycle.issueStats.total,
          estimated: cycle.issueStats.estimated || 0,
          coverage,
        });
      }
    }
    const estimationCoverage = totalIssues > 0 ? Math.round((estimatedIssues / totalIssues) * 100) : 100;
    lowCoverageCycles.sort((a, b) => a.coverage - b.coverage);

    return {
      totalMembers,
      overCapacity,
      overCapacityTeams,
      withBandwidth,
      unplannedMembers,
      avgUtil,
      unplannedPct,
      activeTeams: activeTeamsList.length,
      thresholds: model.config.utilizationThresholds,
      estimationCoverage,
      totalIssues,
      estimatedIssues,
      lowCoverageCycles,
    };
  }, [model, bufferEnabled, availability]);

  if (!stats) return null;

  const handleCardClick = (cardId) => {
    setActiveCard(activeCard === cardId ? null : cardId);
  };

  const activeData =
    activeCard === 'over' ? stats.overCapacity
    : activeCard === 'bandwidth' ? stats.withBandwidth
    : activeCard === 'unplanned' ? stats.unplannedMembers
    : activeCard === 'estimation' ? stats.lowCoverageCycles
    : null;

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard label="Teams" value={stats.activeTeams} />
        <StatCard label="Members" value={stats.totalMembers} />
        <StatCard
          label="Over Capacity"
          value={stats.overCapacity.length + stats.overCapacityTeams.length}
          color="text-red-700"
          bgColor="bg-red-100"
          active={activeCard === 'over'}
          clickable={stats.overCapacity.length > 0 || stats.overCapacityTeams.length > 0}
          onClick={() => handleCardClick('over')}
          subtitle={stats.overCapacityTeams.length > 0 ? `${stats.overCapacityTeams.length} team${stats.overCapacityTeams.length !== 1 ? 's' : ''} · ${stats.overCapacity.length} people` : undefined}
        />
        <StatCard
          label="With Bandwidth"
          value={stats.withBandwidth.length}
          color="text-green-700"
          bgColor="bg-green-50"
          active={activeCard === 'bandwidth'}
          clickable={stats.withBandwidth.length > 0}
          onClick={() => handleCardClick('bandwidth')}
        />
        <StatCard
          label="Avg Utilization"
          value={`${stats.avgUtil}%`}
          color={stats.avgUtil > 85 ? 'text-orange-700' : stats.avgUtil > 60 ? 'text-yellow-700' : 'text-green-700'}
        />
        <StatCard
          label="Unplanned Work"
          value={`${stats.unplannedPct}%`}
          color={stats.unplannedPct > 30 ? 'text-red-700' : stats.unplannedPct > 15 ? 'text-yellow-700' : 'text-[var(--text-secondary)]'}
          subtitle="of total load"
          active={activeCard === 'unplanned'}
          clickable={stats.unplannedMembers.length > 0}
          onClick={() => handleCardClick('unplanned')}
        />
        <StatCard
          label="Est. Coverage"
          value={`${stats.estimationCoverage}%`}
          color={stats.estimationCoverage < 30 ? 'text-red-700' : stats.estimationCoverage < 60 ? 'text-orange-700' : 'text-green-700'}
          bgColor={stats.estimationCoverage < 30 ? 'bg-red-100' : stats.estimationCoverage < 60 ? 'bg-orange-100' : ''}
          subtitle={`${stats.estimatedIssues} of ${stats.totalIssues} issues`}
          active={activeCard === 'estimation'}
          clickable={stats.lowCoverageCycles.length > 0}
          onClick={() => handleCardClick('estimation')}
        />
      </div>

      {/* Detail panel */}
      {activeCard && activeData && activeData.length > 0 && (
        activeCard === 'estimation' ? (
          <EstimationPanel
            cycles={activeData}
            totalIssues={stats.totalIssues}
            estimatedIssues={stats.estimatedIssues}
            coverage={stats.estimationCoverage}
            onClose={() => setActiveCard(null)}
          />
        ) : activeCard === 'over' ? (
          <OverCapacityPanel
            teams={stats.overCapacityTeams}
            members={stats.overCapacity}
            thresholds={stats.thresholds}
            onPersonSelect={onPersonSelect}
            onTeamSelect={onTeamSelect}
            onClose={() => setActiveCard(null)}
          />
        ) : (
          <DetailPanel
            type={activeCard}
            members={activeData}
            thresholds={stats.thresholds}
            onPersonSelect={onPersonSelect}
            onClose={() => setActiveCard(null)}
          />
        )
      )}
    </div>
  );
}

function StatCard({ label, value, color = 'text-[var(--text-primary)]', bgColor, subtitle, active, clickable, onClick }) {
  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={`relative rounded-xl border bg-[var(--bg-card)] px-4 py-3.5 shadow-sm text-left transition-all ${bgColor || ''} ${
        clickable ? 'cursor-pointer hover:shadow-md' : ''
      } ${
        active ? 'ring-2 ring-[var(--accent-blue)] border-[var(--accent-blue)]' : 'border-[var(--border)]'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
          {label}
        </div>
        {clickable && (
          <span className="text-[9px] text-[var(--text-muted)]">{active ? '▲' : '▼'}</span>
        )}
      </div>
      <div className={`text-2xl font-bold ${color}`}>
        {value}
      </div>
      {subtitle && (
        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{subtitle}</div>
      )}
    </button>
  );
}

function DetailPanel({ type, members, thresholds, onPersonSelect, onClose }) {
  const title =
    type === 'over' ? 'Over Capacity'
    : type === 'bandwidth' ? 'Available Bandwidth'
    : 'Unplanned Work';

  const description =
    type === 'over' ? 'These individuals exceed capacity thresholds. Click "Focus" to filter the heatmap to that person.'
    : type === 'bandwidth' ? 'These individuals have available capacity. Click "Focus" to filter the heatmap to that person.'
    : 'These individuals have unplanned work (bugs, ops, incidents). Click "Focus" to filter the heatmap to that person.';

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)]">{title}</h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{description}</p>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg px-2"
        >
          ×
        </button>
      </div>
      <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
        {members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            type={type}
            thresholds={thresholds}
            onFocus={() => onPersonSelect?.(member.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member, type, thresholds, onFocus }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-4 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors">
        {/* Avatar + name */}
        <div className="flex items-center gap-2.5 min-w-[180px]">
          <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-xs font-semibold text-blue-600 shrink-0">
            {member.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)] truncate">{member.name}</div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">
              {member.teams.slice(0, 2).join(', ')}{member.teams.length > 2 ? ` +${member.teams.length - 2}` : ''}
            </div>
          </div>
        </div>

        {/* Key metric */}
        {type === 'unplanned' ? (
          <div className="flex items-center gap-3 flex-1">
            <div className="text-right min-w-[70px]">
              <div className="text-sm font-bold text-[var(--text-primary)]">{member.unplannedPts}pts</div>
              <div className="text-[10px] text-[var(--text-muted)]">{member.unplannedPct}% unplanned</div>
            </div>
            <div className="flex-1 max-w-[200px]">
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden flex">
                <div className="h-full bg-blue-400 rounded-l-full" style={{ width: `${100 - member.unplannedPct}%` }} />
                <div className="h-full bg-gray-400" style={{ width: `${member.unplannedPct}%` }} />
              </div>
              <div className="flex items-center gap-3 mt-1">
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                  <span className="text-[9px] text-[var(--text-muted)]">Planned</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                  <span className="text-[9px] text-[var(--text-muted)]">Unplanned</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-1">
            <div className="text-right min-w-[60px]">
              <div className="text-lg font-bold" style={{ color: getUtilizationColorHex(member.maxUtil, thresholds) }}>
                {member.maxUtil}%
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">peak util</div>
            </div>
            {/* Mini cycle bars */}
            <div className="flex items-end gap-1 flex-1 max-w-[200px]">
              {member.cycleBreakdowns.slice(0, 4).map((cb) => (
                <div key={cb.cycleId} className="flex-1 flex flex-col items-center">
                  <div className="text-[8px] text-[var(--text-muted)] mb-0.5">{cb.utilization}%</div>
                  <div className="w-full bg-gray-100 rounded-sm overflow-hidden" style={{ height: '24px' }}>
                    <div
                      className="w-full rounded-sm transition-all"
                      style={{
                        height: `${Math.min(cb.utilization, 100)}%`,
                        backgroundColor: getUtilizationColorHex(cb.utilization, thresholds),
                        marginTop: `${Math.max(100 - cb.utilization, 0)}%`,
                      }}
                    />
                  </div>
                  <div className="text-[7px] text-[var(--text-muted)] mt-0.5 truncate w-full text-center">{cb.cycleName.replace(/^Cycle\s*/, 'C')}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1 rounded-md hover:bg-gray-100"
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
          <button
            onClick={onFocus}
            className="text-[10px] font-semibold text-white bg-[var(--accent-blue)] px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Focus
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-[var(--bg-primary)]">
          {member.cycleBreakdowns.map((cb) => (
            <div key={cb.cycleId} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{cb.cycleName}</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-[var(--text-muted)]">
                    {cb.totalEstimate}/{cb.effectiveCap} pts
                  </span>
                  <span className="font-bold" style={{ color: getUtilizationColorHex(cb.utilization, thresholds) }}>
                    {cb.utilization}%
                  </span>
                </div>
              </div>
              {/* Calculation breakdown */}
              <div className="text-[10px] text-[var(--text-muted)] mb-2 bg-white rounded-md px-2.5 py-1.5 border border-gray-100">
                Load: {cb.totalEstimate}pts ({cb.plannedWork}pts planned{cb.unplannedWork > 0 ? ` + ${cb.unplannedWork}pts unplanned` : ''})
                {' · '}Capacity: {cb.effectiveCap}pts
                {' · '}Utilization: {cb.totalEstimate}/{cb.effectiveCap} = <span className="font-semibold" style={{ color: getUtilizationColorHex(cb.utilization, thresholds) }}>{cb.utilization}%</span>
              </div>
              {/* Projects */}
              <div className="space-y-1">
                {cb.projects
                  .filter((p) => p.estimate > 0)
                  .sort((a, b) => b.estimate - a.estimate)
                  .map((p) => (
                    <div key={p.name} className="flex items-center justify-between text-xs py-1 px-2.5 rounded-md bg-white border border-gray-100">
                      <span className="text-[var(--text-secondary)] truncate max-w-[250px]">{p.name}</span>
                      <span className="text-[var(--text-muted)] font-medium shrink-0 ml-2">
                        {p.estimate}pts · {p.issueCount} {p.issueCount === 1 ? 'issue' : 'issues'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverCapacityPanel({ teams, members, thresholds, onPersonSelect, onTeamSelect, onClose }) {
  const [activeTab, setActiveTab] = useState(teams.length > 0 ? 'teams' : 'people');

  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)]">Over Capacity</h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            {teams.length > 0 && `${teams.length} team${teams.length !== 1 ? 's' : ''}`}
            {teams.length > 0 && members.length > 0 && ' and '}
            {members.length > 0 && `${members.length} ${members.length === 1 ? 'person' : 'people'}`}
            {' '}exceeding capacity thresholds.
          </p>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg px-2">×</button>
      </div>

      {/* Tabs when both teams and people exist */}
      {teams.length > 0 && members.length > 0 && (
        <div className="flex border-b border-[var(--border)] px-5">
          <button
            onClick={() => setActiveTab('teams')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'teams' ? 'border-red-500 text-red-700' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Teams ({teams.length})
          </button>
          <button
            onClick={() => setActiveTab('people')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'people' ? 'border-red-500 text-red-700' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            People ({members.length})
          </button>
        </div>
      )}

      {/* Team rows */}
      {(activeTab === 'teams' || members.length === 0) && teams.length > 0 && (
        <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
          {teams.map((team) => (
            <TeamOverCapacityRow key={team.id} team={team} thresholds={thresholds} onFocus={() => onTeamSelect?.(team.id)} />
          ))}
        </div>
      )}

      {/* People rows */}
      {(activeTab === 'people' || teams.length === 0) && members.length > 0 && (
        <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
          {members.map((member) => (
            <MemberRow key={member.id} member={member} type="over" thresholds={thresholds} onFocus={() => onPersonSelect?.(member.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamOverCapacityRow({ team, thresholds, onFocus }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-4 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors">
        {/* Team icon + name */}
        <div className="flex items-center gap-2.5 min-w-[180px]">
          <div className="w-7 h-7 rounded-full bg-red-50 flex items-center justify-center text-xs font-semibold text-red-600 shrink-0">
            {team.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)] truncate">{team.name}</div>
            <div className="text-[10px] text-[var(--text-muted)]">{team.memberCount} members</div>
          </div>
        </div>

        {/* Peak utilization + mini cycle bars */}
        <div className="flex items-center gap-3 flex-1">
          <div className="text-right min-w-[60px]">
            <div className="text-lg font-bold" style={{ color: getUtilizationColorHex(team.maxUtil, thresholds) }}>
              {team.maxUtil}%
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">peak util</div>
          </div>
          <div className="flex items-end gap-1 flex-1 max-w-[200px]">
            {team.cycleBreakdowns.slice(0, 4).map((cb) => (
              <div key={cb.cycleId} className="flex-1 flex flex-col items-center">
                <div className="text-[8px] text-[var(--text-muted)] mb-0.5">{cb.utilization}%</div>
                <div className="w-full bg-gray-100 rounded-sm overflow-hidden" style={{ height: '24px' }}>
                  <div
                    className="w-full rounded-sm transition-all"
                    style={{
                      height: `${Math.min(cb.utilization, 100)}%`,
                      backgroundColor: getUtilizationColorHex(cb.utilization, thresholds),
                      marginTop: `${Math.max(100 - cb.utilization, 0)}%`,
                    }}
                  />
                </div>
                <div className="text-[7px] text-[var(--text-muted)] mt-0.5 truncate w-full text-center">{cb.cycleName.replace(/^Cycle\s*/, 'C')}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1 rounded-md hover:bg-gray-100"
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
          <button
            onClick={onFocus}
            className="text-[10px] font-semibold text-white bg-[var(--accent-blue)] px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Focus
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-5 pb-4 pt-1 bg-[var(--bg-primary)]">
          {team.cycleBreakdowns.map((cb) => (
            <div key={cb.cycleId} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{cb.cycleName}</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-[var(--text-muted)]">{cb.load}/{cb.capacity} pts</span>
                  <span className="font-bold" style={{ color: getUtilizationColorHex(cb.utilization, thresholds) }}>{cb.utilization}%</span>
                </div>
              </div>
              <div className="text-[10px] text-[var(--text-muted)] bg-white rounded-md px-2.5 py-1.5 border border-gray-100">
                Load: {cb.load}pts
                {cb.unplannedWork > 0 && ` (${cb.unplannedWork}pts unplanned)`}
                {' · '}Capacity: {cb.capacity}pts
                {' · '}{cb.memberCount} active member{cb.memberCount !== 1 ? 's' : ''}
                {cb.borrowedOut > 0 && ` · ${cb.borrowedOut}pts loaned out`}
                {cb.borrowedIn > 0 && ` · ${cb.borrowedIn}pts borrowed in`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EstimationPanel({ cycles, totalIssues, estimatedIssues, coverage, onClose }) {
  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)]">Estimation Coverage</h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Only {estimatedIssues} of {totalIssues} in-cycle issues have estimates ({coverage}%).
            Capacity numbers undercount actual workload for cycles below.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg px-2"
        >
          ×
        </button>
      </div>

      {/* Overall bar */}
      <div className="px-5 py-3 border-b border-gray-100 bg-[var(--bg-primary)]">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${coverage}%`,
                  backgroundColor: coverage < 30 ? '#b91c1c' : coverage < 60 ? '#c2410c' : '#15803d',
                }}
              />
            </div>
          </div>
          <span className="text-xs font-bold shrink-0" style={{ color: coverage < 30 ? '#b91c1c' : coverage < 60 ? '#c2410c' : '#15803d' }}>
            {coverage}%
          </span>
        </div>
        <div className="flex items-center gap-4 mt-1.5">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: coverage < 30 ? '#b91c1c' : coverage < 60 ? '#c2410c' : '#15803d' }} />
            <span className="text-[9px] text-[var(--text-muted)]">{estimatedIssues} estimated</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-200" />
            <span className="text-[9px] text-[var(--text-muted)]">{totalIssues - estimatedIssues} missing estimates</span>
          </div>
        </div>
      </div>

      {/* Cycles with low coverage */}
      <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
        {cycles.map((cycle, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-2.5">
            <div className="min-w-[180px]">
              <div className="text-sm font-medium text-[var(--text-primary)]">{cycle.teamName}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{cycle.name}</div>
            </div>
            <div className="flex-1 max-w-[200px]">
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${cycle.coverage}%`,
                    backgroundColor: cycle.coverage < 10 ? '#b91c1c' : cycle.coverage < 30 ? '#c2410c' : '#a16207',
                  }}
                />
              </div>
            </div>
            <div className="text-right min-w-[100px]">
              <span className="text-xs font-bold" style={{ color: cycle.coverage < 10 ? '#b91c1c' : cycle.coverage < 30 ? '#c2410c' : '#a16207' }}>
                {cycle.coverage}%
              </span>
              <span className="text-[10px] text-[var(--text-muted)] ml-1">
                ({cycle.estimated}/{cycle.total})
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
