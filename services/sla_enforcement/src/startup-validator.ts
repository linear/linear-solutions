/**
 * Startup validation to ensure everything is configured correctly
 */

import { Config } from './types';
import { LinearClient } from './linear-client';
import logger from './utils/logger';

export class StartupValidator {
  constructor(
    private config: Config,
    private linearClient: LinearClient
  ) {}

  /**
   * Run all startup validation checks
   * Throws error if any critical check fails
   */
  async validate(): Promise<void> {
    logger.info('🔍 Running startup validation checks...');

    await this.validateLinearAPI();
    await this.validateProtectedLabels();
    await this.validateAllowlistUsers();
    await this.validateWebhookSecret();
    
    if (this.config.slack.enabled) {
      await this.validateSlack();
    }

    logger.info('✅ All startup validation checks passed');
  }

  /**
   * Validate Linear API connectivity and store agent user ID
   */
  private async validateLinearAPI(): Promise<void> {
    try {
      const viewer = await this.linearClient.getViewer();
      logger.info(`✓ Linear API connected as: ${viewer.email} (${viewer.name})`);
      
      // Store agent's user ID and email for infinite loop prevention
      if (!this.config.agent.userId) {
        this.config.agent.userId = viewer.id;
        this.config.agent.email = viewer.email;
        logger.info(`✓ Agent user ID stored: ${viewer.id}`);
      }
    } catch (error) {
      throw new Error(`Linear API connection failed: ${(error as Error).message}`);
    }
  }

  /**
   * Verify protected labels exist in the workspace
   */
  private async validateProtectedLabels(): Promise<void> {
    const notFound: string[] = [];
    
    for (const labelName of this.config.protectedLabels) {
      try {
        const label = await this.linearClient.findLabelByName(labelName);
        if (!label) {
          notFound.push(labelName);
          logger.warn(`⚠️  Protected label "${labelName}" not found in workspace`);
        } else {
          const parentInfo = label.parent ? ` (child of "${label.parent.name}")` : ' (top-level)';
          logger.info(`✓ Protected label "${labelName}" found${parentInfo} (ID: ${label.id})`);
        }
      } catch (error) {
        logger.error(`Failed to check label "${labelName}"`, {
          error: (error as Error).message
        });
      }
    }

    if (notFound.length > 0) {
      logger.warn(
        `Some protected labels were not found: ${notFound.join(', ')}. ` +
        `The agent will still monitor for these labels if they are created later.`
      );
    }
  }

  /**
   * Verify allowlist users exist in the workspace
   */
  private async validateAllowlistUsers(): Promise<void> {
    let foundCount = 0;
    let notFoundCount = 0;

    for (const allowedUser of this.config.allowlist) {
      const displayName = allowedUser.name || allowedUser.email || allowedUser.id || 'Unknown';
      
      if (allowedUser.email) {
        try {
          const user = await this.linearClient.findUserByEmail(allowedUser.email);
          if (!user) {
            notFoundCount++;
            logger.warn(`⚠️  Allowlist user ${displayName} not found in workspace`);
          } else {
            foundCount++;
            logger.info(`✓ Allowlist user ${user.email} (${user.name}) found`);
          }
        } catch (error) {
          logger.error(`Failed to check allowlist user ${displayName}`, {
            error: (error as Error).message
          });
        }
      } else if (allowedUser.id) {
        foundCount++;
        logger.info(`✓ Allowlist user ${displayName} configured by ID: ${allowedUser.id}`);
      }
    }

    logger.info(`✓ Allowlist configured with ${foundCount} users (${notFoundCount} not found)`);
  }

  /**
   * Verify webhook secret is configured
   */
  private async validateWebhookSecret(): Promise<void> {
    if (!process.env.LINEAR_WEBHOOK_SECRET) {
      logger.warn(
        '⚠️  LINEAR_WEBHOOK_SECRET not configured. ' +
        'Webhook signature verification will be DISABLED. ' +
        'This is NOT recommended for production!'
      );
    } else {
      logger.info('✓ Webhook secret configured');
    }
  }

  /**
   * Validate Slack connectivity (if enabled)
   */
  private async validateSlack(): Promise<void> {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error(
        'Slack is enabled in config but SLACK_BOT_TOKEN is not set in environment'
      );
    }

    // Basic validation - just check token format
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token.startsWith('xoxb-')) {
      logger.warn('⚠️  SLACK_BOT_TOKEN does not appear to be a bot token (should start with xoxb-)');
    }

    logger.info('✓ Slack configuration validated');
    
    if (!this.config.slack.channelId) {
      logger.warn('⚠️  Slack is enabled but no channelId is configured');
    } else {
      logger.info(`✓ Slack notifications will be sent to channel: ${this.config.slack.channelId}`);
    }
  }
}

