/**
 * Unit tests for webhook handler
 */

import { createHmac } from 'crypto';
import { verifySignature, verifyTimestamp, shouldEnforce, parseWebhookPayload } from '../../src/webhook-handler';
import { IssueWebhookPayload, IssueSLAWebhookPayload } from '../../src/types';

describe('WebhookHandler', () => {
  const SECRET = 'test-secret';

  describe('Signature verification', () => {
    it('should verify valid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const signature = createHmac('sha256', SECRET)
        .update(payload)
        .digest('hex');

      expect(verifySignature(signature, payload, SECRET)).toBe(true);
    });

    it('should reject invalid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const wrongSignature = 'invalid-signature';

      expect(verifySignature(wrongSignature, payload, SECRET)).toBe(false);
    });

    it('should reject missing signature', () => {
      const payload = JSON.stringify({ test: 'data' });

      expect(verifySignature(undefined, payload, SECRET)).toBe(false);
    });

    it('should reject tampered payload', () => {
      const payload = JSON.stringify({ test: 'data' });
      const signature = createHmac('sha256', SECRET)
        .update(payload)
        .digest('hex');

      const tamperedPayload = JSON.stringify({ test: 'modified' });

      expect(verifySignature(signature, tamperedPayload, SECRET)).toBe(false);
    });
  });

  describe('Timestamp verification', () => {
    it('should accept recent timestamp', () => {
      const now = Date.now();
      expect(verifyTimestamp(now)).toBe(true);
    });

    it('should accept timestamp within 60 seconds', () => {
      const fiftySecondsAgo = Date.now() - (50 * 1000);
      expect(verifyTimestamp(fiftySecondsAgo)).toBe(true);
    });

    it('should reject old timestamp', () => {
      const twoMinutesAgo = Date.now() - (120 * 1000);
      expect(verifyTimestamp(twoMinutesAgo)).toBe(false);
    });

    it('should reject future timestamp beyond threshold', () => {
      const twoMinutesInFuture = Date.now() + (120 * 1000);
      expect(verifyTimestamp(twoMinutesInFuture)).toBe(false);
    });
  });

  describe('Enforcement decision', () => {
    it('should enforce on Issue update', () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'update',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        data: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      expect(shouldEnforce(payload)).toBe(true);
    });

    it('should enforce on Issue remove', () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'remove',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        data: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      expect(shouldEnforce(payload)).toBe(true);
    });

    it('should not enforce on Issue create', () => {
      const payload: IssueWebhookPayload = {
        type: 'Issue',
        action: 'create',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        data: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      expect(shouldEnforce(payload)).toBe(false);
    });

    it('should enforce on IssueSLA events', () => {
      const payload: IssueSLAWebhookPayload = {
        type: 'IssueSLA',
        action: 'set',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        issueData: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      expect(shouldEnforce(payload)).toBe(true);
    });
  });

  describe('Payload parsing', () => {
    it('should parse valid Issue webhook', () => {
      const body = {
        type: 'Issue',
        action: 'update',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        data: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      const result = parseWebhookPayload(body);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('Issue');
    });

    it('should parse valid IssueSLA webhook', () => {
      const body = {
        type: 'IssueSLA',
        action: 'set',
        actor: { id: '1', type: 'user', name: 'User', url: 'url' },
        issueData: { id: '1', title: 'Test' },
        createdAt: new Date().toISOString(),
        url: 'url',
        webhookTimestamp: Date.now(),
        webhookId: 'id',
        organizationId: 'org'
      };

      const result = parseWebhookPayload(body);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('IssueSLA');
    });

    it('should reject payload missing required fields', () => {
      const body = {
        type: 'Issue',
        // Missing action, actor, etc.
      };

      const result = parseWebhookPayload(body);

      expect(result).toBeNull();
    });
  });
});

