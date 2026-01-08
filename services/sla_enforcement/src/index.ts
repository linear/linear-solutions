/**
 * Main entry point for Vulnerability Protection Agent
 */

import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { loadConfig, validateEnvironment } from './config-loader';
import { LinearClient } from './linear-client';
import { EnforcementEngine } from './enforcement-engine';
import { SlackNotifier } from './slack-notifier';
import { StartupValidator } from './startup-validator';
import {
  webhookSignatureMiddleware,
  webhookTimestampMiddleware,
  shouldEnforce,
  parseWebhookPayload
} from './webhook-handler';
import { WebhookPayload } from './types';
import logger from './utils/logger';
import { getAuditStats } from './utils/audit-trail';
import { asyncHandler } from './utils/error-handler';

// Load environment variables
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  try {
    logger.info('🚀 Starting Vulnerability Protection Agent...');

    // Validate environment
    validateEnvironment();

    // Load configuration
    const config = loadConfig();
    logger.info('✓ Configuration loaded', {
      protectedLabels: config.protectedLabels,
      allowlistCount: config.allowlist.length,
      dryRun: config.behavior.dryRun,
      notifyOnly: config.behavior.notifyOnly
    });

    // Initialize clients
    const linearClient = new LinearClient(process.env.LINEAR_API_KEY!);
    const enforcementEngine = new EnforcementEngine(config, linearClient);
    const slackNotifier = new SlackNotifier(config);

    // Run startup validation
    const validator = new StartupValidator(config, linearClient);
    await validator.validate();

    // Proactively cache SLA values for all protected issues
    // This ensures we have the "original" SLA values before any changes happen
    await enforcementEngine.cacheProtectedIssues();

    // Test Slack connection if enabled
    if (config.slack.enabled) {
      await slackNotifier.testConnection();
    }

    // Create Express app
    const app = express();

    // Middleware to capture raw body for signature verification
    app.use(express.json({
      verify: (req: any, res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));

    // Health check endpoint
    app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        agent: config.agent.name,
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Config endpoint (for debugging)
    app.get('/config', (req: Request, res: Response) => {
      res.json({
        protectedLabels: config.protectedLabels,
        allowlistCount: config.allowlist.length,
        agentName: config.agent.name,
        slackEnabled: config.slack.enabled,
        dryRun: config.behavior.dryRun,
        notifyOnly: config.behavior.notifyOnly,
        mentionUser: config.behavior.mentionUser
      });
    });

    // Metrics endpoint
    app.get('/metrics', asyncHandler(async (req: Request, res: Response) => {
      const stats = await getAuditStats(config.logging.auditLogPath);
      res.json({
        audit: stats,
        uptime: process.uptime(),
        config: {
          dryRun: config.behavior.dryRun,
          notifyOnly: config.behavior.notifyOnly
        }
      });
    }));

    // Main webhook endpoint
    app.post(
      '/webhooks/linear',
      webhookSignatureMiddleware,
      webhookTimestampMiddleware,
      asyncHandler(async (req: Request, res: Response) => {
        // Log full webhook payload at debug level
        logger.debug('Raw webhook payload received', {
          payload: JSON.stringify(req.body, null, 2)
        });
        
        const payload = parseWebhookPayload(req.body);

        if (!payload) {
          // Check if this is a system event (no actor) vs invalid payload
          if (req.body && req.body.type && req.body.action && !req.body.actor) {
            // System event - acknowledge but don't process
            logger.debug('Skipped system event webhook', {
              type: req.body.type,
              action: req.body.action
            });
            res.status(200).json({ received: true, processed: false, reason: 'system_event' });
            return;
          }
          
          // Invalid payload
          logger.error('Invalid webhook payload');
          res.status(400).json({ error: 'Invalid payload' });
          return;
        }

        logger.info('Received webhook', {
          type: payload.type,
          action: payload.action,
          webhookId: payload.webhookId
        });

        // Check if we should enforce
        if (!shouldEnforce(payload)) {
          logger.debug('Webhook does not require enforcement', {
            type: payload.type,
            action: payload.action
          });
          res.status(200).json({ status: 'acknowledged' });
          return;
        }

        // Process enforcement asynchronously
        // Respond immediately to Linear (within 5 seconds requirement)
        res.status(200).json({ status: 'processing' });

        // Execute enforcement
        try {
          const result = await enforcementEngine.enforce(payload);

          // Send Slack notification if change was reverted or detected
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

          logger.info('Enforcement completed', {
            enforced: result.enforced,
            reason: result.reason
          });
        } catch (error) {
          logger.error('Enforcement failed', {
            error: (error as Error).message,
            webhookId: payload.webhookId
          });
        }
      })
    );

    // 404 handler
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    app.use((error: Error, req: Request, res: Response, next: any) => {
      logger.error('Express error handler', {
        error: error.message,
        stack: error.stack
      });
      res.status(500).json({ error: 'Internal server error' });
    });

    // Start server
    app.listen(PORT, () => {
      logger.info(`✓ Server listening on port ${PORT}`);
      logger.info('\n✅ Vulnerability Protection Agent is ready!');
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

// Start the application
main();

