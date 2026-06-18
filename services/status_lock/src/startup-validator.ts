/**
 * Startup validation for the Issue Lock Agent.
 *
 * On startup it:
 *  - confirms the Linear API connection and learns the agent's own user id
 *  - fetches all workflow states and builds a stateId → state map (so the agent
 *    can classify an issue's *previous* status from the bare stateId in a webhook)
 *  - resolves any allowlist linearTeamId groups into a member cache (refreshed
 *    on an interval) so authorization checks need no live API calls
 *  - warns about locked statuses that don't match any workflow state
 */

import {
  Config,
  AllowlistEntry,
  AllowlistGroup,
  isAllowlistGroup,
  LinearUser,
  WorkflowState
} from './types';
import { LinearClient } from './linear-client';
import logger from './utils/logger';

const MAX_ALLOWLIST_DEPTH = 10;
const DEFAULT_TEAM_REFRESH_MS = 4 * 60 * 60 * 1000; // 4 hours

export class StartupValidator {
  private stateMap: Map<string, WorkflowState> = new Map();
  private teamMemberCache: Map<string, LinearUser[]> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: Config,
    private linearClient: LinearClient
  ) {}

  /** Run all startup checks. Throws on a critical failure (API connection). */
  async validate(): Promise<void> {
    logger.info('🔍 Running startup validation checks...');

    await this.validateLinearAPI();
    await this.loadWorkflowStates();
    await this.resolveAllowlistTeams();
    this.validateWebhookSecret();

    logger.info('✅ All startup validation checks passed');
  }

  /** stateId → workflow state map, for the StatusLockEngine. */
  getStateMap(): Map<string, WorkflowState> {
    return this.stateMap;
  }

  /** linearTeamId → members map, for the StatusLockEngine. */
  getTeamMemberCache(): Map<string, LinearUser[]> {
    return this.teamMemberCache;
  }

  /** Start a background interval that re-fetches allowlist team members. */
  startTeamRefresh(intervalMs: number = DEFAULT_TEAM_REFRESH_MS): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.teamMemberCache.size === 0) return; // nothing to refresh

    this.refreshTimer = setInterval(async () => {
      logger.info('Refreshing Linear team member cache...');
      await this.refreshTeamMembers();
    }, intervalMs);
    if (this.refreshTimer.unref) this.refreshTimer.unref();

    logger.info('Team member cache refresh scheduled', { intervalHours: intervalMs / 3600000 });
  }

  stopTeamRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

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

  private async loadWorkflowStates(): Promise<void> {
    try {
      const states = await this.linearClient.getWorkflowStates();
      for (const s of states) this.stateMap.set(s.id, s);
      logger.info(`✓ Loaded ${states.length} workflow state(s)`);

      // Warn about configured lock names that don't match any state.
      const stateNames = new Set(states.map(s => s.name.toLowerCase()));
      const unmatched = this.config.lockedStatuses.filter(n => !stateNames.has(n.toLowerCase()));
      if (unmatched.length > 0) {
        logger.warn(
          `⚠️  These locked statuses don't match any workflow state (yet): ${unmatched.join(', ')}. ` +
          `Check spelling — names are matched case-insensitively.`
        );
      }

      const lockingStates = states.filter(s =>
        this.config.lockedStatuses.some(n => n.toLowerCase() === s.name.toLowerCase()) ||
        (this.config.lockedStatusTypes ?? []).some(t => t.toLowerCase() === s.type.toLowerCase())
      );

      // Workflow states are per-team in Linear, so the same status name appears
      // once per team. Group by name+type for a readable summary instead of
      // listing the same name N times.
      const grouped = new Map<string, { type: string; teams: string[] }>();
      for (const s of lockingStates) {
        const key = `${s.name} (${s.type})`;
        const g = grouped.get(key) ?? { type: s.type, teams: [] };
        if (s.teamKey) g.teams.push(s.teamKey);
        grouped.set(key, g);
      }

      logger.info('🔒 Statuses that will lock an issue (matched by name/type across all teams)', {
        matchedStateCount: lockingStates.length,
        statuses: Array.from(grouped.entries()).map(([label, g]) =>
          `${label} — ${g.teams.length} team(s)${g.teams.length ? `: ${g.teams.join(', ')}` : ''}`
        )
      });
    } catch (error) {
      throw new Error(`Failed to load workflow states: ${(error as Error).message}`);
    }
  }

  private async resolveAllowlistTeams(): Promise<void> {
    let resolved = 0;
    const walk = async (entries: AllowlistEntry[], depth: number): Promise<void> => {
      if (depth > MAX_ALLOWLIST_DEPTH) return;
      for (const entry of entries) {
        if (!isAllowlistGroup(entry)) continue;
        const group = entry as AllowlistGroup;
        if (group.linearTeamId) {
          try {
            const members = await this.linearClient.getTeamMembers(group.linearTeamId);
            this.teamMemberCache.set(group.linearTeamId, members);
            resolved += members.length;
            logger.info(`✓ Resolved team "${group.linearTeamId}" → ${members.length} member(s)`, {
              group: group.name,
              members: members.map(m => m.email)
            });
          } catch (error) {
            logger.warn(`⚠️  Could not resolve team "${group.linearTeamId}" for group "${group.name}"`, {
              error: (error as Error).message
            });
            this.teamMemberCache.set(group.linearTeamId, []);
          }
        }
        if (group.members) await walk(group.members, depth + 1);
      }
    };
    await walk(this.config.allowlist, 0);
    logger.info(`✓ Allowlist resolved — ${resolved} team member(s) cached`);
  }

  private async refreshTeamMembers(): Promise<void> {
    for (const teamId of Array.from(this.teamMemberCache.keys())) {
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

  private validateWebhookSecret(): void {
    if (!process.env.LINEAR_WEBHOOK_SECRET) {
      logger.warn(
        '⚠️  LINEAR_WEBHOOK_SECRET not configured. Webhook signature verification will be DISABLED. ' +
        'This is NOT recommended for production!'
      );
    } else {
      logger.info('✓ Webhook secret configured');
    }
  }
}
