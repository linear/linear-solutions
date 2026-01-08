/**
 * Unit tests for enforcement engine
 */

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

  beforeEach(() => {
    config = {
      protectedLabels: ['Vulnerability'],
      checkLabelGroups: true,
      protectedFields: { label: true, sla: true },
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
        auditLogPath: './logs/test-audit.log'
      }
    };

    mockLinearClient = new LinearClient('test-key') as jest.Mocked<LinearClient>;
    engine = new EnforcementEngine(config, mockLinearClient);
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
          labels: [] // Label removed
        },
        updatedFrom: {
          labels: [{ id: 'label-1', name: 'Vulnerability' }] // Had protected label before
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      // Need to mock getIssue to return issue with protected label
      mockLinearClient.getIssue = jest.fn().mockResolvedValue({
        id: 'issue-1',
        title: 'Test Issue',
        labels: [{ id: 'label-1', name: 'Vulnerability' }]
      });

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('User authorized');
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
          labels: [] // Label removed
        },
        updatedFrom: {
          labels: [{ id: 'label-1', name: 'Vulnerability' }] // Had protected label before
        },
        createdAt: new Date().toISOString(),
        url: 'https://linear.app/issue/1',
        webhookTimestamp: Date.now(),
        webhookId: 'webhook-1',
        organizationId: 'org-1'
      };

      // Need to mock getIssue to return issue with protected label
      mockLinearClient.getIssue = jest.fn().mockResolvedValue({
        id: 'issue-1',
        title: 'Test Issue',
        labels: [{ id: 'label-1', name: 'Vulnerability' }]
      });

      const result = await engine.enforce(payload);

      expect(result.enforced).toBe(false);
      expect(result.reason).toBe('Dry run mode');
      expect(result.dryRun).toBe(true);
      expect(mockLinearClient.updateIssue).not.toHaveBeenCalled();
    });
  });
});

