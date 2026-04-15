/**
 * TypeScript type definitions for Linear SLA Enforcement Agent
 */

// ============================================================================
// Permission Types
// ============================================================================

/**
 * The set of protected fields an allowlist entry may authorize.
 *
 * - labels      : can add/remove protected labels
 * - sla         : can modify slaType and slaBreachesAt (the deadline/policy)
 * - priority    : can change issue priority
 * - slaBaseline : can modify slaStartedAt (the clock anchor — most restricted)
 *
 * slaBaseline is intentionally separate from sla. Moving the SLA clock origin
 * is how SLA gaming works; it should only be granted to admins.
 */
export type Permission = 'labels' | 'sla' | 'priority' | 'slaBaseline';

export const ALL_PERMISSIONS: Permission[] = ['labels', 'sla', 'priority', 'slaBaseline'];

// ============================================================================
// Allowlist Types — hierarchical, field-level authorization
// ============================================================================

/**
 * A leaf entry — identifies a single Linear user by email or id.
 * May carry its own permissions override; otherwise inherits from its
 * enclosing group. Root-level leaves with no permissions default to ALL.
 */
export interface AllowlistLeaf {
  /** Linear user email */
  email?: string;
  /** Linear user ID */
  id?: string;
  /** Display name (optional, documentation only) */
  name?: string;
  /**
   * Permissions this user is granted.
   * Omit to inherit from parent group, or default to ALL at root level.
   */
  permissions?: Permission[];
}

/**
 * A group entry — a named collection of users and/or sub-groups.
 * Optionally backed by a Linear team (all team members match the group).
 *
 * Discriminated from AllowlistLeaf by the presence of `members` or
 * `linearTeamId`.
 */
export interface AllowlistGroup {
  /** Display name — required for groups, used in logs and audit trail */
  name: string;
  /**
   * All members of this Linear team automatically match this group.
   * Resolved at startup and refreshed on a configurable interval (default 4h).
   */
  linearTeamId?: string;
  /**
   * Permissions this group grants to its members.
   * Omit to inherit from parent group, or default to ALL at root level.
   */
  permissions?: Permission[];
  /** Nested sub-groups or leaf users */
  members?: AllowlistEntry[];
}

/**
 * One entry in the allowlist — either a leaf user or a group.
 * The shape is discriminated by `isAllowlistGroup()`.
 */
export type AllowlistEntry = AllowlistLeaf | AllowlistGroup;

/**
 * Type guard: true when the entry is an AllowlistGroup (has members or linearTeamId).
 */
export function isAllowlistGroup(entry: AllowlistEntry): entry is AllowlistGroup {
  return 'members' in entry || 'linearTeamId' in entry;
}

/**
 * Backward-compatible alias for the old flat AllowlistUser type.
 * Existing configs without a `permissions` field continue to work — they
 * are treated as AllowlistLeaf entries that default to ALL permissions.
 */
export type AllowlistUser = AllowlistLeaf;

// ============================================================================
// SLA Policy Types
// ============================================================================
// SLA Rule Types
// ============================================================================

/**
 * Linear priority levels.
 *
 * Linear does not expose SLA rule definitions via its API — the rule that maps
 * "Urgent priority" to a 24-hour window exists only in the Linear UI settings
 * and is never returned by the GraphQL API. The computed breach timestamp
 * (`slaBreachesAt`) is available on issues, but the underlying policy is not.
 *
 * This config-side declaration is the solution: operators specify their own
 * expected SLA windows here, and the enforcement engine validates issues against
 * these declared rules.
 *
 * Priority values match Linear's integer encoding:
 *   0 = No priority | 1 = Urgent | 2 = High | 3 = Normal | 4 = Low
 */
export type LinearPriority = 0 | 1 | 2 | 3 | 4;

/**
 * Human-readable priority names accepted in config.json as an alternative to
 * the integer form, for readability.
 */
export type LinearPriorityName = 'urgent' | 'high' | 'normal' | 'low' | 'no_priority';

/**
 * Expected SLA breach window for one priority level within a rule set.
 *
 * `hours` is the only required field. The enforcement engine uses it to validate
 * that `slaBreachesAt` is within an acceptable tolerance of
 * `slaStartedAt + hours`.
 */
export interface SLAPriorityWindow {
  /**
   * Priority level — accepts either the Linear integer (1–4) or a
   * human-readable name ("urgent", "high", "normal", "low").
   */
  priority: LinearPriority | LinearPriorityName;
  /** Expected SLA duration in hours from when the SLA clock started */
  hours: number;
}

/**
 * A single SLA rule set — the condition that activates it plus the per-priority
 * windows that apply when it matches.
 *
 * **Matching logic** (all specified conditions must be satisfied — AND):
 * - `labels`: issue must carry *all* listed labels
 * - `teamId`: issue must belong to the specified team (optional)
 *
 * When multiple rule sets match an issue, the *most specific* one wins
 * (most conditions specified). If specificity is equal, the first match wins.
 *
 * **Example — Delivery team bugs:**
 * ```json
 * {
 *   "name": "Delivery Bug SLA",
 *   "teamId": "DELIVERY",
 *   "labels": ["Bug"],
 *   "priorityWindows": [
 *     { "priority": "urgent", "hours": 24 },
 *     { "priority": "high",   "hours": 168 },
 *     { "priority": "normal", "hours": 720 },
 *     { "priority": "low",    "hours": 2880 }
 *   ]
 * }
 * ```
 */
export interface SLARuleSet {
  /** Human-readable name shown in logs and audit entries */
  name: string;
  /**
   * Linear team ID or key (e.g. "DELIVERY" or the team's UUID).
   * When set, the rule only activates for issues belonging to that team.
   * Omit to apply across all teams.
   */
  teamId?: string;
  /**
   * Label names that must *all* be present on the issue for this rule to match.
   * Omit or leave empty to match regardless of labels.
   */
  labels?: string[];
  /**
   * Per-priority expected SLA windows.
   * Priorities not listed here are not validated by this rule.
   */
  priorityWindows: SLAPriorityWindow[];
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface Config {
  protectedLabels: string[];
  checkLabelGroups: boolean;
  protectedFields: {
    label: boolean;
    sla: boolean;
    priority: boolean;
    slaCreatedAtBaseline?: boolean;
  };
  /** Hierarchical allowlist — replaces the old flat AllowlistUser[]. */
  allowlist: AllowlistEntry[];
  /**
   * Declared SLA rule sets, evaluated per issue to determine the expected breach window.
   *
   * Linear does not expose its SLA policy definitions via the API — only the
   * computed `slaBreachesAt` timestamp on individual issues is readable. These
   * rule sets are therefore declared manually here and are the source of truth
   * for validation.
   *
   * Each rule set specifies:
   *   - which issues it applies to (by team and/or label)
   *   - the expected SLA window per priority level
   *
   * Rules are evaluated in order; the most specific matching rule wins.
   * Optional — when absent, the agent protects SLA fields as-is without
   * validating the duration.
   */
  slaRules?: SLARuleSet[];
  agent: AgentConfig;
  slack: SlackConfig;
  behavior: BehaviorConfig;
  logging: LoggingConfig;
}

export interface AgentConfig {
  name: string;
  identifier: string;
  userId?: string;
  email?: string;
}

export interface SlackConfig {
  enabled: boolean;
  channelId?: string;
}

export interface BehaviorConfig {
  dryRun: boolean;
  notifyOnly: boolean;
  mentionUser: boolean;
}

export interface LoggingConfig {
  level: string;
  auditTrail: boolean;
  auditLogPath: string;
}

// ============================================================================
// Linear Webhook Types
// ============================================================================

export interface BaseWebhookPayload {
  type: string;
  action: string;
  actor: WebhookActor;
  createdAt: string;
  url: string;
  webhookTimestamp: number;
  webhookId: string;
  organizationId: string;
}

export interface WebhookActor {
  id: string;
  type: 'user' | 'integration' | 'oauthClient';
  name: string;
  email?: string;
  url: string;
}

export interface IssueWebhookPayload extends BaseWebhookPayload {
  type: 'Issue';
  action: 'create' | 'update' | 'remove';
  data: IssueData;
  updatedFrom?: Partial<IssueData>;
}

export interface IssueSLAWebhookPayload extends BaseWebhookPayload {
  type: 'IssueSLA';
  action: 'set' | 'highRisk' | 'breached';
  issueData: IssueData;
}

export type WebhookPayload = IssueWebhookPayload | IssueSLAWebhookPayload;

// ============================================================================
// Linear Issue Types
// ============================================================================

export interface IssueData {
  id: string;
  title: string;
  identifier?: string;
  labels?: IssueLabel[];
  labelIds?: string[];
  priority?: number;
  slaType?: string | null;
  slaStartedAt?: string | null;
  slaMediumRiskAt?: string | null;
  slaHighRiskAt?: string | null;
  slaBreachesAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

export interface IssueLabel {
  id: string;
  name: string;
  parent?: LabelParent | null;
}

export interface LabelParent {
  id: string;
  name: string;
}

// ============================================================================
// Enforcement Types
// ============================================================================

export interface ChangeDetection {
  field: 'labels' | 'priority' | 'slaType' | 'slaStartedAt' | 'slaMediumRiskAt' | 'slaHighRiskAt' | 'slaBreachesAt';
  oldValue: any;
  newValue: any;
  removed?: string[];
  added?: string[];
  description: string;
  revertDescription: string;
  /**
   * True when this change was detected by the slaCreatedAtBaseline check rather than
   * appearing in the webhook's updatedFrom. Baseline drift is caused by Linear's internal
   * workflows (e.g. priority change recalculates slaStartedAt) — not by the actor
   * intentionally moving the clock. Always reverted regardless of actor permissions.
   */
  fromBaseline?: boolean;
}

export interface EnforcementResult {
  enforced: boolean;
  reason: string;
  changes?: ChangeDetection[];
  unauthorizedChanges?: ChangeDetection[];
  allowedChanges?: ChangeDetection[];
  dryRun?: boolean;
}

// ============================================================================
// Audit Log Types
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  webhookId: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle: string;
  actor: {
    id: string;
    email?: string;
    name: string;
    type: string;
  };
  action: 'allowed' | 'reverted' | 'detected' | 'partial';
  reason: string;
  actorPermissions?: Permission[];
  changes: {
    field: string;
    oldValue: any;
    newValue: any;
    reverted?: boolean;
  }[];
  dryRun?: boolean;
  notifyOnly?: boolean;
}

// ============================================================================
// Linear SDK Response Types
// ============================================================================

export interface LinearViewer {
  id: string;
  email: string;
  name: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  parent?: LinearLabel | null;
}

export interface LinearUser {
  id: string;
  email: string;
  name: string;
}
