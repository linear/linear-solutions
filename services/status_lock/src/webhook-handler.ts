/**
 * Webhook validation and routing
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { WebhookPayload, IssueWebhookPayload, IssueSLAWebhookPayload } from './types';
import logger from './utils/logger';

/**
 * Verify webhook signature using HMAC-SHA256
 */
export function verifySignature(
  headerSignature: string | undefined,
  rawBody: string,
  secret: string
): boolean {
  if (!headerSignature) {
    return false;
  }

  try {
    const headerSignatureBuffer = Buffer.from(headerSignature, 'hex');
    const computedSignature = createHmac('sha256', secret)
      .update(rawBody)
      .digest();

    return timingSafeEqual(headerSignatureBuffer, computedSignature);
  } catch (error) {
    logger.error('Signature verification failed', {
      error: (error as Error).message
    });
    return false;
  }
}

/**
 * Verify webhook timestamp is recent (within 60 seconds)
 * Prevents replay attacks
 */
export function verifyTimestamp(webhookTimestamp: number): boolean {
  const now = Date.now();
  const age = Math.abs(now - webhookTimestamp);
  const maxAge = 60 * 1000; // 60 seconds

  if (age > maxAge) {
    logger.warn('Webhook timestamp too old', {
      age: age / 1000,
      maxAge: maxAge / 1000
    });
    return false;
  }

  return true;
}

/**
 * Express middleware to validate webhook signature
 */
export function webhookSignatureMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  
  // If no secret is configured, skip verification (with warning)
  if (!secret) {
    logger.warn('Webhook signature verification skipped (no secret configured)');
    next();
    return;
  }

  const signature = req.get('linear-signature');
  const rawBody = (req as any).rawBody;

  if (!rawBody) {
    logger.error('Raw body not available for signature verification');
    res.status(400).json({ error: 'Bad request' });
    return;
  }

  if (!verifySignature(signature, rawBody, secret)) {
    logger.error('Invalid webhook signature');
    res.status(401).json({ error: 'Unauthorized - invalid signature' });
    return;
  }

  logger.debug('Webhook signature verified');
  next();
}

/**
 * Express middleware to validate webhook timestamp
 */
export function webhookTimestampMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const payload = req.body as WebhookPayload;

  if (!payload.webhookTimestamp) {
    logger.error('Webhook missing timestamp');
    res.status(400).json({ error: 'Bad request - missing timestamp' });
    return;
  }

  if (!verifyTimestamp(payload.webhookTimestamp)) {
    logger.error('Webhook timestamp validation failed', {
      timestamp: payload.webhookTimestamp,
      age: Math.abs(Date.now() - payload.webhookTimestamp) / 1000
    });
    res.status(401).json({ error: 'Unauthorized - timestamp too old' });
    return;
  }

  logger.debug('Webhook timestamp verified');
  next();
}

/**
 * Determine if webhook should trigger enforcement
 */
export function shouldEnforce(payload: WebhookPayload): boolean {
  // Only handle Issue and IssueSLA events
  if (payload.type === 'Issue') {
    const issuePayload = payload as IssueWebhookPayload;
    // Only handle update and remove actions
    return issuePayload.action === 'update' || issuePayload.action === 'remove';
  }
  
  if (payload.type === 'IssueSLA') {
    // Handle all IssueSLA events (set, highRisk, breached)
    return true;
  }

  return false;
}

/**
 * Parse and validate webhook payload
 */
export function parseWebhookPayload(body: any): WebhookPayload | null {
  try {
    // Validate required fields (actor is optional for system events)
    if (!body.type || !body.action || !body.webhookTimestamp) {
      logger.error('Webhook payload missing required fields', {
        hasType: !!body.type,
        hasAction: !!body.action,
        hasActor: !!body.actor,
        hasTimestamp: !!body.webhookTimestamp
      });
      return null;
    }
    
    // If no actor, this is a system event (automation, workflow, etc.)
    // We skip these because they're not user actions that need protection
    if (!body.actor) {
      logger.debug('System event webhook (no actor), skipping processing', {
        type: body.type,
        action: body.action
      });
      return null; // Skip system events
    }

    // Validate payload based on type
    if (body.type === 'Issue') {
      if (!body.data) {
        logger.error('Issue webhook missing data field');
        return null;
      }
      return body as IssueWebhookPayload;
    }

    if (body.type === 'IssueSLA') {
      if (!body.issueData) {
        logger.error('IssueSLA webhook missing issueData field');
        return null;
      }
      return body as IssueSLAWebhookPayload;
    }

    // Unknown webhook type
    logger.debug('Received webhook with unknown type', { type: body.type });
    return body as WebhookPayload;
  } catch (error) {
    logger.error('Failed to parse webhook payload', {
      error: (error as Error).message
    });
    return null;
  }
}

/**
 * Extract issue data from webhook payload
 */
export function extractIssueData(payload: WebhookPayload): {
  current: any;
  previous?: any;
} {
  if (payload.type === 'Issue') {
    const issuePayload = payload as IssueWebhookPayload;
    
    logger.debug('Extracting Issue webhook data', {
      currentLabels: issuePayload.data?.labels?.map((l: any) => l.name) || [],
      previousLabelIds: issuePayload.updatedFrom?.labelIds || [],
      hasPreviousData: !!issuePayload.updatedFrom
    });
    
    return {
      current: issuePayload.data,
      previous: issuePayload.updatedFrom
    };
  }

  if (payload.type === 'IssueSLA') {
    const slaPayload = payload as IssueSLAWebhookPayload;
    return {
      current: slaPayload.issueData,
      previous: undefined // IssueSLA events don't include updatedFrom
    };
  }

  return { current: null };
}

