import { useState, useMemo } from 'react';
import { generateReport } from '../reports/reportGenerator';
import { exportToCsv } from '../reports/csvExporter';
import { pushToSheets, initGoogleAuth, isAuthenticated, clearAuth } from '../reports/sheetsExporter';
import { DEFAULT_ALERT_THRESHOLDS, ALERT_LABELS } from '../reports/reportConfig';
import {
  getUtilizationColorHex,
  getUtilizationColor,
  DEFAULT_CONFIG,
} from '../utils/calculations';

export default function ReportPanel({
  isOpen,
  onClose,
  model,
  currentFilters,
  scheduler,
}) {
  const [activeTab, setActiveTab] = useState('preview');
  const [exporting, setExporting] = useState(false);
  const [sheetsStatus, setSheetsStatus] = useState(null);
  const [googleAuthed, setGoogleAuthed] = useState(isAuthenticated());

  // Report config — starts from current dashboard filters
  const [reportConfig, setReportConfig] = useState(() => ({
    selectedTeams: currentFilters.selectedTeams || [],
    selectedPersons: currentFilters.selectedPersons || [],
    selectedProjects: currentFilters.selectedProjects || [],
    capacity: currentFilters.capacity || 20,
    bufferEnabled: currentFilters.bufferEnabled || false,
    bufferPercent: currentFilters.bufferPercent || 20,
    availability: currentFilters.availability || {},
    alertThresholds: { ...DEFAULT_ALERT_THRESHOLDS },
  }));

  const [sheetsSpreadsheetId, setSheetsSpreadsheetId] = useState(
    scheduler?.config?.sheetsConfig?.spreadsheetId || ''
  );
  const [createNewSheet, setCreateNewSheet] = useState(true);

  // Generate preview
  const preview = useMemo(() => {
    if (!model) return null;
    try {
      return generateReport(model, reportConfig);
    } catch {
      return null;
    }
  }, [model, reportConfig]);

  if (!isOpen) return null;

  const handleExportCsv = () => {
    if (!preview) return;
    exportToCsv(preview);
  };

  const handleGoogleAuth = async () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) {
      setSheetsStatus({ error: 'Set VITE_GOOGLE_CLIENT_ID in .env first' });
      return;
    }
    try {
      await initGoogleAuth(clientId);
      setGoogleAuthed(true);
      setSheetsStatus({ success: 'Authenticated with Google' });
    } catch (err) {
      setSheetsStatus({ error: err.message });
    }
  };

  const handlePushToSheets = async () => {
    if (!preview) return;
    setExporting(true);
    setSheetsStatus(null);
    try {
      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
      const result = await pushToSheets(preview, {
        spreadsheetId: createNewSheet ? null : sheetsSpreadsheetId || null,
        clientId,
      });
      setSheetsStatus({
        success: 'Report pushed to Google Sheets',
        url: result.url,
        spreadsheetId: result.spreadsheetId,
      });
      if (result.spreadsheetId) {
        setSheetsSpreadsheetId(result.spreadsheetId);
      }
    } catch (err) {
      setSheetsStatus({ error: err.message });
    } finally {
      setExporting(false);
    }
  };

  const handleSignOut = () => {
    clearAuth();
    setGoogleAuthed(false);
    setSheetsStatus(null);
  };

  const updateThreshold = (key, value) => {
    setReportConfig((prev) => ({
      ...prev,
      alertThresholds: { ...prev.alertThresholds, [key]: Number(value) },
    }));
  };

  const tabs = [
    { id: 'preview', label: 'Preview' },
    { id: 'export', label: 'Export' },
    { id: 'configure', label: 'Configure' },
    { id: 'schedule', label: 'Schedule' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">
              Capacity Report
            </h2>
            {preview && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {preview.teamOverview.length} teams · {preview.individualLoad.length} people · {preview.alerts.length} alerts
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-[var(--text-muted)] text-lg"
          >
            x
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)] px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeTab === 'preview' && <PreviewTab preview={preview} />}
          {activeTab === 'export' && (
            <ExportTab
              preview={preview}
              onExportCsv={handleExportCsv}
              onGoogleAuth={handleGoogleAuth}
              onPushToSheets={handlePushToSheets}
              onSignOut={handleSignOut}
              googleAuthed={googleAuthed}
              exporting={exporting}
              sheetsStatus={sheetsStatus}
              sheetsSpreadsheetId={sheetsSpreadsheetId}
              setSheetsSpreadsheetId={setSheetsSpreadsheetId}
              createNewSheet={createNewSheet}
              setCreateNewSheet={setCreateNewSheet}
            />
          )}
          {activeTab === 'configure' && (
            <ConfigureTab
              reportConfig={reportConfig}
              setReportConfig={setReportConfig}
              updateThreshold={updateThreshold}
              model={model}
              currentFilters={currentFilters}
            />
          )}
          {activeTab === 'schedule' && (
            <ScheduleTab scheduler={scheduler} reportConfig={reportConfig} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Utilization helpers ───

const thresholds = DEFAULT_CONFIG.utilizationThresholds;

function UtilBar({ percent, size = 'md' }) {
  const color = getUtilizationColorHex(percent, thresholds);
  const h = size === 'sm' ? 'h-1.5' : 'h-2';
  return (
    <div className={`w-full ${h} bg-gray-100 rounded-full overflow-hidden`}>
      <div
        className={`${h} rounded-full transition-all`}
        style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

function UtilBadge({ percent }) {
  const color = getUtilizationColor(percent, thresholds);
  const classes = {
    green: 'bg-green-100 text-green-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    orange: 'bg-orange-100 text-orange-700',
    red: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${classes[color]}`}>
      {percent}%
    </span>
  );
}

// ─── Preview Tab ───

function PreviewTab({ preview }) {
  const [expandedPerson, setExpandedPerson] = useState(null);

  if (!preview) {
    return (
      <div className="text-center py-8 text-[var(--text-muted)]">
        No data available to preview
      </div>
    );
  }

  // Sort individuals by peak utilization descending
  const sortedIndividuals = [...preview.individualLoad].sort(
    (a, b) => b.peakUtilization - a.peakUtilization
  );

  return (
    <div className="space-y-6">
      {/* Alerts banner */}
      {preview.alerts.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-semibold text-red-800 mb-2">
            {preview.alerts.length} Alert{preview.alerts.length !== 1 ? 's' : ''}
          </h3>
          <div className="space-y-1.5 max-h-28 overflow-y-auto">
            {preview.alerts.map((a, i) => {
              const dotColor =
                a.type === 'over_capacity' || a.type === 'project_at_risk' ? 'bg-red-500'
                : a.type === 'near_capacity' || a.type === 'project_behind_schedule' ? 'bg-orange-500'
                : a.type === 'high_unplanned' || a.type === 'project_watch' ? 'bg-amber-500'
                : 'bg-yellow-500';
              const description =
                a.type === 'over_capacity' ? `Over capacity at ${a.value}%`
                : a.type === 'near_capacity' ? `Near capacity at ${a.value}%`
                : a.type === 'high_unplanned' ? `${a.value}% unplanned work`
                : a.type === 'low_estimation' ? `Only ${a.value}% estimated`
                : a.type === 'project_at_risk' ? `${a.value} risk signals`
                : a.type === 'project_watch' ? `${a.value} risk signal(s)`
                : a.type === 'project_behind_schedule' ? `Behind schedule`
                : ALERT_LABELS[a.type] || a.type;
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                  <span className="font-medium text-red-900">{a.entity}</span>
                  <span className="text-red-600">{description}</span>
                  {a.detail && <span className="text-red-400 text-[10px]">({a.detail})</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Team Overview */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          Team Overview
        </h3>
        <div className="grid gap-3">
          {preview.teamOverview.map((team) => (
            <div
              key={team.teamId}
              className="rounded-xl border border-[var(--border)] p-4 bg-[var(--bg-primary)]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-[var(--text-primary)]">{team.teamName}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {team.memberCount} people · {team.activeCycles} cycle{team.activeCycles !== 1 ? 's' : ''}
                  </span>
                </div>
                <UtilBadge percent={team.avgUtilization} />
              </div>
              <UtilBar percent={team.avgUtilization} />
              <div className="flex items-center gap-4 mt-2 text-[10px] text-[var(--text-muted)]">
                <span>{team.totalLoad}/{team.totalCapacity} pts</span>
                {team.unplannedPct > 0 && (
                  <span className="text-amber-600">{team.unplannedPct}% unplanned</span>
                )}
                {team.borrowedOut > 0 && (
                  <span className="text-blue-600">{team.borrowedOut}pts loaned out</span>
                )}
                {team.borrowedIn > 0 && (
                  <span className="text-purple-600">{team.borrowedIn}pts borrowed in</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Individual Load */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          Individual Load ({sortedIndividuals.length} people)
        </h3>
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          {/* Table header */}
          <div className="flex items-center bg-gray-50 px-4 py-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border)]">
            <div className="w-44 shrink-0">Person</div>
            <div className="w-28 shrink-0">Team(s)</div>
            <div className="flex-1">Per-Cycle Breakdown</div>
            <div className="w-20 text-right shrink-0">Peak</div>
          </div>

          {sortedIndividuals.map((person) => {
            const isExpanded = expandedPerson === person.memberId;
            return (
              <div key={person.memberId}>
                <button
                  onClick={() => setExpandedPerson(isExpanded ? null : person.memberId)}
                  className="w-full flex items-center px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors border-b border-gray-100 text-left"
                >
                  <div className="w-44 shrink-0 flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-50 flex items-center justify-center text-[10px] font-semibold text-blue-600 shrink-0">
                      {person.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[var(--text-primary)] truncate">{person.name}</div>
                      {person.crossTeamCount >= 2 && (
                        <div className="text-[9px] text-blue-600">{person.crossTeamCount} teams</div>
                      )}
                    </div>
                  </div>
                  <div className="w-28 shrink-0 text-[10px] text-[var(--text-muted)] truncate">
                    {person.teams.join(', ')}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    {person.cycleBreakdowns.map((cb) => (
                      <div
                        key={cb.cycleId}
                        className="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1"
                        title={`${cb.cycleName} (${cb.teamName}): ${cb.load}/${cb.capacity}pts = ${cb.utilization}%`}
                      >
                        <span className="text-[10px] text-[var(--text-muted)]">{cb.cycleName}</span>
                        <span
                          className="text-[10px] font-semibold"
                          style={{ color: getUtilizationColorHex(cb.utilization, thresholds) }}
                        >
                          {cb.load}/{cb.capacity}
                        </span>
                        <div className="w-10">
                          <UtilBar percent={cb.utilization} size="sm" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="w-20 text-right shrink-0">
                    <UtilBadge percent={person.peakUtilization} />
                  </div>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="bg-gray-50 border-b border-[var(--border)] px-4 py-3">
                    {person.cycleBreakdowns.map((cb) => (
                      <div key={cb.cycleId} className="mb-3 last:mb-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-semibold text-[var(--text-primary)]">
                            {cb.cycleName}
                          </span>
                          <span className="text-[10px] text-[var(--text-muted)]">{cb.teamName}</span>
                          <UtilBadge percent={cb.utilization} />
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {cb.load}pts / {cb.capacity}pts capacity
                            {cb.availability < 1 && ` (${Math.round(cb.availability * 100)}% avail)`}
                          </span>
                        </div>

                        {/* Breakdown stats */}
                        <div className="flex gap-4 text-[10px] text-[var(--text-muted)] mb-2">
                          <span>Planned: {cb.plannedWork}pts</span>
                          {cb.unplannedWork > 0 && (
                            <span className="text-amber-600">Unplanned: {cb.unplannedWork}pts</span>
                          )}
                          <span>Estimated: {cb.estimatedCount} issues</span>
                          {cb.unestimatedCount > 0 && (
                            <span className="text-orange-600">Unestimated: {cb.unestimatedCount}</span>
                          )}
                        </div>

                        {/* Issue list */}
                        {cb.issues && cb.issues.length > 0 && (
                          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                            <div className="flex items-center px-3 py-1.5 bg-gray-50 text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-gray-200">
                              <div className="flex-1">Issue</div>
                              <div className="w-24">Project</div>
                              <div className="w-16 text-center">Estimate</div>
                              <div className="w-20 text-center">State</div>
                            </div>
                            {cb.issues.map((issue, idx) => (
                              <div
                                key={idx}
                                className="flex items-center px-3 py-1.5 text-[11px] border-b border-gray-50 last:border-0"
                              >
                                <div className="flex-1 flex items-center gap-1.5 min-w-0">
                                  <span className="text-[var(--text-primary)] truncate">{issue.title}</span>
                                  {issue.isUnplanned && (
                                    <span className="text-[8px] bg-amber-100 text-amber-700 px-1 py-px rounded font-medium shrink-0">
                                      unplanned
                                    </span>
                                  )}
                                </div>
                                <div className="w-24 text-[var(--text-muted)] truncate">{issue.project}</div>
                                <div className="w-16 text-center font-medium text-[var(--text-primary)]">
                                  {issue.estimate > 0 ? `${issue.estimate}pts` : (
                                    <span className="text-orange-500">none</span>
                                  )}
                                </div>
                                <div className="w-20 text-center">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                    issue.stateType === 'completed' ? 'bg-green-100 text-green-700'
                                    : issue.stateType === 'started' ? 'bg-blue-100 text-blue-700'
                                    : issue.stateType === 'cancelled' ? 'bg-gray-200 text-gray-500'
                                    : 'bg-gray-100 text-[var(--text-muted)]'
                                  }`}>
                                    {issue.state || 'Unknown'}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Project Allocation */}
      {preview.projectAllocation.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            Project Allocation ({preview.projectAllocation.length})
          </h3>
          <div className="grid gap-2">
            {preview.projectAllocation.map((p) => {
              const cycleStatusStyles = {
                active: 'bg-green-100 text-green-700',
                upcoming: 'bg-blue-100 text-blue-700',
                past: 'bg-gray-100 text-gray-500',
                unplanned: 'bg-amber-100 text-amber-700',
              };
              const riskBadgeStyles = {
                high: 'bg-red-100 text-red-700',
                medium: 'bg-amber-100 text-amber-700',
              };
              return (
                <div
                  key={p.projectId}
                  className={`rounded-lg border px-4 py-3 bg-[var(--bg-primary)] ${
                    p.riskLevel === 'high' ? 'border-red-200' : p.riskLevel === 'medium' ? 'border-amber-200' : 'border-[var(--border)]'
                  }`}
                >
                  {/* Row 1: Name + badges + total */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{p.projectName}</span>
                      {riskBadgeStyles[p.riskLevel] && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${riskBadgeStyles[p.riskLevel]}`}>
                          {p.riskLevel === 'high' ? 'AT RISK' : 'WATCH'}
                        </span>
                      )}
                      {p.cycleStatus && (
                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${cycleStatusStyles[p.cycleStatus] || ''}`}>
                          {p.cycleStatus}
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-bold text-[var(--text-primary)] shrink-0">{p.totalEstimate} pts</span>
                  </div>

                  {/* Row 2: Planned/Unplanned bar + Issue state counts */}
                  {p.totalEstimate > 0 && (
                    <div className="flex items-center gap-3 mb-1.5">
                      <div className="flex-1">
                        <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden flex">
                          <div
                            className="h-1.5 bg-blue-400 rounded-l-full"
                            style={{ width: `${Math.round((p.plannedWork / p.totalEstimate) * 100)}%` }}
                          />
                          {p.unplannedWork > 0 && (
                            <div
                              className="h-1.5 bg-amber-400"
                              style={{ width: `${Math.round((p.unplannedWork / p.totalEstimate) * 100)}%` }}
                            />
                          )}
                        </div>
                        {p.unplannedPct > 0 && (
                          <div className="text-[9px] text-amber-600 mt-0.5">{p.unplannedPct}% unplanned</div>
                        )}
                      </div>
                      {p.totalIssueCount > 0 && (
                        <div className="flex items-center gap-2 text-[10px] shrink-0">
                          {p.issuesByState.completed > 0 && (
                            <span className="text-green-600">{p.issuesByState.completed} done</span>
                          )}
                          {p.issuesByState.started > 0 && (
                            <span className="text-blue-600">{p.issuesByState.started} started</span>
                          )}
                          {p.issuesByState.backlog > 0 && (
                            <span className="text-gray-500">{p.issuesByState.backlog} backlog</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Row 3: Estimation coverage */}
                  {p.totalIssueCount > 0 && p.estimationCoverage < 100 && (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="w-16 h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-1 rounded-full ${p.estimationCoverage >= 70 ? 'bg-green-400' : p.estimationCoverage >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
                          style={{ width: `${p.estimationCoverage}%` }}
                        />
                      </div>
                      <span className="text-[9px] text-[var(--text-muted)]">{p.estimationCoverage}% estimated</span>
                    </div>
                  )}

                  {/* Members */}
                  <div className="flex flex-wrap gap-1.5">
                    {p.members.map((m, i) => (
                      <span key={i} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md font-medium">
                        {m.name} <span className="text-blue-400">{m.estimate}pts</span>
                      </span>
                    ))}
                  </div>

                  {/* Team breakdown chips (multi-team projects) */}
                  {p.teamBreakdown && p.teamBreakdown.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {p.teamBreakdown.map((t, i) => (
                        <span key={i} className="text-[9px] bg-purple-50 text-purple-700 px-2 py-0.5 rounded-md font-medium">
                          {t.name} <span className="text-purple-400">{t.estimate}pts · {t.memberCount}p</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Dates + progress */}
                  {(p.startDate || p.targetDate) && (
                    <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
                      {p.startDate || '?'} - {p.targetDate || '?'}
                      {p.progress != null && <span className="ml-2 font-medium">{p.progress}% complete</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cross-Team */}
      {preview.crossTeamCommitments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            Cross-Team Commitments
          </h3>
          <div className="space-y-2">
            {preview.crossTeamCommitments.map((ct, i) => (
              <div key={i} className="rounded-lg border border-blue-100 bg-blue-50/50 px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">{ct.memberName}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">Home: {ct.homeTeam}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ct.commitments.map((c, j) => (
                    <span key={j} className="text-[10px] bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded-md">
                      {c.teamName} / {c.cycleName}: <span className="font-semibold">{c.estimate}pts</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unestimated Issues */}
      {preview.unestimatedIssues.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-orange-700 mb-3">
            Unestimated Issues ({preview.unestimatedIssues.length})
          </h3>
          <div className="rounded-xl border border-orange-200 bg-orange-50 overflow-hidden max-h-48 overflow-y-auto">
            <div className="flex items-center px-4 py-2 bg-orange-100/50 text-[9px] font-semibold text-orange-700 uppercase tracking-wider border-b border-orange-200">
              <div className="w-28 shrink-0">Person</div>
              <div className="w-20 shrink-0">Cycle</div>
              <div className="flex-1">Issue</div>
              <div className="w-24">Project</div>
              <div className="w-20 text-right">State</div>
            </div>
            {preview.unestimatedIssues.map((u, i) => (
              <div key={i} className="flex items-center px-4 py-1.5 text-[11px] border-b border-orange-100 last:border-0">
                <div className="w-28 shrink-0 text-[var(--text-primary)] font-medium truncate">{u.memberName}</div>
                <div className="w-20 shrink-0 text-[var(--text-muted)]">{u.cycleName}</div>
                <div className="flex-1 text-[var(--text-primary)] truncate">{u.issueTitle}</div>
                <div className="w-24 text-[var(--text-muted)] truncate">{u.project}</div>
                <div className="w-20 text-right text-[var(--text-muted)]">{u.state}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Export Tab ───

function ExportTab({
  preview,
  onExportCsv,
  onGoogleAuth,
  onPushToSheets,
  onSignOut,
  googleAuthed,
  exporting,
  sheetsStatus,
  sheetsSpreadsheetId,
  setSheetsSpreadsheetId,
  createNewSheet,
  setCreateNewSheet,
}) {
  if (!preview) {
    return (
      <div className="text-center py-8 text-[var(--text-muted)]">
        No data available to export
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-3">
        <SummaryCard label="Teams" value={preview.teamOverview.length} />
        <SummaryCard label="People" value={preview.individualLoad.length} />
        <SummaryCard label="Projects" value={preview.projectAllocation.length} />
        <SummaryCard label="Alerts" value={preview.alerts.length} highlight={preview.alerts.length > 0} />
      </div>

      {/* CSV */}
      <div className="border-t border-[var(--border)] pt-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">CSV Download</h3>
        <div className="flex items-center gap-4">
          <button
            onClick={onExportCsv}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent-blue)] text-white text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm"
          >
            <span>&#x2913;</span>
            Download CSV
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            Includes all sections: teams, individuals with issue details, projects, cross-team, alerts
          </span>
        </div>
      </div>

      {/* Google Sheets */}
      <div className="border-t border-[var(--border)] pt-5">
        <div className="bg-gray-50 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Google Sheets
            </h3>
            {googleAuthed ? (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Connected
                </span>
                <button
                  onClick={onSignOut}
                  className="text-[10px] text-[var(--text-muted)] hover:text-red-500"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={onGoogleAuth}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium px-3 py-1 border border-blue-200 rounded-lg hover:bg-blue-50"
              >
                Sign in with Google
              </button>
            )}
          </div>

          {googleAuthed && (
            <>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="radio"
                    checked={createNewSheet}
                    onChange={() => setCreateNewSheet(true)}
                    className="accent-blue-600"
                  />
                  Create new spreadsheet
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="radio"
                    checked={!createNewSheet}
                    onChange={() => setCreateNewSheet(false)}
                    className="accent-blue-600"
                  />
                  Update existing
                </label>
              </div>

              {!createNewSheet && (
                <input
                  type="text"
                  value={sheetsSpreadsheetId}
                  onChange={(e) => setSheetsSpreadsheetId(e.target.value)}
                  placeholder="Spreadsheet ID"
                  className="w-full bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              )}

              <button
                onClick={onPushToSheets}
                disabled={exporting || (!createNewSheet && !sheetsSpreadsheetId)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50"
              >
                {exporting ? (
                  <>
                    <span className="animate-spin">&#8635;</span>
                    Pushing...
                  </>
                ) : (
                  <>
                    <span>&#x2197;</span>
                    Push to Google Sheets
                  </>
                )}
              </button>
              <p className="text-[10px] text-[var(--text-muted)]">
                Creates 5 tabs: Overview, Individual Load (with issue details), Projects, Cross-Team, Alerts
              </p>
            </>
          )}

          {sheetsStatus?.success && (
            <div className="text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">
              {sheetsStatus.success}
              {sheetsStatus.url && (
                <>
                  {' — '}
                  <a
                    href={sheetsStatus.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-medium"
                  >
                    Open Sheet
                  </a>
                </>
              )}
            </div>
          )}
          {sheetsStatus?.error && (
            <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {sheetsStatus.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, highlight }) {
  return (
    <div
      className={`rounded-xl px-4 py-3 text-center ${
        highlight ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'
      }`}
    >
      <div className={`text-xl font-bold ${highlight ? 'text-red-600' : 'text-[var(--text-primary)]'}`}>
        {value}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold mt-0.5">
        {label}
      </div>
    </div>
  );
}

// ─── Configure Tab ───

function ConfigureTab({
  reportConfig,
  setReportConfig,
  updateThreshold,
  model,
  currentFilters,
}) {
  const inheritFilters = () => {
    setReportConfig((prev) => ({
      ...prev,
      selectedTeams: currentFilters.selectedTeams || [],
      selectedPersons: currentFilters.selectedPersons || [],
      selectedProjects: currentFilters.selectedProjects || [],
      capacity: currentFilters.capacity || 20,
      bufferEnabled: currentFilters.bufferEnabled || false,
      bufferPercent: currentFilters.bufferPercent || 20,
      availability: currentFilters.availability || {},
    }));
  };

  const teamNames = reportConfig.selectedTeams.length > 0
    ? reportConfig.selectedTeams
        .map((id) => model.teams.find((t) => t.id === id)?.name)
        .filter(Boolean)
    : ['All'];

  const personNames = reportConfig.selectedPersons.length > 0
    ? reportConfig.selectedPersons
        .map((id) => model.members[id]?.name)
        .filter(Boolean)
    : ['All'];

  const projectNames = reportConfig.selectedProjects.length > 0
    ? reportConfig.selectedProjects
        .map((id) => model.projects.find((p) => p.id === id)?.name)
        .filter(Boolean)
    : ['All'];

  return (
    <div className="space-y-6">
      {/* Filter snapshot */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Filters
          </h3>
          <button
            onClick={inheritFilters}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            Sync from dashboard
          </button>
        </div>
        <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-[var(--text-muted)] w-16 shrink-0">Teams:</span>
            <span className="text-[var(--text-primary)]">{teamNames.join(', ')}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-[var(--text-muted)] w-16 shrink-0">People:</span>
            <span className="text-[var(--text-primary)]">{personNames.join(', ')}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-[var(--text-muted)] w-16 shrink-0">Projects:</span>
            <span className="text-[var(--text-primary)]">{projectNames.join(', ')}</span>
          </div>
        </div>
      </div>

      {/* Capacity settings */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          Capacity Settings
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-[var(--text-muted)] block mb-1">
              Points per cycle
            </label>
            <input
              type="number"
              value={reportConfig.capacity}
              onChange={(e) =>
                setReportConfig((p) => ({ ...p, capacity: Number(e.target.value) }))
              }
              min={1}
              max={100}
              className="w-full bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--text-muted)] block mb-1">
              Buffer
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setReportConfig((p) => ({
                    ...p,
                    bufferEnabled: !p.bufferEnabled,
                  }))
                }
                className={`relative w-10 h-5 rounded-full transition-all ${
                  reportConfig.bufferEnabled ? 'bg-amber-500' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                    reportConfig.bufferEnabled ? 'translate-x-5' : ''
                  }`}
                />
              </button>
              {reportConfig.bufferEnabled && (
                <select
                  value={reportConfig.bufferPercent}
                  onChange={(e) =>
                    setReportConfig((p) => ({
                      ...p,
                      bufferPercent: Number(e.target.value),
                    }))
                  }
                  className="bg-white border border-[var(--border)] rounded-lg px-2 py-1 text-xs outline-none"
                >
                  {[10, 15, 20, 25, 30].map((v) => (
                    <option key={v} value={v}>
                      {v}%
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Alert thresholds */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
          Alert Thresholds
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <ThresholdInput
            label="Utilization warning"
            value={reportConfig.alertThresholds.utilizationWarning}
            onChange={(v) => updateThreshold('utilizationWarning', v)}
            suffix="%"
            description="Flag members above this"
          />
          <ThresholdInput
            label="Utilization critical"
            value={reportConfig.alertThresholds.utilizationCritical}
            onChange={(v) => updateThreshold('utilizationCritical', v)}
            suffix="%"
            description="Flag as over-capacity"
          />
          <ThresholdInput
            label="Min estimation coverage"
            value={reportConfig.alertThresholds.estimationCoverageMin}
            onChange={(v) => updateThreshold('estimationCoverageMin', v)}
            suffix="%"
            description="Flag cycles below this"
          />
          <ThresholdInput
            label="Max unplanned work"
            value={reportConfig.alertThresholds.unplannedWorkMax}
            onChange={(v) => updateThreshold('unplannedWorkMax', v)}
            suffix="%"
            description="Flag teams above this"
          />
        </div>
      </div>
    </div>
  );
}

function ThresholdInput({ label, value, onChange, suffix, description }) {
  return (
    <div>
      <label className="text-xs text-[var(--text-muted)] block mb-1">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={0}
          max={200}
          className="w-20 bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <span className="text-xs text-[var(--text-muted)]">{suffix}</span>
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{description}</p>
    </div>
  );
}

// ─── Schedule Tab ───

function ScheduleTab({ scheduler, reportConfig }) {
  if (!scheduler) {
    return (
      <div className="text-center py-8 text-[var(--text-muted)] text-sm">
        Scheduler not available
      </div>
    );
  }

  const { config, setConfig, status, executeReport, enableScheduler, disableScheduler } =
    scheduler;

  const handleRunNow = () => {
    executeReport({ ...config, reportConfig });
  };

  const handleToggle = () => {
    if (config.enabled) {
      disableScheduler();
    } else {
      setConfig((prev) => ({
        ...prev,
        reportConfig,
      }));
      enableScheduler();
    }
  };

  return (
    <div className="space-y-6">
      {/* Enable/disable */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Automatic Reports
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Generate reports on a schedule
          </p>
        </div>
        <button
          onClick={handleToggle}
          className={`relative w-12 h-6 rounded-full transition-all ${
            config.enabled
              ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.25)]'
              : 'bg-gray-200'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
              config.enabled ? 'translate-x-6' : ''
            }`}
          />
        </button>
      </div>

      {/* Warning */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
        Scheduler runs only while this browser tab is open. If the tab is
        closed, missed runs will execute when you reopen it.
      </div>

      {/* Frequency */}
      <div>
        <label className="text-xs text-[var(--text-muted)] block mb-1.5 font-medium">
          Frequency
        </label>
        <div className="flex gap-2">
          {[
            { label: 'Every 8h', value: 8 },
            { label: 'Every 12h', value: 12 },
            { label: 'Daily', value: 24 },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() =>
                setConfig((prev) => ({
                  ...prev,
                  intervalHours: opt.value,
                  nextRun: prev.enabled
                    ? new Date(Date.now() + opt.value * 3600_000).toISOString()
                    : prev.nextRun,
                }))
              }
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                config.intervalHours === opt.value
                  ? 'bg-blue-100 text-blue-700 border border-blue-200'
                  : 'bg-gray-100 text-[var(--text-muted)] hover:bg-gray-200 border border-transparent'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Destination */}
      <div>
        <label className="text-xs text-[var(--text-muted)] block mb-1.5 font-medium">
          Destination
        </label>
        <div className="flex gap-2">
          {[
            { label: 'CSV Download', value: 'csv' },
            { label: 'Google Sheets', value: 'sheets' },
            { label: 'Both', value: 'both' },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() =>
                setConfig((prev) => ({ ...prev, destination: opt.value }))
              }
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                config.destination === opt.value
                  ? 'bg-blue-100 text-blue-700 border border-blue-200'
                  : 'bg-gray-100 text-[var(--text-muted)] hover:bg-gray-200 border border-transparent'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sheets config for scheduler */}
      {(config.destination === 'sheets' || config.destination === 'both') && (
        <div className="bg-gray-50 rounded-xl p-4 space-y-2">
          <label className="text-xs text-[var(--text-muted)] block font-medium">
            Spreadsheet ID (for scheduled pushes)
          </label>
          <input
            type="text"
            value={config.sheetsConfig?.spreadsheetId || ''}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                sheetsConfig: {
                  ...prev.sheetsConfig,
                  spreadsheetId: e.target.value,
                },
              }))
            }
            placeholder="Leave empty to create new each time"
            className="w-full bg-white border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={config.sheetsConfig?.createNewDaily || false}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  sheetsConfig: {
                    ...prev.sheetsConfig,
                    createNewDaily: e.target.checked,
                  },
                }))
              }
              className="accent-blue-600"
            />
            Create new spreadsheet each run
          </label>
        </div>
      )}

      {/* Status */}
      <div className="border-t border-[var(--border)] pt-4 space-y-2">
        {config.enabled && config.nextRun && (
          <div className="text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Next run:</span>{' '}
            {new Date(config.nextRun).toLocaleString()}
          </div>
        )}
        {config.lastRun && (
          <div className="text-xs text-[var(--text-muted)]">
            <span className="font-medium">Last run:</span>{' '}
            {new Date(config.lastRun).toLocaleString()}
          </div>
        )}
        {status.lastResult?.sheetsUrl && (
          <div className="text-xs text-green-600">
            Last report:{' '}
            <a
              href={status.lastResult.sheetsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Open Sheet
            </a>
          </div>
        )}
        {status.lastError && (
          <div className="text-xs text-red-600">Error: {status.lastError}</div>
        )}
      </div>

      {/* Run Now */}
      <button
        onClick={handleRunNow}
        disabled={status.running}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent-blue)] text-white text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
      >
        {status.running ? (
          <>
            <span className="animate-spin">&#8635;</span>
            Generating...
          </>
        ) : (
          'Run Now'
        )}
      </button>
    </div>
  );
}
