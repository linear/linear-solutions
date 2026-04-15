/**
 * Core enforcement engine - detect and revert unauthorized changes
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Config,
  WebhookPayload,
  IssueWebhookPayload,
  IssueSLAWebhookPayload,
  WebhookActor,
  ChangeDetection,
  EnforcementResult,
  IssueData,
  IssueLabel,
  AuditEntry,
  Permission,
  ALL_PERMISSIONS,
  AllowlistEntry,
  AllowlistLeaf,
  AllowlistGroup,
  isAllowlistGroup,
  LinearUser
} from './types';
import { LinearClient } from './linear-client';
import logger from './utils/logger';
import { logAudit } from './utils/audit-trail';
import { extractIssueData } from './webhook-handler';

interface CacheEntry {
  slaType: string | null;
  slaStartedAt: string | null;
  slaBreachesAt: string | null;
  originalSlaBreachesAt: string | null; // immutable baseline — set once when first seen, never overwritten by webhooks
  priority?: number;
  createdAt: string | null; // immutable baseline — never overwritten after first cache
  cachedAt: string; // ISO string for JSON serialization
}

interface PersistentCache {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class EnforcementEngine {
  // In-memory cache of SLA and priority states for protected issues
  // Maps issueId -> { slaType, slaStartedAt, slaBreachesAt, priority, cachedAt }
  private slaCache: Map<string, {
    slaType: string | null;
    slaStartedAt: string | null;
    slaBreachesAt: string | null;
    originalSlaBreachesAt: string | null; // immutable baseline — set once, never overwritten by webhooks
    priority?: number;
    createdAt: string | null; // immutable baseline — set once, never updated
    cachedAt: Date
  }> = new Map();

  private cacheFilePath: string;

  constructor(
    private config: Config,
    private linearClient: LinearClient,
    private teamMemberCache: Map<string, LinearUser[]> = new Map()
  ) {
    // Set cache file path next to audit log
    const logsDir = path.dirname(this.config.logging.auditLogPath);
    this.cacheFilePath = path.join(logsDir, 'sla-cache.json');
    
    // Load persistent cache on startup
    this.loadCacheFromDisk();
  }

  /**
   * Load cache from disk on startup
   */
  private loadCacheFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const cache: PersistentCache = JSON.parse(data);
        
        // Load entries into memory
        for (const [issueId, entry] of Object.entries(cache.entries)) {
          this.slaCache.set(issueId, {
            slaType: entry.slaType,
            slaStartedAt: entry.slaStartedAt,
            slaBreachesAt: entry.slaBreachesAt,
            // Backward compat: old cache files won't have this field; fall back to slaBreachesAt
            originalSlaBreachesAt: (entry as any).originalSlaBreachesAt ?? entry.slaBreachesAt ?? null,
            priority: entry.priority,
            createdAt: entry.createdAt ?? null,
            cachedAt: new Date(entry.cachedAt)
          });
        }
        
        logger.info('Loaded SLA cache from disk', {
          cacheFile: this.cacheFilePath,
          issueCount: this.slaCache.size
        });
      } else {
        logger.info('No existing SLA cache found, starting fresh', {
          cacheFile: this.cacheFilePath
        });
      }
    } catch (error) {
      logger.warn('Failed to load SLA cache from disk, starting fresh', {
        error: (error as Error).message,
        cacheFile: this.cacheFilePath
      });
    }
  }

  /**
   * Proactively cache all issues with protected labels on startup
   * This ensures we have the "original" SLA values before any changes happen
   */
  async cacheProtectedIssues(): Promise<void> {
    logger.info('🔍 Proactively caching SLA values for protected issues...');
    
    let cachedCount = 0;
    let skippedCount = 0;
    
    for (const labelName of this.config.protectedLabels) {
      try {
        // Find the label ID
        const label = await this.linearClient.findLabelByName(labelName);
        if (!label) {
          logger.warn(`Protected label "${labelName}" not found, skipping`);
          continue;
        }
        
        // Search for issues with this label
        const issues = await this.linearClient.getIssuesWithLabel(label.id);
        
        for (const issue of issues) {
          const existingEntry = this.slaCache.get(issue.id);

          // Always cache if issue has slaStartedAt or createdAt — we need
          // createdAt as the immutable baseline even when SLA is not fully set.
          if (issue.slaType && issue.slaStartedAt && issue.slaBreachesAt || issue.createdAt) {
            // Update SLA/priority fields if they changed, but NEVER overwrite createdAt
            // once it has been set — it is the immutable baseline.
            const shouldUpdate = !existingEntry ||
              existingEntry.slaBreachesAt !== issue.slaBreachesAt ||
              existingEntry.priority !== issue.priority;

            if (shouldUpdate) {
              this.slaCache.set(issue.id, {
                slaType: issue.slaType || null,
                slaStartedAt: issue.slaStartedAt || null,
                slaBreachesAt: issue.slaBreachesAt || null,
                // Preserve existing originalSlaBreachesAt if already cached — never overwrite.
                // This is the immutable target for SLA restoration; set once from the first
                // known-good value and never updated from webhook/workflow-computed values.
                originalSlaBreachesAt: existingEntry?.originalSlaBreachesAt ?? issue.slaBreachesAt ?? null,
                priority: issue.priority,
                // Preserve existing createdAt if already cached — never overwrite
                createdAt: existingEntry?.createdAt ?? issue.createdAt ?? null,
                cachedAt: new Date()
              });
              cachedCount++;

              logger.info('Cached/updated issue on startup', {
                issueId: issue.id,
                identifier: issue.identifier,
                slaType: issue.slaType,
                slaBreachesAt: issue.slaBreachesAt,
                createdAt: issue.createdAt,
                priority: issue.priority,
                wasUpdate: !!existingEntry
              });
            } else {
              logger.debug('Issue unchanged, keeping cached values', {
                issueId: issue.id,
                identifier: issue.identifier
              });
            }
          } else {
            skippedCount++;
            logger.debug('Issue has no SLA or createdAt, skipping', {
              issueId: issue.id,
              identifier: issue.identifier
            });
          }
        }
      } catch (error) {
        logger.error(`Failed to cache issues for label "${labelName}"`, {
          error: (error as Error).message
        });
      }
    }
    
    // Save to disk
    if (cachedCount > 0) {
      this.saveCacheToDisk();
    }
    
    logger.info('✓ Finished caching protected issues', {
      cachedCount,
      skippedCount,
      totalCached: this.slaCache.size
    });
  }

  /**
   * Save cache to disk for persistence across restarts
   */
  private saveCacheToDisk(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const cache: PersistentCache = {
        version: 1,
        entries: {}
      };
      
      for (const [issueId, entry] of this.slaCache.entries()) {
        cache.entries[issueId] = {
          slaType: entry.slaType,
          slaStartedAt: entry.slaStartedAt,
          slaBreachesAt: entry.slaBreachesAt,
          originalSlaBreachesAt: entry.originalSlaBreachesAt ?? null,
          priority: entry.priority,
          createdAt: entry.createdAt ?? null,
          cachedAt: entry.cachedAt.toISOString()
        };
      }
      
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cache, null, 2));
      
      logger.debug('Saved SLA cache to disk', {
        issueCount: this.slaCache.size
      });
    } catch (error) {
      logger.error('Failed to save SLA cache to disk', {
        error: (error as Error).message,
        cacheFile: this.cacheFilePath
      });
    }
  }

  /**
   * Main enforcement method - called for each webhook
   */
  async enforce(payload: WebhookPayload): Promise<EnforcementResult> {
    const { current, previous } = extractIssueData(payload);

    if (!current || !current.id) {
      logger.error('Invalid issue data in webhook');
      return { enforced: false, reason: 'Invalid issue data' };
    }

    // CRITICAL: Check if this action was made by the agent itself (infinite loop prevention)
    if (this.isAgentAction(payload.actor)) {
      // Skip general enforcement to prevent loops — but still run the baseline drift
      // correction if enabled. Priority changes (even by the agent/authorized user) can
      // trigger Linear workflows that silently reset slaStartedAt away from createdAt.
      // The correction is safe: after fixing drift, the next webhook will have
      // slaStartedAt === createdAt, so this block won't fire again.
      if (this.config.protectedFields.slaCreatedAtBaseline) {
        const cached = this.slaCache.get(current.id);
        const hasProtectedLabel = (current.labels || []).some((l: any) =>
          this.config.protectedLabels.includes(l.name)
        );
        if (cached?.createdAt && hasProtectedLabel && current.slaStartedAt &&
            current.slaStartedAt !== cached.createdAt &&
            current.slaBreachesAt && current.slaType) {
          const ruleBreachesAt = this.resolveBreachFromRules(
            cached.createdAt,
            current.priority ?? 0,
            current.labels ?? [],
            (current as any).teamId
          );
          const durationMs = new Date(current.slaBreachesAt).getTime() -
                             new Date(current.slaStartedAt).getTime();
          const correctBreachesAt = ruleBreachesAt ?? new Date(
            new Date(cached.createdAt).getTime() + durationMs
          );
          logger.info('slaCreatedAtBaseline: correcting drift after agent/authorized action', {
            issueId: current.id,
            actor: payload.actor.email || payload.actor.name,
            currentSlaStartedAt: current.slaStartedAt,
            createdAt: cached.createdAt,
            currentSlaBreachesAt: current.slaBreachesAt,
            durationMs,
            durationHours: Math.round(durationMs / 1000 / 60 / 60 * 10) / 10,
            correctSlaBreachesAt: correctBreachesAt,
            reasoning: `SLA duration (${Math.round(durationMs / 1000 / 60 / 60 * 10) / 10}h) preserved, anchored to createdAt instead of now`
          });
          await this.linearClient.updateIssue(current.id, {
            slaType: current.slaType,
            slaStartedAt: new Date(cached.createdAt),
            slaBreachesAt: correctBreachesAt
          });
          // Lock in the corrected breach date as the immutable originalSlaBreachesAt baseline.
          // This prevents the duration formula in revertChanges from inheriting a stale
          // policy duration if Linear's workflows later fire out of order (e.g. rapid
          // priority toggling causes a 7-day High-policy workflow to arrive after the
          // issue has already been set back to Urgent).
          this.updateCache(current.id, {
            slaType: current.slaType,
            slaStartedAt: cached.createdAt,
            slaBreachesAt: correctBreachesAt.toISOString(),
            updateOriginalSlaBreachesAt: true
          });
        }
      }
      logger.debug('Skipping general enforcement - action was made by agent itself', {
        actor: payload.actor.name,
        issueId: current.id
      });
      return { enforced: false, reason: 'Agent action (self)' };
    }

    // Check if issue has or had any protected labels (current OR previous state)
    const currentLabels = current.labels || [];
    const previousLabels = previous?.labels || [];
    
    const hasProtectedNow = this.hasProtectedLabel(currentLabels);
    let hadProtectedBefore = previousLabels.length > 0 ? this.hasProtectedLabel(previousLabels) : false;
    
    // IMPORTANT: Linear sends labelIds (UUIDs) in updatedFrom, NOT label objects
    // We need to look up the previous labelIds to check if they were protected
    if (!hadProtectedBefore && previous?.labelIds && previous.labelIds.length > 0) {
      logger.info('Checking previous labelIds for protected labels', {
        issueId: current.id,
        previousLabelIds: previous.labelIds
      });
      
      for (const labelId of previous.labelIds) {
        const label = await this.linearClient.findLabelById(labelId);
        if (label && this.config.protectedLabels.includes(label.name)) {
          hadProtectedBefore = true;
          logger.info('Found protected label in previous labelIds', {
            labelId,
            labelName: label.name
          });
          break;
        }
      }
    }
    
    // If still no previous data, check cache as fallback
    if (!hasProtectedNow && !hadProtectedBefore && !previous?.labelIds) {
      logger.info('No previous label data in webhook, checking issue history for protected labels', {
        issueId: current.id
      });
      
      // Check our SLA cache - if we cached this issue, it had a protected label
      const cachedSLA = this.slaCache.get(current.id);
      if (cachedSLA) {
        logger.info('Issue was previously cached, so it had a protected label before', {
          issueId: current.id
        });
        hadProtectedBefore = true;
      }
    }
    
    logger.info('Checking protected labels', {
      issueId: current.id,
      currentLabels: currentLabels.map((l: IssueLabel) => l.name),
      previousLabelIds: previous?.labelIds || [],
      hasProtectedNow,
      hadProtectedBefore,
      hasPreviousData: !!previous,
      protectedLabels: this.config.protectedLabels
    });
    
    if (!hasProtectedNow && !hadProtectedBefore) {
      logger.info('Skipping enforcement - issue does not have (and did not have) protected label', {
        issueId: current.id,
        hasProtectedNow,
        hadProtectedBefore
      });
      return { enforced: false, reason: 'No protected label' };
    }
    
    // Skip enforcement if a protected label was just ADDED (allowed)
    // BUT: Only skip if labels actually changed (labelIds in updatedFrom)
    // If labelIds is NOT in updatedFrom, it means only SLA/other fields changed,
    // so we should continue to check those changes
    if (hasProtectedNow && !hadProtectedBefore && previous?.labelIds !== undefined) {
      logger.info('Skipping enforcement - protected label was just added (allowed)', {
        issueId: current.id,
        hasProtectedNow,
        hadProtectedBefore,
        labelIdsInUpdatedFrom: true
      });
      return { enforced: false, reason: 'Protected label added (allowed)' };
    }
    
    // If we couldn't determine hadProtectedBefore (no labelIds in updatedFrom),
    // assume the issue already had the label if it has one now
    if (hasProtectedNow && !hadProtectedBefore && previous?.labelIds === undefined) {
      logger.info('Assuming issue already had protected label (no labelIds in webhook)', {
        issueId: current.id,
        note: 'Linear does not send labelIds when only non-label fields change'
      });
      hadProtectedBefore = true;
    }

    // IMPORTANT: Read cached values BEFORE potentially updating the cache
    // This is critical for restoration - we need the pre-change state
    const existingCache = this.slaCache.get(current.id);
    
    // Detect what changed
    const changes = await this.detectChanges(current, previous, payload.type);
    if (changes.length === 0) {
      logger.debug('No relevant changes detected', { issueId: current.id });
      // No relevant changes - update cache with current values for future reference
      if (hasProtectedNow) {
        this.updateCache(current.id, {
          slaType: current.slaType,
          slaStartedAt: current.slaStartedAt,
          slaBreachesAt: current.slaBreachesAt,
          priority: current.priority
        });
      }
      return { enforced: false, reason: 'No relevant changes' };
    }
    
    // Debug: Log SLA state for troubleshooting
    if (changes.some(c => c.field.startsWith('sla'))) {
      logger.debug('SLA change detected, logging states', {
        currentSLA: {
          type: current.slaType,
          startedAt: current.slaStartedAt
        },
        previousSLA: previous ? {
          type: previous.slaType,
          startedAt: previous.slaStartedAt
        } : 'no previous data',
        cachedSLA: this.slaCache.get(current.id) || 'no cache'
      });
    }

    // Resolve what fields this actor is permitted to change
    const actorPermissions = this.getActorPermissions(payload.actor);

    const allowedChanges = changes.filter(c =>
      // Baseline-detected drift is always reverted — the actor didn't intentionally
      // move the SLA clock, Linear's workflow did. slaBaseline permission only covers
      // explicit slaStartedAt changes that appeared in the webhook's updatedFrom.
      !c.fromBaseline && actorPermissions.has(this.changeRequiresPermission(c))
    );
    const unauthorizedChanges = changes.filter(c =>
      c.fromBaseline || !actorPermissions.has(this.changeRequiresPermission(c))
    );

    logger.info('Permission check', {
      actor: payload.actor.email || payload.actor.name,
      issueId: current.id,
      actorPermissions: Array.from(actorPermissions),
      allowedFields: allowedChanges.map(c => c.field),
      unauthorizedFields: unauthorizedChanges.map(c => c.field)
    });

    // Fully authorized — no enforcement needed
    if (unauthorizedChanges.length === 0) {
      logger.info('Change allowed — user is authorized for all changed fields', {
        actor: payload.actor.email || payload.actor.name,
        issueId: current.id,
        fields: changes.map(c => c.field)
      });

      await this.logAuditEntry({
        webhookId: payload.webhookId,
        issueId: current.id,
        issueIdentifier: current.identifier,
        issueTitle: current.title,
        actor: payload.actor,
        action: 'allowed',
        reason: 'User authorized for all changed fields',
        actorPermissions: Array.from(actorPermissions),
        changes: changes.map(c => ({
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reverted: false
        }))
      });

      if (hasProtectedNow) {
        const slaBreachesAtWasChanged = changes.some(c => c.field === 'slaBreachesAt');
        this.updateCache(current.id, {
          slaType: current.slaType,
          slaStartedAt: current.slaStartedAt,
          slaBreachesAt: current.slaBreachesAt,
          priority: current.priority,
          // Authorized user explicitly changed slaBreachesAt — update the immutable baseline
          // so future restorations target the new deadline, not the old one
          updateOriginalSlaBreachesAt: slaBreachesAtWasChanged
        });

        // After an authorized priority change, Linear's workflow will recalculate the SLA
        // (resetting slaStartedAt to "now"). The resulting webhook comes from a different
        // webhook subscription (non-OAuth) and fails signature verification, so we can't
        // rely on it. Instead, fetch the live issue after a short delay and apply the
        // createdAt correction proactively.
        const hasPriorityChange = changes.some(c => c.field === 'priority');
        if (hasPriorityChange && this.config.protectedFields.slaCreatedAtBaseline) {
          const issueId = current.id;
          const cachedCreatedAt = this.slaCache.get(issueId)?.createdAt;

          if (cachedCreatedAt) {
            setTimeout(async () => {
              try {
                const liveIssue = await this.linearClient.getIssue(issueId);

                if (!liveIssue.slaType) {
                  logger.debug('slaCreatedAtBaseline: live issue has no SLA after priority change, skipping correction', { issueId });
                  return;
                }

                // Compute the correct slaBreachesAt = createdAt + authoritative window.
                //
                // Source priority:
                //   1. SLA rule match (resolveBreachFromRules) — always authoritative
                //   2. Cached duration (pre-workflow snapshot from webhook) — safe fallback when
                //      slaStartedAt drifted: the cache holds values before Linear's workflow ran,
                //      so the duration is from the previously-correct state, not from a potentially
                //      stale workflow for the wrong priority level
                //   3. Bail — no rule and no drift means nothing reliable to act on
                //
                // We deliberately do NOT use liveIssue duration (slaBreachesAt - slaStartedAt)
                // because Linear's workflow can fire for the wrong priority window during rapid
                // priority changes, producing durations that corrupt slaBreachesAt.
                const cachedEntry = this.slaCache.get(issueId);
                const hasDrift = liveIssue.slaStartedAt !== cachedCreatedAt;

                const ruleBreachesAt = this.resolveBreachFromRules(
                  cachedCreatedAt,
                  liveIssue.priority ?? 0,
                  liveIssue.labels ?? [],
                  (liveIssue as any).teamId
                );

                let correctBreachesAt: Date | null = null;
                let source = '';

                if (ruleBreachesAt) {
                  // Rule match — authoritative for any priority, drift or not
                  correctBreachesAt = ruleBreachesAt;
                  source = 'slaRule';
                } else if (hasDrift && cachedEntry?.slaBreachesAt && cachedEntry?.slaStartedAt) {
                  // slaStartedAt drifted but no rule — use cached duration to re-anchor to createdAt.
                  // The cache was written from the webhook payload (before Linear's workflow ran),
                  // so its duration reflects the last known-good state, not a stale workflow result.
                  const durationMs = new Date(cachedEntry.slaBreachesAt).getTime() -
                                     new Date(cachedEntry.slaStartedAt).getTime();
                  correctBreachesAt = new Date(new Date(cachedCreatedAt).getTime() + durationMs);
                  source = 'cachedDuration';
                } else {
                  // No rule and no drift — slaStartedAt is already anchored to createdAt.
                  // Without a rule we have no authoritative window, so leave slaBreachesAt alone.
                  logger.debug('slaCreatedAtBaseline: no drift and no SLA rule — slaBreachesAt unchanged', { issueId });
                  return;
                }

                const alreadyCorrect =
                  liveIssue.slaStartedAt === cachedCreatedAt &&
                  liveIssue.slaBreachesAt === correctBreachesAt.toISOString();

                if (alreadyCorrect) {
                  logger.debug('slaCreatedAtBaseline: slaStartedAt and slaBreachesAt already correct after priority change', { issueId });
                  return;
                }

                logger.info('slaCreatedAtBaseline: applying correct SLA after authorized priority change', {
                  issueId,
                  createdAt: cachedCreatedAt,
                  priority: liveIssue.priority,
                  hasDrift,
                  currentSlaStartedAt: liveIssue.slaStartedAt,
                  currentSlaBreachesAt: liveIssue.slaBreachesAt,
                  correctSlaBreachesAt: correctBreachesAt,
                  source
                });

                await this.linearClient.updateIssue(issueId, {
                  slaType: liveIssue.slaType,
                  slaStartedAt: new Date(cachedCreatedAt),
                  slaBreachesAt: correctBreachesAt
                });

                this.updateCache(issueId, {
                  slaType: liveIssue.slaType,
                  slaStartedAt: cachedCreatedAt,
                  slaBreachesAt: correctBreachesAt.toISOString(),
                  updateOriginalSlaBreachesAt: true
                });
              } catch (error) {
                logger.error('slaCreatedAtBaseline: failed to correct drift after authorized priority change', {
                  issueId,
                  error: (error as Error).message
                });
              }
            }, 2500);
          }
        }
      }

      return { enforced: false, reason: 'User authorized', changes, allowedChanges: changes, unauthorizedChanges: [] };
    }

    // Partially authorized — log what's allowed through before enforcing the rest
    if (allowedChanges.length > 0) {
      logger.info('Partial authorization — some changes allowed, reverting unauthorized fields only', {
        actor: payload.actor.email || payload.actor.name,
        issueId: current.id,
        allowedFields: allowedChanges.map(c => c.field),
        unauthorizedFields: unauthorizedChanges.map(c => c.field)
      });
    } else {
      logger.warn('Unauthorized change detected — actor has no permission for any changed fields', {
        actor: payload.actor.email || payload.actor.name,
        issueId: current.id,
        fields: changes.map(c => c.field)
      });
    }

    // DRY RUN MODE - Log what would happen but don't actually revert
    if (this.config.behavior.dryRun) {
      logger.info('[DRY RUN] Would revert unauthorized fields', {
        issueId: current.id,
        actor: payload.actor.email || payload.actor.name,
        unauthorizedFields: unauthorizedChanges.map(c => c.field),
        allowedFields: allowedChanges.map(c => c.field)
      });

      await this.logAuditEntry({
        webhookId: payload.webhookId,
        issueId: current.id,
        issueIdentifier: current.identifier,
        issueTitle: current.title,
        actor: payload.actor,
        action: 'detected',
        reason: 'Dry run mode - would revert',
        actorPermissions: Array.from(actorPermissions),
        changes: unauthorizedChanges.map(c => ({
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reverted: false
        })),
        dryRun: true
      });

      if (hasProtectedNow) {
        this.updateCache(current.id, {
          slaType: current.slaType,
          slaStartedAt: current.slaStartedAt,
          slaBreachesAt: current.slaBreachesAt,
          priority: current.priority
        });
      }

      return { enforced: false, reason: 'Dry run mode', changes: unauthorizedChanges, allowedChanges, unauthorizedChanges, dryRun: true };
    }

    // NOTIFY ONLY MODE - Comment but don't revert
    if (this.config.behavior.notifyOnly) {
      logger.info('[NOTIFY ONLY] Detected unauthorized fields but not reverting', {
        issueId: current.id,
        actor: payload.actor.email || payload.actor.name,
        unauthorizedFields: unauthorizedChanges.map(c => c.field)
      });

      await this.postAgentComment(current.id, payload.actor, allowedChanges, unauthorizedChanges, false);

      await this.logAuditEntry({
        webhookId: payload.webhookId,
        issueId: current.id,
        issueIdentifier: current.identifier,
        issueTitle: current.title,
        actor: payload.actor,
        action: 'detected',
        reason: 'Notify only mode - no revert',
        actorPermissions: Array.from(actorPermissions),
        changes: unauthorizedChanges.map(c => ({
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          reverted: false
        })),
        notifyOnly: true
      });

      if (hasProtectedNow) {
        this.updateCache(current.id, {
          slaType: current.slaType,
          slaStartedAt: current.slaStartedAt,
          slaBreachesAt: current.slaBreachesAt,
          priority: current.priority
        });
      }

      return { enforced: false, reason: 'Notify only mode', changes: unauthorizedChanges, allowedChanges, unauthorizedChanges };
    }

    // NORMAL MODE - Revert only the unauthorized changes
    try {
      await this.revertChanges(current.id, unauthorizedChanges, previous, existingCache, current);
      await this.postAgentComment(current.id, payload.actor, allowedChanges, unauthorizedChanges, true);

      const auditAction = allowedChanges.length > 0 ? 'partial' : 'reverted';
      await this.logAuditEntry({
        webhookId: payload.webhookId,
        issueId: current.id,
        issueIdentifier: current.identifier,
        issueTitle: current.title,
        actor: payload.actor,
        action: auditAction,
        reason: allowedChanges.length > 0
          ? 'Partial authorization — some fields allowed, unauthorized fields reverted'
          : 'User not authorized for any changed fields',
        actorPermissions: Array.from(actorPermissions),
        changes: [
          ...allowedChanges.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: false })),
          ...unauthorizedChanges.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: true }))
        ]
      });

      logger.info('Successfully reverted unauthorized fields', {
        issueId: current.id,
        actor: payload.actor.email || payload.actor.name,
        revertedFields: unauthorizedChanges.map(c => c.field),
        allowedFields: allowedChanges.map(c => c.field)
      });

      if (hasProtectedNow && previous) {
        this.updateCache(current.id, {
          slaType: previous.slaType ?? existingCache?.slaType ?? current.slaType,
          slaStartedAt: previous.slaStartedAt ?? existingCache?.slaStartedAt ?? current.slaStartedAt,
          slaBreachesAt: previous.slaBreachesAt ?? existingCache?.slaBreachesAt ?? current.slaBreachesAt,
          priority: previous.priority ?? existingCache?.priority ?? current.priority
        });
      }

      return {
        enforced: true,
        reason: allowedChanges.length > 0 ? 'Partial revert — unauthorized fields reverted' : 'Unauthorized change reverted',
        changes: unauthorizedChanges,
        allowedChanges,
        unauthorizedChanges
      };
    } catch (error) {
      logger.error('Failed to revert changes', {
        issueId: current.id,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Update the SLA/priority cache for an issue and persist to disk
   */
  private updateCache(issueId: string, values: {
    slaType?: string | null;
    slaStartedAt?: string | null;
    slaBreachesAt?: string | null;
    priority?: number;
    /** Set to true only for authorized slaBreachesAt changes — updates the immutable baseline */
    updateOriginalSlaBreachesAt?: boolean;
  }): void {
    // Preserve immutable baseline fields — createdAt and originalSlaBreachesAt must never be
    // overwritten by webhook-derived or workflow-computed values. Only updateOriginalSlaBreachesAt:true
    // (used for authorized sla changes) is allowed to update originalSlaBreachesAt.
    const existing = this.slaCache.get(issueId);
    this.slaCache.set(issueId, {
      slaType: values.slaType || null,
      slaStartedAt: values.slaStartedAt || null,
      slaBreachesAt: values.slaBreachesAt || null,
      originalSlaBreachesAt: values.updateOriginalSlaBreachesAt
        ? (values.slaBreachesAt ?? null)
        : (existing?.originalSlaBreachesAt ?? values.slaBreachesAt ?? null),
      priority: values.priority,
      createdAt: existing?.createdAt ?? null,
      cachedAt: new Date()
    });
    
    // Persist to disk for durability across restarts
    this.saveCacheToDisk();
    
    logger.debug('Updated SLA/priority cache', {
      issueId,
      slaType: values.slaType,
      slaBreachesAt: values.slaBreachesAt,
      priority: values.priority
    });
  }

  /**
   * Check if actor is the agent itself (infinite loop prevention)
   */
  private isAgentAction(actor: WebhookActor): boolean {
    // Check by user ID
    if (this.config.agent.userId && actor.id === this.config.agent.userId) {
      return true;
    }

    // Check by email
    if (this.config.agent.email && actor.email === this.config.agent.email) {
      return true;
    }

    // Check if actor is integration with matching name
    if (actor.type === 'integration' && actor.name === this.config.agent.name) {
      return true;
    }

    return false;
  }

  /**
   * Check if issue has any protected label
   */
  private hasProtectedLabel(issueLabels: IssueLabel[]): boolean {
    return issueLabels.some(label =>
      this.config.protectedLabels.includes(label.name)
    );
  }

  /**
   * Compute slaBreachesAt = createdAt + rule.hours for the best-matching SLA rule.
   * Returns null if no rule applies (caller should fall back to duration-based calculation).
   *
   * Matching: all label constraints must be satisfied AND teamId must match when provided.
   * Most specific rule (most conditions) wins.
   */
  private resolveBreachFromRules(
    createdAt: string,
    priority: number,
    labels: IssueLabel[],
    teamId?: string
  ): Date | null {
    if (!this.config.slaRules || this.config.slaRules.length === 0) return null;

    const priorityNameMap: Record<number, string> = {
      0: 'no_priority', 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low'
    };
    const priorityName = priorityNameMap[priority];
    const labelNames = (labels ?? []).map(l => l.name);

    let bestRule: (typeof this.config.slaRules)[number] | null = null;
    let bestSpecificity = -1;

    for (const rule of this.config.slaRules) {
      // Team constraint: skip if rule requires a specific team and we can't verify it
      if (rule.teamId) {
        if (!teamId || rule.teamId !== teamId) continue;
      }

      // Label constraint: all required labels must be present on the issue
      if (rule.labels && rule.labels.length > 0) {
        if (!rule.labels.every(l => labelNames.includes(l))) continue;
      }

      // Most specific match wins (most conditions = highest specificity)
      const specificity = (rule.teamId ? 1 : 0) + (rule.labels?.length ?? 0);
      if (specificity > bestSpecificity) {
        bestRule = rule;
        bestSpecificity = specificity;
      }
    }

    if (!bestRule) return null;

    const window = bestRule.priorityWindows.find(
      w => w.priority === priority || w.priority === priorityName
    );
    if (!window) return null;

    logger.debug('resolveBreachFromRules: matched rule', {
      rule: bestRule.name,
      priority,
      priorityName,
      hours: window.hours,
      createdAt
    });

    return new Date(new Date(createdAt).getTime() + window.hours * 3600 * 1000);
  }

  /**
   * Resolve the set of permissions an actor has by walking the allowlist tree.
   *
   * Resolution rules:
   * - Walk every root entry; recursively walk groups.
   * - An entry matches when: email/id matches (leaf), or actor is a member of
   *   the linearTeamId team (group), or the actor matches a nested sub-entry.
   * - Collect ALL matching permission sets and return their union.
   * - An entry without `permissions` inherits the effective permissions of its
   *   parent; root entries without `permissions` default to ALL_PERMISSIONS.
   * - Empty Set returned → actor is not authorized for any field.
   */
  getActorPermissions(actor: WebhookActor): Set<Permission> {
    const collected = new Set<Permission>();

    for (const entry of this.config.allowlist) {
      const perms = this.resolveEntry(entry, actor, ALL_PERMISSIONS, 0);
      for (const p of perms) {
        collected.add(p);
      }
    }

    return collected;
  }

  /**
   * Recursively resolve an allowlist entry against an actor.
   * Returns the set of permissions matched, or an empty set if no match.
   */
  private resolveEntry(
    entry: AllowlistEntry,
    actor: WebhookActor,
    parentPermissions: Permission[],
    depth: number
  ): Set<Permission> {
    if (depth > 10) return new Set();

    // Effective permissions = own permissions if set, otherwise inherit from parent
    const effectivePermissions: Permission[] = (entry as any).permissions ?? parentPermissions;

    if (isAllowlistGroup(entry)) {
      const group = entry as AllowlistGroup;
      const result = new Set<Permission>();

      // Match via linearTeamId membership
      if (group.linearTeamId) {
        const teamMembers = this.teamMemberCache.get(group.linearTeamId) ?? [];
        const inTeam = teamMembers.some(
          m => (actor.id && m.id === actor.id) || (actor.email && m.email === actor.email)
        );
        if (inTeam) {
          for (const p of effectivePermissions) result.add(p);
        }
      }

      // Recurse into nested members
      for (const member of group.members ?? []) {
        const subPerms = this.resolveEntry(member, actor, effectivePermissions, depth + 1);
        for (const p of subPerms) result.add(p);
      }

      return result;
    } else {
      // Leaf — match by id or email
      const leaf = entry as AllowlistLeaf;
      const matched =
        (leaf.id && actor.id === leaf.id) ||
        (leaf.email && actor.email === leaf.email);

      if (matched) {
        return new Set(effectivePermissions);
      }
      return new Set();
    }
  }

  /**
   * Map a detected change to the permission required to authorize it.
   *
   * slaStartedAt requires `slaBaseline` — it is the clock anchor and the most
   * restricted field. All other SLA fields (slaType, slaBreachesAt, risk thresholds)
   * require only the general `sla` permission.
   */
  private changeRequiresPermission(change: ChangeDetection): Permission {
    switch (change.field) {
      case 'labels':         return 'labels';
      case 'priority':       return 'priority';
      case 'slaStartedAt':   return 'slaBaseline';
      default:               return 'sla';
    }
  }

  /**
   * Detect what changed between current and previous state
   */
  private async detectChanges(
    current: IssueData,
    previous: Partial<IssueData> | undefined,
    eventType: string
  ): Promise<ChangeDetection[]> {
    const changes: ChangeDetection[] = [];

    if (!previous) {
      // No previous data - might be IssueSLA event
      // We can't detect what changed without previous values
      logger.debug('No previous data available for change detection');
      return changes;
    }

    // Check label changes
    // Linear sends labelIds (UUIDs) in updatedFrom, not full label objects
    if (this.config.protectedFields.label && previous?.labelIds) {
      const currentLabels = current.labels || [];
      const currentLabelIds = current.labelIds || [];
      const previousLabelIds = previous.labelIds || [];
      
      logger.debug('Checking label changes', {
        currentLabelIds,
        previousLabelIds,
        currentLabelNames: currentLabels.map((l: any) => l.name),
        protectedLabels: this.config.protectedLabels
      });
      
      // Check if any labels were removed or added
      const removedLabelIds = previousLabelIds.filter((id: string) => !currentLabelIds.includes(id));
      const addedLabelIds = currentLabelIds.filter((id: string) => !previousLabelIds.includes(id));
      
      if (removedLabelIds.length > 0 || addedLabelIds.length > 0) {
        // Track protected labels that were removed or added
        const removedProtectedLabels: string[] = [];
        const addedProtectedLabels: string[] = [];
        
        // Check removed labels by looking them up by ID
        for (const labelId of removedLabelIds) {
          const label = await this.linearClient.findLabelById(labelId);
          if (label && this.config.protectedLabels.includes(label.name)) {
            removedProtectedLabels.push(label.name);
            logger.info('Detected removal of protected label', {
              labelId,
              labelName: label.name
            });
          }
        }
        
        // Check added labels - but we DON'T enforce on additions
        // Users are allowed to ADD protected labels, just not remove them
        for (const labelId of addedLabelIds) {
          const label = currentLabels.find((l: any) => l.id === labelId);
          if (label && this.config.protectedLabels.includes(label.name)) {
            logger.info('Protected label was added (allowed)', {
              labelId,
              labelName: label.name
            });
          }
        }
        
        logger.debug('Label change detection result', {
          removedProtectedLabels,
          note: 'Only removals trigger enforcement, additions are allowed'
        });
        
        // ONLY trigger enforcement if a protected label was REMOVED
        // Adding a protected label is allowed and should not trigger the agent
        if (removedProtectedLabels.length > 0) {
          const currentLabelNames = currentLabels.map((l: any) => l.name);
          const previousLabelNames = [...currentLabelNames, ...removedProtectedLabels];
          
          changes.push({
            field: 'labels',
            oldValue: previousLabelNames,
            newValue: currentLabelNames,
            removed: removedProtectedLabels,
            added: [],  // We don't track additions for enforcement
            description: `Removed protected label(s): ${removedProtectedLabels.join(', ')}`,
            revertDescription: `Restored label(s): ${removedProtectedLabels.join(', ')}`
          });
        }
      }
    }

    // Check SLA field changes
    // Note: Only slaType and slaStartedAt are writable fields
    // slaMediumRiskAt, slaHighRiskAt, slaBreachesAt are calculated by Linear
    if (this.config.protectedFields.sla) {
      const allSlaFields: Array<keyof IssueData> = [
        'slaType',
        'slaStartedAt',
        'slaMediumRiskAt',
        'slaHighRiskAt',
        'slaBreachesAt'
      ];

      // Check if ANY SLA field changed
      let slaChanged = false;
      const changedSlaFields: string[] = [];
      
      for (const field of allSlaFields) {
        if (previous[field] !== undefined && current[field] !== previous[field]) {
          slaChanged = true;
          changedSlaFields.push(field as string);
          
          // Store individual field changes for reversion logic
          changes.push({
            field: field as any,
            oldValue: previous[field],
            newValue: current[field],
            description: '', // Will be set below
            revertDescription: '' // Will be set below
          });
        }
      }
      
      // If ANY SLA field changed, create a single simplified description
      if (slaChanged && changes.length > 0) {
        // Update the description of the first SLA change to be user-friendly
        const firstSlaChange = changes.find(c => changedSlaFields.includes(String(c.field)));
        if (firstSlaChange) {
          firstSlaChange.description = 'Modified SLA settings';
          firstSlaChange.revertDescription = 'Restored SLA settings';
        }
        
        // Remove descriptions from other SLA changes (they won't appear in comment)
        for (let i = 1; i < changes.length; i++) {
          if (changedSlaFields.includes(String(changes[i].field))) {
            changes[i].description = '';
            changes[i].revertDescription = '';
          }
        }
      }
    }

    // Check priority changes
    // Linear priority values: 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low
    if (this.config.protectedFields.priority) {
      if (previous.priority !== undefined && current.priority !== previous.priority) {
        const priorityLabels: Record<number, string> = {
          0: 'No priority',
          1: 'Urgent',
          2: 'High',
          3: 'Normal',
          4: 'Low'
        };
        
        const oldPriorityLabel = priorityLabels[previous.priority] || `Priority ${previous.priority}`;
        const newPriorityLabel = priorityLabels[current.priority ?? 0] || `Priority ${current.priority}`;
        
        // Check if SLA also changed (priority and SLA are often linked in Linear)
        // Include slaBreachesAt in the check
        const slaAlsoChanged = (previous.slaType !== undefined && current.slaType !== previous.slaType) ||
                               (previous.slaStartedAt !== undefined && current.slaStartedAt !== previous.slaStartedAt) ||
                               (previous.slaBreachesAt !== undefined && current.slaBreachesAt !== previous.slaBreachesAt);
        
        // DEBUG: Log what SLA fields are in the webhook's previousState (updatedFrom)
        // This helps us understand if Linear includes old SLA values
        logger.info('Detected priority change', {
          issueId: current.id,
          oldPriority: previous.priority,
          newPriority: current.priority,
          oldLabel: oldPriorityLabel,
          newLabel: newPriorityLabel,
          slaAlsoChanged,
          // Log what's in previousState for SLA (from webhook's updatedFrom)
          previousStateHas: {
            slaType: previous.slaType !== undefined,
            slaStartedAt: previous.slaStartedAt !== undefined,
            slaBreachesAt: previous.slaBreachesAt !== undefined,
          },
          // Log actual values if present
          previousSlaValues: {
            slaType: previous.slaType,
            slaStartedAt: previous.slaStartedAt,
            slaBreachesAt: previous.slaBreachesAt,
          },
          currentSlaValues: {
            slaType: current.slaType,
            slaStartedAt: current.slaStartedAt,
            slaBreachesAt: current.slaBreachesAt,
          },
          note: slaAlsoChanged ? 'SLA change detected alongside priority (likely linked)' : 'SLA fields not in updatedFrom'
        });
        
        // Build description - note if SLA will also be restored
        const revertDesc = slaAlsoChanged 
          ? `Restored priority to "${oldPriorityLabel}" (SLA also restored)`
          : `Restored priority to "${oldPriorityLabel}"`;
        
        changes.push({
          field: 'priority',
          oldValue: previous.priority,
          newValue: current.priority,
          description: `Changed priority from "${oldPriorityLabel}" to "${newPriorityLabel}"`,
          revertDescription: revertDesc
        });
      }
    }

    // Canonical slaStartedAt baseline check
    // When enabled, slaStartedAt must always equal the issue's createdAt.
    // This catches silent resets (e.g. from priority-triggered workflows) that
    // don't appear in updatedFrom and would otherwise go undetected.
    if (this.config.protectedFields.slaCreatedAtBaseline) {
      const cached = this.slaCache.get(current.id);
      if (cached?.createdAt && current.slaStartedAt !== cached.createdAt) {
        const alreadyDetected = changes.find(c => c.field === 'slaStartedAt');
        if (alreadyDetected) {
          // Override the revert target to createdAt rather than the previous value.
          // Mark as fromBaseline so the permission check always reverts it — the drift
          // was caused by a workflow, not the actor intentionally moving the clock.
          alreadyDetected.oldValue = cached.createdAt;
          alreadyDetected.description = `SLA start date changed from issue creation date`;
          alreadyDetected.revertDescription = `Restored SLA start date to issue creation date (${cached.createdAt})`;
          alreadyDetected.fromBaseline = true;
        } else {
          // Not caught by the updatedFrom check — add it now.
          // fromBaseline=true ensures this is always reverted regardless of actor permissions.
          changes.push({
            field: 'slaStartedAt',
            oldValue: cached.createdAt,
            newValue: current.slaStartedAt,
            description: `SLA start date (${current.slaStartedAt ?? 'unset'}) differs from issue creation date (${cached.createdAt})`,
            revertDescription: `Restored SLA start date to issue creation date (${cached.createdAt})`,
            fromBaseline: true
          });
          logger.info('Canonical baseline: detected slaStartedAt drift', {
            issueId: current.id,
            currentSlaStartedAt: current.slaStartedAt,
            expectedCreatedAt: cached.createdAt
          });
        }
      }
    }

    return changes;
  }

  /**
   * Revert changes by updating the issue
   * @param issueId - The issue to update
   * @param changes - The detected changes
   * @param previousState - The previous state from webhook (for SLA restoration)
   * @param existingCache - The cached state from BEFORE this webhook (for restoration)
   * @param currentState - The current state from webhook data (fallback for first revert)
   */
  private async revertChanges(
    issueId: string, 
    changes: ChangeDetection[],
    previousState?: Partial<IssueData>,
    existingCache?: { slaType: string | null; slaStartedAt: string | null; slaBreachesAt: string | null; priority?: number; cachedAt: Date } | null,
    currentState?: IssueData
  ): Promise<void> {
    const update: any = {};
    
    // Check for priority changes
    const priorityChange = changes.find(c => c.field === 'priority');
    if (priorityChange) {
      update.priority = priorityChange.oldValue;
      logger.info('Reverting priority change', {
        issueId,
        from: priorityChange.newValue,
        to: priorityChange.oldValue
      });
      
      // IMPORTANT: Priority changes can trigger SLA recalculations in Linear
      // We need to also restore the SLA state to prevent cascading changes
      // Check if SLA was also changed in this webhook (linked change)
      const slaAlsoChanged = changes.some(c => 
        c.field === 'slaType' || c.field === 'slaStartedAt' || c.field === 'slaBreachesAt'
      );
      
      // ALWAYS try to restore SLA when priority changes, because Linear's workflow may recalculate it
      // Priority order for SLA values (most reliable first):
      // 1. previousState.slaBreachesAt (from updatedFrom) - IF Linear included the old value
      // 2. existingCache - cached from BEFORE this webhook arrived
      // 3. DO NOT use currentState - it may already have workflow-corrupted values!
      
      // Log what sources we have
      logger.debug('SLA restoration sources', {
        issueId,
        hasPreviousState: {
          slaType: previousState?.slaType !== undefined,
          slaStartedAt: previousState?.slaStartedAt !== undefined,
          slaBreachesAt: previousState?.slaBreachesAt !== undefined,
        },
        hasExistingCache: !!existingCache,
        existingCacheValues: existingCache ? {
          slaType: existingCache.slaType,
          slaBreachesAt: existingCache.slaBreachesAt,
          cachedAt: existingCache.cachedAt
        } : null,
        currentStateValues: {
          slaType: currentState?.slaType,
          slaBreachesAt: currentState?.slaBreachesAt
        }
      });
      
      // Determine the best source for SLA values
      // CRITICAL: Do NOT use currentState as fallback - it has the workflow-corrupted values
      let slaType: string | null | undefined;
      let slaStartedAt: string | null | undefined;
      let slaBreachesAt: string | null | undefined;
      let source = 'none';
      
      // First choice: previousState (from Linear's updatedFrom - the TRUE "before" values)
      if (previousState?.slaBreachesAt !== undefined) {
        slaType = previousState.slaType;
        slaStartedAt = previousState.slaStartedAt;
        slaBreachesAt = previousState.slaBreachesAt;
        source = 'previousState (from updatedFrom)';
      }
      // Second choice: existingCache (our cached values from BEFORE the change)
      else if (existingCache?.slaBreachesAt) {
        slaType = existingCache.slaType;
        slaStartedAt = existingCache.slaStartedAt;
        slaBreachesAt = existingCache.slaBreachesAt;
        source = 'existingCache';
      }
      // NO FALLBACK to currentState - that has the wrong (workflow-generated) values!
      
      // When baseline mode is on, always use createdAt as slaStartedAt.
      // Also recompute slaBreachesAt = createdAt + (current duration) so the SLA
      // policy duration is preserved but anchored to the creation date instead of now.
      // e.g. if Linear set slaStartedAt=today and slaBreachesAt=today+24h (Urgent policy),
      // we set slaStartedAt=createdAt and slaBreachesAt=createdAt+24h (already breached if old).
      if (this.config.protectedFields.slaCreatedAtBaseline) {
        const cached = this.slaCache.get(issueId);
        if (cached?.createdAt) {
          slaStartedAt = cached.createdAt;

          // Priority 1: SLA rule lookup — createdAt + rule.hours(revertedPriority)
          const revertedPriority = priorityChange.oldValue as number;
          const ruleBreachesAt = this.resolveBreachFromRules(
            cached.createdAt,
            revertedPriority,
            currentState?.labels ?? [],
            (currentState as any)?.teamId
          );
          if (ruleBreachesAt) {
            slaBreachesAt = ruleBreachesAt.toISOString();
            logger.info('slaCreatedAtBaseline: computed slaBreachesAt from SLA rule (priority revert)', {
              issueId,
              createdAt: cached.createdAt,
              revertedPriority,
              correctSlaBreachesAt: slaBreachesAt
            });
          } else {
            // Priority 2: duration-based (createdAt + Linear's computed window)
            const currentStartedAt = currentState?.slaStartedAt;
            const currentBreachesAt = currentState?.slaBreachesAt;
            if (currentStartedAt && currentBreachesAt) {
              const durationMs = new Date(currentBreachesAt).getTime() - new Date(currentStartedAt).getTime();
              const correctBreachesAt = new Date(new Date(cached.createdAt).getTime() + durationMs);
              slaBreachesAt = correctBreachesAt.toISOString();
              logger.info('slaCreatedAtBaseline: computed slaBreachesAt = createdAt + current duration', {
                issueId,
                createdAt: cached.createdAt,
                currentSlaStartedAt: currentStartedAt,
                currentSlaBreachesAt: currentBreachesAt,
                durationMs,
                correctSlaBreachesAt: slaBreachesAt
              });
            } else if (!slaBreachesAt) {
              // Priority 3: fall back to cached values
              const targetBreachesAt = cached.originalSlaBreachesAt ?? cached.slaBreachesAt;
              if (targetBreachesAt) {
                slaBreachesAt = targetBreachesAt;
                logger.info('slaCreatedAtBaseline: falling back to cached slaBreachesAt', {
                  issueId,
                  using: targetBreachesAt
                });
              }
            }
          }

          logger.info('slaCreatedAtBaseline: overriding slaStartedAt with createdAt for priority revert', {
            issueId,
            createdAt: cached.createdAt,
            slaBreachesAt
          });
        }
      }

      if (slaType && slaStartedAt && slaBreachesAt) {
        update.slaType = slaType;
        update.slaStartedAt = typeof slaStartedAt === 'string' ? new Date(slaStartedAt) : slaStartedAt;
        update.slaBreachesAt = typeof slaBreachesAt === 'string' ? new Date(slaBreachesAt) : slaBreachesAt;

        logger.info('Restoring SLA to prevent workflow recalculation after priority revert', {
          issueId,
          slaType: update.slaType,
          slaStartedAt: update.slaStartedAt,
          slaBreachesAt: update.slaBreachesAt,
          source
        });
      } else {
        // We don't have reliable SLA values to restore
        // This means either:
        // 1. Linear didn't include old SLA in updatedFrom
        // 2. Our cache is empty (first time seeing this issue)
        logger.warn('⚠️  Cannot restore original SLA - no reliable source available', {
          issueId,
          reason: 'Neither previousState (updatedFrom) nor cache has the original SLA values',
          recommendation: 'The SLA may be reset by Linear workflow. Manual correction may be needed.',
          hasPreviousStateSla: previousState?.slaBreachesAt !== undefined,
          hasExistingCache: !!existingCache,
          note: 'NOT using currentState as it contains workflow-corrupted values'
        });
      }
    }
    
    // Track if we're reverting SLA fields
    const slaChanges = changes.filter(c => 
      c.field === 'slaType' || c.field === 'slaStartedAt' || 
      c.field === 'slaMediumRiskAt' || c.field === 'slaHighRiskAt' || c.field === 'slaBreachesAt'
    );
    
    // slaMediumRiskAt and slaHighRiskAt are truly read-only (Linear rejects them in mutations)
    // Only slaType, slaStartedAt, and slaBreachesAt can be written
    const readOnlySlaFields = ['slaMediumRiskAt', 'slaHighRiskAt'];

    for (const change of changes) {
      if ((change as any).field === 'labels') {
        // Need to restore previous label state completely
        // IMPORTANT: We must restore ALL previous labels, not just add removed ones
        // This handles cases where a label in the same group was swapped
        // (e.g., "Vulnerability" -> "Bug" in the same label group)
        
        if (!previousState?.labelIds) {
          logger.error('Cannot revert labels - no previous labelIds in webhook', {
            issueId,
            change
          });
          continue;
        }
        
        // Restore to exactly the previous labelIds from the webhook
        update.labelIds = previousState.labelIds;
        
        logger.info('Restoring labels to previous state', {
          previousLabelIds: previousState.labelIds,
          removedLabels: (change as any).removed,
          addedLabels: (change as any).added
        });
      } else if ((change as any).field !== 'labels' && !readOnlySlaFields.includes(change.field)) {
        // Add writable SLA field changes to update
        // Skip truly read-only fields (slaMediumRiskAt, slaHighRiskAt)
        const fieldName = change.field;
        let value = change.oldValue;

        // Convert string dates back to Date objects if needed
        if (value && typeof value === 'string' && fieldName.includes('At')) {
          value = new Date(value);
        }

        update[fieldName] = value;
      }
    }
    
    // IMPORTANT: If we're reverting any SLA field, we must restore BOTH slaType and slaStartedAt
    // Linear requires both fields to properly restore an SLA
    if (slaChanges.length > 0) {
      // Get slaType:
      // 1. From previousState if it changed
      // 2. From current issue if it didn't change (still set on issue)
      logger.debug('SLA change detected, gathering complete SLA state');
      
      // Check if slaType was in the webhook's updatedFrom
      // liveIssue is fetched lazily and reused below for slaBreachesAt duration calculation
      let liveIssue: IssueData | null = null;
      if (previousState?.slaType !== undefined) {
        // slaType changed, use the old value
        update.slaType = previousState.slaType;
        logger.debug('Using slaType from webhook previousState', { slaType: update.slaType });
      } else {
        // slaType didn't change (not in updatedFrom), check current issue
        liveIssue = await this.linearClient.getIssue(issueId);
        logger.debug('Fetched current issue for slaType', {
          currentSlaType: liveIssue.slaType,
          currentSlaStartedAt: liveIssue.slaStartedAt,
          currentSlaBreachesAt: liveIssue.slaBreachesAt
        });

        if (liveIssue.slaType) {
          // SLA type is still set, user probably just changed the start time
          update.slaType = liveIssue.slaType;
          logger.debug('Using slaType from current issue (unchanged)', { slaType: update.slaType });
        } else {
          // SLA was removed entirely but slaType wasn't in updatedFrom
          // Try to get it from our cache
          const cachedSLA = this.slaCache.get(issueId);
          if (cachedSLA && cachedSLA.slaType) {
            update.slaType = cachedSLA.slaType;
            logger.info('Restored slaType from cache', {
              slaType: update.slaType,
              cachedAt: cachedSLA.cachedAt
            });
          } else {
            logger.error('SLA was removed but slaType not available - cannot restore!', {
              previousStateKeys: previousState ? Object.keys(previousState) : [],
              hasCachedSLA: !!cachedSLA,
              note: 'Linear API limitation - slaType not in updatedFrom and not in cache'
            });
          }
        }
      }
      
      // Get slaStartedAt from changes or previousState
      const slaStartChange = slaChanges.find(c => c.field === 'slaStartedAt');
      if (slaStartChange && slaStartChange.oldValue) {
        let value: any = slaStartChange.oldValue;
        if (typeof value === 'string') {
          value = new Date(value);
        }
        update.slaStartedAt = value;
      } else if (previousState?.slaStartedAt) {
        let value: any = previousState.slaStartedAt;
        if (typeof value === 'string') {
          value = new Date(value);
        }
        update.slaStartedAt = value;
      }

      // If slaBreachesAt is still not set, restore it via the following priority order:
      //
      // 1. originalSlaBreachesAt from cache — the value locked in by the last agent
      //    correction (isAgentAction block). Immune to async workflow timing issues:
      //    if the user rapidly toggled Urgent→High→Urgent, Linear's High-policy workflow
      //    may arrive after the Urgent toggle and give a 7-day duration. The cached
      //    original (e.g. April 2 for a 24h Urgent policy) is always correct.
      //
      // 2. createdAt + current duration — used on first correction before originalSlaBreachesAt
      //    has been set. Falls back to liveIssue SLA when currentState lacks SLA fields
      //    (happens for priority-only webhooks where Linear omits SLA from the payload).
      //
      // 3. cached slaBreachesAt — last-resort fallback.
      if (!update.slaBreachesAt) {
        const cachedSLA = this.slaCache.get(issueId);
        const createdAt = cachedSLA?.createdAt;

        // Priority 1: SLA rule lookup — createdAt + rule.hours(currentPriority)
        if (createdAt && currentState?.priority !== undefined) {
          const ruleBreachesAt = this.resolveBreachFromRules(
            createdAt,
            currentState.priority,
            currentState.labels ?? [],
            (currentState as any).teamId
          );
          if (ruleBreachesAt) {
            update.slaBreachesAt = ruleBreachesAt;
            logger.info('slaCreatedAtBaseline: computed slaBreachesAt from SLA rule', {
              issueId,
              createdAt,
              priority: currentState.priority,
              correctSlaBreachesAt: update.slaBreachesAt
            });
          }
        }

        // Priority 2: compute from current duration (createdAt + Linear's computed window)
        // For priority-only webhooks, Linear does not include SLA fields in the data payload —
        // currentState.slaStartedAt/slaBreachesAt will be null. Fall back to liveIssue (already
        // fetched above for slaType) which reflects the values Linear's workflow just computed.
        if (!update.slaBreachesAt) {
          const currentStartedAt = currentState?.slaStartedAt ?? liveIssue?.slaStartedAt;
          const currentBreachesAt = currentState?.slaBreachesAt ?? liveIssue?.slaBreachesAt;

          if (createdAt && currentStartedAt && currentBreachesAt) {
            const durationMs = new Date(currentBreachesAt).getTime() - new Date(currentStartedAt).getTime();
            update.slaBreachesAt = new Date(new Date(createdAt).getTime() + durationMs);
            logger.info('slaCreatedAtBaseline: computed slaBreachesAt = createdAt + current duration', {
              issueId,
              createdAt,
              currentSlaStartedAt: currentStartedAt,
              currentSlaBreachesAt: currentBreachesAt,
              source: currentState?.slaStartedAt ? 'webhook currentState' : 'liveIssue (fetched)',
              durationMs,
              durationHours: Math.round(durationMs / 1000 / 60 / 60 * 10) / 10,
              correctSlaBreachesAt: update.slaBreachesAt
            });
          }
        }

        // Priority 3: originalSlaBreachesAt from cache (last resort — may be stale after priority change)
        if (!update.slaBreachesAt && cachedSLA?.originalSlaBreachesAt) {
          update.slaBreachesAt = new Date(cachedSLA.originalSlaBreachesAt);
          logger.info('slaCreatedAtBaseline: falling back to originalSlaBreachesAt from cache', {
            issueId,
            originalSlaBreachesAt: cachedSLA.originalSlaBreachesAt
          });
        }

        // Priority 4: last-resort cached value
        if (!update.slaBreachesAt && cachedSLA?.slaBreachesAt) {
          update.slaBreachesAt = new Date(cachedSLA.slaBreachesAt);
          logger.info('slaCreatedAtBaseline: falling back to cached slaBreachesAt', {
            issueId,
            using: cachedSLA.slaBreachesAt
          });
        }
      }

      logger.info('Restoring SLA (writable fields only)', {
        slaType: update.slaType,
        slaStartedAt: update.slaStartedAt,
        slaBreachesAt: update.slaBreachesAt,
        changedFields: slaChanges.map(c => c.field),
        note: 'slaMediumRiskAt and slaHighRiskAt are read-only (calculated by Linear)',
        willSendWritableFields: !!update.slaType && !!update.slaStartedAt && !!update.slaBreachesAt
      });
      
      if (!update.slaType || !update.slaStartedAt || !update.slaBreachesAt) {
        logger.error('Cannot restore SLA - missing required writable fields', {
          hasSlaType: !!update.slaType,
          hasSlaStartedAt: !!update.slaStartedAt,
          hasBreachesAt: !!update.slaBreachesAt
        });
      }
    }

    // IMPORTANT: Two-step update to defeat Linear's priority-based workflows
    // Linear's workflows may trigger when priority changes and overwrite our SLA.
    // By updating priority FIRST, waiting for the workflow to run, then updating SLA,
    // we ensure our SLA values "win" over the workflow.
    
    const hasSlaToRestore = update.slaType && update.slaStartedAt && update.slaBreachesAt;
    const hasPriorityToRestore = update.priority !== undefined;
    
    if (hasPriorityToRestore && hasSlaToRestore) {
      // Step 1: Update priority only (let workflow run)
      const priorityOnlyUpdate = { priority: update.priority };
      logger.info('Step 1/2: Updating priority first (letting workflow run)', {
        issueId,
        priority: update.priority
      });
      await this.linearClient.updateIssue(issueId, priorityOnlyUpdate);
      
      // Step 2: Wait for workflow to complete, then update SLA
      // Linear's workflows are async, so we need to wait a bit
      const workflowDelayMs = 1500; // 1.5 seconds should be enough
      logger.info(`Step 2/2: Waiting ${workflowDelayMs}ms for workflow to complete, then restoring SLA`, {
        issueId
      });
      await new Promise(resolve => setTimeout(resolve, workflowDelayMs));
      
      // Now update SLA (this will overwrite whatever the workflow set)
      const slaOnlyUpdate = {
        slaType: update.slaType,
        slaStartedAt: update.slaStartedAt,
        slaBreachesAt: update.slaBreachesAt
      };
      await this.linearClient.updateIssue(issueId, slaOnlyUpdate);
      
      logger.info('SLA restored after priority update', {
        issueId,
        slaBreachesAt: update.slaBreachesAt
      });
    } else {
      // No two-step needed, just do a single update
      await this.linearClient.updateIssue(issueId, update);
    }
  }

  /**
   * Post AIG-compliant comment explaining what was and wasn't reverted.
   * Handles partial authorization — some fields allowed through, others reverted.
   */
  private async postAgentComment(
    issueId: string,
    actor: WebhookActor,
    allowedChanges: ChangeDetection[],
    unauthorizedChanges: ChangeDetection[],
    reverted: boolean
  ): Promise<void> {
    const userMention = this.config.behavior.mentionUser && actor.id
      ? `[${actor.name}](${actor.url})`
      : actor.name;

    const isPartial = allowedChanges.length > 0 && unauthorizedChanges.length > 0;

    const unauthorizedDescription = unauthorizedChanges
      .filter(c => c.description)
      .map(c => `- ${c.description}`)
      .join('\n');

    const allowedDescription = allowedChanges
      .filter(c => c.description)
      .map(c => `- ${c.description} _(allowed)_`)
      .join('\n');

    const allChangesDescription = [unauthorizedDescription, allowedDescription]
      .filter(Boolean)
      .join('\n');

    let actionDescription: string;
    if (reverted) {
      const revertLines = unauthorizedChanges
        .filter(c => c.revertDescription)
        .map(c => `- ✅ ${c.revertDescription}`)
        .join('\n');
      actionDescription = revertLines || '- ✅ Reverted unauthorized changes';
    } else {
      actionDescription = '- ℹ️ Detected but not reverted (notify-only mode)';
    }

    const protectedItems = this.config.protectedLabels.join(', ');
    const protectedFieldTypes: string[] = [];
    if (this.config.protectedFields.label) protectedFieldTypes.push(`${protectedItems} label(s)`);
    if (this.config.protectedFields.priority) protectedFieldTypes.push('priority');
    if (this.config.protectedFields.sla) protectedFieldTypes.push('SLA fields');
    const protectedFieldsText = protectedFieldTypes.join(', ');

    const heading = isPartial
      ? `${userMention} - I detected changes to this issue. Some were within your permissions; others were not${reverted ? ' and have been reverted' : ''}.`
      : `${userMention} - I detected an unauthorized change to this issue${reverted ? ' and have reverted it' : ''}.`;

    const comment = `
${heading}

**What happened:**
- User: ${userMention}
${allChangesDescription}
- Time: ${new Date().toLocaleString()}

**What I did:**
${actionDescription}

This issue is protected. Only authorized users can modify the ${protectedFieldsText}.

---
_I am an automated agent. [Learn more](https://linear.app/developers/aig)_
    `.trim();

    await this.linearClient.createComment(issueId, comment);
  }

  /**
   * Log audit entry
   */
  private async logAuditEntry(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    if (!this.config.logging.auditTrail) {
      return;
    }

    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };

    await logAudit(fullEntry, this.config.logging.auditLogPath);
  }
}

