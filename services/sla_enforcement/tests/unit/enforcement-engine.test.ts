/**
 * Unit tests for enforcement engine
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EnforcementEngine } from '../../src/enforcement-engine';
import { LinearClient } from '../../src/linear-client';
import { Config, IssueWebhookPayload, WebhookActor, IssueLabel } from '../../src/types';

// Mock LinearClient
jest.mock('../../src/linear-client');
jest.mock('../../src/utils/logger');
jest.mock('../../src/utils/audit-trail');

describe('EnforcementEngine', () => {
  let engine: EnforcementEngine;
  let mockLinearClient: jest.Mocked<LinearClient>;
  let config: Config;
  let outerTmpDir: string;

  beforeEach(() => {
    // Use a fresh temp directory for each test so disk-persisted cache files
    // from previous runs never contaminate subsequent tests.
    outerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-test-'));

    config = {
      protectedLabels: ['Vulnerability'],
      checkLabelGroups: true,
      protectedFields: { label: true, sla: true, priority: false },
      allowlist: [
        { email: 'admin@example.com', name: 'Admin User' }
      ],
      agent: {
        name: 'Test Agent',
        identifier: '🤖 [TEST]',
        userId: 'agent-id',
        email: 'agent@example.com'
      },
      slack: { enabled: false },
      behavior: {
        dryRun: false,
        notifyOnly: false,
        mentionUser: true
      },
      logging: {
        level: 'info',
        auditTrail: true,
        auditLogPath: path.join(outerTmpDir, 'audit.log')
      }
    };

    mockLinearClient = new LinearClient('test-key') as jest.Mocked<LinearClient>;
    engine = new EnforcementEngine(config, mockLinearClient);
  });

  afterEach(() => {
    fs.rmSync(outerTmpDir, { recursive: true, force: true });
  });

  describe('Agent action detection', () => {
    it('should skip enforcement for agent actions (by user ID)', async () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'agent-id', // Matches config.agent.userId
          type: 'user',
          name: 'Test Agent',
          url: 'https://linear.app/user/agent-id'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [{ id: 'label-1', name: 'Vulnerability' }]
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('Agent action (self)');
    });

    it('should skip enforcement for agent actions (by email)', async () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'different-id',
          type: 'user',
          name: 'Test Agent',
          email: 'agent@example.com', // Matches config.agent.email
          url: 'https://linear.app/user/different-id'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [{ id: 'label-1', name: 'Vulnerability' }]
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('Agent action (self)');
    });
  });

  describe('Protected label detection', () => {
    it('should skip enforcement when issue has no protected label', async () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'user-1',
          type: 'user',
          name: 'Regular User',
          email: 'user@example.com',
          url: 'https://linear.app/user/user-1'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [{ id: 'label-1', name: 'Bug' }] // Not a protected label
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('No protected label');
    });

    it('should detect protected label in top-level labels', async () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'user-1',
          type: 'user',
          name: 'Regular User',
          email: 'user@example.com',
          url: 'https://linear.app/user/user-1'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [{ id: 'label-1', name: 'Vulnerability' }]
        },
        updatedFrom: {
          labels: [] // Label was added
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      // Should not enforce because no relevant change detected (label was added, not removed)
      expect(result.reason).not.toBe('No protected label');
    });
  });

  describe('Authorized user detection', () => {
    it('should allow changes from allowlisted users', async () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'admin-1',
          type: 'user',
          name: 'Admin User',
          email: 'admin@example.com', // In allowlist
          url: 'https://linear.app/user/admin-1'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [], // Label removed
          labelIds: []
        },
        updatedFrom: {
          labelIds: ['label-1'], // triggers label change detection
          labels: [{ id: 'label-1', name: 'Vulnerability' }] // for hadProtectedBefore check
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      mockLinearClient.findLabelById = jest.fn().mockResolvedValue({ id: 'label-1', name: 'Vulnerability' });
      mockLinearClient.createComment = jest.fn().mockResolvedValue(undefined);

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('User authorized');
    });
  });

  describe('slaCreatedAtBaseline enforcement', () => {
    const ISSUE_ID = 'issue-baseline-1';
    const CREATED_AT = '2026-01-01T09:00:00.000Z';
    const DRIFTED_SLA_STARTED_AT = '2026-03-01T09:00:00.000Z';
    const SLA_BREACHES_AT = '2026-04-15T09:00:00.000Z';

    // Shared baseline actor (unauthorized)
    const unauthorizedActor = {
      id: 'user-1',
      type: 'user' as const,
      name: 'Regular User',
      email: 'user@example.com',
      url: 'https://linear.app/user/user-1'
    };

    // Shared baseline actor (authorized)
    const authorizedActor = {
      id: 'admin-1',
      type: 'user' as const,
      name: 'Admin User',
      email: 'admin@example.com',
      url: 'https://linear.app/user/admin-1'
    };

    // Populates the cache with createdAt so the engine has a baseline to enforce against
    async function seedCache(issueId = ISSUE_ID, createdAt = CREATED_AT) {
      mockLinearClient.findLabelByName = jest.fn().mockResolvedValue({
        id: 'label-vuln',
        name: 'Vulnerability'
      });
      mockLinearClient.getIssuesWithLabel = jest.fn().mockResolvedValue([{
        id: issueId,
        title: 'Test Issue',
        identifier: 'SEC-1',
        priority: 2,
        slaType: 'all',
        slaStartedAt: createdAt,
        slaBreachesAt: SLA_BREACHES_AT,
        createdAt,
        labels: [{ id: 'label-vuln', name: 'Vulnerability' }]
      }]);
      await engine.cacheProtectedIssues();
    }

    let tmpDir: string;

    beforeEach(() => {
      // Isolate each test to its own temp directory so disk-persisted cache
      // from one test never leaks into another.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-test-'));
      config.logging.auditLogPath = path.join(tmpDir, 'audit.log');
      config.protectedFields = { label: true, sla: true, priority: true, slaCreatedAtBaseline: true };
      engine = new EnforcementEngine(config, mockLinearClient);

      mockLinearClient.findLabelById = jest.fn().mockResolvedValue(null);
      mockLinearClient.createComment = jest.fn().mockResolvedValue(undefined);
      mockLinearClient.updateIssue = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should not enforce when slaStartedAt equals createdAt', async () => {
      await seedCache();

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: CREATED_AT, // in sync with baseline — no drift
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          // title changed only — no SLA, priority, or label fields — no enforceable changes
          title: 'Old title'
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.changes?.some(c => c.field === 'slaStartedAt')).toBeFalsy();
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });

    it('should revert slaStartedAt to createdAt when explicitly changed', async () => {
      await seedCache();

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT, // manually reset the clock
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          slaType: 'all',
          slaStartedAt: CREATED_AT, // previous value was createdAt
          slaBreachesAt: SLA_BREACHES_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(true);
      expect(result.changes?.some(c => c.field === 'slaStartedAt')).toBe(true);

      // slaStartedAt in the update call must be createdAt, not the intermediate value
      const updateCalls = (mockLinearClient.updateIssue as jest.Mock).mock.calls;
      const slaCall = updateCalls.find(([, input]) => input.slaStartedAt !== undefined);
      expect(slaCall).toBeDefined();
      const sent = slaCall[1].slaStartedAt;
      expect(sent instanceof Date ? sent.toISOString() : sent).toBe(CREATED_AT);
    });

    it('should detect slaStartedAt drift that is absent from updatedFrom', async () => {
      // A priority-triggered workflow silently resets slaStartedAt.
      // Linear does NOT include slaStartedAt in updatedFrom in this case —
      // the standard check misses it, but the canonical baseline check catches it.
      await seedCache();

      config.behavior.dryRun = true; // use dry run so we can inspect changes without full revert
      engine = new EnforcementEngine(config, mockLinearClient);
      await seedCache();

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT, // silently reset by workflow
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 1
        },
        updatedFrom: { priority: 2 }, // only priority in updatedFrom — slaStartedAt absent
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.dryRun).toBe(true);
      const slaStartChange = result.changes?.find(c => c.field === 'slaStartedAt');
      expect(slaStartChange).toBeDefined();
      expect(slaStartChange?.oldValue).toBe(CREATED_AT); // revert target is createdAt
      expect(slaStartChange?.newValue).toBe(DRIFTED_SLA_STARTED_AT);
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });

    it('should use createdAt as slaStartedAt in the two-step priority revert', async () => {
      // Priority change + SLA fields in updatedFrom triggers the two-step update.
      // The second call (SLA restore) must use createdAt as slaStartedAt.
      jest.useFakeTimers();
      await seedCache();

      const PREV_BREACHES_AT = '2026-03-01T09:00:00.000Z';

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT, // reset by workflow after priority change
          slaBreachesAt: SLA_BREACHES_AT, // recalculated after reset
          priority: 1 // changed from 2
        },
        updatedFrom: {
          priority: 2,
          slaType: 'all',
          slaStartedAt: '2025-12-01T00:00:00.000Z', // some intermediate — NOT createdAt
          slaBreachesAt: PREV_BREACHES_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const enforcePromise = engine.enforce(payload);
      await jest.runAllTimersAsync();
      const result = await enforcePromise;

      jest.useRealTimers();

      expect(result.enforced).toBe(true);
      expect(mockLinearClient.updateIssue).toHaveBeenCalledTimes(2);

      // Second call restores SLA — slaStartedAt must be createdAt
      const slaRestoreCall = (mockLinearClient.updateIssue as jest.Mock).mock.calls[1];
      const sentSlaStartedAt = slaRestoreCall[1].slaStartedAt;
      const isoValue = sentSlaStartedAt instanceof Date
        ? sentSlaStartedAt.toISOString()
        : sentSlaStartedAt;
      expect(isoValue).toBe(CREATED_AT);
    });

    it('should allow slaStartedAt changes from authorized users without reverting', async () => {
      await seedCache();

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: authorizedActor, // in allowlist
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT,
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          slaType: 'all',
          slaStartedAt: CREATED_AT,
          slaBreachesAt: SLA_BREACHES_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('User authorized');
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });

    it('should never overwrite createdAt baseline even after an authorized change', async () => {
      await seedCache();

      // Authorized user changes slaStartedAt — cache updates, but createdAt stays fixed
      const authorizedPayload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: authorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT,
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          slaType: 'all',
          slaStartedAt: CREATED_AT,
          slaBreachesAt: SLA_BREACHES_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-admin',
        organizationId: 'org-1'
      };
      await engine.enforce(authorizedPayload);

      // Now an unauthorized user touches the issue — baseline must still be CREATED_AT
      const unauthorizedPayload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT, // still drifted from createdAt
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT,
          slaBreachesAt: SLA_BREACHES_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-user',
        organizationId: 'org-1'
      };
      const result = await engine.enforce(unauthorizedPayload);

      const slaStartChange = result.changes?.find(c => c.field === 'slaStartedAt');
      // Baseline is still CREATED_AT — the authorized change did not overwrite it
      expect(slaStartChange?.oldValue).toBe(CREATED_AT);
    });

    it('should skip baseline check gracefully when createdAt is not in cache', async () => {
      // No seedCache() call — simulates an issue the engine has never seen
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT,
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {}, // nothing changed explicitly
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      // Should not throw — baseline check should be silently skipped
      await expect(engine.enforce(payload)).resolves.not.toThrow();
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });

    it('should not enforce canonical check when slaCreatedAtBaseline is false', async () => {
      config.protectedFields = { label: true, sla: false, priority: false, slaCreatedAtBaseline: false };
      engine = new EnforcementEngine(config, mockLinearClient);
      await seedCache();

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: unauthorizedActor,
        data: {
          id: ISSUE_ID,
          title: 'Test Issue',
          labels: [{ id: 'label-vuln', name: 'Vulnerability' }],
          slaType: 'all',
          slaStartedAt: DRIFTED_SLA_STARTED_AT, // drifted — but feature is off
          slaBreachesAt: SLA_BREACHES_AT,
          priority: 2
        },
        updatedFrom: {
          slaStartedAt: CREATED_AT
        },
        createdAt: CREATED_AT,
        url: '',
        webhookTimestamp: Date.now(),
        webhookId: 'wh-1',
        organizationId: 'org-1'
      };

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });
  });

  describe('Dry run mode', () => {
    it('should not revert in dry run mode', async () => {
      config.behavior.dryRun = true;
      engine = new EnforcementEngine(config, mockLinearClient);

      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: {
          id: 'user-1',
          type: 'user',
          name: 'Regular User',
          email: 'user@example.com',
          url: 'https://linear.app/user/user-1'
        },
        data: {
          id: 'issue-1',
          title: 'Test Issue',
          labels: [], // Label removed
          labelIds: []
        },
        updatedFrom: {
          labelIds: ['label-1'], // triggers label change detection
          labels: [{ id: 'label-1', name: 'Vulnerability' }] // for hadProtectedBefore check
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      mockLinearClient.findLabelById = jest.fn().mockResolvedValue({ id: 'label-1', name: 'Vulnerability' });

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('Dry run mode');
      expect(result.dryRun).toBe(true);
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });
  });
});

