/**
 * Main entry point for the Linear Issue Lock Agent.
 */

import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { loadConfig, validateEnvironment } from './config-loader';
import { LinearClient } from './linear-client';
import { StatusLockEngine } from './status-lock-engine';
import { SlackNotifier } from './slack-notifier';
import { StartupValidator } from './startup-validator';
import {
  webhookSignatureMiddleware,
  webhookTimestampMiddleware,
  shouldEnforce,
  parseWebhookPayload
} from './webhook-handler';
import logger from './utils/logger';
import { getAuditStats } from './utils/audit-trail';
import { asyncHandler } from './utils/error-handler';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  try {
    logger.info('🔒 Starting Linear Issue Lock Agent...');

    validateEnvironment();

    const config = loadConfig();
    logger.info('✓ Configuration loaded', {
      lockedStatuses: config.lockedStatuses,
      lockedStatusTypes: config.lockedStatusTypes ?? [],
      monitoredFields: config.monitoredFields,
      allowlistGroups: config.allowlist.length,
      dryRun: config.behavior.dryRun,
      notifyOnly: config.behavior.notifyOnly
    });

    const linearClient = new LinearClient(process.env.LINEAR_API_KEY!);
    const slackNotifier = new SlackNotifier(config);

    // Startup validation — connects to Linear, builds the workflow-state map,
    // and resolves any allowlist team memberships.
    const validator = new StartupValidator(config, linearClient);
    await validator.validate();

    const engine = new StatusLockEngine(
      config,
      linearClient,
      validator.getStateMap(),
      validator.getTeamMemberCache()
    );

    validator.startTeamRefresh();

    if (config.slack.enabled) {
      await slackNotifier.testConnection();
    }

    const app = express();
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));

    // Health check
    app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        agent: config.agent.name,
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Config (redacted)
    app.get('/config', (_req: Request, res: Response) => {
      res.json({
        lockedStatuses: config.lockedStatuses,
        lockedStatusTypes: config.lockedStatusTypes ?? [],
        monitoredFields: config.monitoredFields,
        allowlistGroups: config.allowlist.length,
        agentName: config.agent.name,
        slackEnabled: config.slack.enabled,
        dryRun: config.behavior.dryRun,
        notifyOnly: config.behavior.notifyOnly,
        mentionUser: config.behavior.mentionUser,
        announceLock: config.behavior.announceLock
      });
    });

    // Metrics
    app.get('/metrics', asyncHandler(async (_req: Request, res: Response) => {
      const stats = await getAuditStats(config.logging.auditLogPath);
      res.json({
        audit: stats,
        uptime: process.uptime(),
        config: { dryRun: config.behavior.dryRun, notifyOnly: config.behavior.notifyOnly }
      });
    }));

    // Webhook endpoint
    app.post(
      '/webhooks/linear',
      webhookSignatureMiddleware,
      webhookTimestampMiddleware,
      asyncHandler(async (req: Request, res: Response) => {
        logger.debug('Raw webhook payload received', { payload: JSON.stringify(req.body) });

        const payload = parseWebhookPayload(req.body);

        if (!payload) {
          if (req.body && req.body.type && req.body.action && !req.body.actor) {
            // System event (no actor) — acknowledge, don't process.
            res.status(200).json({ received: true, processed: false, reason: 'system_event' });
            return;
          }
          logger.error('Invalid webhook payload');
          res.status(400).json({ error: 'Invalid payload' });
          return;
        }

        logger.info('Received webhook', {
          type: payload.type,
          action: payload.action,
          webhookId: payload.webhookId
        });

        if (!shouldEnforce(payload)) {
          res.status(200).json({ status: 'acknowledged' });
          return;
        }

        // Respond immediately (Linear expects a fast 200), then process.
        res.status(200).json({ status: 'processing' });

        try {
          const result = await engine.enforce(payload);

          if (result.enforced || result.reason === 'Notify only mode') {
            const issueData = (payload as any).data || (payload as any).issueData;
            if (issueData && result.changes) {
              await slackNotifier.notifyUnauthorizedChange(
                issueData.id,
                issueData.identifier || issueData.id,
                issueData.title || 'Unknown Issue',
                payload.url,
                payload.actor,
                result.changes,
                result.enforced
              );
            }
          }

          logger.info('Enforcement completed', { enforced: result.enforced, reason: result.reason });
        } catch (error) {
          logger.error('Enforcement failed', {
            error: (error as Error).message,
            webhookId: payload.webhookId
          });
        }
      })
    );

    app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    app.use((error: Error, _req: Request, res: Response, _next: any) => {
      logger.error('Express error handler', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Internal server error' });
    });

    app.listen(PORT, () => {
      logger.info(`✓ Server listening on port ${PORT}`);
      logger.info('\n✅ Issue Lock Agent is ready!');
      logger.info(`\n📝 Expose this server with ngrok:\n   ngrok http ${PORT}\n`);
    });
  } catch (error) {
    logger.error('Failed to start agent', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });
    process.exit(1);
  }
}

main();
