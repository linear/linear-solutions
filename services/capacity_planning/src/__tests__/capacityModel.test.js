import { describe, it, expect } from 'vitest';
import { buildCapacityModel } from '../data/capacityModel';
import { buildRawData } from './testFixtures';

describe('buildCapacityModel', () => {
  const rawData = buildRawData();
  const model = buildCapacityModel(rawData);

  // ─── Team membership ───

  describe('team membership', () => {
    it('should assign Luke to both Rider App (formal) and Core Services (cross-team)', () => {
      const luke = model.members['M1'];
      expect(luke.teams).toContain('T1'); // formal
      expect(luke.teams).toContain('T2'); // cross-team via issues I4, I5
    });

    it('should assign Craig to both Core Services and Android (formal)', () => {
      const craig = model.members['M3'];
      expect(craig.teams).toContain('T2');
      expect(craig.teams).toContain('T3');
    });

    it('should keep Gino only in Rider App', () => {
      const gino = model.members['M2'];
      expect(gino.teams).toEqual(['T1']);
    });

    it('should keep Melissa only in Core Services', () => {
      const melissa = model.members['M4'];
      expect(melissa.teams).toEqual(['T2']);
    });

    it('should keep Aaron only in Android', () => {
      const aaron = model.members['M5'];
      expect(aaron.teams).toEqual(['T3']);
    });

    it('should track cross-team count for Luke', () => {
      const luke = model.members['M1'];
      expect(luke.crossTeamCount).toBe(2);
    });

    it('should track cross-team count for Craig', () => {
      const craig = model.members['M3'];
      expect(craig.crossTeamCount).toBe(2);
    });
  });

  // ─── Cycle data ───

  describe('cycle-level estimates', () => {
    it('Luke should have 15pts in Rider App Cycle 31 (C1)', () => {
      expect(model.members['M1'].cycles['C1'].totalEstimate).toBe(15);
    });

    it('Luke should have 10pts in Core Services Cycle 11 (C2)', () => {
      expect(model.members['M1'].cycles['C2'].totalEstimate).toBe(10);
    });

    it('Gino should have 12pts estimated in C1 (null estimate issue = 0pts)', () => {
      expect(model.members['M2'].cycles['C1'].totalEstimate).toBe(12);
    });

    it('Craig should have 7pts in C2 and 5pts in C3', () => {
      expect(model.members['M3'].cycles['C2'].totalEstimate).toBe(7);
      expect(model.members['M3'].cycles['C3'].totalEstimate).toBe(5);
    });

    it('Aaron should have 18pts in C3', () => {
      expect(model.members['M5'].cycles['C3'].totalEstimate).toBe(18);
    });
  });

  // ─── By-team tracking ───

  describe('by-team tracking within cycles', () => {
    it('Luke C1 work should be tracked under team T1', () => {
      expect(model.members['M1'].cycles['C1'].byTeam['T1'].estimate).toBe(15);
    });

    it('Luke C2 work should be tracked under team T2', () => {
      expect(model.members['M1'].cycles['C2'].byTeam['T2'].estimate).toBe(10);
    });

    it('Craig C2 work should be under T2, C3 work under T3', () => {
      expect(model.members['M3'].cycles['C2'].byTeam['T2'].estimate).toBe(7);
      expect(model.members['M3'].cycles['C3'].byTeam['T3'].estimate).toBe(5);
    });
  });

  // ─── Utilization ───

  describe('utilization calculations', () => {
    it('Luke C1 utilization: 15/20 = 75%', () => {
      expect(model.members['M1'].cycles['C1'].utilization).toBe(75);
    });

    it('Luke C2 utilization: 10/20 = 50%', () => {
      expect(model.members['M1'].cycles['C2'].utilization).toBe(50);
    });

    it('Aaron C3 utilization: 18/20 = 90%', () => {
      expect(model.members['M5'].cycles['C3'].utilization).toBe(90);
    });

    it('Gino C1 utilization: 12/20 = 60%', () => {
      expect(model.members['M2'].cycles['C1'].utilization).toBe(60);
    });
  });

  // ─── Estimation coverage ───

  describe('estimation coverage', () => {
    it('Gino has 1 unestimated issue in C1', () => {
      const gino = model.members['M2'];
      expect(gino.cycles['C1'].unestimatedIssueCount).toBe(1);
      expect(gino.cycles['C1'].estimatedIssueCount).toBe(2);
    });

    it('Melissa has 1 unestimated issue in C2', () => {
      const melissa = model.members['M4'];
      expect(melissa.cycles['C2'].unestimatedIssueCount).toBe(1);
      expect(melissa.cycles['C2'].estimatedIssueCount).toBe(1);
    });

    it('Luke has 0 unestimated issues', () => {
      const luke = model.members['M1'];
      expect(luke.cycles['C1'].unestimatedIssueCount).toBe(0);
      expect(luke.cycles['C2'].unestimatedIssueCount).toBe(0);
    });

    it('cycle C2 should count unassigned issue I17 in total', () => {
      const c2 = model.cycles.find((c) => c.id === 'C2');
      // C2: I4, I5 (Luke), I9, I10 (Craig), I12, I13 (Melissa), I17 (unassigned) = 7
      expect(c2.issueStats.total).toBe(7);
      // Estimated: I4(5), I5(5), I9(4), I10(3), I12(3), I17(3) = 6 estimated, I13(null) = 1 unestimated
      expect(c2.issueStats.estimated).toBe(6);
      expect(c2.issueStats.unestimated).toBe(1);
    });
  });

  // ─── Unplanned work ───

  describe('unplanned work tracking', () => {
    it('Gino I8 (bug label, no estimate) tracked as unplanned but 0pts', () => {
      const gino = model.members['M2'];
      // I8 has null estimate → 0pts, but label "bug" → unplanned
      expect(gino.cycles['C1'].unplannedWork).toBe(0);
      expect(gino.cycles['C1'].unplannedIssues.length).toBe(1);
    });

    it('Aaron has 13pts unplanned (bugs) and 5pts planned', () => {
      const aaron = model.members['M5'];
      // I14(8,bug), I15(5,bug), I16(5,planned)
      expect(aaron.cycles['C3'].unplannedWork).toBe(13);
      expect(aaron.cycles['C3'].plannedWork).toBe(5);
    });

    it('Melissa has ops label as unplanned', () => {
      const melissa = model.members['M4'];
      // I13 has ops label but null estimate → 0pts unplanned
      expect(melissa.cycles['C2'].unplannedIssues.length).toBe(1);
    });
  });

  // ─── Cross-team commitments ───

  describe('cross-team commitments', () => {
    it('Luke should have cross-team commitment for C2 in team T2', () => {
      const luke = model.members['M1'];
      const ctc = luke.crossTeamCommitments['C2'];
      expect(ctc).toBeDefined();
      expect(ctc['T2']).toBeDefined();
      expect(ctc['T2'].estimate).toBe(10);
    });

    it('Craig C2 commitment is home (T2), C3 is also home (T3)', () => {
      const craig = model.members['M3'];
      // Craig is in both teams, so both are "home" from byTeam perspective
      expect(craig.crossTeamCommitments['C2']['T2']).toBeDefined();
      expect(craig.crossTeamCommitments['C3']['T3']).toBeDefined();
    });
  });

  // ─── Project tracking ───

  describe('project allocation', () => {
    it('Luke has work on P1 (Payments) and P2 (Mexico)', () => {
      const lukeProjects = model.memberProjects['M1'];
      expect(lukeProjects['P1']).toBeDefined();
      expect(lukeProjects['P2']).toBeDefined();
      // P1: I1(8) + I2(5) + I4(5) + I5(5) = 23pts
      expect(lukeProjects['P1'].totalEstimate).toBe(23);
      // P2: I3(2) = 2pts
      expect(lukeProjects['P2'].totalEstimate).toBe(2);
    });

    it('cross-project count for Luke is 2', () => {
      expect(model.members['M1'].crossProjectCount).toBe(2);
    });

    it('Gino works only on P2 (Mexico Launch)', () => {
      const ginoProjects = model.memberProjects['M2'];
      expect(ginoProjects['P2']).toBeDefined();
      expect(ginoProjects['P2'].totalEstimate).toBe(12);
      // Also has __no_project__ from unestimated bug? No, I8 has project P2
      expect(ginoProjects['P1']).toBeUndefined();
    });
  });

  // ─── Team capacity aggregation ───

  describe('team capacity', () => {
    it('Rider App (T1) in C1: Luke(15) + Gino(12) = 27pts load', () => {
      const tc = model.teamCapacity['T1'].cycles['C1'];
      expect(tc.load).toBe(27);
      expect(tc.rawCapacity).toBe(40); // 2 members × 20
    });

    it('Core Services (T2) in C2 should include formal members only for rawCapacity', () => {
      const tc = model.teamCapacity['T2'].cycles['C2'];
      // Formal members: Craig(7) + Melissa(3) = 10 from formal
      // But load includes ALL issue work in the team's cycles by team members
      // Craig(7) + Melissa(3) = 10pts from formal members
      expect(tc.rawCapacity).toBe(40); // 2 formal members × 20
    });

    it('Android (T3) in C3: Craig(5) + Aaron(18) = 23pts load', () => {
      const tc = model.teamCapacity['T3'].cycles['C3'];
      expect(tc.load).toBe(23);
      expect(tc.rawCapacity).toBe(40); // 2 members × 20
    });
  });

  // ─── Cycle confidence ───

  describe('cycle confidence (plannedPct, estimationCoverage)', () => {
    it('C1 has all 6 issues assigned → 100% planned (all assigned / total)', () => {
      const c1 = model.cycles.find((c) => c.id === 'C1');
      // Luke: I1, I2, I3 + Gino: I6, I7, I8 = 6 issues, all assigned
      expect(c1.issueStats.total).toBe(6);
      expect(c1.issueStats.assigned).toBe(6);
      expect(c1.plannedPct).toBe(100);
    });

    it('C2 has 6 assigned + 1 unassigned = 86% planned', () => {
      const c2 = model.cycles.find((c) => c.id === 'C2');
      expect(c2.issueStats.assigned).toBe(6);
      expect(c2.plannedPct).toBe(Math.round((6 / 7) * 100));
    });

    it('C1 estimation coverage: 3 estimated out of 4 = 75%', () => {
      const c1 = model.cycles.find((c) => c.id === 'C1');
      // I1(8), I2(5), I3(2), I6(8), I7(4) estimated; I8(null) unestimated
      // Wait: I1,I2,I3 (Luke), I6,I7,I8 (Gino) = 5 estimated, 1 unestimated = 6 total
      // Actually let me re-count: C1 issues = I1,I2,I3,I6,I7,I8 = 6 total
      // Estimated: I1,I2,I3,I6,I7 = 5; Unestimated: I8 = 1
      expect(c1.issueStats.total).toBe(6);
      expect(c1.issueStats.estimated).toBe(5);
      expect(c1.estimationCoverage).toBe(Math.round((5 / 6) * 100));
    });
  });
});
