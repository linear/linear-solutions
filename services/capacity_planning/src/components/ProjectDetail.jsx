import { useState } from 'react';

export default function ProjectDetail({ member, projectId, projectData, project, cycles }) {
  if (!projectData) return null;

  const cycleLookup = {};
  for (const c of cycles) {
    cycleLookup[c.id] = c;
  }

  const sortedCycles = Object.entries(projectData.byCycle)
    .map(([cycleId, data]) => ({
      cycleId,
      cycle: cycleLookup[cycleId],
      ...data,
    }))
    .sort((a, b) => {
      const aStart = a.cycle?.startsAt ? new Date(a.cycle.startsAt) : 0;
      const bStart = b.cycle?.startsAt ? new Date(b.cycle.startsAt) : 0;
      return aStart - bStart;
    });

  const formatDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-primary)] p-6 transition-all duration-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">
            {member.name} — {projectData.name}
          </h3>
          {project && (project.startDate || project.targetDate) && (
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Project timeline: {formatDate(project.startDate)} – {formatDate(project.targetDate)}
              {project.progress != null && (
                <span className="ml-2 text-blue-600 font-medium">{Math.round(project.progress * 100)}% complete</span>
              )}
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-[var(--text-primary)]">
            {projectData.totalEstimate} pts
          </div>
          <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            across {sortedCycles.length} {sortedCycles.length === 1 ? 'cycle' : 'cycles'}
          </div>
        </div>
      </div>

      {/* Summary bar */}
      <div className="mb-6 bg-white rounded-lg p-4 border border-[var(--border)]">
        <div className="text-xs font-medium text-[var(--text-muted)] mb-2">
          {projectData.issues.length} issues · {projectData.totalEstimate} total points
        </div>
        {/* Cycle distribution bar */}
        <div className="w-full h-5 rounded-lg overflow-hidden flex">
          {sortedCycles.map((cd, i) => {
            const pct = projectData.totalEstimate > 0
              ? Math.round((cd.estimate / projectData.totalEstimate) * 100)
              : 0;
            const colors = ['#1d4ed8', '#6d28d9', '#15803d', '#a16207', '#c2410c'];
            return (
              <div
                key={cd.cycleId}
                className="h-full flex items-center justify-center text-[10px] text-white font-semibold"
                style={{
                  width: `${pct}%`,
                  backgroundColor: colors[i % colors.length],
                  minWidth: pct > 3 ? undefined : '12px',
                }}
                title={`${cd.cycle?.name || 'Cycle'}: ${cd.estimate}pts (${pct}%)`}
              >
                {pct > 12 ? `${pct}%` : ''}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 mt-2">
          {sortedCycles.map((cd, i) => {
            const colors = ['#1d4ed8', '#6d28d9', '#15803d', '#a16207', '#c2410c'];
            return (
              <div key={cd.cycleId} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors[i % colors.length] }} />
                <span className="text-[10px] text-[var(--text-muted)] font-medium">
                  {cd.cycle?.name || 'Cycle'} ({cd.estimate}pts)
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Issues grouped by cycle */}
      <div className="space-y-4">
        {sortedCycles.map((cd) => (
          <CycleIssueGroup
            key={cd.cycleId}
            cycleName={cd.cycle?.name || 'Cycle'}
            cycleDate={cd.cycle ? `${formatDate(cd.cycle.startsAt)} – ${formatDate(cd.cycle.endsAt)}` : ''}
            estimate={cd.estimate}
            issues={cd.issues}
          />
        ))}
      </div>
    </div>
  );
}

function CycleIssueGroup({ cycleName, cycleDate, estimate, issues }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="bg-white rounded-lg border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)]">{expanded ? '▼' : '▶'}</span>
          <span className="text-sm font-semibold text-[var(--text-primary)]">{cycleName}</span>
          {cycleDate && <span className="text-[10px] text-[var(--text-muted)]">{cycleDate}</span>}
        </div>
        <div className="text-xs text-[var(--text-muted)] font-medium">
          {estimate} pts · {issues.length} issues
        </div>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-2 space-y-1">
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-center justify-between text-xs py-1.5 px-2 rounded-md hover:bg-gray-50"
            >
              <span className="text-[var(--text-secondary)] truncate max-w-[320px]">
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
