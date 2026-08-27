import { useMemo, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import {
  getUtilizationColorHex,
  getUtilizationColor,
  getEffectiveCapacity,
} from '../utils/calculations';

const BAR_COLORS = ['#1d4ed8', '#6d28d9', '#15803d', '#a16207', '#c2410c', '#b91c1c', '#be185d', '#0e7490'];
const TEAM_COLORS = ['#1d4ed8', '#6d28d9', '#15803d', '#c2410c', '#be185d', '#0e7490', '#a16207', '#b91c1c'];

export default function PersonDetail({ member, cycleId, cycle, config, bufferEnabled, availability = 1.0, ptoDaysValue, allCycles = [] }) {
  const cycleData = member.cycles[cycleId];
  if (!cycleData) return null;

  const capacity = getEffectiveCapacity(cycleData.capacity, {
    bufferEnabled,
    bufferPercent: config.bufferPercent,
    availability,
  });
  const utilization = capacity > 0 ? Math.round((cycleData.totalEstimate / capacity) * 100) : 0;
  const color = getUtilizationColorHex(utilization, config.utilizationThresholds);
  const colorName = getUtilizationColor(utilization, config.utilizationThresholds);

  const projects = useMemo(() => {
    return Object.values(cycleData.byProject)
      .filter((p) => !p.issues.every((i) => i.isUnplanned))
      .sort((a, b) => b.estimate - a.estimate)
      .map((p) => ({
        ...p,
        percent: cycleData.totalEstimate > 0 ? Math.round((p.estimate / cycleData.totalEstimate) * 100) : 0,
      }));
  }, [cycleData]);

  const crossTeamData = useMemo(() => {
    const byTeam = cycleData.byTeam || {};
    return Object.entries(byTeam)
      .map(([teamId, data]) => ({
        teamId,
        teamName: data.teamName || teamId.slice(0, 8),
        estimate: data.estimate,
        isHome: member.homeTeamId === teamId,
        percent: cycleData.totalEstimate > 0 ? Math.round((data.estimate / cycleData.totalEstimate) * 100) : 0,
      }))
      .sort((a, b) => b.estimate - a.estimate);
  }, [cycleData, member]);

  const chartData = projects.map((p) => ({
    name: p.name.length > 22 ? p.name.slice(0, 20) + '…' : p.name,
    points: p.estimate,
  }));

  // Trajectory data: utilization across all cycles for this member
  const trajectoryData = useMemo(() => {
    if (!allCycles || allCycles.length === 0) return [];
    return allCycles
      .filter((c) => member.cycles[c.id])
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
      .map((c) => {
        const cd = member.cycles[c.id];
        const cap = getEffectiveCapacity(cd.capacity, {
          bufferEnabled,
          bufferPercent: config.bufferPercent,
          availability: 1.0,
        });
        const util = cap > 0 ? Math.round((cd.totalEstimate / cap) * 100) : 0;
        return {
          name: c.name?.replace(/^Cycle\s*/, 'C') || `C${c.number}`,
          utilization: util,
          load: cd.totalEstimate,
          capacity: cap,
          isCurrent: c.id === cycleId,
        };
      });
  }, [allCycles, member, cycleId, bufferEnabled, config]);

  const cycleName = cycle?.name || 'Cycle';
  const dateRange =
    cycle?.startsAt && cycle?.endsAt
      ? `${new Date(cycle.startsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(cycle.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-primary)] p-6 transition-all duration-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">
            {member.name} — {cycleName}
          </h3>
          <div className="flex items-center gap-3 mt-0.5">
            {dateRange && <p className="text-xs text-[var(--text-muted)]">{dateRange}</p>}
            {availability < 1 && (
              <span className="text-xs text-amber-600 font-medium">
                {ptoDaysValue != null
                  ? `${ptoDaysValue} PTO days (${Math.round(availability * 100)}% available)`
                  : `${Math.round(availability * 100)}% availability`}
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold" style={{ color }}>
            {utilization}%
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
            {utilization > 100 ? 'Over Capacity' : colorName === 'green' ? 'On Track' : colorName === 'yellow' ? 'Near Capacity' : 'At Risk'}
          </div>
        </div>
      </div>

      {/* Utilization bar */}
      <div className="mb-6 bg-white rounded-lg p-4 border border-[var(--border)]">
        <div className="text-xs text-[var(--text-muted)] mb-2 flex items-center justify-between">
          <span className="font-medium">
            {cycleData.totalEstimate} / {capacity} pts
            {bufferEnabled && (
              <span className="ml-1 text-amber-600">({config.bufferPercent}% buffer applied)</span>
            )}
          </span>
          <span>
            <span className="font-medium text-[var(--text-secondary)]">{cycleData.plannedWork}pts planned</span>
            {cycleData.unplannedWork > 0 && (
              <span className="text-[var(--text-muted)]"> · {cycleData.unplannedWork}pts unplanned</span>
            )}
          </span>
        </div>
        <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full flex">
            <div
              className="h-full rounded-l-full transition-all duration-700"
              style={{
                width: `${Math.min((cycleData.plannedWork / capacity) * 100, 100)}%`,
                backgroundColor: color,
              }}
            />
            {cycleData.unplannedWork > 0 && (
              <div
                className="h-full transition-all duration-700"
                style={{
                  width: `${Math.min((cycleData.unplannedWork / capacity) * 100, 100 - Math.min((cycleData.plannedWork / capacity) * 100, 100))}%`,
                  backgroundColor: '#d1d5db',
                }}
              />
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 mt-2">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
            <span className="text-[10px] text-[var(--text-muted)] font-medium">Planned work</span>
          </div>
          {cycleData.unplannedWork > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm bg-gray-300" />
              <span className="text-[10px] text-[var(--text-muted)] font-medium">Bugs & ops</span>
            </div>
          )}
        </div>
      </div>

      {/* Estimation coverage warning */}
      {cycleData.unestimatedIssueCount > 0 && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-orange-50 border border-orange-200">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-orange-700">
              {cycleData.unestimatedIssueCount} issue{cycleData.unestimatedIssueCount !== 1 ? 's' : ''} without estimates
            </span>
            <span className="text-[10px] text-orange-600 font-medium">
              {cycleData.estimatedIssueCount} of {cycleData.estimatedIssueCount + cycleData.unestimatedIssueCount} issues estimated
              ({Math.round((cycleData.estimatedIssueCount / (cycleData.estimatedIssueCount + cycleData.unestimatedIssueCount)) * 100)}% coverage)
            </span>
          </div>
          <p className="text-[10px] text-orange-600 mb-2">
            Utilization shown ({utilization}%) only reflects estimated work. Actual load is likely higher.
          </p>
          <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {cycleData.unestimatedIssues.map((issue) => (
              <div key={issue.id} className="flex items-center justify-between text-[10px] py-1 px-2 rounded bg-white/60">
                <span className="text-orange-800 truncate max-w-[300px]">{issue.title}</span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {issue.project !== 'No Project' && (
                    <span className="text-orange-500">{issue.project}</span>
                  )}
                  <span className={`px-1 py-px rounded text-[9px] font-medium ${
                    issue.stateType === 'completed' ? 'bg-green-100 text-green-700'
                    : issue.stateType === 'started' ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-500'
                  }`}>{issue.state}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Left: Project breakdown + unplanned + cross-team */}
        <div className="space-y-5">
          {/* Project breakdown */}
          <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">By Project</h4>
            <div className="space-y-0.5">
              {projects.map((p, i) => (
                <ProjectRow key={p.id} project={p} colorIdx={i} />
              ))}
            </div>
          </div>

          {/* Unplanned work */}
          {cycleData.unplannedWork > 0 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3 flex items-center gap-2">
                Unplanned Work
                <span className="text-[10px] font-normal text-gray-400 normal-case tracking-normal">
                  {cycleData.unplannedWork} pts ({cycleData.totalEstimate > 0 ? Math.round((cycleData.unplannedWork / cycleData.totalEstimate) * 100) : 0}% of load)
                </span>
              </h4>
              <div className="space-y-1.5">
                {cycleData.unplannedIssues.map((issue) => (
                  <div
                    key={issue.id}
                    className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-md bg-gray-50"
                  >
                    <span className="text-[var(--text-secondary)] truncate max-w-[220px]">
                      {issue.title}
                    </span>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-[var(--text-muted)] font-medium">{issue.estimate}pts</span>
                      {issue.labels.map((l) => (
                        <span key={l} className="text-[9px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full font-medium">
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-team commitment */}
          {crossTeamData.length > 1 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
                Team Commitment Split
              </h4>
              <div className="w-full h-6 rounded-lg overflow-hidden flex mb-3">
                {crossTeamData.map((t, i) => (
                  <div
                    key={t.teamId}
                    className="h-full flex items-center justify-center text-[10px] text-white font-semibold transition-all duration-500"
                    style={{
                      width: `${t.percent}%`,
                      backgroundColor: TEAM_COLORS[i % TEAM_COLORS.length],
                      minWidth: t.percent > 5 ? undefined : '16px',
                    }}
                    title={`${t.teamName}: ${t.estimate}pts (${t.percent}%)`}
                  >
                    {t.percent > 15 ? `${t.percent}%` : ''}
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                {crossTeamData.map((t, i) => (
                  <div key={t.teamId} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-2.5 h-2.5 rounded-sm"
                        style={{ backgroundColor: TEAM_COLORS[i % TEAM_COLORS.length] }}
                      />
                      <span className="text-[var(--text-secondary)] font-medium">
                        {t.teamName}
                        {t.isHome && (
                          <span className="ml-1 text-[10px] text-[var(--text-muted)] font-normal">(home)</span>
                        )}
                      </span>
                    </div>
                    <span className="text-[var(--text-muted)] font-medium">
                      {t.estimate} pts · {t.percent}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Charts */}
        <div className="space-y-5">
          {chartData.length > 0 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Point Distribution</h4>
              <ResponsiveContainer width="100%" height={Math.max(projects.length * 38 + 20, 100)}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={130}
                    tick={{ fill: '#334155', fontSize: 11, fontWeight: 500 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#fff',
                      border: '1px solid #94a3b8',
                      borderRadius: 10,
                      color: '#0f172a',
                      fontSize: 12,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                    }}
                  />
                  <Bar dataKey="points" radius={[0, 6, 6, 0]}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Trajectory: Utilization across cycles */}
          {trajectoryData.length > 1 && (
            <div className="bg-white rounded-lg p-4 border border-[var(--border)]">
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Utilization Trajectory</h4>
              <p className="text-[10px] text-[var(--text-muted)] mb-3">
                {trajectoryData.length} cycles ·
                avg {Math.round(trajectoryData.reduce((s, d) => s + d.utilization, 0) / trajectoryData.length)}%
                {(() => {
                  const first = trajectoryData[0].utilization;
                  const last = trajectoryData[trajectoryData.length - 1].utilization;
                  const delta = last - first;
                  if (Math.abs(delta) < 5) return ' · stable';
                  return delta > 0 ? ` · trending up (+${delta}%)` : ` · trending down (${delta}%)`;
                })()}
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
                    contentStyle={{
                      background: '#fff',
                      border: '1px solid #94a3b8',
                      borderRadius: 10,
                      color: '#0f172a',
                      fontSize: 12,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                    }}
                    formatter={(value, name) => [`${value}%`, 'Utilization']}
                    labelFormatter={(label) => label}
                  />
                  <Line
                    type="monotone"
                    dataKey="utilization"
                    stroke="#1d4ed8"
                    strokeWidth={2}
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      const dotColor = payload.isCurrent ? '#1d4ed8' : '#94a3b8';
                      const r = payload.isCurrent ? 5 : 3;
                      return (
                        <circle
                          key={payload.name}
                          cx={cx}
                          cy={cy}
                          r={r}
                          fill={dotColor}
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
        </div>
      </div>

      {/* Warnings */}
      <div className="mt-5 space-y-2">
        {member.crossProjectCount >= 3 && (
          <Warning text={`Assigned to ${member.crossProjectCount} projects — context-switching risk`} type="warning" />
        )}
        {member.crossTeamCount >= 3 && (
          <Warning text={`Contributing to ${member.crossTeamCount} different teams — high fragmentation`} type="warning" />
        )}
        {utilization > 100 && (
          <Warning text={`Over capacity by ${cycleData.totalEstimate - capacity} pts — consider redistributing`} type="critical" />
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, colorIdx }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between py-2 px-2 rounded-md hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)]">{expanded ? '▼' : '▶'}</span>
          <span
            className="w-2.5 h-2.5 rounded-sm inline-block shrink-0"
            style={{ backgroundColor: BAR_COLORS[colorIdx % BAR_COLORS.length] }}
          />
          <span className="text-sm text-[var(--text-primary)] font-medium truncate max-w-[200px]">
            {project.name === '__no_project__' ? 'No Project' : project.name}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] shrink-0 font-medium">
          <span>{project.estimate} pts</span>
          <span className="text-gray-400">({project.percent}%)</span>
        </div>
      </button>
      {expanded && (
        <div className="ml-8 mt-1 mb-2 space-y-1">
          {project.issues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-md bg-gray-50"
            >
              <span className="text-[var(--text-secondary)] truncate max-w-[220px]">
                {issue.title}
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {issue.isUnplanned && issue.labels?.length > 0 && (
                  issue.labels.map((l) => (
                    <span key={l} className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                      {l}
                    </span>
                  ))
                )}
                <span className="text-[var(--text-muted)] font-medium">{issue.estimate}pts</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                    issue.stateType === 'completed'
                      ? 'bg-green-100 text-green-700'
                      : issue.stateType === 'started'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {issue.state}
                </span>
              </div>
            </div>
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
      <span>{type === 'critical' ? '🔴' : '⚠️'}</span>
      <span>{text}</span>
    </div>
  );
}
