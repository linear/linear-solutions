import { useEffect, useMemo, useRef, useState } from 'react';
import {
  aggregateMemberBucket,
  buildCalendarBuckets,
  formatMonthInput,
  getCoveredWorkingDays,
  getOverlapWorkingDays,
  getPeriodBounds,
  parseMonthInput,
  rangesOverlap,
} from '../utils/calendarAggregation';
import {
  getUtilizationBgClass,
  getUtilizationColorHex,
  getWorkingDays,
} from '../utils/calculations';

const HEADER_CYCLE_LIMIT = 3;
const CELL_CYCLE_LIMIT = 2;

function formatPoints(value) {
  return Number.isInteger(value) ? value : value.toFixed(1);
}

function formatShortDate(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "Cycle 53" -> "C53", "Sprint 9" -> "S9", so chips fit inside a calendar cell.
function shortCycleLabel(name) {
  if (!name) return 'Cycle';
  const match = name.trim().match(/^([A-Za-z]+)\s*(\d+)$/);
  if (match) return `${match[1][0].toUpperCase()}${match[2]}`;
  return name.length > 9 ? `${name.slice(0, 8)}…` : name;
}

function shiftMonth(value, amount) {
  const date = parseMonthInput(value);
  date.setMonth(date.getMonth() + amount);
  return formatMonthInput(date);
}

export default function CapacityCalendar({
  model,
  selectedTeams,
  selectedPersons,
  selectedProjects,
  selectedCycles,
  sortBy,
  bufferEnabled,
  availability,
  ptoDays,
}) {
  const [periodMode, setPeriodMode] = useState('month');
  const [anchorMonth, setAnchorMonth] = useState(() => formatMonthInput(new Date()));
  const [expandedCell, setExpandedCell] = useState(null);
  const [expandedBucketId, setExpandedBucketId] = useState(null);
  const [collapsedTeams, setCollapsedTeams] = useState({});

  const anchor = useMemo(() => parseMonthInput(anchorMonth), [anchorMonth]);
  const period = useMemo(() => getPeriodBounds(anchor, periodMode), [anchor, periodMode]);
  const buckets = useMemo(() => buildCalendarBuckets(anchor, periodMode), [anchor, periodMode]);

  const relevantCycles = useMemo(() => {
    let cycles = model.cycles.filter((cycle) =>
      rangesOverlap(cycle.startsAt, cycle.endsAt, period.start, period.end)
    );
    if (selectedCycles.length > 0) {
      cycles = cycles.filter((cycle) => selectedCycles.includes(cycle.id));
    }
    return cycles;
  }, [model.cycles, period, selectedCycles]);

  const bucketMeta = useMemo(
    () =>
      buckets.map((bucket) => {
        const cycles = relevantCycles
          .filter((cycle) => rangesOverlap(cycle.startsAt, cycle.endsAt, bucket.start, bucket.end))
          .sort(
            (a, b) =>
              new Date(a.startsAt) - new Date(b.startsAt) || a.teamName.localeCompare(b.teamName),
          );
        const nameCounts = cycles.reduce((counts, cycle) => {
          counts[cycle.name] = (counts[cycle.name] || 0) + 1;
          return counts;
        }, {});

        return {
          cycles: cycles.map((cycle) => ({
            ...cycle,
            headerLabel:
              nameCounts[cycle.name] > 1 ? `${cycle.name} · ${cycle.teamName}` : cycle.name,
          })),
          coveredDays: getCoveredWorkingDays(relevantCycles, bucket),
          totalDays: getWorkingDays(bucket.start, bucket.end),
        };
      }),
    [buckets, relevantCycles],
  );

  const { groups, stats } = useMemo(() => {
    const sourceTeams =
      selectedTeams.length === 0
        ? model.teams.filter((team) => team.members.length > 0)
        : model.teams.filter((team) => selectedTeams.includes(team.id));

    let hotspotCount = 0;
    let visiblePeople = 0;
    let visiblePtoDays = 0;
    const seenPeople = new Set();

    const calendarGroups = sourceTeams
      .map((team) => {
        const memberIds = new Set(team.members);

        // Match the cycle heatmap: include people contributing to this team's
        // work even when they are not in the formal roster.
        for (const [memberId, member] of Object.entries(model.members)) {
          if (memberIds.has(memberId)) continue;
          const contributes = relevantCycles.some(
            (cycle) => member.cycles[cycle.id]?.byTeam?.[team.id]?.estimate > 0,
          );
          if (contributes) memberIds.add(memberId);
        }

        let members = [...memberIds]
          .map((memberId) => model.members[memberId])
          .filter(Boolean);

        if (selectedPersons.length > 0) {
          members = members.filter((member) => selectedPersons.includes(member.id));
        }

        const rows = members
          .map((member) => {
            const cells = buckets.map((bucket) =>
              aggregateMemberBucket({
                member,
                cycles: relevantCycles,
                bucket,
                selectedProjectIds: selectedProjects,
                capacityPerCycle: model.config.defaultCapacityPerCycle,
                bufferEnabled,
                bufferPercent: model.config.bufferPercent,
                availability,
                ptoDays,
              })
            );
            return { member, cells };
          })
          .filter((row) => row.cells.some((cell) => cell.load > 0 || cell.ptoDays > 0));

        rows.sort((a, b) => {
          if (sortBy === 'utilization') {
            return Math.max(0, ...b.cells.map((cell) => cell.utilization))
              - Math.max(0, ...a.cells.map((cell) => cell.utilization));
          }
          if (sortBy === 'bandwidth') {
            return Math.max(0, ...a.cells.map((cell) => cell.utilization))
              - Math.max(0, ...b.cells.map((cell) => cell.utilization));
          }
          if (sortBy === 'points') {
            return b.cells.reduce((sum, cell) => sum + cell.load, 0)
              - a.cells.reduce((sum, cell) => sum + cell.load, 0);
          }
          return a.member.name.localeCompare(b.member.name);
        });

        for (const row of rows) {
          if (!seenPeople.has(row.member.id)) {
            seenPeople.add(row.member.id);
            visiblePeople++;
            visiblePtoDays += row.cells.reduce((sum, cell) => sum + cell.ptoDays, 0);
            hotspotCount += row.cells.filter((cell) => cell.utilization > 100).length;
          }
        }

        return { ...team, rows };
      })
      .filter((team) => team.rows.length > 0);

    return {
      groups: calendarGroups,
      stats: {
        hotspotCount,
        visiblePeople,
        visiblePtoDays: Math.round(visiblePtoDays * 10) / 10,
      },
    };
  }, [
    model,
    selectedTeams,
    selectedPersons,
    selectedProjects,
    sortBy,
    relevantCycles,
    buckets,
    bufferEnabled,
    availability,
    ptoDays,
  ]);

  const selected = useMemo(() => {
    if (!expandedCell) return null;
    const group = groups.find((team) => team.id === expandedCell.teamId);
    const row = group?.rows.find((candidate) => candidate.member.id === expandedCell.memberId);
    const bucketIndex = buckets.findIndex((bucket) => bucket.id === expandedCell.bucketId);
    if (!group || !row || bucketIndex < 0) return null;
    return { group, row, bucket: buckets[bucketIndex], cell: row.cells[bucketIndex] };
  }, [expandedCell, groups, buckets]);

  const selectedBucket = useMemo(() => {
    if (!expandedBucketId) return null;
    const index = buckets.findIndex((bucket) => bucket.id === expandedBucketId);
    if (index < 0) return null;
    return { bucket: buckets[index], meta: bucketMeta[index] };
  }, [expandedBucketId, buckets, bucketMeta]);

  const periodShift = periodMode === 'quarter' ? 3 : 1;
  const gridTemplate = `240px repeat(${buckets.length}, minmax(150px, 1fr))`;
  const minGridWidth = 240 + buckets.length * 150;

  const toggleTeam = (teamId) => {
    setCollapsedTeams((prev) => ({ ...prev, [teamId]: !prev[teamId] }));
    setExpandedCell((current) => (current?.teamId === teamId ? null : current));
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-white px-5 py-3.5 shadow-sm">
        <div>
          <div className="text-sm font-bold text-[var(--text-primary)]">Calendar capacity</div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            Concurrent cycle commitments prorated into {periodMode === 'month' ? 'weeks' : 'months'}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-0.5">
            {['month', 'quarter'].map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setPeriodMode(mode);
                  setExpandedCell(null);
                  setExpandedBucketId(null);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                  periodMode === mode
                    ? 'bg-white text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setAnchorMonth(shiftMonth(anchorMonth, -periodShift));
                setExpandedCell(null);
                setExpandedBucketId(null);
              }}
              className="h-8 w-8 rounded-lg border border-[var(--border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              aria-label={`Previous ${periodMode}`}
            >
              ‹
            </button>
            <input
              type="month"
              value={anchorMonth}
              onChange={(event) => {
                setAnchorMonth(event.target.value);
                setExpandedCell(null);
                setExpandedBucketId(null);
              }}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-medium text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"
            />
            <button
              onClick={() => {
                setAnchorMonth(shiftMonth(anchorMonth, periodShift));
                setExpandedCell(null);
                setExpandedBucketId(null);
              }}
              className="h-8 w-8 rounded-lg border border-[var(--border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              aria-label={`Next ${periodMode}`}
            >
              ›
            </button>
          </div>

          <div className="min-w-[110px] text-right">
            <div className="text-xs font-bold text-[var(--text-primary)]">{period.label}</div>
            <div className="text-[10px] text-[var(--text-muted)]">
              {relevantCycles.length} overlapping cycle{relevantCycles.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <CalendarStat label="People in view" value={stats.visiblePeople} />
        <CalendarStat
          label="Hot spots"
          value={stats.hotspotCount}
          className={stats.hotspotCount > 0 ? 'text-red-700' : 'text-green-700'}
        />
        <CalendarStat label="PTO in view" value={`${formatPoints(stats.visiblePtoDays)}d`} />
        <CalendarStat label="Cycle coverage" value={relevantCycles.length} />
      </div>

      {selectedBucket && (
        <CalendarBucketDetail
          bucket={selectedBucket.bucket}
          cycles={selectedBucket.meta.cycles}
          coveredDays={selectedBucket.meta.coveredDays}
          totalDays={selectedBucket.meta.totalDays}
          onClose={() => setExpandedBucketId(null)}
        />
      )}

      {relevantCycles.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-white px-6 py-16 text-center">
          <div className="text-sm font-semibold text-[var(--text-primary)]">No loaded cycles overlap {period.label}</div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            The current API window contains active cycles and cycles ended in the last 30 days.
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-white px-6 py-16 text-center">
          <div className="text-sm font-semibold text-[var(--text-primary)]">No matching people or project work</div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">Clear filters or choose another period.</div>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-white shadow-sm">
            <div style={{ minWidth: `${minGridWidth}px` }}>
              <div
                className="grid border-b border-[var(--border)] bg-[var(--bg-primary)]"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="sticky left-0 z-20 border-r border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Person</div>
                  <div className="mt-0.5 text-[9px] text-[var(--text-muted)]">
                    {model.config.defaultCapacityPerCycle} pts / 10 weekdays
                  </div>
                </div>
                {buckets.map((bucket, index) => {
                  const meta = bucketMeta[index];
                  const shownCycles = meta.cycles.slice(0, HEADER_CYCLE_LIMIT);
                  const hiddenCycleCount = meta.cycles.length - shownCycles.length;
                  const isSelected = expandedBucketId === bucket.id;
                  const hasCycles = meta.cycles.length > 0;
                  return (
                    <div key={bucket.id} className="border-r border-[var(--border)] p-1.5 last:border-r-0">
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedCell(null);
                          setExpandedBucketId(isSelected ? null : bucket.id);
                        }}
                        disabled={!hasCycles}
                        aria-expanded={isSelected}
                        aria-label={`${bucket.label}: ${meta.cycles.length} overlapping cycle${meta.cycles.length === 1 ? '' : 's'}`}
                        className={`flex min-h-[72px] w-full flex-col items-center justify-center rounded-lg border px-2 py-2 text-center transition-colors ${
                          !hasCycles
                            ? 'cursor-default border-transparent'
                            : isSelected
                              ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-600'
                              : 'border-transparent hover:border-[var(--border)] hover:bg-white'
                        }`}
                      >
                        <div className="text-xs font-bold text-[var(--text-primary)]">{bucket.label}</div>
                        <div className="mt-1 flex flex-wrap justify-center gap-1">
                          {shownCycles.map((cycle) => (
                            <span
                              key={cycle.id}
                              className="max-w-[120px] truncate rounded bg-white px-1.5 py-px text-[9px] font-semibold text-[var(--text-secondary)] ring-1 ring-[var(--border)]"
                            >
                              {cycle.headerLabel}
                            </span>
                          ))}
                          {hiddenCycleCount > 0 && (
                            <span className="rounded bg-blue-100 px-1.5 py-px text-[9px] font-bold text-blue-700 ring-1 ring-blue-300">
                              +{hiddenCycleCount} more
                            </span>
                          )}
                          {!hasCycles && (
                            <span className="text-[9px] text-[var(--text-muted)]">No cycle</span>
                          )}
                        </div>
                        <div className="mt-1 text-[9px] text-[var(--text-muted)]">
                          {hasCycles
                            ? `${meta.cycles.length} cycle${meta.cycles.length === 1 ? '' : 's'} · ${meta.coveredDays}/${meta.totalDays} weekdays`
                            : `${meta.coveredDays}/${meta.totalDays} weekdays loaded`}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>

              {groups.map((team) => (
                <div key={team.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={!collapsedTeams[team.id]}
                    title={collapsedTeams[team.id] ? 'Expand members' : 'Collapse members'}
                    onClick={() => toggleTeam(team.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleTeam(team.id);
                      }
                    }}
                    className="grid cursor-pointer border-b border-[var(--border)] bg-gray-100 hover:bg-gray-200"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    <div className="sticky left-0 z-10 flex items-center gap-2 border-r border-[var(--border)] bg-inherit px-2 py-2">
                      <span className="w-3 shrink-0 text-[10px] text-[var(--text-muted)]">
                        {collapsedTeams[team.id] ? '▶' : '▼'}
                      </span>
                      <span className="min-w-0">
                        <span className="text-xs font-bold text-[var(--text-primary)]">{team.name}</span>
                        <span className="ml-2 text-[10px] font-medium text-[var(--text-muted)]">
                          {team.rows.length} people
                        </span>
                      </span>
                    </div>
                    {buckets.map((bucket) => {
                      const bucketIndex = buckets.findIndex((candidate) => candidate.id === bucket.id);
                      const teamLoad = team.rows.reduce((sum, row) => sum + row.cells[bucketIndex].load, 0);
                      const teamCapacity = team.rows.reduce((sum, row) => sum + row.cells[bucketIndex].capacity, 0);
                      const utilization = teamCapacity > 0 ? Math.round(teamLoad / teamCapacity * 100) : 0;
                      return (
                        <div key={bucket.id} className="border-r border-[var(--border)] px-3 py-2 text-center last:border-r-0">
                          <span className="text-[10px] font-semibold text-[var(--text-secondary)]">
                            {formatPoints(teamLoad)}/{formatPoints(teamCapacity)} pts
                          </span>
                          <span
                            className="ml-1.5 text-[10px] font-bold"
                            style={{ color: getUtilizationColorHex(utilization, model.config.utilizationThresholds) }}
                          >
                            {utilization}%
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {!collapsedTeams[team.id] && team.rows.map(({ member, cells }) => (
                    <div
                      key={`${team.id}-${member.id}`}
                      className="grid border-b border-gray-200 last:border-b-0"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      <div className="sticky left-0 z-10 flex min-w-0 items-center border-r border-[var(--border)] bg-white px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-[var(--text-primary)]">{member.name}</div>
                          <div className="mt-0.5 flex items-center gap-1">
                            {member.homeTeamId !== team.id && (
                              <span className="rounded bg-blue-100 px-1 py-px text-[8px] font-semibold text-blue-700">
                                Cross-team
                              </span>
                            )}
                            {member.crossTeamCount >= 2 && (
                              <span className="text-[9px] text-[var(--text-muted)]">
                                {member.crossTeamCount} teams
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {cells.map((cell, index) => {
                        const bucket = buckets[index];
                        const cellCycles = [...cell.contributingCycles].sort((a, b) => b.load - a.load);
                        const shownCycles = cellCycles.slice(0, CELL_CYCLE_LIMIT);
                        const hiddenCycles = cellCycles.slice(CELL_CYCLE_LIMIT);
                        const isSelected =
                          expandedCell?.teamId === team.id
                          && expandedCell?.memberId === member.id
                          && expandedCell?.bucketId === bucket.id;
                        const hasData = cell.load > 0 || cell.ptoDays > 0;
                        return (
                          <div key={bucket.id} className="border-r border-[var(--border)] p-1.5 last:border-r-0">
                            <button
                              onClick={() => {
                                setExpandedBucketId(null);
                                setExpandedCell(
                                  isSelected ? null : { teamId: team.id, memberId: member.id, bucketId: bucket.id },
                                );
                              }}
                              disabled={!hasData}
                              className={`flex min-h-[78px] w-full flex-col items-center justify-center rounded-lg border px-2 py-1.5 transition-colors ${
                                !hasData
                                  ? 'cursor-default border-transparent bg-gray-50 text-[var(--text-muted)]'
                                  : isSelected
                                    ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-600'
                                    : `${getUtilizationBgClass(cell.utilization, model.config.utilizationThresholds)} hover:brightness-95`
                              }`}
                            >
                              {hasData ? (
                                <>
                                  <div className="text-xs font-bold text-[var(--text-primary)]">
                                    {formatPoints(cell.load)}/{formatPoints(cell.capacity)}
                                  </div>
                                  <div
                                    className="text-[11px] font-bold"
                                    style={{
                                      color: getUtilizationColorHex(
                                        cell.utilization,
                                        model.config.utilizationThresholds,
                                      ),
                                    }}
                                  >
                                    {cell.utilization}%
                                  </div>
                                  <div className="mt-1 flex flex-wrap justify-center gap-1">
                                    {shownCycles.map((cycle) => (
                                      <span
                                        key={cycle.id}
                                        title={`${cycle.teamName} · ${cycle.name}: ${formatPoints(cycle.load)} pts over ${cycle.overlapDays} weekdays`}
                                        className="rounded bg-white/70 px-1 py-px text-[8px] font-semibold text-[var(--text-secondary)]"
                                      >
                                        {shortCycleLabel(cycle.name)} {formatPoints(cycle.load)}
                                      </span>
                                    ))}
                                    {hiddenCycles.length > 0 && (
                                      <span
                                        title={hiddenCycles
                                          .map(
                                            (cycle) =>
                                              `${cycle.teamName} · ${cycle.name}: ${formatPoints(cycle.load)} pts`,
                                          )
                                          .join('\n')}
                                        className="rounded bg-white/70 px-1 py-px text-[8px] font-semibold text-[var(--text-muted)]"
                                      >
                                        +{hiddenCycles.length}
                                      </span>
                                    )}
                                    {cell.ptoDays > 0 && (
                                      <span className="rounded bg-white/70 px-1 py-px text-[8px] font-semibold text-amber-800">
                                        {formatPoints(cell.ptoDays)}d PTO
                                      </span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--text-muted)]">
            <div className="flex flex-wrap items-center gap-3">
              <Legend color="bg-green-100 border-green-300" label="≤60% on track" />
              <Legend color="bg-amber-200 border-amber-400" label="61–85% near capacity" />
              <Legend color="bg-orange-200 border-orange-400" label="86–100% at risk" />
              <Legend color="bg-red-200 border-red-400" label=">100% over capacity" />
            </div>
            <span>
              Click a week or month header to list every overlapping cycle. Cell chips show prorated points; one cycle = 10 working days of supply.
            </span>
          </div>
        </>
      )}

      {selected && (
        <CalendarCellDetail
          member={selected.row.member}
          bucket={selected.bucket}
          cell={selected.cell}
          onClose={() => setExpandedCell(null)}
        />
      )}
    </div>
  );
}

function CalendarStat({ label, value, className = 'text-[var(--text-primary)]' }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-white px-4 py-3 shadow-sm">
      <div className={`text-xl font-bold ${className}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded-sm border ${color}`} />
      {label}
    </span>
  );
}

function CalendarBucketDetail({ bucket, cycles, coveredDays, totalDays, onClose }) {
  const panelRef = useRef(null);
  const grouped = useMemo(() => {
    const byTeam = new Map();
    for (const cycle of cycles) {
      const teamName = cycle.teamName || 'Unknown team';
      if (!byTeam.has(teamName)) byTeam.set(teamName, []);
      byTeam.get(teamName).push({
        ...cycle,
        overlapDays: getOverlapWorkingDays(cycle.startsAt, cycle.endsAt, bucket.start, bucket.end),
      });
    }
    return [...byTeam.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [cycles, bucket]);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [bucket.id]);

  return (
    <div ref={panelRef} className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">
            Cycles overlapping {bucket.label}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {cycles.length} cycle{cycles.length === 1 ? '' : 's'}
            {' · '}{coveredDays}/{totalDays} weekdays loaded
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-gray-100"
        >
          Close
        </button>
      </div>

      <div className="grid max-h-56 gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
        {grouped.map(([teamName, teamCycles]) => (
          <div key={teamName} className="rounded-lg border border-[var(--border)] bg-white p-4">
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
              {teamName}
              <span className="ml-1.5 font-semibold normal-case tracking-normal text-[var(--text-secondary)]">
                {teamCycles.length}
              </span>
            </h4>
            <div className="space-y-2">
              {teamCycles.map((cycle) => (
                <div key={cycle.id} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-[var(--text-primary)]">{cycle.name}</div>
                    <div className="mt-0.5 text-[var(--text-muted)]">
                      {formatShortDate(cycle.startsAt)} – {formatShortDate(cycle.endsAt)}
                    </div>
                  </div>
                  <span className="shrink-0 font-semibold text-[var(--text-secondary)]">
                    {cycle.overlapDays}d overlap
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarCellDetail({ member, bucket, cell, onClose }) {
  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">
            {member.name} — {bucket.label}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {formatPoints(cell.load)} pts demand / {formatPoints(cell.capacity)} pts available
            {' · '}{cell.utilization}% utilization
            {cell.ptoDays > 0 ? ` · ${formatPoints(cell.ptoDays)} PTO days` : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-gray-100"
        >
          Close
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <DetailList
          title="Contributing cycles"
          rows={cell.contributingCycles.map((cycle) => [
            `${cycle.name || 'Cycle'} · ${cycle.teamName}`,
            `${formatPoints(cycle.load)} pts / ${cycle.overlapDays}d`,
          ])}
        />
        <DetailList
          title="Team commitments"
          rows={Object.entries(cell.teamLoads).map(([name, points]) => [name, `${formatPoints(points)} pts`])}
        />
        <DetailList
          title="Project demand"
          rows={Object.entries(cell.projectLoads).slice(0, 8).map(([name, points]) => [name, `${formatPoints(points)} pts`])}
        />
      </div>

      {cell.unestimatedIssueCount > 0 && (
        <div className="mt-4 rounded-lg border border-orange-300 bg-orange-100 px-3 py-2 text-xs text-orange-800">
          About {formatPoints(cell.unestimatedIssueCount)} prorated issues have no estimate and contribute 0 points.
        </div>
      )}
    </div>
  );
}

function DetailList({ title, rows }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4">
      <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">{title}</h4>
      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map(([label, value]) => (
            <div key={`${label}-${value}`} className="flex items-start justify-between gap-3 text-xs">
              <span className="text-[var(--text-secondary)]">{label}</span>
              <span className="shrink-0 font-semibold text-[var(--text-primary)]">{value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-[var(--text-muted)]">No data</div>
      )}
    </div>
  );
}
