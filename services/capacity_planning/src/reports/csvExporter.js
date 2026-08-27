/**
 * Converts report data to CSV and triggers browser download.
 */

import { ALERT_LABELS } from './reportConfig';

function escapeCsv(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function row(...cells) {
  return cells.map(escapeCsv).join(',');
}

function sectionHeader(title) {
  return `\n${row(`=== ${title} ===`)}`;
}

function buildCsvString(report) {
  const lines = [];

  // Metadata
  lines.push(row('Capacity Report'));
  lines.push(row('Generated', report.metadata.generatedAt));
  lines.push(row('Teams', report.metadata.filters.teams.join('; ')));
  lines.push(row('Persons', report.metadata.filters.persons.join('; ')));
  lines.push(row('Projects', report.metadata.filters.projects.join('; ')));
  lines.push(
    row(
      'Config',
      `Capacity: ${report.metadata.config.capacity}pts`,
      report.metadata.config.bufferEnabled
        ? `Buffer: ${report.metadata.config.bufferPercent}%`
        : 'Buffer: off'
    )
  );

  // Alerts summary at the top for quick scanning
  if (report.alerts.length > 0) {
    lines.push(sectionHeader('ALERTS'));
    lines.push(row('Type', 'Entity', 'Value', 'Threshold', 'Detail'));
    for (const a of report.alerts) {
      lines.push(row(ALERT_LABELS[a.type] || a.type, a.entity, `${a.value}%`, `${a.threshold}%`, a.detail || ''));
    }
  }

  // Team Overview
  lines.push(sectionHeader('TEAM OVERVIEW'));
  lines.push(
    row(
      'Team', 'Members', 'Active Cycles', 'Total Load', 'Total Capacity',
      'Avg Utilization %', 'Unplanned %', 'Borrowed Out', 'Borrowed In'
    )
  );
  for (const t of report.teamOverview) {
    lines.push(
      row(
        t.teamName, t.memberCount, t.activeCycles, t.totalLoad,
        t.totalCapacity, t.avgUtilization, t.unplannedPct,
        t.borrowedOut, t.borrowedIn
      )
    );
  }

  // Individual Load — with issue details
  lines.push(sectionHeader('INDIVIDUAL LOAD'));
  for (const m of report.individualLoad) {
    // Person header
    lines.push('');
    lines.push(
      row(
        `--- ${m.name} ---`,
        `Team(s): ${m.teams.join('; ')}`,
        `Peak Utilization: ${m.peakUtilization}%`,
        m.crossTeamCount >= 2 ? `Cross-team: ${m.crossTeamCount} teams` : '',
        m.crossProjectCount >= 2 ? `Projects: ${m.crossProjectCount}` : ''
      )
    );

    for (const cb of m.cycleBreakdowns) {
      // Cycle summary
      const ptoInfo = cb.ptoDays != null ? `PTO: ${cb.ptoDays}d` : '';
      lines.push(
        row(
          '', `${cb.cycleName} (${cb.teamName})`,
          `Load: ${cb.load}/${cb.capacity}pts`,
          `Utilization: ${cb.utilization}%`,
          `Planned: ${cb.plannedWork}pts`,
          cb.unplannedWork > 0 ? `Unplanned: ${cb.unplannedWork}pts` : '',
          `Est Coverage: ${cb.estimationCoverage}%`,
          ptoInfo
        )
      );

      // Issue details
      if (cb.issues && cb.issues.length > 0) {
        lines.push(row('', '', 'Issue', 'Project', 'Estimate', 'State', 'Flags'));
        for (const issue of cb.issues) {
          const flags = [];
          if (issue.isUnplanned) flags.push('unplanned');
          if (!issue.estimate) flags.push('unestimated');
          lines.push(
            row(
              '', '',
              issue.title,
              issue.project,
              issue.estimate > 0 ? `${issue.estimate}pts` : 'none',
              issue.state || '',
              flags.join('; ')
            )
          );
        }
      }
    }
  }

  // Project Allocation
  lines.push(sectionHeader('PROJECT ALLOCATION'));
  lines.push(
    row(
      'Project', 'Cycle Status', 'Risk Level', 'Risks',
      'Start Date', 'Target Date', 'Progress %', 'Total Estimate',
      'Planned', 'Unplanned', 'Unplanned %',
      'Total Issues', 'Estimated', 'Unestimated', 'Est Coverage %',
      'Completed', 'Started', 'Backlog',
      'Completed (pts)', 'Started (pts)', 'Backlog (pts)',
      'Members', 'Teams', 'Member Detail', 'Team Breakdown'
    )
  );
  for (const p of report.projectAllocation) {
    lines.push(
      row(
        p.projectName,
        p.cycleStatus || '',
        p.riskLevel || 'low',
        (p.risks || []).join('; '),
        p.startDate || '', p.targetDate || '',
        p.progress ?? '', p.totalEstimate,
        p.plannedWork ?? '', p.unplannedWork ?? '', p.unplannedPct ?? '',
        p.totalIssueCount ?? '', p.estimatedIssueCount ?? '', p.unestimatedIssueCount ?? '', p.estimationCoverage ?? '',
        p.issuesByState?.completed ?? '', p.issuesByState?.started ?? '', p.issuesByState?.backlog ?? '',
        p.issuesByStatePts?.completed ?? '', p.issuesByStatePts?.started ?? '', p.issuesByStatePts?.backlog ?? '',
        p.members.length,
        (p.teamBreakdown || []).length,
        p.members.map((m) => `${m.name} (${m.estimate}pts)`).join('; '),
        (p.teamBreakdown || []).map((t) => `${t.name} (${t.estimate}pts; ${t.memberCount} people)`).join('; ')
      )
    );
  }

  // Cross-Team Commitments
  if (report.crossTeamCommitments.length > 0) {
    lines.push(sectionHeader('CROSS-TEAM COMMITMENTS'));
    lines.push(row('Member', 'Home Team', 'Contributing To', 'Cycle', 'Estimate'));
    for (const ct of report.crossTeamCommitments) {
      for (const c of ct.commitments) {
        lines.push(
          row(ct.memberName, ct.homeTeam, c.teamName, c.cycleName, c.estimate)
        );
      }
    }
  }

  // Unestimated Issues
  if (report.unestimatedIssues.length > 0) {
    lines.push(sectionHeader('UNESTIMATED ISSUES'));
    lines.push(row('Member', 'Cycle', 'Team', 'Issue Title', 'State', 'Project'));
    for (const u of report.unestimatedIssues) {
      lines.push(
        row(u.memberName, u.cycleName, u.teamName, u.issueTitle, u.state, u.project)
      );
    }
  }

  return lines.join('\n');
}

export function exportToCsv(reportData, filename) {
  const csv = buildCsvString(reportData);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download =
    filename ||
    `capacity-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
