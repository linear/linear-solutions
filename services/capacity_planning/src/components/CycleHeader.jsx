export default function CycleHeader({ cycle }) {
  const start = cycle.startsAt ? new Date(cycle.startsAt) : null;
  const end = cycle.endsAt ? new Date(cycle.endsAt) : null;
  const now = new Date();
  const isActive = start && end && now >= start && now <= end;
  const isPast = end && now > end;
  const isFuture = start && now < start;

  const formatDate = (d) =>
    d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';

  return (
    <div className="text-center px-2 py-3 min-w-[150px]">
      {cycle.teamName && (
        <div className="text-[9px] text-[var(--text-muted)] font-medium truncate max-w-[140px] mx-auto" title={cycle.teamName}>
          {cycle.teamName}
        </div>
      )}
      <div className="text-xs font-semibold text-[var(--text-primary)] flex items-center justify-center gap-1.5">
        {cycle.name}
        {isActive && (
          <span className="inline-block text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold">
            Active
          </span>
        )}
        {isPast && (
          <span className="inline-block text-[10px] bg-gray-100 text-[var(--text-muted)] px-1.5 py-0.5 rounded-full font-medium">
            Completed
          </span>
        )}
        {isFuture && !isActive && (
          <span className="inline-block text-[10px] bg-gray-100 text-[var(--text-muted)] px-1.5 py-0.5 rounded-full font-medium">
            Upcoming
          </span>
        )}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
        {formatDate(start)} – {formatDate(end)}
      </div>
      {cycle.issueStats?.assigneeCount > 0 && (
        <div className="text-[10px] text-[var(--text-secondary)] mt-0.5 font-medium">
          {cycle.issueStats.assigneeCount} {cycle.issueStats.assigneeCount === 1 ? 'person' : 'people'} · {cycle.issueStats.total} {cycle.issueStats.total === 1 ? 'issue' : 'issues'}
        </div>
      )}
      {isFuture && cycle.plannedPct != null && (
        <div className="mt-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            cycle.plannedPct >= 75
              ? 'bg-green-100 text-green-700'
              : cycle.plannedPct >= 40
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-[var(--text-muted)]'
          }`}>
            {cycle.plannedPct}% planned
          </span>
        </div>
      )}
      {isActive && (
        <div className="mt-1.5 w-full h-1 rounded-full bg-blue-100">
          <div
            className="h-full rounded-full bg-blue-500"
            style={{ width: `${Math.round((cycle.progress || 0) * 100)}%` }}
          />
        </div>
      )}
      {cycle.estimationCoverage != null && cycle.issueStats?.total > 0 && cycle.estimationCoverage < 50 && (
        <div className="mt-1" title={`${cycle.issueStats.estimated || 0} of ${cycle.issueStats.total} issues have estimates`}>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
            cycle.estimationCoverage < 10
              ? 'bg-red-100 text-red-600'
              : 'bg-orange-100 text-orange-600'
          }`}>
            {cycle.estimationCoverage}% estimated
          </span>
        </div>
      )}
    </div>
  );
}
