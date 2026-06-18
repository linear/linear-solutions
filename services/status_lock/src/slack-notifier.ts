/**
 * Slack notification handler
 */

import { WebClient } from '@slack/web-api';
import { Config, ChangeDetection, WebhookActor } from './types';
import logger from './utils/logger';
import { tryGracefully } from './utils/error-handler';

export class SlackNotifier {
  private client: WebClient | null = null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;

    if (config.slack.enabled) {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        logger.error('Slack is enabled but SLACK_BOT_TOKEN is not set');
        return;
      }
      this.client = new WebClient(token);
    }
  }

  /**
   * Send notification about unauthorized change
   */
  async notifyUnauthorizedChange(
    issueId: string,
    issueIdentifier: string,
    issueTitle: string,
    issueUrl: string,
    actor: WebhookActor,
    changes: ChangeDetection[],
    reverted: boolean
  ): Promise<void> {
    if (!this.config.slack.enabled || !this.client || !this.config.slack.channelId) {
      return;
    }

    const changesText = changes
      .map(c => c.description)
      .join('\n• ');

    const actionText = reverted ? '→ Reverted ✅' : '→ Detected ℹ️';

    const message = {
      channel: this.config.slack.channelId,
      text: `🔒 Change to locked issue ${issueIdentifier}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔒 Locked Issue Changed',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Issue:*\n<${issueUrl}|${issueIdentifier}: ${issueTitle}>`
            },
            {
              type: 'mrkdwn',
              text: `*User:*\n${actor.email || actor.name}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Changes:*\n• ${changesText}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Action:* ${actionText}`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🤖 ${this.config.agent.name} | ${new Date().toLocaleString()}`
            }
          ]
        }
      ]
    };

    await tryGracefully(
      async () => {
        await this.client!.chat.postMessage(message);
        logger.info('Slack notification sent', { issueId });
      },
      undefined,
      'Send Slack notification'
    );
  }

  /**
   * Test Slack connection
   */
  async testConnection(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      const result = await this.client.auth.test();
      logger.info('Slack connection test successful', {
        team: result.team,
        user: result.user
      });
      return true;
    } catch (error) {
      logger.error('Slack connection test failed', {
        error: (error as Error).message
      });
      return false;
    }
  }
}

