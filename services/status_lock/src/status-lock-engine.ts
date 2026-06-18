/**
 * Status Lock Engine
 *
 * Freezes an issue once it reaches a "locked" status (e.g. "Ready for
 * Deployment", "Closed", "Cancelled"). While an issue is locked, any change to
 * a monitored field made by a non-authorized user is reverted to its previous
 * value, the actor is notified in a comment, and the action is recorded in the
 * audit trail.
 *
 * Reverting uses the previous values Linear sends in the webhook's `updatedFrom`
 * payload — the agent does not need to maintain a snapshot of every issue.
 *
 * Authorized users (the allowlist — admins / release managers) may edit a locked
 * issue freely, including moving it out of the locked status.
 */

import {
  Config,
  WebhookPayload,
  WebhookActor,
  IssueData,
  IssueLabel,
  WorkflowState,
  ChangeDetection,
  EnforcementResult,
  MonitoredField,
  AllowlistEntry,
  AllowlistLeaf,
  AllowlistGroup,
  isAllowlistGroup,
  LinearUser
} from './types';
import { LinearClient, IssueUpdateInput } from './linear-client';
import logger from './utils/logger';
import { logAudit } from './utils/audit-trail';
import { extractIssueData } from './webhook-handler';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low'
};

export class StatusLockEngine {
  constructor(
    private config: Config,
    private linearClient: LinearClient,
    /** stateId → workflow state, used to classify an issue's *previous* status. */
    private stateMap: Map<string, WorkflowState> = new Map(),
    /** linearTeamId → members, used to resolve allowlist team membership. */
    private teamMemberCache: Map<string, LinearUser[]> = new Map()
  ) {}

  /**
   * Main entry point — called for each webhook that should be enforced.
   */
  async enforce(payload: WebhookPayload): Promise<EnforcementResult> {
    // The lock agent only acts on Issue events.
    if (payload.type !== 'Issue') {
      return { enforced: false, reason: 'Not an Issue event' };
    }

    const { current, previous } = extractIssueData(payload);
    if (!current || !current.id) {
      logger.error('Invalid issue data in webhook');
      return { enforced: false, reason: 'Invalid issue data' };
    }

    // Loop prevention: ignore the agent's own reverts.
    if (this.isAgentAction(payload.actor)) {
      logger.debug('Skipping — action was made by the agent itself', { issueId: current.id });
      return { enforced: false, reason: 'Agent action (self)' };
    }

    // Resolve the current and previous workflow states.
    const currentState = this.resolveCurrentState(current);
    const stateChanged = previous?.stateId !== undefined;
    const previousState = stateChanged
      ? this.resolveStateById(previous!.stateId ?? null)
      : currentState;

    const currentLocked = this.isLockedState(currentState);
    const wasLocked = this.isLockedState(previousState);

    // Keep the state map fresh as we observe states in webhooks.
    if (currentState) this.stateMap.set(currentState.id, currentState);

    // Not locked now and wasn't locked before → nothing to protect.
    if (!currentLocked && !wasLocked) {
      return { enforced: false, reason: 'Issue is not in a locked status' };
    }

    // The issue just entered a locked status — this transition is allowed.
    // Snapshot is unnecessary: future changes revert against the webhook's
    // updatedFrom values. Optionally announce the lock.
    if (!wasLocked && currentLocked) {
      logger.info('Issue entered a locked status', {
        issueId: current.id,
        identifier: current.identifier,
        status: currentState?.name,
        actor: payload.actor.email || payload.actor.name
      });

      if (this.config.behavior.announceLock && !this.config.behavior.dryRun) {
        await this.postLockComment(current, currentState);
      }

      await this.audit({
        payload,
        current,
        lockedStatus: currentState?.name,
        action: 'locked',
        reason: `Issue entered locked status "${currentState?.name}"`,
        changes: []
      });

      return { enforced: false, reason: 'Issue entered locked status', lockApplied: true };
    }

    // At this point the issue WAS locked before this change (wasLocked === true).
    // Any monitored field that changed is a candidate for reverting.
    const lockedStatusName = (previousState ?? currentState)?.name;
    const { changes, revertInput } = await this.detectChanges(current, previous);

    if (changes.length === 0) {
      logger.debug('Locked issue changed, but no monitored fields were affected', {
        issueId: current.id,
        status: lockedStatusName
      });
      return { enforced: false, reason: 'No monitored field changed' };
    }

    // Authorized users (admins / release managers) may edit a locked issue.
    if (this.isAuthorized(payload.actor)) {
      logger.info('Change to locked issue allowed — actor is authorized', {
        issueId: current.id,
        actor: payload.actor.email || payload.actor.name,
        fields: changes.map(c => c.field)
      });
      await this.audit({
        payload,
        current,
        lockedStatus: lockedStatusName,
        action: 'allowed',
        reason: 'Actor is authorized to edit locked issues',
        changes: changes.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: false }))
      });
      return { enforced: false, reason: 'Actor authorized', changes };
    }

    // --- Unauthorized change to a locked issue ---

    // DRY RUN — log only.
    if (this.config.behavior.dryRun) {
      logger.info('[DRY RUN] Would revert unauthorized change to locked issue', {
        issueId: current.id,
        actor: payload.actor.email || payload.actor.name,
        fields: changes.map(c => c.field)
      });
      await this.audit({
        payload, current, lockedStatus: lockedStatusName,
        action: 'detected', reason: 'Dry run — would revert', dryRun: true,
        changes: changes.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: false }))
      });
      return { enforced: false, reason: 'Dry run mode', changes, dryRun: true };
    }

    // NOTIFY ONLY — comment but don't revert.
    if (this.config.behavior.notifyOnly) {
      logger.info('[NOTIFY ONLY] Detected unauthorized change to locked issue (not reverting)', {
        issueId: current.id,
        fields: changes.map(c => c.field)
      });
      await this.postRevertComment(current, lockedStatusName, payload.actor, changes, false);
      await this.audit({
        payload, current, lockedStatus: lockedStatusName,
        action: 'detected', reason: 'Notify only — no revert', notifyOnly: true,
        changes: changes.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: false }))
      });
      return { enforced: false, reason: 'Notify only mode', changes };
    }

    // NORMAL — revert the change.
    logger.warn('Unauthorized change to locked issue — reverting', {
      issueId: current.id,
      identifier: current.identifier,
      status: lockedStatusName,
      actor: payload.actor.email || payload.actor.name,
      fields: changes.map(c => c.field)
    });

    await this.linearClient.applyIssueUpdate(current.id, revertInput);
    await this.postRevertComment(current, lockedStatusName, payload.actor, changes, true);
    await this.audit({
      payload, current, lockedStatus: lockedStatusName,
      action: 'reverted', reason: 'Unauthorized change to a locked issue',
      changes: changes.map(c => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue, reverted: true }))
    });

    return { enforced: true, reason: 'Unauthorized change reverted', changes };
  }

  // ===========================================================================
  // Status classification
  // ===========================================================================

  /** Resolve the issue's current workflow state from the webhook (or state map). */
  private resolveCurrentState(issue: IssueData): WorkflowState | undefined {
    if (issue.state && issue.state.id) return issue.state;
    if (issue.stateId) return this.resolveStateById(issue.stateId);
    return undefined;
  }

  private resolveStateById(stateId: string | null): WorkflowState | undefined {
    if (!stateId) return undefined;
    return this.stateMap.get(stateId);
  }

  /** True when a state locks the issue, by configured name or state type. */
  isLockedState(state: WorkflowState | undefined): boolean {
    if (!state) return false;
    const byName = this.config.lockedStatuses.some(
      name => name.toLowerCase() === state.name.toLowerCase()
    );
    const byType = (this.config.lockedStatusTypes ?? []).some(
      type => type.toLowerCase() === state.type.toLowerCase()
    );
    return byName || byType;
  }

  // ===========================================================================
  // Change detection
  // ===========================================================================

  /**
   * Compare the incoming issue against the previous values in `updatedFrom`,
   * for every monitored field. Returns the human-readable change list plus the
   * exact update needed to revert each field to its previous value.
   */
  private async detectChanges(
    current: IssueData,
    previous: Partial<IssueData> | undefined
  ): Promise<{ changes: ChangeDetection[]; revertInput: IssueUpdateInput }> {
    const changes: ChangeDetection[] = [];
    const revertInput: IssueUpdateInput = {};
    if (!previous) return { changes, revertInput };

    const monitors = new Set(this.config.monitoredFields);
    const wants = (f: MonitoredField) => monitors.has(f);

    // Title
    if (wants('title') && previous.title !== undefined && current.title !== previous.title) {
      changes.push({
        field: 'title',
        oldValue: previous.title,
        newValue: current.title,
        description: `Title changed to "${current.title}"`,
        revertDescription: `Restored title to "${previous.title}"`
      });
      revertInput.title = previous.title;
    }

    // Description
    if (wants('description') && previous.description !== undefined && current.description !== previous.description) {
      changes.push({
        field: 'description',
        oldValue: previous.description,
        newValue: current.description,
        description: 'Description was edited',
        revertDescription: 'Restored the previous description'
      });
      revertInput.description = previous.description ?? '';
    }

    // Priority
    if (wants('priority') && previous.priority !== undefined && current.priority !== previous.priority) {
      const oldLabel = PRIORITY_LABELS[previous.priority] ?? `Priority ${previous.priority}`;
      const newLabel = PRIORITY_LABELS[current.priority ?? 0] ?? `Priority ${current.priority}`;
      changes.push({
        field: 'priority',
        oldValue: previous.priority,
        newValue: current.priority,
        description: `Priority changed from "${oldLabel}" to "${newLabel}"`,
        revertDescription: `Restored priority to "${oldLabel}"`
      });
      revertInput.priority = previous.priority;
    }

    // Estimate
    if (wants('estimate') && previous.estimate !== undefined && current.estimate !== previous.estimate) {
      changes.push({
        field: 'estimate',
        oldValue: previous.estimate,
        newValue: current.estimate,
        description: `Estimate changed to "${current.estimate ?? 'none'}"`,
        revertDescription: `Restored estimate to "${previous.estimate ?? 'none'}"`
      });
      revertInput.estimate = previous.estimate ?? null;
    }

    // Assignee
    if (wants('assignee') && previous.assigneeId !== undefined && current.assigneeId !== previous.assigneeId) {
      changes.push({
        field: 'assignee',
        oldValue: previous.assigneeId,
        newValue: current.assigneeId,
        description: 'Assignee was changed',
        revertDescription: 'Restored the previous assignee'
      });
      revertInput.assigneeId = previous.assigneeId ?? null;
    }

    // Due date
    if (wants('dueDate') && previous.dueDate !== undefined && current.dueDate !== previous.dueDate) {
      changes.push({
        field: 'dueDate',
        oldValue: previous.dueDate,
        newValue: current.dueDate,
        description: `Due date changed to "${current.dueDate ?? 'none'}"`,
        revertDescription: `Restored due date to "${previous.dueDate ?? 'none'}"`
      });
      revertInput.dueDate = previous.dueDate ?? null;
    }

    // Status (attempt to move the issue out of its locked state).
    // Linear sends the new state as an object in `data`; the bare `stateId` may
    // or may not also be present, so derive it from the state object as needed.
    const currentStateId = current.stateId ?? current.state?.id ?? null;
    if (wants('state') && previous.stateId !== undefined && currentStateId !== previous.stateId) {
      const fromName = this.resolveStateById(previous.stateId ?? null)?.name ?? 'previous status';
      const toName = this.resolveCurrentState(current)?.name ?? 'a new status';
      changes.push({
        field: 'state',
        oldValue: previous.stateId,
        newValue: currentStateId,
        description: `Status changed from "${fromName}" to "${toName}"`,
        revertDescription: `Restored status to "${fromName}"`
      });
      revertInput.stateId = previous.stateId;
    }

    // Labels
    if (wants('labels') && previous.labelIds !== undefined) {
      const prevIds = previous.labelIds ?? [];
      const currIds = current.labelIds ?? (current.labels ?? []).map(l => l.id);
      if (!sameSet(prevIds, currIds)) {
        const { added, removed } = await this.describeLabelDelta(prevIds, currIds, current.labels);
        const parts: string[] = [];
        if (added.length) parts.push(`added ${added.join(', ')}`);
        if (removed.length) parts.push(`removed ${removed.join(', ')}`);
        changes.push({
          field: 'labels',
          oldValue: prevIds,
          newValue: currIds,
          description: `Labels changed (${parts.join('; ') || 'modified'})`,
          revertDescription: 'Restored the previous labels'
        });
        revertInput.labelIds = prevIds;
      }
    }

    return { changes, revertInput };
  }

  /** Resolve added/removed label IDs to names for a readable comment. */
  private async describeLabelDelta(
    prevIds: string[],
    currIds: string[],
    currentLabels?: IssueLabel[]
  ): Promise<{ added: string[]; removed: string[] }> {
    const addedIds = currIds.filter(id => !prevIds.includes(id));
    const removedIds = prevIds.filter(id => !currIds.includes(id));

    const nameOf = async (id: string): Promise<string> => {
      const onIssue = currentLabels?.find(l => l.id === id);
      if (onIssue) return onIssue.name;
      const fetched = await this.linearClient.findLabelById(id);
      return fetched?.name ?? id;
    };

    const added = await Promise.all(addedIds.map(nameOf));
    const removed = await Promise.all(removedIds.map(nameOf));
    return { added, removed };
  }

  // ===========================================================================
  // Authorization
  // ===========================================================================

  /** True when the actor is the agent itself (loop prevention). */
  private isAgentAction(actor: WebhookActor): boolean {
    if (this.config.agent.userId && actor.id === this.config.agent.userId) return true;
    if (this.config.agent.email && actor.email === this.config.agent.email) return true;
    if (actor.type === 'integration' && actor.name === this.config.agent.name) return true;
    return false;
  }

  /** True when the actor may edit a locked issue (matches the allowlist). */
  isAuthorized(actor: WebhookActor): boolean {
    return this.config.allowlist.some(entry => this.matchesEntry(entry, actor, 0));
  }

  private matchesEntry(entry: AllowlistEntry, actor: WebhookActor, depth: number): boolean {
    if (depth > 10) return false;

    if (isAllowlistGroup(entry)) {
      const group = entry as AllowlistGroup;
      if (group.linearTeamId) {
        const members = this.teamMemberCache.get(group.linearTeamId) ?? [];
        const inTeam = members.some(
          m => (actor.id && m.id === actor.id) || (actor.email && m.email === actor.email)
        );
        if (inTeam) return true;
      }
      return (group.members ?? []).some(m => this.matchesEntry(m, actor, depth + 1));
    }

    const leaf = entry as AllowlistLeaf;
    return Boolean(
      (leaf.id && actor.id === leaf.id) ||
      (leaf.email && actor.email === leaf.email)
    );
  }

  // ===========================================================================
  // Comments & audit
  // ===========================================================================

  private async postLockComment(issue: IssueData, state: WorkflowState | undefined): Promise<void> {
    const body =
      `🔒 **This issue is now locked.**\n\n` +
      `It has entered the **${state?.name ?? 'locked'}** status, so its fields are frozen for audit and release integrity. ` +
      `Any change made from here will be automatically reverted unless it comes from an authorized user.\n\n` +
      `_${this.config.agent.name}_`;
    await this.linearClient.createComment(issue.id, body);
  }

  private async postRevertComment(
    issue: IssueData,
    lockedStatus: string | undefined,
    actor: WebhookActor,
    changes: ChangeDetection[],
    reverted: boolean
  ): Promise<void> {
    const who = this.config.behavior.mentionUser
      ? `**${actor.name}${actor.email ? ` (${actor.email})` : ''}**`
      : 'A user';

    const header = reverted
      ? `🔒 **Change reverted — this issue is locked.**`
      : `🔒 **Locked issue changed.**`;

    const detected = changes.map(c => `• ${c.description}`).join('\n');
    const restored = reverted ? changes.map(c => `• ${c.revertDescription}`).join('\n') : '';

    const when = new Date().toISOString();
    const body =
      `${header}\n\n` +
      `${who} modified this issue while it is in the **${lockedStatus ?? 'locked'}** status.\n\n` +
      `**Detected change(s):**\n${detected}\n\n` +
      (reverted ? `**Restored:**\n${restored}\n\n` : `_No changes were reverted (notify-only mode)._\n\n`) +
      `_${this.config.agent.name} · ${when}_`;

    await this.linearClient.createComment(issue.id, body);
  }

  private async audit(opts: {
    payload: WebhookPayload;
    current: IssueData;
    lockedStatus?: string;
    action: 'allowed' | 'reverted' | 'detected' | 'locked';
    reason: string;
    changes: { field: string; oldValue: any; newValue: any; reverted?: boolean }[];
    dryRun?: boolean;
    notifyOnly?: boolean;
  }): Promise<void> {
    if (!this.config.logging.auditTrail) return;
    await logAudit(
      {
        timestamp: new Date().toISOString(),
        webhookId: opts.payload.webhookId,
        issueId: opts.current.id,
        issueIdentifier: opts.current.identifier,
        issueTitle: opts.current.title,
        lockedStatus: opts.lockedStatus,
        actor: {
          id: opts.payload.actor.id,
          email: opts.payload.actor.email,
          name: opts.payload.actor.name,
          type: opts.payload.actor.type
        },
        action: opts.action,
        reason: opts.reason,
        changes: opts.changes,
        dryRun: opts.dryRun,
        notifyOnly: opts.notifyOnly
      },
      this.config.logging.auditLogPath
    );
  }
}

/** Order-insensitive equality for two id lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every(x => setB.has(x));
}
