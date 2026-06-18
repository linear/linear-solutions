/**
 * Unit tests for the StatusLockEngine — the core decision logic of the
 * Issue Lock Agent.
 */

import { StatusLockEngine } from '../../src/status-lock-engine';
import { Config, IssueWebhookPayload, WebhookActor, WorkflowState, LinearUser } from '../../src/types';

// --- Workflow states used across the tests -------------------------------------
const OPEN: WorkflowState = { id: 'st-open', name: 'In Progress', type: 'started' };
const RFD: WorkflowState = { id: 'st-rfd', name: 'Ready for Deployment', type: 'started' };
const CLOSED: WorkflowState = { id: 'st-closed', name: 'Closed', type: 'completed' };

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    lockedStatuses: ['Ready for Deployment', 'Closed', 'Cancelled'],
    lockedStatusTypes: [],
    monitoredFields: ['title', 'description', 'priority', 'estimate', 'assignee', 'labels', 'state', 'dueDate'],
    allowlist: [
      { name: 'Release Managers', members: [{ email: 'release@example.com', name: 'Release Mgr' }] }
    ],
    agent: { name: 'Issue Lock Agent', identifier: '🔒', userId: 'agent-user', email: 'agent@example.com' },
    slack: { enabled: false },
    behavior: { dryRun: false, notifyOnly: false, mentionUser: true, announceLock: true },
    // auditTrail off so tests don't write files
    logging: { level: 'error', auditTrail: false, auditLogPath: './logs/audit.log' },
    ...overrides
  };
}

function mockClient() {
  return {
    applyIssueUpdate: jest.fn().mockResolvedValue(undefined),
    createComment: jest.fn().mockResolvedValue(undefined),
    findLabelById: jest.fn().mockResolvedValue(null)
  };
}

function stateMap(): Map<string, WorkflowState> {
  return new Map([
    [OPEN.id, OPEN],
    [RFD.id, RFD],
    [CLOSED.id, CLOSED]
  ]);
}

const USER: WebhookActor = { id: 'u-dev', type: 'user', name: 'Dev Person', email: 'dev@example.com', url: '' };
const RELEASE_MGR: WebhookActor = { id: 'u-rel', type: 'user', name: 'Release Mgr', email: 'release@example.com', url: '' };
const AGENT: WebhookActor = { id: 'agent-user', type: 'user', name: 'Issue Lock Agent', email: 'agent@example.com', url: '' };

function issueUpdate(opts: {
  actor: WebhookActor;
  data: any;
  updatedFrom?: any;
}): IssueWebhookPayload {
  return {
    type: 'Issue',
    action: 'update',
    actor: opts.actor,
    data: opts.data,
    updatedFrom: opts.updatedFrom,
    createdAt: new Date().toISOString(),
    url: 'https://linear.app/acme/issue/ENG-1',
    webhookTimestamp: Date.now(),
    webhookId: 'wh-1',
    organizationId: 'org-1'
  };
}

describe('StatusLockEngine', () => {
  describe('isLockedState', () => {
    it('locks by configured status name (case-insensitive)', () => {
      const engine = new StatusLockEngine(buildConfig(), mockClient() as any, stateMap());
      expect(engine.isLockedState(RFD)).toBe(true);
      expect(engine.isLockedState({ id: 'x', name: 'ready for deployment', type: 'started' })).toBe(true);
      expect(engine.isLockedState(OPEN)).toBe(false);
    });

    it('locks by configured status type', () => {
      const cfg = buildConfig({ lockedStatuses: [], lockedStatusTypes: ['completed', 'canceled'] });
      const engine = new StatusLockEngine(cfg, mockClient() as any, stateMap());
      expect(engine.isLockedState(CLOSED)).toBe(true); // type 'completed'
      expect(engine.isLockedState(RFD)).toBe(false);   // type 'started', not in list
    });
  });

  describe('isAuthorized', () => {
    it('authorizes allowlisted users only', () => {
      const engine = new StatusLockEngine(buildConfig(), mockClient() as any, stateMap());
      expect(engine.isAuthorized(RELEASE_MGR)).toBe(true);
      expect(engine.isAuthorized(USER)).toBe(false);
    });

    it('authorizes members of an allowlisted Linear team', () => {
      const cfg = buildConfig({ allowlist: [{ name: 'Release Team', linearTeamId: 'REL' }] });
      const teamCache = new Map<string, LinearUser[]>([
        ['REL', [{ id: 'u-rel', email: 'release@example.com', name: 'Release Mgr' }]]
      ]);
      const engine = new StatusLockEngine(cfg, mockClient() as any, stateMap(), teamCache);
      expect(engine.isAuthorized(RELEASE_MGR)).toBe(true);
      expect(engine.isAuthorized(USER)).toBe(false);
    });
  });

  describe('enforce', () => {
    it('ignores changes to an issue that is not in a locked status', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'New title', state: OPEN },
        updatedFrom: { title: 'Old title' }
      }));
      expect(result.enforced).toBe(false);
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
    });

    it('allows (and announces) the transition INTO a locked status', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'Ship it', identifier: 'ENG-1', state: RFD },
        updatedFrom: { stateId: OPEN.id }
      }));
      expect(result.enforced).toBe(false);
      expect(result.lockApplied).toBe(true);
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
      expect(client.createComment).toHaveBeenCalledTimes(1); // the 🔒 announcement
    });

    it('reverts an unauthorized title change while locked', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'Sneaky edit', identifier: 'ENG-1', state: RFD },
        updatedFrom: { title: 'Approved title' }
      }));
      expect(result.enforced).toBe(true);
      expect(client.applyIssueUpdate).toHaveBeenCalledWith('i1', { title: 'Approved title' });
      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    it('reverts an unauthorized attempt to move the issue OUT of a locked status', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'X', identifier: 'ENG-1', state: OPEN }, // moved back to In Progress
        updatedFrom: { stateId: RFD.id } // was Ready for Deployment (locked)
      }));
      expect(result.enforced).toBe(true);
      expect(client.applyIssueUpdate).toHaveBeenCalledWith('i1', { stateId: RFD.id });
    });

    it('allows an authorized user to edit a locked issue', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: RELEASE_MGR,
        data: { id: 'i1', title: 'Legit fix', identifier: 'ENG-1', state: RFD },
        updatedFrom: { title: 'Approved title' }
      }));
      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('Actor authorized');
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
    });

    it('does not act on the agent\'s own changes (loop prevention)', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: AGENT,
        data: { id: 'i1', title: 'Reverting', state: RFD },
        updatedFrom: { title: 'Approved title' }
      }));
      expect(result.enforced).toBe(false);
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
    });

    it('reverts multiple changed fields at once', async () => {
      const client = mockClient();
      const engine = new StatusLockEngine(buildConfig(), client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'T2', priority: 1, assigneeId: 'a2', state: CLOSED },
        updatedFrom: { title: 'T1', priority: 3, assigneeId: 'a1' }
      }));
      expect(result.enforced).toBe(true);
      expect(client.applyIssueUpdate).toHaveBeenCalledWith('i1', {
        title: 'T1',
        priority: 3,
        assigneeId: 'a1'
      });
    });

    it('dry-run mode detects but does not revert', async () => {
      const client = mockClient();
      const cfg = buildConfig({ behavior: { dryRun: true, notifyOnly: false, mentionUser: true, announceLock: true } });
      const engine = new StatusLockEngine(cfg, client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'Edit', state: RFD },
        updatedFrom: { title: 'Original' }
      }));
      expect(result.enforced).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
      expect(client.createComment).not.toHaveBeenCalled();
    });

    it('notify-only mode comments but does not revert', async () => {
      const client = mockClient();
      const cfg = buildConfig({ behavior: { dryRun: false, notifyOnly: true, mentionUser: true, announceLock: true } });
      const engine = new StatusLockEngine(cfg, client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'Edit', state: RFD },
        updatedFrom: { title: 'Original' }
      }));
      expect(result.enforced).toBe(false);
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    it('ignores changes to unmonitored fields while locked', async () => {
      const client = mockClient();
      // only monitor 'title'
      const cfg = buildConfig({ monitoredFields: ['title'] });
      const engine = new StatusLockEngine(cfg, client as any, stateMap());
      const result = await engine.enforce(issueUpdate({
        actor: USER,
        data: { id: 'i1', title: 'Same', priority: 1, state: RFD },
        updatedFrom: { priority: 3 } // priority not monitored
      }));
      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('No monitored field changed');
      expect(client.applyIssueUpdate).not.toHaveBeenCalled();
    });
  });
});
