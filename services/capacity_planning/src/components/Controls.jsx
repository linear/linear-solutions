import { useMemo, useState, useRef, useEffect } from 'react';

export default function Controls({
  teams,
  members,
  cycles,
  memberProjects,
  selectedTeams,
  onTeamsChange,
  selectedPersons,
  onPersonsChange,
  selectedProjects,
  onProjectsChange,
  selectedCycles,
  onCyclesChange,
  viewMode,
  onViewModeChange,
  capacity,
  onCapacityChange,
  bufferEnabled,
  bufferPercent,
  onBufferToggle,
  onBufferPercentChange,
  onRefresh,
  isLoading,
  sortBy,
  onSortChange,
  onOpenReport,
  isSchedulerActive,
}) {
  const personList = useMemo(() => {
    if (!members) return [];
    let list = Object.values(members);
    if (selectedTeams.length > 0) {
      list = list.filter((m) => m.teams.some((t) => selectedTeams.includes(t)));
    }
    if (selectedProjects.length > 0 && memberProjects) {
      list = list.filter((m) => {
        const mp = memberProjects[m.id];
        return mp && selectedProjects.some((pid) => mp[pid]);
      });
    }
    return list
      .filter((m) => Object.keys(m.cycles).length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [members, selectedTeams, selectedProjects, memberProjects]);

  const projectList = useMemo(() => {
    if (!memberProjects) return [];
    const projectMap = {};
    for (const [memberId, mp] of Object.entries(memberProjects)) {
      const member = members?.[memberId];
      if (!member) continue;
      if (selectedTeams.length > 0 && !member.teams.some((t) => selectedTeams.includes(t))) continue;
      if (selectedPersons.length > 0 && !selectedPersons.includes(memberId)) continue;
      for (const [projectId, projData] of Object.entries(mp)) {
        if (projectId === '__no_project__') continue;
        if (!projectMap[projectId]) {
          projectMap[projectId] = { id: projectId, name: projData.name, pts: 0 };
        }
        projectMap[projectId].pts += projData.totalEstimate;
      }
    }
    return Object.values(projectMap).sort((a, b) => b.pts - a.pts);
  }, [memberProjects, members, selectedTeams, selectedPersons]);

  const cycleList = useMemo(() => {
    if (!cycles) return [];
    let list = [...cycles].filter((c) => c.issueStats && c.issueStats.total > 0);
    if (selectedTeams.length > 0) {
      // Show cycles owned by selected teams, plus cycles where selected-team members have work
      const teamMemberIds = new Set();
      for (const t of (teams || [])) {
        if (selectedTeams.includes(t.id)) {
          (members[t.id]?.teams || []).forEach((mid) => teamMemberIds.add(mid));
          // Use team members from model teams
          for (const [mid, m] of Object.entries(members)) {
            if (m.teams.includes(t.id)) teamMemberIds.add(mid);
          }
        }
      }
      list = list.filter((c) => {
        if (selectedTeams.includes(c.teamId)) return true;
        for (const mid of teamMemberIds) {
          if (members[mid]?.cycles[c.id]) return true;
        }
        return false;
      });
    }
    return list.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  }, [cycles, teams, members, selectedTeams]);

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6 px-5 py-3.5 rounded-xl bg-white border border-[var(--border)] shadow-sm">
      {/* Team filter */}
      <MultiSelect
        label="Team"
        options={teams.map((t) => ({ id: t.id, name: t.name }))}
        selected={selectedTeams}
        onChange={onTeamsChange}
        placeholder="All Teams"
      />

      {/* Person filter */}
      <MultiSelect
        label="Person"
        options={personList.map((m) => ({ id: m.id, name: m.name }))}
        selected={selectedPersons}
        onChange={onPersonsChange}
        placeholder="All People"
      />

      {/* Project filter */}
      <MultiSelect
        label="Project"
        options={projectList.map((p) => ({ id: p.id, name: p.name }))}
        selected={selectedProjects}
        onChange={onProjectsChange}
        placeholder="All Projects"
      />

      {/* Cycle filter */}
      <MultiSelect
        label="Cycle"
        options={cycleList.map((c) => ({
          id: c.id,
          name: c.teamName ? `${c.name} (${c.teamName})` : c.name,
        }))}
        selected={selectedCycles}
        onChange={onCyclesChange}
        placeholder="All Cycles"
      />

      {/* View mode toggle */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
        <button
          onClick={() => onViewModeChange('cycles')}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            viewMode === 'cycles'
              ? 'bg-white text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          Cycles
        </button>
        <button
          onClick={() => onViewModeChange('projects')}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            viewMode === 'projects'
              ? 'bg-white text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          Projects
        </button>
      </div>

      {/* Capacity */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Capacity</label>
        <input
          type="number"
          value={capacity}
          onChange={(e) => onCapacityChange(Number(e.target.value))}
          min={1}
          max={100}
          className="w-16 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] text-center outline-none focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)]/20"
        />
        <span className="text-xs text-[var(--text-muted)]">pts</span>
      </div>

      <div className="w-px h-8 bg-[var(--border)]" />

      {/* Buffer toggle */}
      <div className="flex items-center gap-2.5">
        <div className="flex flex-col">
          <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Buffer</label>
          {bufferEnabled && (
            <span className="text-[10px] text-amber-600 font-medium">
              Eff: {Math.round(capacity * (1 - bufferPercent / 100))}pts
            </span>
          )}
        </div>
        <button
          onClick={onBufferToggle}
          className={`relative w-11 h-6 rounded-full transition-all duration-500 ${
            bufferEnabled ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.25)]' : 'bg-gray-200'
          }`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-500 ${
            bufferEnabled ? 'translate-x-5' : 'translate-x-0'
          }`} />
        </button>
        {bufferEnabled && (
          <select
            value={bufferPercent}
            onChange={(e) => onBufferPercentChange(Number(e.target.value))}
            className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
          >
            <option value={10}>10%</option>
            <option value={15}>15%</option>
            <option value={20}>20%</option>
            <option value={25}>25%</option>
            <option value={30}>30%</option>
          </select>
        )}
      </div>

      {/* Sort */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Sort</label>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)]/20"
        >
          <option value="name">Name</option>
          <option value="utilization">Utilization (High→Low)</option>
          <option value="bandwidth">Bandwidth</option>
          {viewMode === 'projects' && (
            <option value="points">Points (High→Low)</option>
          )}
        </select>
      </div>

      {/* Actions */}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onOpenReport}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--text-secondary)] hover:bg-gray-50 transition-colors shadow-sm"
        >
          <span>&#x2913;</span>
          Report
          {isSchedulerActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Scheduler active" />
          )}
        </button>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[var(--accent-blue)] text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 shadow-sm"
        >
          <span className={isLoading ? 'animate-spin' : ''}>↻</span>
          {isLoading ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </div>
  );
}

function MultiSelect({ label, options, selected, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = search
    ? options.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (id) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const selectedNames = selected
    .map((id) => options.find((o) => o.id === id)?.name)
    .filter(Boolean);

  return (
    <div className="relative" ref={ref}>
      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider block mb-0.5">
        {label}
      </label>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 min-w-[130px] max-w-[240px] bg-[var(--bg-primary)] border rounded-lg px-3 py-1.5 text-sm text-left outline-none transition-colors ${
          open ? 'border-[var(--accent-blue)] ring-1 ring-[var(--accent-blue)]/20' : 'border-[var(--border)]'
        }`}
      >
        <span className="truncate flex-1 text-[var(--text-primary)]">
          {selected.length === 0
            ? <span className="text-[var(--text-muted)]">{placeholder}</span>
            : selected.length === 1
              ? selectedNames[0]
              : `${selected.length} selected`
          }
        </span>
        <span className="text-[var(--text-muted)] text-[10px]">▼</span>
      </button>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 max-w-[240px]">
          {selectedNames.map((name, i) => (
            <span
              key={selected[i]}
              className="inline-flex items-center gap-1 text-[10px] font-medium bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-md"
            >
              {name.length > 14 ? name.slice(0, 12) + '…' : name}
              <button
                onClick={(e) => { e.stopPropagation(); toggle(selected[i]); }}
                className="text-blue-400 hover:text-blue-600"
              >
                ×
              </button>
            </span>
          ))}
          {selected.length > 1 && (
            <button
              onClick={() => onChange([])}
              className="text-[10px] text-[var(--text-muted)] hover:text-red-500 px-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-white border border-[var(--border)] rounded-xl shadow-lg overflow-hidden min-w-[200px] max-h-[280px] flex flex-col">
          {options.length > 6 && (
            <div className="px-3 py-2 border-b border-gray-100">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full text-xs bg-gray-50 border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-[var(--accent-blue)]"
                autoFocus
              />
            </div>
          )}
          <div className="overflow-y-auto">
            {filtered.map((opt) => {
              const isSelected = selected.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  onClick={() => toggle(opt.id)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors ${
                    isSelected ? 'bg-blue-50' : ''
                  }`}
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    isSelected ? 'bg-[var(--accent-blue)] border-[var(--accent-blue)]' : 'border-gray-300'
                  }`}>
                    {isSelected && <span className="text-white text-[8px] font-bold">✓</span>}
                  </span>
                  <span className={isSelected ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'}>
                    {opt.name}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)] text-center">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
