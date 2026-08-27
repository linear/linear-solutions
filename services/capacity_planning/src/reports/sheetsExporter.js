/**
 * Google Sheets exporter using OAuth2 popup + Sheets API v4 REST.
 */

import { ALERT_LABELS } from './reportConfig';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

let tokenClient = null;
let accessToken = null;

/**
 * Initialize Google OAuth2 token client.
 * Must be called after the GIS script has loaded.
 */
export function initGoogleAuth(clientId) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services not loaded. Add the GIS script to index.html.'));
      return;
    }
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        accessToken = response.access_token;
        resolve(accessToken);
      },
    });
    // Trigger consent popup
    tokenClient.requestAccessToken();
  });
}

export function isAuthenticated() {
  return !!accessToken;
}

export function clearAuth() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
}

/**
 * Re-authenticate if token expired.
 */
export async function ensureAuth(clientId) {
  if (accessToken) {
    // Test if token is still valid
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + accessToken);
      if (res.ok) return accessToken;
    } catch {
      // Token expired
    }
  }
  return initGoogleAuth(clientId);
}

async function sheetsApi(path, options = {}) {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (res.status === 401) {
    accessToken = null;
    throw new Error('Google auth expired. Please re-authenticate.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Sheets API error: ${res.status}`);
  }
  return res.json();
}

/**
 * Create a new Google Sheet and return its ID and URL.
 */
async function createSpreadsheet(title) {
  const body = {
    properties: { title },
    sheets: [
      { properties: { title: 'Overview' } },
      { properties: { title: 'Individual Load' } },
      { properties: { title: 'Issue Details' } },
      { properties: { title: 'Projects' } },
      { properties: { title: 'Cross-Team' } },
      { properties: { title: 'Alerts' } },
    ],
  };
  const result = await sheetsApi('', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    spreadsheetId: result.spreadsheetId,
    url: result.spreadsheetUrl,
    sheetIds: result.sheets.map((s) => s.properties.sheetId),
  };
}

/**
 * Write values to a range.
 */
async function writeRange(spreadsheetId, range, values) {
  await sheetsApi(
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }
  );
}

// Color helpers for conditional formatting
function utilColor(percent) {
  if (percent <= 60) return { red: 0.86, green: 0.94, blue: 0.83 }; // green-100
  if (percent <= 85) return { red: 0.99, green: 0.96, blue: 0.82 }; // yellow-100
  if (percent <= 100) return { red: 1.0, green: 0.93, blue: 0.84 }; // orange-100
  return { red: 0.99, green: 0.89, blue: 0.89 }; // red-100
}

function utilTextColor(percent) {
  if (percent <= 60) return { red: 0.08, green: 0.4, blue: 0.18 };
  if (percent <= 85) return { red: 0.5, green: 0.34, blue: 0.02 };
  if (percent <= 100) return { red: 0.58, green: 0.22, blue: 0.05 };
  return { red: 0.55, green: 0.1, blue: 0.1 };
}

/**
 * Apply formatting (bold headers, colors, column widths, freeze rows, conditional util coloring).
 */
async function applyFormatting(spreadsheetId, sheetIds, report) {
  const requests = [];

  for (let i = 0; i < sheetIds.length; i++) {
    const sheetId = sheetIds[i];
    // Freeze first row
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    // Bold header row with light blue background
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 10 },
            backgroundColor: { red: 0.85, green: 0.9, blue: 0.98 },
            verticalAlignment: 'MIDDLE',
            padding: { top: 4, bottom: 4 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor,verticalAlignment,padding)',
      },
    });
    // Auto-resize columns
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS' },
      },
    });
  }

  // Overview tab (index 0): color utilization cells
  if (report.teamOverview.length > 0) {
    const overviewSheetId = sheetIds[0];
    report.teamOverview.forEach((team, rowIdx) => {
      const dataRow = rowIdx + 1; // skip header
      // Column F (index 5) = Avg Utilization %
      requests.push({
        repeatCell: {
          range: { sheetId: overviewSheetId, startRowIndex: dataRow, endRowIndex: dataRow + 1, startColumnIndex: 5, endColumnIndex: 6 },
          cell: {
            userEnteredFormat: {
              backgroundColor: utilColor(team.avgUtilization),
              textFormat: { bold: true, foregroundColor: utilTextColor(team.avgUtilization) },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    });
  }

  // Individual Load tab (index 1): color utilization cells
  if (report.individualLoad.length > 0) {
    const indivSheetId = sheetIds[1];
    let dataRow = 1; // skip header
    for (const m of report.individualLoad) {
      for (const cb of m.cycleBreakdowns) {
        // Column G (index 6) = Utilization %
        requests.push({
          repeatCell: {
            range: { sheetId: indivSheetId, startRowIndex: dataRow, endRowIndex: dataRow + 1, startColumnIndex: 6, endColumnIndex: 7 },
            cell: {
              userEnteredFormat: {
                backgroundColor: utilColor(cb.utilization),
                textFormat: { bold: true, foregroundColor: utilTextColor(cb.utilization) },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
        dataRow++;
      }
    }
  }

  // Projects tab (index 3): conditional formatting for risk, cycle status, unplanned %
  if (report.projectAllocation.length > 0) {
    const projSheetId = sheetIds[3];
    const riskColors = {
      high: { bg: { red: 0.99, green: 0.89, blue: 0.89 }, text: { red: 0.55, green: 0.1, blue: 0.1 } },
      medium: { bg: { red: 1.0, green: 0.95, blue: 0.82 }, text: { red: 0.6, green: 0.4, blue: 0.02 } },
    };
    const cycleStatusColors = {
      active: { bg: { red: 0.86, green: 0.94, blue: 0.83 }, text: { red: 0.08, green: 0.4, blue: 0.18 } },
      upcoming: { bg: { red: 0.85, green: 0.9, blue: 0.98 }, text: { red: 0.1, green: 0.3, blue: 0.6 } },
      past: { bg: { red: 0.93, green: 0.93, blue: 0.93 }, text: { red: 0.3, green: 0.3, blue: 0.3 } },
      unplanned: { bg: { red: 1.0, green: 0.95, blue: 0.82 }, text: { red: 0.6, green: 0.4, blue: 0.02 } },
    };
    report.projectAllocation.forEach((p, rowIdx) => {
      const dataRow = rowIdx + 1;
      // Column B (index 1) = Cycle Status
      const csColor = cycleStatusColors[p.cycleStatus];
      if (csColor) {
        requests.push({
          repeatCell: {
            range: { sheetId: projSheetId, startRowIndex: dataRow, endRowIndex: dataRow + 1, startColumnIndex: 1, endColumnIndex: 2 },
            cell: { userEnteredFormat: { backgroundColor: csColor.bg, textFormat: { bold: true, foregroundColor: csColor.text } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
      // Column C (index 2) = Risk Level
      const rlColor = riskColors[p.riskLevel];
      if (rlColor) {
        requests.push({
          repeatCell: {
            range: { sheetId: projSheetId, startRowIndex: dataRow, endRowIndex: dataRow + 1, startColumnIndex: 2, endColumnIndex: 3 },
            cell: { userEnteredFormat: { backgroundColor: rlColor.bg, textFormat: { bold: true, foregroundColor: rlColor.text } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
      // Column K (index 10) = Unplanned %
      if (p.unplannedPct > 30) {
        requests.push({
          repeatCell: {
            range: { sheetId: projSheetId, startRowIndex: dataRow, endRowIndex: dataRow + 1, startColumnIndex: 10, endColumnIndex: 11 },
            cell: { userEnteredFormat: { backgroundColor: { red: 1.0, green: 0.95, blue: 0.82 }, textFormat: { bold: true, foregroundColor: { red: 0.6, green: 0.4, blue: 0.02 } } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
    });
  }

  // Issue Details tab (index 2): alternate row colors for readability
  if (sheetIds[2]) {
    // Light gray for person-header rows (we mark them in the data)
    // Will be applied below if we can compute offsets
  }

  if (requests.length > 0) {
    await sheetsApi(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }
}

/**
 * Build sheet data arrays from report.
 */
function buildSheetData(report) {
  // Tab 1: Overview — team summary
  const overview = [
    ['Team', 'Members', 'Active Cycles', 'Total Load (pts)', 'Total Capacity (pts)', 'Avg Utilization %', 'Unplanned %', 'Borrowed Out (pts)', 'Borrowed In (pts)'],
    ...report.teamOverview.map((t) => [
      t.teamName, t.memberCount, t.activeCycles, t.totalLoad,
      t.totalCapacity, t.avgUtilization, t.unplannedPct,
      t.borrowedOut, t.borrowedIn,
    ]),
    [],
    ['Report Info'],
    ['Generated', report.metadata.generatedAt],
    ['Teams Filter', report.metadata.filters.teams.join(', ')],
    ['People Filter', report.metadata.filters.persons.join(', ')],
    ['Projects Filter', report.metadata.filters.projects.join(', ')],
    ['Capacity', `${report.metadata.config.capacity}pts per cycle`],
    ['Buffer', report.metadata.config.bufferEnabled ? `${report.metadata.config.bufferPercent}%` : 'Off'],
  ];

  // Tab 2: Individual Load — person × cycle summary (sorted by peak util)
  const sortedMembers = [...report.individualLoad].sort(
    (a, b) => b.peakUtilization - a.peakUtilization
  );
  const individual = [
    ['Name', 'Team(s)', 'Peak Util %', 'Cycle', 'Cycle Team', 'Load (pts)', 'Capacity (pts)', 'Utilization %', 'PTO Days', 'Availability %', 'Planned (pts)', 'Unplanned (pts)', 'Estimated Issues', 'Unestimated Issues', 'Est Coverage %'],
    ...sortedMembers.flatMap((m) =>
      m.cycleBreakdowns.map((cb) => [
        m.name, m.teams.join(', '), m.peakUtilization,
        cb.cycleName, cb.teamName,
        cb.load, cb.capacity, cb.utilization,
        cb.ptoDays ?? '',
        Math.round(cb.availability * 100),
        cb.plannedWork,
        cb.unplannedWork, cb.estimatedCount, cb.unestimatedCount,
        cb.estimationCoverage,
      ])
    ),
  ];

  // Tab 3: Issue Details — per-person per-cycle issue list
  const issueDetails = [
    ['Person', 'Team(s)', 'Cycle', 'Issue Title', 'Project', 'Estimate (pts)', 'State', 'Unplanned', 'Labels'],
  ];
  for (const m of sortedMembers) {
    for (const cb of m.cycleBreakdowns) {
      if (!cb.issues || cb.issues.length === 0) continue;
      for (const issue of cb.issues) {
        issueDetails.push([
          m.name,
          m.teams.join(', '),
          `${cb.cycleName} (${cb.teamName})`,
          issue.title,
          issue.project,
          issue.estimate > 0 ? issue.estimate : '',
          issue.state || '',
          issue.isUnplanned ? 'Yes' : '',
          (issue.labels || []).join(', '),
        ]);
      }
    }
  }

  // Tab 4: Projects (expanded with metrics, risk, cycle status)
  const projects = [
    [
      'Project', 'Cycle Status', 'Risk Level', 'Risks',
      'Start Date', 'Target Date', 'Progress %', 'Total Estimate (pts)',
      'Planned (pts)', 'Unplanned (pts)', 'Unplanned %',
      'Total Issues', 'Estimated', 'Unestimated', 'Est Coverage %',
      'Completed', 'Started', 'Backlog',
      'Completed (pts)', 'Started (pts)', 'Backlog (pts)',
      'Members', 'Teams', 'Member Detail', 'Team Breakdown',
    ],
    ...report.projectAllocation.map((p) => [
      p.projectName,
      p.cycleStatus || '',
      p.riskLevel || 'low',
      (p.risks || []).join(', '),
      p.startDate || '', p.targetDate || '',
      p.progress ?? '', p.totalEstimate,
      p.plannedWork ?? '', p.unplannedWork ?? '', p.unplannedPct ?? '',
      p.totalIssueCount ?? '', p.estimatedIssueCount ?? '', p.unestimatedIssueCount ?? '', p.estimationCoverage ?? '',
      p.issuesByState?.completed ?? '', p.issuesByState?.started ?? '', p.issuesByState?.backlog ?? '',
      p.issuesByStatePts?.completed ?? '', p.issuesByStatePts?.started ?? '', p.issuesByStatePts?.backlog ?? '',
      p.members.length,
      (p.teamBreakdown || []).length,
      p.members.map((m) => `${m.name} (${m.estimate}pts)`).join(', '),
      (p.teamBreakdown || []).map((t) => `${t.name} (${t.estimate}pts, ${t.memberCount} people)`).join(', '),
    ]),
  ];

  // Tab 5: Cross-Team
  const crossTeam = [
    ['Member', 'Home Team', 'Contributing To', 'Cycle', 'Estimate (pts)'],
    ...report.crossTeamCommitments.flatMap((ct) =>
      ct.commitments.map((c) => [
        ct.memberName, ct.homeTeam, c.teamName, c.cycleName, c.estimate,
      ])
    ),
  ];

  // Tab 6: Alerts + Unestimated Issues
  const alertsData = [
    ['Type', 'Entity', 'Value', 'Threshold', 'Detail'],
    ...report.alerts.map((a) => [
      ALERT_LABELS[a.type] || a.type, a.entity, `${a.value}%`, `${a.threshold}%`, a.detail || '',
    ]),
  ];
  if (report.unestimatedIssues.length > 0) {
    alertsData.push([]);
    alertsData.push(['Unestimated Issues']);
    alertsData.push(['Person', 'Cycle', 'Team', 'Issue Title', 'State', 'Project']);
    for (const u of report.unestimatedIssues) {
      alertsData.push([u.memberName, u.cycleName, u.teamName, u.issueTitle, u.state, u.project]);
    }
  }

  return { overview, individual, issueDetails, projects, crossTeam, alerts: alertsData };
}

/**
 * Push report to Google Sheets.
 * @param {Object} reportData - Output from generateReport()
 * @param {Object} options
 * @param {string} [options.spreadsheetId] - Existing spreadsheet ID (null to create new)
 * @param {string} [options.clientId] - Google OAuth client ID
 * @returns {{ spreadsheetId, url }}
 */
export async function pushToSheets(reportData, { spreadsheetId, clientId }) {
  await ensureAuth(clientId);

  const data = buildSheetData(reportData);
  let sheetInfo;

  if (!spreadsheetId) {
    const title = `Capacity Report - ${new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })}`;
    sheetInfo = await createSpreadsheet(title);
    spreadsheetId = sheetInfo.spreadsheetId;
  } else {
    // Get existing sheet IDs
    const meta = await sheetsApi(`/${spreadsheetId}`);
    sheetInfo = {
      spreadsheetId,
      url: meta.spreadsheetUrl,
      sheetIds: meta.sheets.map((s) => s.properties.sheetId),
    };
    // Clear existing data
    const sheetNames = meta.sheets.map((s) => s.properties.title);
    for (const name of sheetNames) {
      await sheetsApi(
        `/${spreadsheetId}/values/${encodeURIComponent(name)}:clear`,
        { method: 'POST', body: '{}' }
      );
    }
  }

  // Write each tab
  const tabs = [
    { name: 'Overview', data: data.overview },
    { name: 'Individual Load', data: data.individual },
    { name: 'Issue Details', data: data.issueDetails },
    { name: 'Projects', data: data.projects },
    { name: 'Cross-Team', data: data.crossTeam },
    { name: 'Alerts', data: data.alerts },
  ];

  for (const tab of tabs) {
    if (tab.data.length > 0) {
      await writeRange(spreadsheetId, `${tab.name}!A1`, tab.data);
    }
  }

  // Apply formatting
  await applyFormatting(spreadsheetId, sheetInfo.sheetIds, reportData);

  return { spreadsheetId, url: sheetInfo.url };
}
