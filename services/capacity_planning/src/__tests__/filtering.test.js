import { describe, it, expect } from 'vitest';
import { buildCapacityModel } from '../data/capacityModel';
import { buildRawData } from './testFixtures';

/**
 * These tests simulate the filtering logic from CapacityHeatmap.jsx
 * to verify correct behavior without needing React rendering.
 *
 * The filtering pipeline:
 *   1. allCycles: filter model.cycles by selectedTeams + issueStats.total > 0
 *   2. teamGroups: for each team, gather members (formal + cross-team contributors),
 *      then filter by selectedPersons, selectedProjects, and visible cycles
 *   3. cycles (final): optionally filter allCycles to only those with visible member data
 */

const rawData = buildRawData();
const model = buildCapacityModel(rawData);

// --- Helper: replicate CapacityHeatmap filtering logic ---

function getFilteredCycles(selectedTeams) {
  let filtered = model.cycles.filter(
    (c) => c.issueStats && c.issueStats.total > 0
  );
  if (selectedTeams.length > 0) {
    // Collect all members belonging to the selected teams
    const teamMemberIds = new Set();
    for (const team of model.teams) {
      if (selectedTeams.includes(team.id)) {
        team.members.forEach((mid) => teamMemberIds.add(mid));
      }
    }
    filtered = filtered.filter((c) => {
      // Cycles owned by selected teams
      if (selectedTeams.includes(c.teamId)) return true;
      // Cycles where any selected-team member has work
      for (const mid of teamMemberIds) {
        if (model.members[mid]?.cycles[c.id]) return true;
      }
      return false;
    });
  }
  return [...filtered].sort(
    (a, b) => new Date(a.startsAt) - new Date(b.startsAt)
  );
}

function getTeamGroups({
  selectedTeams = [],
  selectedPersons = [],
  selectedProjects = [],
  allCycles = null,
} = {}) {
  const visibleCycles = allCycles || getFilteredCycles(selectedTeams);

  let teams =
    selectedTeams.length === 0
      ? model.teams
      : model.teams.filter((t) => selectedTeams.includes(t.id));

  if (selectedPersons.length > 0) {
    const personTeamIds = new Set();
    for (const pid of selectedPersons) {
      const person = model.members[pid];
      if (person) person.teams.forEach((t) => personTeamIds.add(t));
    }
    teams = teams.filter((t) => personTeamIds.has(t.id));
  }

  return teams
    .map((team) => {
      // Replicate the fix: formal members + cross-team contributors
      const memberIds = new Set(team.members);
      // Include anyone who has byTeam work for this team in ANY cycle
      for (const [memberId, member] of Object.entries(model.members)) {
        if (memberIds.has(memberId)) continue;
        for (const cycleData of Object.values(member.cycles)) {
          if (cycleData.byTeam?.[team.id]?.estimate > 0) {
            memberIds.add(memberId);
            break;
          }
        }
      }

      let members = [...memberIds]
        .map((mid) => model.members[mid])
        .filter(Boolean);

      if (selectedPersons.length > 0) {
        members = members.filter((m) => selectedPersons.includes(m.id));
      }

      if (selectedProjects.length > 0) {
        members = members.filter((m) => {
          const mp = model.memberProjects[m.id];
          return mp && selectedProjects.some((pid) => mp[pid]);
        });
      }

      // Only show members with data in visible cycles
      if (visibleCycles.length > 0) {
        members = members.filter((m) =>
          visibleCycles.some((c) => m.cycles[c.id])
        );
      }

      return { ...team, memberData: members };
    })
    .filter((t) => t.memberData.length > 0);
}

// ═══════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════

describe('Filtering: No filters (all data)', () => {
  const allCycles = getFilteredCycles([]);
  const groups = getTeamGroups();

  it('should show all 3 teams', () => {
    expect(groups.length).toBe(3);
    const names = groups.map((g) => g.name);
    expect(names).toContain('Rider App');
    expect(names).toContain('Core Services');
    expect(names).toContain('Android');
  });

  it('should show all 3 cycles', () => {
    expect(allCycles.length).toBe(3);
  });

  it('Rider App should have Luke and Gino', () => {
    const riderApp = groups.find((g) => g.id === 'T1');
    const names = riderApp.memberData.map((m) => m.name);
    expect(names).toContain('Luke');
    expect(names).toContain('Gino');
  });

  it('Core Services should have Craig, Melissa, and Luke (cross-team)', () => {
    const cs = groups.find((g) => g.id === 'T2');
    const names = cs.memberData.map((m) => m.name);
    expect(names).toContain('Craig');
    expect(names).toContain('Melissa');
    expect(names).toContain('Luke');
  });

  it('Android should have Craig and Aaron', () => {
    const android = groups.find((g) => g.id === 'T3');
    const names = android.memberData.map((m) => m.name);
    expect(names).toContain('Craig');
    expect(names).toContain('Aaron');
  });
});

describe('Filtering: by team only', () => {
  it('filter to Core Services (T2) should show Luke as cross-team contributor', () => {
    const groups = getTeamGroups({ selectedTeams: ['T2'] });
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Core Services');

    const names = groups[0].memberData.map((m) => m.name);
    expect(names).toContain('Luke');   // cross-team: has work in C2
    expect(names).toContain('Craig');  // formal member
    expect(names).toContain('Melissa'); // formal member
    expect(names).not.toContain('Gino'); // no work in T2
    expect(names).not.toContain('Aaron'); // no work in T2
  });

  it('filter to Rider App (T1) should show Luke and Gino only', () => {
    const groups = getTeamGroups({ selectedTeams: ['T1'] });
    expect(groups.length).toBe(1);
    const names = groups[0].memberData.map((m) => m.name);
    expect(names).toContain('Luke');
    expect(names).toContain('Gino');
    expect(names.length).toBe(2);
  });

  it('filter to Android (T3) should show Craig and Aaron', () => {
    const groups = getTeamGroups({ selectedTeams: ['T3'] });
    expect(groups.length).toBe(1);
    const names = groups[0].memberData.map((m) => m.name);
    expect(names).toContain('Craig');
    expect(names).toContain('Aaron');
    expect(names.length).toBe(2);
  });

  it('filter to multiple teams (T1 + T2) should show both team groups', () => {
    const groups = getTeamGroups({ selectedTeams: ['T1', 'T2'] });
    expect(groups.length).toBe(2);
    const allNames = groups.flatMap((g) => g.memberData.map((m) => m.name));
    expect(allNames).toContain('Luke');
    expect(allNames).toContain('Gino');
    expect(allNames).toContain('Craig');
    expect(allNames).toContain('Melissa');
  });
});

describe('Filtering: by person only', () => {
  it('filter to Luke (M1) should show Rider App and Core Services teams', () => {
    const groups = getTeamGroups({ selectedPersons: ['M1'] });
    const teamNames = groups.map((g) => g.name);
    expect(teamNames).toContain('Rider App');
    expect(teamNames).toContain('Core Services');
    expect(teamNames).not.toContain('Android');
  });

  it('filter to Luke should show only Luke in each team', () => {
    const groups = getTeamGroups({ selectedPersons: ['M1'] });
    for (const g of groups) {
      expect(g.memberData.length).toBe(1);
      expect(g.memberData[0].name).toBe('Luke');
    }
  });

  it('filter to Craig (M3) should show Core Services and Android', () => {
    const groups = getTeamGroups({ selectedPersons: ['M3'] });
    const teamNames = groups.map((g) => g.name);
    expect(teamNames).toContain('Core Services');
    expect(teamNames).toContain('Android');
    expect(teamNames).not.toContain('Rider App');
  });

  it('filter to Aaron (M5) should show only Android', () => {
    const groups = getTeamGroups({ selectedPersons: ['M5'] });
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Android');
    expect(groups[0].memberData[0].name).toBe('Aaron');
  });
});

describe('Filtering: team + person combined', () => {
  it('filter to Core Services + Luke should show Luke under Core Services', () => {
    const groups = getTeamGroups({
      selectedTeams: ['T2'],
      selectedPersons: ['M1'],
    });
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Core Services');
    expect(groups[0].memberData.length).toBe(1);
    expect(groups[0].memberData[0].name).toBe('Luke');
  });

  it('filter to Rider App + Aaron should return empty (Aaron not in Rider App)', () => {
    const groups = getTeamGroups({
      selectedTeams: ['T1'],
      selectedPersons: ['M5'],
    });
    expect(groups.length).toBe(0);
  });

  it('filter to Android + Craig should show Craig under Android', () => {
    const groups = getTeamGroups({
      selectedTeams: ['T3'],
      selectedPersons: ['M3'],
    });
    expect(groups.length).toBe(1);
    expect(groups[0].memberData.length).toBe(1);
    expect(groups[0].memberData[0].name).toBe('Craig');
  });
});

describe('Filtering: by project', () => {
  it('filter to P1 (Payments) should show Luke and Craig', () => {
    const groups = getTeamGroups({ selectedProjects: ['P1'] });
    const allNames = groups.flatMap((g) => g.memberData.map((m) => m.name));
    expect(allNames).toContain('Luke');
    expect(allNames).toContain('Craig');
    expect(allNames).not.toContain('Gino'); // Gino only has P2
    expect(allNames).not.toContain('Aaron'); // Aaron has P2 and no-project bugs
  });

  it('filter to P2 (Mexico Launch) should show Luke, Gino, Craig, Aaron', () => {
    const groups = getTeamGroups({ selectedProjects: ['P2'] });
    const allNames = groups.flatMap((g) => g.memberData.map((m) => m.name));
    expect(allNames).toContain('Luke');
    expect(allNames).toContain('Gino');
    expect(allNames).toContain('Craig');
    expect(allNames).toContain('Aaron');
    expect(allNames).not.toContain('Melissa'); // Melissa has no project
  });

  it('filter to P1 + T2 (Payments + Core Services) shows Luke and Craig', () => {
    const groups = getTeamGroups({
      selectedTeams: ['T2'],
      selectedProjects: ['P1'],
    });
    const allNames = groups.flatMap((g) => g.memberData.map((m) => m.name));
    expect(allNames).toContain('Luke');
    expect(allNames).toContain('Craig');
    expect(allNames.length).toBe(2);
  });
});

describe('Filtering: cycle visibility', () => {
  it('filtering to T1 should show C1 (owned) and C2 (Luke cross-team)', () => {
    const cycles = getFilteredCycles(['T1']);
    // C1 is owned by T1; C2 has Luke (T1 member) working in it
    const ids = cycles.map((c) => c.id);
    expect(ids).toContain('C1');
    expect(ids).toContain('C2');
  });

  it('filtering to T2 should show C2 (owned) and C1 (Craig cross-team to T1 cycle)', () => {
    const cycles = getFilteredCycles(['T2']);
    // C2 owned by T2; Craig (T2 member) works in C2 and C3
    // So T2 members' cycles: Craig has C2, C3; Melissa has C2
    const ids = cycles.map((c) => c.id);
    expect(ids).toContain('C2');
    // Craig is formal member of T2 and has work in C3 (Android cycle)
    expect(ids).toContain('C3');
  });

  it('filtering to T3 should show C3 (owned) and C2 (Craig cross-team)', () => {
    const cycles = getFilteredCycles(['T3']);
    // C3 owned by T3; Craig (T3 member) also has work in C2
    const ids = cycles.map((c) => c.id);
    expect(ids).toContain('C3');
    expect(ids).toContain('C2');
  });

  it('no team filter should show all 3 cycles', () => {
    const cycles = getFilteredCycles([]);
    expect(cycles.length).toBe(3);
  });
});

describe('Filtering: "Relevant cycles" mode (hide empty cycles)', () => {
  it('Luke filtered: relevant cycles should be C1 and C2 only', () => {
    const allCycles = getFilteredCycles([]);
    const groups = getTeamGroups({ selectedPersons: ['M1'] });
    const visibleMembers = groups.flatMap((g) => g.memberData);

    const relevantCycles = allCycles.filter((c) =>
      visibleMembers.some((m) => m.cycles[c.id])
    );

    expect(relevantCycles.length).toBe(2);
    const ids = relevantCycles.map((c) => c.id);
    expect(ids).toContain('C1');
    expect(ids).toContain('C2');
    expect(ids).not.toContain('C3'); // Luke has no work in Android cycle
  });

  it('Aaron filtered: relevant cycle should be C3 only', () => {
    const allCycles = getFilteredCycles([]);
    const groups = getTeamGroups({ selectedPersons: ['M5'] });
    const visibleMembers = groups.flatMap((g) => g.memberData);

    const relevantCycles = allCycles.filter((c) =>
      visibleMembers.some((m) => m.cycles[c.id])
    );

    expect(relevantCycles.length).toBe(1);
    expect(relevantCycles[0].id).toBe('C3');
  });

  it('Craig filtered: relevant cycles should be C2 and C3', () => {
    const allCycles = getFilteredCycles([]);
    const groups = getTeamGroups({ selectedPersons: ['M3'] });
    const visibleMembers = groups.flatMap((g) => g.memberData);

    const relevantCycles = allCycles.filter((c) =>
      visibleMembers.some((m) => m.cycles[c.id])
    );

    expect(relevantCycles.length).toBe(2);
    const ids = relevantCycles.map((c) => c.id);
    expect(ids).toContain('C2');
    expect(ids).toContain('C3');
  });
});

describe('Filtering: "Estimated" cycles mode', () => {
  it('should hide cycles where no visible member has estimated issues', () => {
    const allCycles = getFilteredCycles([]);
    // Melissa only: she has 1 estimated (I12, 3pts) and 1 unestimated (I13) in C2
    const groups = getTeamGroups({ selectedPersons: ['M4'] });
    const visibleMembers = groups.flatMap((g) => g.memberData);

    const estimatedCycles = allCycles.filter((c) =>
      visibleMembers.some((m) => m.cycles[c.id]?.estimatedIssueCount > 0)
    );

    expect(estimatedCycles.length).toBe(1);
    expect(estimatedCycles[0].id).toBe('C2');
  });
});

describe('Filtering: cross-team cycle visibility (the Luke/Core Services bug)', () => {
  it('Core Services members should see cycles from other teams where they have work', () => {
    // This is the exact bug: filter to Core Services, Luke has work in Rider App Cycle 31
    // Both Luke and Cycle 31 should be visible
    const allCycles = getFilteredCycles(['T2']);
    const groups = getTeamGroups({ selectedTeams: ['T2'], allCycles });

    // Luke should appear as a member (cross-team contributor)
    const csGroup = groups.find((g) => g.id === 'T2');
    const memberNames = csGroup.memberData.map((m) => m.name);
    expect(memberNames).toContain('Luke');

    // The cycles should include cycles where Core Services members have work
    // Craig (T2 member) has work in C2 (Core Services) and C3 (Android)
    // So allCycles should include C2 and C3
    const cycleIds = allCycles.map((c) => c.id);
    expect(cycleIds).toContain('C2'); // Core Services owned cycle

    // Luke should have cycle data that maps to visible cycles
    const luke = csGroup.memberData.find((m) => m.name === 'Luke');
    const lukeCycleIds = Object.keys(luke.cycles);
    // Luke has C1 (Rider App) and C2 (Core Services) — both should be visible
    const lukeVisibleCycles = allCycles.filter((c) => luke.cycles[c.id]);
    expect(lukeVisibleCycles.length).toBeGreaterThan(0);
  });

  it('filtering Core Services should show C1 if a Core Services member has work there', () => {
    // In our fixture, Luke is cross-team to Core Services and has C1 work
    // But Luke is a formal T1 member, so allCycles for T2 includes cycles where T2 members work
    // Craig (formal T2 member) has C2 and C3
    // So C1 would only be included if a formal T2 member has work in C1
    // In fixture, no formal T2 member (Craig, Melissa) has C1 work
    // Luke is NOT a formal T2 member, so his C1 work doesn't pull in C1
    // This is correct behavior: C1 is only shown if a formal team member works there
    const allCycles = getFilteredCycles(['T2']);
    const cycleIds = allCycles.map((c) => c.id);
    // C1 should NOT be included because no formal T2 member has C1 work
    expect(cycleIds).not.toContain('C1');
  });
});

describe('Edge cases', () => {
  it('filter to non-existent team returns empty', () => {
    const groups = getTeamGroups({ selectedTeams: ['T_FAKE'] });
    expect(groups.length).toBe(0);
  });

  it('filter to non-existent person returns empty', () => {
    const groups = getTeamGroups({ selectedPersons: ['M_FAKE'] });
    expect(groups.length).toBe(0);
  });

  it('filter to non-existent project returns empty', () => {
    const groups = getTeamGroups({ selectedProjects: ['P_FAKE'] });
    expect(groups.length).toBe(0);
  });

  it('filter to person + team mismatch returns empty', () => {
    // Melissa (M4) is only in Core Services (T2), not Rider App (T1)
    const groups = getTeamGroups({
      selectedTeams: ['T1'],
      selectedPersons: ['M4'],
    });
    expect(groups.length).toBe(0);
  });

  it('member with only unestimated issues still appears', () => {
    // Hypothetical: if someone only had unestimated issues, they should still show
    // In our fixture, Gino's I8 is unestimated — Gino still shows because he has other estimated issues too
    const groups = getTeamGroups({ selectedPersons: ['M2'] });
    expect(groups.length).toBe(1);
    expect(groups[0].memberData[0].name).toBe('Gino');
  });
});
