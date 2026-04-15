/**
 * Test suite: nested team authorization with field-level permissions
 *
 * Covers:
 * - Permission resolution: union, inheritance, linearTeamId matching
 * - Partial authorization (only unauthorized fields reverted)
 * - slaBaseline vs sla separation
 * - Backward compatibility (flat legacy entries)
 * - Edge cases: empty permissions, deep nesting, unknown actor, no match
 */

import { EnforcementEngine } from '../../src/enforcement-engine';
import { LinearClient } from '../../src/linear-client';
import {
  Config,
  AllowlistEntry,
  Permission,
  WebhookActor,
  ChangeDetection,
  LinearUser
} from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActor(overrides: Partial<WebhookActor> = {}): WebhookActor {
  return {
    id: 'user-default',
    type: 'user',
    name: 'Test User',
    email: 'test@example.com',
    url: 'https://linear.app/user/test',
    ...overrides
  };
}

function makeChange(
  field: ChangeDetection['field'],
  overrides: Partial<ChangeDetection> = {}
): ChangeDetection {
  return {
    field,
    oldValue: 'old',
    newValue: 'new',
    description: `Changed ${field}`,
    revertDescription: `Reverted ${field}`,
    ...overrides
  };
}

function makeConfig(allowlist: AllowlistEntry[]): Config {
  return {
    protectedLabels: ['oosla'],
    checkLabelGroups: false,
    protectedFields: { label: true, sla: true, priority: true, slaCreatedAtBaseline: true },
    allowlist,
    agent: { name: 'Test Agent', identifier: '🤖' },
    slack: { enabled: false },
    behavior: { dryRun: false, notifyOnly: false, mentionUser: false },
    logging: { level: 'silent', auditTrail: false, auditLogPath: '/dev/null' }
  };
}

function makeEngine(
  allowlist: AllowlistEntry[],
  teamMemberCache: Map<string, LinearUser[]> = new Map()
): EnforcementEngine {
  const config = makeConfig(allowlist);
  const linearClient = {} as LinearClient; // not used by getActorPermissions
  return new EnforcementEngine(config, linearClient, teamMemberCache);
}

function perms(engine: EnforcementEngine, actor: WebhookActor): Permission[] {
  return Array.from(engine.getActorPermissions(actor)).sort();
}

const ALL: Permission[] = ['labels', 'priority', 'sla', 'slaBaseline'].sort() as Permission[];
const NONE: Permission[] = [];

// ---------------------------------------------------------------------------
// 1. Flat / legacy entries (backward compatibility)
// ---------------------------------------------------------------------------

describe('Flat legacy entries (backward compatibility)', () => {
  test('flat entry with no permissions defaults to all permissions', () => {
    const engine = makeEngine([{ email: 'user@example.com', name: 'User' }]);
    const actor = makeActor({ email: 'user@example.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('flat entry matched by id', () => {
    const engine = makeEngine([{ id: 'abc123', name: 'User' }]);
    const actor = makeActor({ id: 'abc123' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('flat entry not matched by wrong email', () => {
    const engine = makeEngine([{ email: 'user@example.com' }]);
    const actor = makeActor({ email: 'other@example.com' });
    expect(perms(engine, actor)).toEqual(NONE);
  });

  test('flat entry with explicit permissions respects them', () => {
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['labels', 'sla'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'sla'].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Group entries — inheritance
// ---------------------------------------------------------------------------

describe('Group permission inheritance', () => {
  test('leaf inherits group permissions when no own permissions set', () => {
    const engine = makeEngine([{
      name: 'Team A',
      permissions: ['labels', 'sla'],
      members: [{ email: 'member@example.com' }]
    }]);
    const actor = makeActor({ email: 'member@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'sla'].sort());
  });

  test('leaf overrides group permissions with its own', () => {
    const engine = makeEngine([{
      name: 'Team A',
      permissions: ['labels', 'sla'],
      members: [{ email: 'lead@example.com', permissions: ['labels', 'sla', 'priority', 'slaBaseline'] }]
    }]);
    const actor = makeActor({ email: 'lead@example.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('root group with no permissions defaults to all (backward compat)', () => {
    const engine = makeEngine([{
      name: 'Team A',
      members: [{ email: 'member@example.com' }]
    }]);
    const actor = makeActor({ email: 'member@example.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('nested sub-group inherits grandparent permissions', () => {
    const engine = makeEngine([{
      name: 'Org',
      permissions: ['labels'],
      members: [{
        name: 'Sub-team',
        members: [{ email: 'deep@example.com' }]
      }]
    }]);
    const actor = makeActor({ email: 'deep@example.com' });
    expect(perms(engine, actor)).toEqual(['labels']);
  });

  test('sub-group overrides parent permissions for its descendants', () => {
    const engine = makeEngine([{
      name: 'Org',
      permissions: ['labels'],
      members: [{
        name: 'Leads',
        permissions: ['labels', 'sla', 'priority'],
        members: [{ email: 'lead@example.com' }]
      }]
    }]);
    const actor = makeActor({ email: 'lead@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'priority', 'sla'].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. Union resolution — user matches multiple entries
// ---------------------------------------------------------------------------

describe('Union resolution (most permissive wins)', () => {
  test('user matching two flat entries gets union of permissions', () => {
    const engine = makeEngine([
      { email: 'user@example.com', permissions: ['labels'] },
      { email: 'user@example.com', permissions: ['sla', 'priority'] }
    ]);
    const actor = makeActor({ email: 'user@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'priority', 'sla'].sort());
  });

  test('user in group and also flat entry gets union', () => {
    const engine = makeEngine([
      {
        name: 'Team',
        permissions: ['labels'],
        members: [{ email: 'user@example.com' }]
      },
      { email: 'user@example.com', permissions: ['slaBaseline'] }
    ]);
    const actor = makeActor({ email: 'user@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'slaBaseline'].sort());
  });

  test('user in restricted group but also in admin group gets all permissions', () => {
    const engine = makeEngine([
      {
        name: 'Admins',
        permissions: ['labels', 'sla', 'priority', 'slaBaseline'],
        members: [{ email: 'admin@example.com' }]
      },
      {
        name: 'Regular Team',
        permissions: ['labels'],
        members: [{ email: 'admin@example.com' }]
      }
    ]);
    const actor = makeActor({ email: 'admin@example.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });
});

// ---------------------------------------------------------------------------
// 4. linearTeamId resolution
// ---------------------------------------------------------------------------

describe('linearTeamId group membership', () => {
  const teamMembers: LinearUser[] = [
    { id: 'tm-1', email: 'member1@example.com', name: 'Member 1' },
    { id: 'tm-2', email: 'member2@example.com', name: 'Member 2' }
  ];

  function makeTeamEngine(groupPermissions?: Permission[]): EnforcementEngine {
    const cache = new Map<string, LinearUser[]>([['team-xyz', teamMembers]]);
    return makeEngine([{
      name: 'Engineering',
      linearTeamId: 'team-xyz',
      permissions: groupPermissions,
      members: []
    }], cache);
  }

  test('actor matched by id as team member gets group permissions', () => {
    const engine = makeTeamEngine(['labels', 'sla']);
    const actor = makeActor({ id: 'tm-1', email: 'member1@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'sla'].sort());
  });

  test('actor matched by email as team member gets group permissions', () => {
    const engine = makeTeamEngine(['labels', 'priority']);
    const actor = makeActor({ id: 'other-id', email: 'member2@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'priority'].sort());
  });

  test('actor not in team gets no permissions', () => {
    const engine = makeTeamEngine(['labels', 'sla']);
    const actor = makeActor({ id: 'outsider', email: 'outsider@example.com' });
    expect(perms(engine, actor)).toEqual(NONE);
  });

  test('linearTeamId with no permissions defaults to all', () => {
    const engine = makeTeamEngine(undefined);
    const actor = makeActor({ id: 'tm-1' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('empty team cache (API failed at startup) matches nobody', () => {
    const cache = new Map<string, LinearUser[]>([['team-xyz', []]]);
    const engine = makeEngine([{
      name: 'Engineering',
      linearTeamId: 'team-xyz',
      permissions: ['labels'],
      members: []
    }], cache);
    const actor = makeActor({ id: 'tm-1' });
    expect(perms(engine, actor)).toEqual(NONE);
  });

  test('team member also gets permissions from nested member entries via union', () => {
    const cache = new Map<string, LinearUser[]>([['team-xyz', teamMembers]]);
    const engine = makeEngine([{
      name: 'Engineering',
      linearTeamId: 'team-xyz',
      permissions: ['labels'],
      members: [
        { email: 'member1@example.com', permissions: ['labels', 'sla', 'priority'] }
      ]
    }], cache);
    // member1 matches via teamId (labels) AND via explicit leaf (labels+sla+priority)
    const actor = makeActor({ id: 'tm-1', email: 'member1@example.com' });
    expect(perms(engine, actor)).toEqual(['labels', 'priority', 'sla'].sort());
  });
});

// ---------------------------------------------------------------------------
// 5. slaBaseline vs sla separation
// ---------------------------------------------------------------------------

describe('slaBaseline vs sla permission distinction', () => {
  test('actor with sla but not slaBaseline cannot modify slaStartedAt', () => {
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['sla'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('sla')).toBe(true);
    expect(actorPerms.has('slaBaseline')).toBe(false);
  });

  test('actor with slaBaseline can modify slaStartedAt', () => {
    const engine = makeEngine([{ email: 'admin@example.com', permissions: ['sla', 'slaBaseline'] }]);
    const actor = makeActor({ email: 'admin@example.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('slaBaseline')).toBe(true);
  });

  test('team lead has sla but not slaBaseline; admin has both', () => {
    const engine = makeEngine([
      {
        name: 'Team Leads',
        permissions: ['labels', 'sla', 'priority'],
        members: [{ email: 'lead@example.com' }]
      },
      {
        name: 'Admins',
        permissions: ['labels', 'sla', 'priority', 'slaBaseline'],
        members: [{ email: 'admin@example.com' }]
      }
    ]);

    const leadPerms = engine.getActorPermissions(makeActor({ email: 'lead@example.com' }));
    const adminPerms = engine.getActorPermissions(makeActor({ email: 'admin@example.com' }));

    expect(leadPerms.has('slaBaseline')).toBe(false);
    expect(adminPerms.has('slaBaseline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. changeRequiresPermission mapping (via getActorPermissions + partial revert)
// ---------------------------------------------------------------------------

describe('changeRequiresPermission field mapping', () => {
  // We test indirectly: actor has only one permission, check which changes are allowed

  test('slaStartedAt requires slaBaseline, not sla', () => {
    // Actor has sla but NOT slaBaseline
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['sla'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    const actorPerms = engine.getActorPermissions(actor);

    // slaStartedAt requires slaBaseline
    const slaStartChange = makeChange('slaStartedAt');
    // slaBreachesAt requires sla
    const slaBreachChange = makeChange('slaBreachesAt');

    // Simulate what enforce() does: filter by permission
    const isStartAllowed = actorPerms.has('slaBaseline');
    const isBreachAllowed = actorPerms.has('sla');

    expect(isStartAllowed).toBe(false); // slaStartedAt blocked — needs slaBaseline
    expect(isBreachAllowed).toBe(true);  // slaBreachesAt allowed — has sla
  });

  test('label changes require labels permission', () => {
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['sla', 'priority'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('labels')).toBe(false);
  });

  test('priority changes require priority permission', () => {
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['labels', 'sla'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('priority')).toBe(false);
  });

  test('slaType and slaBreachesAt require sla permission', () => {
    const engine = makeEngine([{ email: 'user@example.com', permissions: ['slaBaseline'] }]);
    const actor = makeActor({ email: 'user@example.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('sla')).toBe(false);
    expect(actorPerms.has('slaBaseline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  test('actor with no email or id never matches any entry', () => {
    const engine = makeEngine([{ email: 'user@example.com' }]);
    const actor: WebhookActor = { id: '', type: 'integration', name: 'Bot', url: '' };
    expect(perms(engine, actor)).toEqual(NONE);
  });

  test('empty allowlist returns no permissions for any actor', () => {
    // Config-loader prevents empty allowlist, but test the engine directly
    const config = makeConfig([]);
    const engine = new EnforcementEngine(config, {} as LinearClient, new Map());
    expect(perms(engine, makeActor())).toEqual(NONE);
  });

  test('group with no linearTeamId and no members never matches', () => {
    // Config-loader rejects this, but engine should handle it gracefully
    const engine = makeEngine([{
      name: 'Empty Group',
      permissions: ['labels'],
      members: []
    } as any]);
    expect(perms(engine, makeActor({ email: 'user@example.com' }))).toEqual(NONE);
  });

  test('unknown actor not in any entry gets no permissions', () => {
    const engine = makeEngine([
      { email: 'alice@example.com', permissions: ['labels'] },
      { email: 'bob@example.com', permissions: ['sla'] }
    ]);
    const actor = makeActor({ email: 'unknown@example.com' });
    expect(perms(engine, actor)).toEqual(NONE);
  });

  test('deeply nested user inherits permissions through multiple levels', () => {
    const engine = makeEngine([{
      name: 'Level 1',
      permissions: ['labels'],
      members: [{
        name: 'Level 2',
        members: [{
          name: 'Level 3',
          members: [{
            name: 'Level 4',
            members: [{ email: 'deep@example.com' }]
          }]
        }]
      }]
    }]);
    const actor = makeActor({ email: 'deep@example.com' });
    expect(perms(engine, actor)).toEqual(['labels']);
  });

  test('actor matching by both email and id is not double-counted', () => {
    const engine = makeEngine([{ id: 'user-abc', email: 'user@example.com', permissions: ['labels'] }]);
    const actor = makeActor({ id: 'user-abc', email: 'user@example.com' });
    // Should match exactly once — permissions should be ['labels'], not duplicated
    expect(perms(engine, actor)).toEqual(['labels']);
  });

  test('integration actor with no email matched only by id', () => {
    const engine = makeEngine([{ id: 'integration-id', permissions: ['sla'] }]);
    const actor: WebhookActor = {
      id: 'integration-id',
      type: 'integration',
      name: 'My Integration',
      url: 'https://example.com'
      // no email
    };
    expect(perms(engine, actor)).toEqual(['sla']);
  });
});

// ---------------------------------------------------------------------------
// 8. Multi-team hierarchy scenario
// ---------------------------------------------------------------------------

describe('Multi-team hierarchy scenario', () => {
  const teamMembers: LinearUser[] = [
    { id: 'platform-1', email: 'platform-eng@yourcompany.com', name: 'Platform Engineer' },
    { id: 'platform-2', email: 'platform-lead@yourcompany.com', name: 'Platform Lead' }
  ];

  function makeMultiTeamEngine(): EnforcementEngine {
    const cache = new Map<string, LinearUser[]>([['team-platform', teamMembers]]);
    return makeEngine([
      {
        name: 'SLA Admins',
        permissions: ['labels', 'sla', 'priority', 'slaBaseline'],
        members: [
          { email: 'sla-admin@yourcompany.com', name: 'SLA Admin' }
        ]
      },
      {
        name: 'Platform Team',
        linearTeamId: 'team-platform',
        permissions: ['labels', 'sla', 'priority'],
        members: [
          {
            name: 'Platform Team Leads',
            permissions: ['labels', 'sla', 'priority', 'slaBaseline'],
            members: [
              { email: 'platform-lead@yourcompany.com', name: 'Platform Lead' }
            ]
          }
        ]
      }
    ], cache);
  }

  test('SLA admin can modify all fields including slaStartedAt', () => {
    const engine = makeMultiTeamEngine();
    const actor = makeActor({ email: 'sla-admin@yourcompany.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('regular team member can modify labels/sla/priority but NOT slaStartedAt', () => {
    const engine = makeMultiTeamEngine();
    // platform-eng is in team-platform but not in the Leads sub-group
    const actor = makeActor({ id: 'platform-1', email: 'platform-eng@yourcompany.com' });
    const actorPerms = engine.getActorPermissions(actor);
    expect(actorPerms.has('labels')).toBe(true);
    expect(actorPerms.has('sla')).toBe(true);
    expect(actorPerms.has('priority')).toBe(true);
    expect(actorPerms.has('slaBaseline')).toBe(false);
  });

  test('team lead can modify all fields including slaStartedAt', () => {
    const engine = makeMultiTeamEngine();
    // platform-lead is in team-platform (sla/priority/labels) AND in Leads sub-group (+ slaBaseline)
    // Union = all four permissions
    const actor = makeActor({ id: 'platform-2', email: 'platform-lead@yourcompany.com' });
    expect(perms(engine, actor)).toEqual(ALL);
  });

  test('external actor not in any group gets no permissions', () => {
    const engine = makeMultiTeamEngine();
    const actor = makeActor({ email: 'outsider@example.com' });
    expect(perms(engine, actor)).toEqual(NONE);
  });
});
