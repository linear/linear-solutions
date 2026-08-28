import { useState, useEffect, useCallback } from 'react';
import { fetchAllData, loadSnapshot } from './data/linearApi';
import { buildCapacityModel, recalculateWithCapacity } from './data/capacityModel';
import { DEFAULT_CONFIG, getWorkingDays } from './utils/calculations';
import SummaryStats from './components/SummaryStats';
import CapacityHeatmap from './components/CapacityHeatmap';
import CapacityCalendar from './components/CapacityCalendar';
import Controls from './components/Controls';
import ReportPanel from './components/ReportPanel';
import { useReportScheduler } from './hooks/useReportScheduler';

function App() {
  const [model, setModel] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [usingCache, setUsingCache] = useState(false);
  const [cacheTimestamp, setCacheTimestamp] = useState(null);

  const [selectedTeams, setSelectedTeams] = useState([]);
  const [selectedPersons, setSelectedPersons] = useState([]);
  const [selectedProjects, setSelectedProjects] = useState([]);
  const [selectedCycles, setSelectedCycles] = useState([]);
  const [viewMode, setViewMode] = useState('cycles');
  const [capacity, setCapacity] = useState(DEFAULT_CONFIG.defaultCapacityPerCycle);
  const [bufferEnabled, setBufferEnabled] = useState(false);
  const [bufferPercent, setBufferPercent] = useState(DEFAULT_CONFIG.bufferPercent);
  const [sortBy, setSortBy] = useState('name');
  const [availability, setAvailability] = useState({});
  const [ptoDays, setPtoDays] = useState({});
  const [reportPanelOpen, setReportPanelOpen] = useState(false);

  const handleAvailabilityChange = useCallback((memberId, cycleId, value) => {
    setAvailability((prev) => ({
      ...prev,
      [memberId]: {
        ...(prev[memberId] || {}),
        [cycleId]: value,
      },
    }));
  }, []);

  const handlePtoDaysChange = useCallback((memberId, cycleId, days, cycleDates) => {
    setPtoDays((prev) => ({
      ...prev,
      [memberId]: {
        ...(prev[memberId] || {}),
        [cycleId]: days,
      },
    }));
    const workingDays = getWorkingDays(cycleDates.startsAt, cycleDates.endsAt);
    const avail = workingDays > 0 ? Math.max(0, (workingDays - days) / workingDays) : 1.0;
    setAvailability((prev) => ({
      ...prev,
      [memberId]: {
        ...(prev[memberId] || {}),
        [cycleId]: avail,
      },
    }));
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setUsingCache(false);

    const isDemo = new URLSearchParams(window.location.search).get('demo') === 'true';
    try {
      if (isDemo) throw new Error('Demo mode');
      const rawData = await fetchAllData();
      const capacityModel = buildCapacityModel(rawData, { defaultCapacityPerCycle: capacity });
      setModel(capacityModel);
    } catch (err) {
      console.warn('Live fetch failed, trying snapshot:', err.message);
      try {
        const snapshot = await loadSnapshot();
        if (snapshot && snapshot.teams && snapshot.teams.length > 0) {
          const rawData = {
            teams: snapshot.teams || [],
            cycles: snapshot.cycles || [],
            projects: snapshot.projects || [],
            issues: snapshot.sampleIssues || [],
            timestamp: snapshot.timestamp,
          };
          const capacityModel = buildCapacityModel(rawData, { defaultCapacityPerCycle: capacity });
          setModel(capacityModel);
          setUsingCache(true);
          setCacheTimestamp(snapshot.timestamp);
        } else {
          setError(err.message);
        }
      } catch {
        setError(err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [capacity]);

  const scheduler = useReportScheduler(model, loadData);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (model) {
      setModel((prev) => recalculateWithCapacity(prev, capacity));
    }
  }, [capacity]);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--bg-primary)]">
        <div className="max-w-[1800px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--accent-blue)] flex items-center justify-center text-white font-bold text-sm shadow-sm">
              CP
            </div>
            <div>
              <h1 className="text-lg font-bold text-[var(--text-primary)]">
                Capacity Planning
              </h1>
              <p className="text-xs text-[var(--text-muted)]">
                Team & individual capacity across cycles
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {bufferEnabled && (
              <div className="text-xs text-amber-700 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200 font-medium">
                Buffer active — {Math.round(capacity * (1 - bufferPercent / 100))}pts effective per person
              </div>
            )}
            {model?.timestamp && (
              <div className="text-xs text-[var(--text-muted)]">
                Synced {new Date(model.timestamp).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-6 py-6">
        {/* Cache warning */}
        {usingCache && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm flex items-center gap-2 font-medium">
            <span>⚠️</span>
            <span>
              Showing cached data from{' '}
              {cacheTimestamp ? new Date(cacheTimestamp).toLocaleString() : 'unknown'}. Live sync unavailable.
            </span>
          </div>
        )}

        {/* Error */}
        {error && !model && (
          <div className="text-center py-20">
            <div className="text-red-600 text-lg font-semibold mb-2">Failed to load data</div>
            <div className="text-[var(--text-muted)] text-sm mb-4 max-w-md mx-auto">{error}</div>
            <button
              onClick={loadData}
              className="px-5 py-2 rounded-lg bg-[var(--accent-blue)] text-white text-sm font-medium hover:bg-blue-700 shadow-sm"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading */}
        {isLoading && !model && (
          <div className="text-center py-20">
            <div className="inline-block w-8 h-8 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin mb-4" />
            <div className="text-[var(--text-secondary)] font-medium">Fetching from Linear...</div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              Loading teams, cycles, and issues with pagination
            </div>
          </div>
        )}

        {/* Dashboard */}
        {model && (
          <>
            <SummaryStats
              model={model}
              bufferEnabled={bufferEnabled}
              availability={availability}
              onPersonSelect={(memberId) => setSelectedPersons([memberId])}
              onTeamSelect={(teamId) => setSelectedTeams([teamId])}
            />

            <Controls
              teams={model.teams.filter((t) => t.members.length > 0)}
              members={model.members}
              cycles={model.cycles}
              memberProjects={model.memberProjects}
              selectedTeams={selectedTeams}
              onTeamsChange={setSelectedTeams}
              selectedPersons={selectedPersons}
              onPersonsChange={setSelectedPersons}
              selectedProjects={selectedProjects}
              onProjectsChange={setSelectedProjects}
              selectedCycles={selectedCycles}
              onCyclesChange={setSelectedCycles}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              capacity={capacity}
              onCapacityChange={setCapacity}
              bufferEnabled={bufferEnabled}
              bufferPercent={bufferPercent}
              onBufferToggle={() => setBufferEnabled(!bufferEnabled)}
              onBufferPercentChange={setBufferPercent}
              onRefresh={loadData}
              isLoading={isLoading}
              sortBy={sortBy}
              onSortChange={setSortBy}
              onOpenReport={() => setReportPanelOpen(true)}
              isSchedulerActive={scheduler.isSchedulerActive}
            />

            {viewMode === 'calendar' ? (
              <CapacityCalendar
                model={model}
                selectedTeams={selectedTeams}
                selectedPersons={selectedPersons}
                selectedProjects={selectedProjects}
                selectedCycles={selectedCycles}
                sortBy={sortBy}
                bufferEnabled={bufferEnabled}
                availability={availability}
                ptoDays={ptoDays}
              />
            ) : (
              <CapacityHeatmap
                model={model}
                selectedTeams={selectedTeams}
                selectedPersons={selectedPersons}
                selectedProjects={selectedProjects}
                selectedCycles={selectedCycles}
                viewMode={viewMode}
                sortBy={sortBy}
                bufferEnabled={bufferEnabled}
                availability={availability}
                onAvailabilityChange={handleAvailabilityChange}
                ptoDays={ptoDays}
                onPtoDaysChange={handlePtoDaysChange}
              />
            )}
          </>
        )}
      </main>

      <ReportPanel
        isOpen={reportPanelOpen}
        onClose={() => setReportPanelOpen(false)}
        model={model}
        currentFilters={{
          selectedTeams,
          selectedPersons,
          selectedProjects,
          selectedCycles,
          capacity,
          bufferEnabled,
          bufferPercent,
          availability,
          ptoDays,
        }}
        scheduler={scheduler}
      />
    </div>
  );
}

export default App;
