/**
 * Startup validation to ensure everything is configured correctly.
 * Also owns the linearTeamId → member cache used by the enforcement engine.
 */

import { Config, AllowlistEntry, AllowlistLeaf, AllowlistGroup, isAllowlistGroup, LinearUser } from './types';
import { LinearClient } from './linear-client';
import logger from './utils/logger';

const MAX_ALLOWLIST_DEPTH = 10;
const DEFAULT_TEAM_REFRESH_MS = 4 * 60 * 60 * 1000; // 4 hours

export class StartupValidator {
  /**
   * Maps linearTeamId → array of team members.
   * Populated during validateAllowlistEntries() and refreshed on an interval.
   */
  private teamMemberCache: Map<string, LinearUser[]> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: Config,
    private linearClient: LinearClient
  ) {}

  /**
   * Run all startup validation checks.
   * Throws on any critical failure.
   */
  async validate(): Promise<void> {
    logger.info('🔍 Running startup validation checks...');

    await this.validateLinearAPI();
    await this.validateProtectedLabels();
    await this.validateAllowlistEntries();
    await this.validateWebhookSecret();

    if (this.config.slack.enabled) {
      await this.validateSlack();
    }

    logger.info('✅ All startup validation checks passed');
  }

  /**
   * Returns the team member cache for use by EnforcementEngine.
   * Call after validate() completes.
   */
  getTeamMemberCache(): Map<string, LinearUser[]> {
    return this.teamMemberCache;
  }

  /**
   * Start a background interval that re-fetches all linearTeamId members.
   * Call after validate() so the initial fetch is already done.
   */
  startTeamRefresh(intervalMs: number = DEFAULT_TEAM_REFRESH_MS): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      logger.info('Refreshing Linear team member cache...');
      await this.refreshTeamMembers();
    }, intervalMs);

    // Don't keep the Node process alive just for this timer
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }

    logger.info('Team member cache refresh scheduled', {
      intervalHours: intervalMs / 3600000
    });
  }

  /**
   * Stop the background refresh (primarily for tests).
   */
  stopTeamRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async validateLinearAPI(): Promise<void> {
    try {
      const viewer = await this.linearClient.getViewer();
      logger.info(`✓ Linear API connected as: ${viewer.email} (${viewer.name})`);

      if (!this.config.agent.userId) {
        this.config.agent.userId = viewer.id;
        this.config.agent.email = viewer.email;
        logger.info(`✓ Agent user ID stored: ${viewer.id}`);
      }
    } catch (error) {
      throw new Error(`Linear API connection failed: ${(error as Error).message}`);
    }
  }

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
        logger.error(`Failed to check label "${labelName}"`, { error: (error as Error).message });
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
   * Recursively validate all allowlist entries, resolving linearTeamId
   * entries into the team member cache.
   */
  private async validateAllowlistEntries(): Promise<void> {
    let found = 0;
    let notFound = 0;

    for (let i = 0; i < this.config.allowlist.length; i++) {
      const entry = this.config.allowlist[i];
      const counts = await this.validateEntry(entry, `allowlist[${i}]`, 0);
      found += counts.found;
      notFound += counts.notFound;
    }

    logger.info(`✓ Allowlist validated — ${found} users found, ${notFound} not found`);
  }

  /**
   * Validate a single AllowlistEntry recursively.
   * Populates teamMemberCache for any linearTeamId groups.
   */
  private async validateEntry(
    entry: AllowlistEntry,
    path: string,
    depth: number
  ): Promise<{ found: number; notFound: number }> {
    if (depth > MAX_ALLOWLIST_DEPTH) {
      logger.warn(`Allowlist entry at "${path}" exceeds max depth (${MAX_ALLOWLIST_DEPTH}), skipping`);
      return { found: 0, notFound: 0 };
    }

    if (isAllowlistGroup(entry)) {
      return this.validateGroup(entry as AllowlistGroup, path, depth);
    } else {
      return this.validateLeaf(entry as AllowlistLeaf, path);
    }
  }

  private async validateGroup(
    group: AllowlistGroup,
    path: string,
    depth: number
  ): Promise<{ found: number; notFound: number }> {
    let found = 0;
    let notFound = 0;

    const displayPath = `${path} ("${group.name}")`;
    logger.info(`Validating group at ${displayPath}`, {
      linearTeamId: group.linearTeamId,
      memberCount: group.members?.length ?? 0,
      permissions: group.permissions ?? 'inherit/all'
    });

    // Resolve linearTeamId → fetch members and cache them
    if (group.linearTeamId) {
      try {
        const members = await this.linearClient.getTeamMembers(group.linearTeamId);
        this.teamMemberCache.set(group.linearTeamId, members);
        logger.info(`✓ Resolved linearTeamId "${group.linearTeamId}" → ${members.length} members`, {
          groupName: group.name,
          members: members.map(m => m.email)
        });
        found += members.length;
      } catch (error) {
        logger.warn(
          `⚠️  Could not resolve linearTeamId "${group.linearTeamId}" for group "${group.name}". ` +
          `Team will have zero members until next refresh.`,
          { error: (error as Error).message }
        );
        this.teamMemberCache.set(group.linearTeamId, []);
      }
    }

    // Recurse into members
    for (let i = 0; i < (group.members ?? []).length; i++) {
      const member = group.members![i];
      const counts = await this.validateEntry(member, `${path}.members[${i}]`, depth + 1);
      found += counts.found;
      notFound += counts.notFound;
    }

    return { found, notFound };
  }

  private async validateLeaf(
    leaf: AllowlistLeaf,
    path: string
  ): Promise<{ found: number; notFound: number }> {
    const displayName = leaf.name || leaf.email || leaf.id || 'Unknown';

    if (leaf.email) {
      try {
        const user = await this.linearClient.findUserByEmail(leaf.email);
        if (!user) {
          logger.warn(`⚠️  Allowlist user "${displayName}" (${leaf.email}) not found in workspace`);
          return { found: 0, notFound: 1 };
        }
        logger.info(`✓ Allowlist user ${user.email} (${user.name}) found`, {
          path,
          permissions: leaf.permissions ?? 'inherit/all'
        });
        return { found: 1, notFound: 0 };
      } catch (error) {
        logger.error(`Failed to check allowlist user "${displayName}"`, { error: (error as Error).message });
        return { found: 0, notFound: 1 };
      }
    } else if (leaf.id) {
      logger.info(`✓ Allowlist user "${displayName}" configured by ID: ${leaf.id}`, {
        path,
        permissions: leaf.permissions ?? 'inherit/all'
      });
      return { found: 1, notFound: 0 };
    }

    logger.warn(`⚠️  Allowlist entry at "${path}" has neither email nor id — will never match`);
    return { found: 0, notFound: 1 };
  }

  /**
   * Re-fetch members for all linearTeamId entries currently in the cache.
   * Called by the background refresh interval.
   */
  private async refreshTeamMembers(): Promise<void> {
    const teamIds = Array.from(this.teamMemberCache.keys());
    if (teamIds.length === 0) return;

    for (const teamId of teamIds) {
      try {
        const members = await this.linearClient.getTeamMembers(teamId);
        this.teamMemberCache.set(teamId, members);
        logger.info('Refreshed team members', { teamId, memberCount: members.length });
      } catch (error) {
        logger.warn('Failed to refresh team members, keeping stale cache', {
          teamId,
          error: (error as Error).message
        });
      }
    }
  }

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

  private async validateSlack(): Promise<void> {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error('Slack is enabled in config but SLACK_BOT_TOKEN is not set in environment');
    }

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
