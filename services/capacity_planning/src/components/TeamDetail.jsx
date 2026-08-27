import { useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import {
  getUtilizationColorHex,
  getUtilizationColor,
  getEffectiveCapacity,
} from '../utils/calculations';

const TOOLTIP_STYLE = {
  background: '#fff',
  border: '1px solid #94a3b8',
  borderRadius: 10,
  color: '#0f172a',
  fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
};

const BAR_COLORS = ['#1d4ed8', '#6d28d9', '#15803d', '#a16207', '#c2410c', '#b91c1c', '#be185d', '#0e7490'];

export default function TeamDetail({ team, members, cycles, model, bufferEnabled, availability }) {
  const teamCap = model.teamCapacity[team.id];
  const cyclesWithData = useMemo(
    () => cycles.filter((c) => teamCap?.cycles[c.id]?.load > 0),
    [cycles, teamCap]
  );

  const [selectedCycleId, setSelectedCycleId] = useState(
    () => cyclesWithData[0]?.id || cycles[0]?.id
  );

  const cycleData = teamCap?.cycles[selectedCycleId];

  // ── Compute team effective capacity for selected cycle ──
  const teamEffectiveCap = useMemo(() => {
    if (!cycleData) return 0;
    let cap = cycleData.rawCapacity;
    if (bufferEnabled) {
      cap = Math.round(cap * (1 - model.config.bufferPercent / 100));
    }
    if (availability) {
      let ptoReduction = 0;
      for (const mid of team.members) {
        const avail = availability[mid]?.[selectedCycleId];
        if (avail != null && avail < 1) {
          ptoReduction += model.config.defaultCapacityPerCycle * (1 - avail);
        }
      }
      cap = Math.round(cap - ptoReduction);
    }
    return cap;
  }, [cycleData, bufferEnabled, availability, model, team.members, selectedCycleId]);

  const teamUtil = teamEffectiveCap > 0 ? Math.round((cycleData?.load || 0) / teamEffectiveCap * 100) : 0;
  const teamColor = getUtilizationColorHex(teamUtil, model.config.utilizationThresholds);
  const teamColorName = getUtilizationColor(teamUtil, model.config.utilizationThresholds);

  // ── Member comparison data (sorted by utilization desc) ──
  const memberComparisonData = useMemo(() => {
    return members
      .map((m) => {
        const cd = m.cycles[selectedCycleId];
        if (!cd) return null;
        const avail = availability?.[m.id]?.[selectedCycleId] ?? 1.0;
        const eCap = getEffectiveCapacity(cd.capacity, {
          bufferEnabled, bufferPercent: model.config.bufferPercent, availability: avail,
        });
        const util = eCap > 0 ? Math.round((cd.totalEstimate / eCap) * 100) : 0;
        return {
          id: m.id,
          name: m.name,
          utilization: util,
          load: cd.totalEstimate,
          capacity: eCap,
          planned: cd.plannedWork,
          unplanned: cd.unplannedWork,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.utilization - a.utilization);
  }, [members, selectedCycleId, bufferEnabled, model.config.bufferPercent, availability]);

  // ── Work composition (planned vs unplanned) ──
  const workComp = useMemo(() => {
    if (!cycleData) return { planned: 0, unplanned: 0, total: 0, unplannedPct: 0 };
    const total = cycleData.load || 0;
    const unplanned = cycleData.unplannedWork || 0;
    const planned = total - unplanned;
    return {
      planned,
      unplanned,
      total,
      unplannedPct: total > 0 ? Math.round((unplanned / total) * 100) : 0,
    };
  }, [cycleData]);

  // ── Project capacity breakdown ──
  const projectBreakdown = useMemo(() => {
    const projectMap = {};
    for (const m of members) {
      const cd = m.cycles[selectedCycleId];
      if (!cd?.byProject) continue;
      for (const [pid, proj] of Object.entries(cd.byProject)) {
        if (!projectMap[pid]) {
          projectMap[pid] = { id: pid, name: proj.name || pid, estimate: 0 };
        }
        projectMap[pid].estimate += proj.estimate;
      }
    }
    return Object.values(projectMap)
      .filter((p) => p.estimate > 0)
      .sort((a, b) => b.estimate - a.estimate);
  }, [members, selectedCycleId]);

  const maxProjectEst = projectBreakdown.length > 0 ? projectBreakdown[0].estimate : 1;

  // ── Cross-team flow ──
  const crossTeamFlow = useMemo(() => {
    if (!cycleData) return { borrowedOut: 0, borrowedIn: 0, sharedMembers: [], effectiveFTE: 0 };
    return {
      borrowedOut: cycleData.borrowedOut || 0,
      borrowedIn: cycleData.borrowedIn || 0,
      sharedMembers: cycleData.sharedMembers || [],
      effectiveFTE: cycleData.effectiveFTE ?? members.length,
    };
  }, [cycleData, members.length]);

  // ── Utilization trajectory across cycles ──
  const trajectoryData = useMemo(() => {
    return cycles
      .filter((c) => teamCap?.cycles[c.id])
      .map((c) => {
        const cd = teamCap.cycles[c.id];
        let cap = cd.rawCapacity;
        if (bufferEnabled) cap = Math.round(cap * (1 - model.config.bufferPercent / 100));
        if (availability) {
          let ptoRed = 0;
          for (const mid of team.members) {
            const avail = availability[mid]?.[c.id];
            if (avail != null && avail < 1) ptoRed += model.config.defaultCapacityPerCycle * (1 - avail);
          }
          cap = Math.round(cap - ptoRed);
        }
        const util = cap > 0 ? Math.round((cd.load / cap) * 100) : 0;
        return {
          name: c.name?.replace(/^Cycle\s*/, 'C') || `C${c.number}`,
          utilization: util,
          isCurrent: c.id === selectedCycleId,
        };
      });
  }, [cycles, teamCap, bufferEnabled, model, team.members, availability, selectedCycleId]);

  const trendLabel = useMemo(() => {
    if (trajectoryData.length < 2) return '';
    const first = trajectoryData[0].utilization;
    const last = trajectoryData[trajectoryData.length - 1].utilization;
    const delta = last - first;
    if (Math.abs(delta) < 5) return 'stable';
    return delta > 0 ? `trending up (+${delta}%)` : `trending down (${delta}%)`;
  }, [trajectoryData]);

  // ── Member sparkline data ──
  const memberSparklines = useMemo(() => {
    return members.map((m) => {
      const points = cycles.map((c) => {
        const cd = m.cycles[c.id];
        if (!cd) return { name: c.name, util: null };
        const avail = availability?.[m.id]?.[c.id] ?? 1.0;
        const eCap = getEffectiveCapacity(cd.capacity, {
          bufferEnabled, bufferPercent: model.config.bufferPercent, availability: avail,
        });
        return { name: c.name, util: eCap > 0 ? Math.round((cd.totalEstimate / eCap) * 100) : 0 };
      });
      return { id: m.id, name: m.name, points };
    });
  }, [members, cycles, bufferEnabled, model.config.bufferPercent, availability]);

  // ── Warnings ──
  const warnings = useMemo(() => {
    const w = [];
    if (memberComparisonData.length >= 2) {
      const max = memberComparisonData[0];
      const min = memberComparisonData[memberComparisonData.length - 1];
      const gap = max.utilization - min.utilization;
      if (gap > 40) {
        w.push({
          type: 'warning',
          text: `Max utilization (${max.name}: ${max.utilization}%) is ${gap}pp above min (${min.name}: ${min.utilization}%) — consider redistributing`,
        });
      }
    }
    if (workComp.unplannedPct > 30) {
      w.push({
        type: 'warning',
        text: `Unplanned work is ${workComp.unplannedPct}% of total load`,
      });
    }
    if (crossTeamFlow.borrowedOut > 0) {
      w.push({
        type: 'warning',
        text: `Team is lending ${crossTeamFlow.borrowedOut} pts to other teams, reducing effective FTE to ${crossTeamFlow.effectiveFTE}`,
      });
    }
    // Check for unestimated issues across members
    let totalUnestimated = 0;
    for (const m of members) {
      const cd = m.cycles[selectedCycleId];
      if (cd) totalUnestimated += cd.unestimatedIssueCount || 0;
    }
    if (totalUnestimated > 0) {
      w.push({
        type: 'warning',
        text: `${totalUnestimated} issue${totalUnestimated !== 1 ? 's' : ''} without estimates — actual load may be higher`,
      });
    }
    // Over-capacity members
    const overCap = memberComparisonData.filter((m) => m.utilization > 100);
    if (overCap.length > 0) {
      w.push({
        type: 'critical',
        text: `${overCap.length} member${overCap.length !== 1 ? 's' : ''} over capacity: ${overCap.map((m) => `${m.name} (${m.utilization}%)`).join(', ')}`,
      });
    }
    return w;
  }, [memberComparisonData, workComp, crossTeamFlow, members, selectedCycleId]);

  if (!teamCap) return null;

  const statusLabel = teamUtil > 100 ? 'Over Capacity' : teamColorName === 'green' ? 'On Track' : teamColorName === 'yellow' ? 'Near Capacity' : 'At Risk';

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-primary)] p-6 transition-all duration-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">{team.name}</h3>
          <div className="flex items-center gap-1 mt-2 flex-wrap">
            {cyclesWithData.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCycleId(c.id)}
                className={`text-[10px] px-2.5 py-1 rounded-full font-medium transition-colors ${
                  selectedCycleId === c.id
                    ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300'
                    : 'bg-gray-100 text-[var(--text-muted)] hover:bg-gray-200'
                }`}
              >
                {c.name || `Cycle ${c.number}`}
              </button>
            ))}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold" style={{ color: teamColor }}>{teamUtil}%</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: teamColor }}>
            {statusLabel}
          </div>
        </div>
      </div>

      {/* Member Comparison Bar Chart */}
      {memberComparisonData.length > 0 && (
        <div className="bg-white rounded-lg p-4 border border-[var(--border)] mb-6">
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Member Utilization Comparison
          </h4>
          <ResponsiveContainer width="100%" height={Math.max(memberComparisonData.length * 36 + 20, 80)}>
            <BarChart data={memberComparisonData} layout="vertical" margin={{ left: 0, right: 20 }}>
              <XAxis
                type="number"
                domain={[0, (max) => Math.max(max + 10, 110)]}
                tick={{ fill: '#475569', fontSize: 10 }}
                tickFormatter={(v) => `${v}%`}
                axisLine={{ stroke: '#94a3b8' }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={100}
                tick={{ fill: '#334155', fontSize: 11, fontWeight: 500 }}
                axisLine={false}
                tickLine={false}
              />
              <ReferenceLine x={100} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value, name, props) => {
                  const d = props.payload;
                  return [
                    `${d.utilization}% (${d.load}/${d.capacity} pts) — ${d.planned}pts planned, ${d.unplanned}pts unplanned`,
                    d.name,
                  ];
                }}
                labelFormatter={() => ''}
              />
              <Bar dataKey="utilization" radius={[0, 6, 6, 0]} barSize={20}>
                {memberComparisonData.map((entry) => (
                  <Cell
                    key={entry.id}
                    fill={getUtilizationColorHex(entry.utilization, model.config.utilizationThresholds)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Two-column detail grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-5">
          {/* Work Composition */}
          <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Work Composition</h4>
            {workComp.total > 0 ? (
              <>
                <div className="w-full h-5 rounded-lg overflow-hidden flex mb-2">
                  <div
                    className="h-full flex items-center justify-center text-[10px] text-white font-semibold"
                    style={{ width: `${100 - workComp.unplannedPct}%`, backgroundColor: '#1d4ed8', minWidth: '16px' }}
                  >
                    {100 - workComp.unplannedPct > 15 ? `${100 - workComp.unplannedPct}%` : ''}
                  </div>
                  {workComp.unplanned > 0 && (
                    <div
                      className="h-full flex items-center justify-center text-[10px] text-gray-600 font-semibold"
                      style={{ width: `${workComp.unplannedPct}%`, backgroundColor: '#d1d5db', minWidth: '16px' }}
                    >
                      {workComp.unplannedPct > 15 ? `${workComp.unplannedPct}%` : ''}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-blue-600" />
                    <span className="text-[var(--text-muted)] font-medium">Planned ({workComp.planned} pts)</span>
                  </div>
                  {workComp.unplanned > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-gray-300" />
                      <span className="text-[var(--text-muted)] font-medium">Unplanned ({workComp.unplanned} pts)</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">No work data for this cycle</p>
            )}
          </div>

          {/* Project Capacity Breakdown */}
          {projectBreakdown.length > 0 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Project Capacity Breakdown</h4>
              <div className="space-y-2">
                {projectBreakdown.map((proj, i) => (
                  <div key={proj.id} className="flex items-center gap-2">
                    <span className="text-xs text-[var(--text-secondary)] font-medium truncate w-28 shrink-0" title={proj.name}>
                      {proj.name === '__no_project__' ? 'No Project' : proj.name}
                    </span>
                    <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full rounded transition-all duration-500"
                        style={{
                          width: `${(proj.estimate / maxProjectEst) * 100}%`,
                          backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-[var(--text-muted)] font-medium w-12 text-right shrink-0">
                      {proj.estimate} pts
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-Team Flow */}
          {(crossTeamFlow.borrowedOut > 0 || crossTeamFlow.borrowedIn > 0 || crossTeamFlow.sharedMembers.length > 0) && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Cross-Team Flow</h4>
              <div className="space-y-2 text-xs">
                {crossTeamFlow.borrowedOut > 0 && (
                  <div className="flex items-center gap-2 text-amber-700">
                    <span className="text-sm">&#8594;</span>
                    <span>Lending <strong>{crossTeamFlow.borrowedOut} pts</strong> to other teams</span>
                  </div>
                )}
                {crossTeamFlow.borrowedIn > 0 && (
                  <div className="flex items-center gap-2 text-blue-700">
                    <span className="text-sm">&#8592;</span>
                    <span>Borrowing <strong>{crossTeamFlow.borrowedIn} pts</strong> from other teams</span>
                  </div>
                )}
                {crossTeamFlow.sharedMembers.length > 0 && (
                  <div className="text-[var(--text-muted)] mt-1">
                    Shared members: {crossTeamFlow.sharedMembers.join(', ')}
                  </div>
                )}
                <div className="text-[var(--text-muted)] pt-1 border-t border-gray-100">
                  Effective FTE: <strong className="text-[var(--text-primary)]">{crossTeamFlow.effectiveFTE}</strong>
                  {crossTeamFlow.effectiveFTE < members.length && (
                    <span className="text-amber-600 ml-1">(of {members.length} members)</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {/* Team Utilization Trajectory */}
          {trajectoryData.length > 1 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Utilization Trajectory</h4>
              <p className="text-[10px] text-[var(--text-muted)] mb-3">
                {trajectoryData.length} cycles ·
                avg {Math.round(trajectoryData.reduce((s, d) => s + d.utilization, 0) / trajectoryData.length)}%
                {trendLabel && ` · ${trendLabel}`}
              </p>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={trajectoryData} margin={{ left: 0, right: 10, top: 5, bottom: 5 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fill: '#475569', fontSize: 10, fontWeight: 500 }}
                    axisLine={{ stroke: '#94a3b8' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, (max) => Math.max(max + 10, 110)]}
                    tick={{ fill: '#475569', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={35}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <ReferenceLine y={100} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [`${value}%`, 'Utilization']}
                  />
                  <Line
                    type="monotone"
                    dataKey="utilization"
                    stroke="#1d4ed8"
                    strokeWidth={2}
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      return (
                        <circle
                          key={payload.name}
                          cx={cx}
                          cy={cy}
                          r={payload.isCurrent ? 5 : 3}
                          fill={payload.isCurrent ? '#1d4ed8' : '#94a3b8'}
                          stroke="#fff"
                          strokeWidth={payload.isCurrent ? 2 : 1}
                        />
                      );
                    }}
                    activeDot={{ r: 5, stroke: '#1d4ed8', strokeWidth: 2, fill: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Member Load Sparklines */}
          {memberSparklines.length > 0 && cycles.length > 1 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Member Load Across Cycles</h4>
              <div className="space-y-2">
                {memberSparklines.map((ms) => (
                  <div key={ms.id} className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--text-secondary)] font-medium truncate w-20 shrink-0">
                      {ms.name.split(' ')[0]}
                    </span>
                    <div className="flex-1 flex items-end gap-px h-5">
                      {ms.points.map((p, i) => {
                        if (p.util == null) {
                          return <div key={i} className="flex-1 h-full bg-gray-50 rounded-sm" />;
                        }
                        const pct = Math.min(p.util / 150, 1);
                        const color = getUtilizationColorHex(p.util, model.config.utilizationThresholds);
                        return (
                          <div
                            key={i}
                            className="flex-1 rounded-sm transition-all duration-300"
                            style={{
                              height: `${Math.max(pct * 100, 8)}%`,
                              backgroundColor: color,
                              opacity: 0.8,
                            }}
                            title={`${p.name}: ${p.util}%`}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mt-5 space-y-2">
          {warnings.map((w, i) => (
            <Warning key={i} text={w.text} type={w.type} />
          ))}
        </div>
      )}
    </div>
  );
}

function Warning({ text, type = 'warning' }) {
  const styles = {
    warning: 'bg-amber-100 text-amber-800 border-amber-400',
    critical: 'bg-red-100 text-red-800 border-red-400',
  };

  return (
    <div className={`flex items-center gap-2 text-xs px-3 py-2.5 rounded-lg border font-medium ${styles[type]}`}>
      <span>{type === 'critical' ? '\uD83D\uDD34' : '\u26A0\uFE0F'}</span>
      <span>{text}</span>
    </div>
  );
}
