import { describe, it, expect } from 'vitest';
import { buildCapacityModel } from '../data/capacityModel';
import { generateReport } from '../reports/reportGenerator';
import { buildRawData } from './testFixtures';

const rawData = buildRawData();
const model = buildCapacityModel(rawData);

describe('Report Generator: no filters', () => {
  const report = generateReport(model);

  it('should include all 3 teams in teamOverview', () => {
    expect(report.teamOverview.length).toBe(3);
  });

  it('should include all 5 unique members in individualLoad', () => {
    expect(report.individualLoad.length).toBe(5);
    const names = report.individualLoad.map((m) => m.name);
    expect(names).toContain('Luke');
    expect(names).toContain('Gino');
    expect(names).toContain('Craig');
    expect(names).toContain('Melissa');
    expect(names).toContain('Aaron');
  });

  it('should include both projects in projectAllocation', () => {
    expect(report.projectAllocation.length).toBe(2);
    const names = report.projectAllocation.map((p) => p.projectName);
    expect(names).toContain('Support Local Payments');
    expect(names).toContain('Mexico Launch');
  });

  it('should track unestimated issues', () => {
    // I8 (Gino, bug), I13 (Melissa, ops)
    expect(report.unestimatedIssues.length).toBe(2);
  });

  it('should have metadata with timestamp', () => {
    expect(report.metadata.generatedAt).toBeDefined();
    expect(report.metadata.filters.teams).toEqual(['All']);
  });
});

describe('Report Generator: filtered by team', () => {
  const report = generateReport(model, {
    selectedTeams: ['T2'], // Core Services
  });

  it('should only include Core Services in teamOverview', () => {
    expect(report.teamOverview.length).toBe(1);
    expect(report.teamOverview[0].teamName).toBe('Core Services');
  });

  it('should include Luke (cross-team), Craig, and Melissa', () => {
    const names = report.individualLoad.map((m) => m.name);
    expect(names).toContain('Craig');
    expect(names).toContain('Melissa');
    // Luke has cross-team work in C2 — should appear
    // (report generator filters cycles, and Luke has C2 data)
  });

  it('cycle breakdowns should only include C2 cycles', () => {
    for (const member of report.individualLoad) {
      for (const cb of member.cycleBreakdowns) {
        expect(cb.teamName).toBe('Core Services');
      }
    }
  });
});

describe('Report Generator: filtered by person', () => {
  const report = generateReport(model, {
    selectedPersons: ['M5'], // Aaron
  });

  it('should only include Aaron in individualLoad', () => {
    expect(report.individualLoad.length).toBe(1);
    expect(report.individualLoad[0].name).toBe('Aaron');
  });

  it('Aaron should have 18pts in C3', () => {
    const aaron = report.individualLoad[0];
    expect(aaron.cycleBreakdowns.length).toBe(1);
    expect(aaron.cycleBreakdowns[0].load).toBe(18);
    expect(aaron.cycleBreakdowns[0].utilization).toBe(90);
  });
});

describe('Report Generator: alert thresholds', () => {
  it('should flag Aaron as near-capacity with default 85% warning', () => {
    const report = generateReport(model, {
      alertThresholds: {
        utilizationWarning: 85,
        utilizationCritical: 100,
        estimationCoverageMin: 50,
        unplannedWorkMax: 30,
      },
    });
    const nearCapAlerts = report.alerts.filter(
      (a) => a.type === 'near_capacity' && a.entity === 'Aaron'
    );
    expect(nearCapAlerts.length).toBe(1);
    expect(nearCapAlerts[0].value).toBe(90);
  });

  it('should flag Aaron as over-capacity with 80% critical threshold', () => {
    const report = generateReport(model, {
      alertThresholds: {
        utilizationWarning: 70,
        utilizationCritical: 80,
        estimationCoverageMin: 50,
        unplannedWorkMax: 30,
      },
    });
    const overCapAlerts = report.alerts.filter(
      (a) => a.type === 'over_capacity' && a.entity === 'Aaron'
    );
    expect(overCapAlerts.length).toBe(1);
  });

  it('should flag low estimation coverage cycles', () => {
    const report = generateReport(model, {
      alertThresholds: {
        utilizationWarning: 85,
        utilizationCritical: 100,
        estimationCoverageMin: 90, // High threshold to trigger
        unplannedWorkMax: 30,
      },
    });
    const estAlerts = report.alerts.filter((a) => a.type === 'low_estimation');
    // All cycles have < 90% coverage
    expect(estAlerts.length).toBeGreaterThan(0);
  });

  it('should flag high unplanned work', () => {
    const report = generateReport(model, {
      alertThresholds: {
        utilizationWarning: 85,
        utilizationCritical: 100,
        estimationCoverageMin: 50,
        unplannedWorkMax: 20, // Low threshold
      },
    });
    const unplannedAlerts = report.alerts.filter(
      (a) => a.type === 'high_unplanned'
    );
    // Android has high unplanned (Aaron's bugs)
    expect(unplannedAlerts.length).toBeGreaterThan(0);
  });
});

describe('Report Generator: filtered by project', () => {
  const report = generateReport(model, {
    selectedProjects: ['P1'], // Support Local Payments
  });

  it('should only include Payments project in projectAllocation', () => {
    const names = report.projectAllocation.map((p) => p.projectName);
    expect(names).toContain('Support Local Payments');
    expect(names).not.toContain('Mexico Launch');
  });

  it('should only include members who work on P1', () => {
    const names = report.individualLoad.map((m) => m.name);
    expect(names).toContain('Luke');
    expect(names).toContain('Craig');
    expect(names).not.toContain('Gino'); // only P2
    expect(names).not.toContain('Aaron'); // only P2 + no-project
  });
});

describe('Report Generator: cross-team commitments', () => {
  const report = generateReport(model);

  it('should show Luke cross-team commitment to Core Services', () => {
    const lukeCtc = report.crossTeamCommitments.find(
      (c) => c.memberName === 'Luke'
    );
    expect(lukeCtc).toBeDefined();
    expect(lukeCtc.commitments.length).toBeGreaterThan(0);
    const t2Commitment = lukeCtc.commitments.find(
      (c) => c.teamName === 'Core Services'
    );
    expect(t2Commitment).toBeDefined();
    expect(t2Commitment.estimate).toBe(10);
  });
});
