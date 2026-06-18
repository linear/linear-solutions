/**
 * TypeScript type definitions for the Linear Issue Lock Agent.
 *
 * The agent freezes an issue once it reaches a "locked" status (e.g. "Ready for
 * Deployment", "Closed", "Cancelled"). Any subsequent change made by a
 * non-authorized user is reverted, the actor is notified, and the action is
 * recorded in the audit trail.
 */

// ============================================================================
// Allowlist — who is allowed to edit a locked issue
// ============================================================================

/**
 * A leaf entry — a single Linear user identified by email or id.
 */
export interface AllowlistLeaf {
  /** Linear user email */
  email?: string;
  /** Linear user ID */
  id?: string;
  /** Display name (optional, documentation only) */
  name?: string;
}

/**
 * A group entry — a named collection of users and/or sub-groups, optionally
 * backed by a Linear team (every member of the team is treated as a member of
 * the group). Use this for "Release Managers", "Project Admins", etc.
 */
export interface AllowlistGroup {
  /** Display name — required for groups, used in logs and audit trail */
  name: string;
  /**
   * All members of this Linear team automatically match the group.
   * Accepts the team key (e.g. "REL") or a full UUID. Resolved at startup and
   * refreshed on an interval (default 4h).
   */
  linearTeamId?: string;
  /** Nested sub-groups or leaf users */
  members?: AllowlistEntry[];
}

/** One entry in the allowlist — either a leaf user or a group. */
export type AllowlistEntry = AllowlistLeaf | AllowlistGroup;

/** Type guard: true when the entry is a group (has members or linearTeamId). */
export function isAllowlistGroup(entry: AllowlistEntry): entry is AllowlistGroup {
  return 'members' in entry || 'linearTeamId' in entry;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * The issue fields the agent watches while an issue is locked. A change to any
 * monitored field by a non-authorized user is reverted to its previous value.
 *
 * `state` covers attempts to drag the issue out of its locked status.
 */
export type MonitoredField =
  | 'title'
  | 'description'
  | 'priority'
  | 'estimate'
  | 'assignee'
  | 'labels'
  | 'state'
  | 'dueDate';

export const ALL_MONITORED_FIELDS: MonitoredField[] = [
  'title',
  'description',
  'priority',
  'estimate',
  'assignee',
  'labels',
  'state',
  'dueDate'
];

export interface Config {
  /**
   * Status names that lock an issue, matched against the issue's workflow state
   * name (case-insensitive). e.g. ["Ready for Deployment", "Closed", "Cancelled"].
   */
  lockedStatuses: string[];
  /**
   * Optional: lock by Linear workflow state *type* instead of (or in addition
   * to) name. Linear state types: "backlog", "unstarted", "started",
   * "completed", "canceled", "triage". e.g. ["completed", "canceled"] locks
   * every Done/Cancelled-style status regardless of its custom name.
   */
  lockedStatusTypes?: string[];
  /** Which fields to protect while an issue is locked. */
  monitoredFields: MonitoredField[];
  /** Users / teams permitted to edit a locked issue (admins, release managers). */
  allowlist: AllowlistEntry[];
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
  /** Log what would happen without making any changes. */
  dryRun: boolean;
  /** Post a comment when a change is detected, but do not revert it. */
  notifyOnly: boolean;
  /** @mention the actor in revert comments. */
  mentionUser: boolean;
  /** Post a "🔒 locked" comment when an issue first enters a locked status. */
  announceLock: boolean;
}

export interface LoggingConfig {
  level: string;
  auditTrail: boolean;
  auditLogPath: string;
}

// ============================================================================
// Linear webhook payloads
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
  /** Previous values of every field that changed in this webhook. */
  updatedFrom?: Partial<IssueData>;
}

/**
 * Linear also emits IssueSLA events. The lock agent does not act on them, but
 * the type is retained so webhook parsing/routing stays generic.
 */
export interface IssueSLAWebhookPayload extends BaseWebhookPayload {
  type: 'IssueSLA';
  action: 'set' | 'highRisk' | 'breached';
  issueData: IssueData;
}

export type WebhookPayload = IssueWebhookPayload | IssueSLAWebhookPayload;

// ============================================================================
// Linear issue / workflow state
// ============================================================================

/** A Linear workflow state (status). */
export interface WorkflowState {
  id: string;
  name: string;
  /** "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage" */
  type: string;
  color?: string;
  /**
   * Owning team key (e.g. "ENG"). Workflow states are per-team in Linear, so the
   * same status name exists once per team. Populated when fetched at startup;
   * not present on state objects parsed from webhooks.
   */
  teamKey?: string;
}

export interface IssueData {
  id: string;
  title: string;
  identifier?: string;
  description?: string | null;
  priority?: number;
  estimate?: number | null;
  dueDate?: string | null;
  /** Full workflow-state object — present on the `data` of Issue webhooks. */
  state?: WorkflowState | null;
  /** Workflow-state id — present in `updatedFrom` when the status changed. */
  stateId?: string | null;
  assigneeId?: string | null;
  assignee?: { id: string; name?: string; email?: string } | null;
  labels?: IssueLabel[];
  labelIds?: string[];
  teamId?: string | null;
  team?: { id: string } | null;
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
// Enforcement
// ============================================================================

/** A single detected field change and how to describe / revert it. */
export interface ChangeDetection {
  field: MonitoredField;
  oldValue: any;
  newValue: any;
  /** Human-readable description of what changed (shown in comments / Slack). */
  description: string;
  /** Human-readable description of the revert. */
  revertDescription: string;
}

export interface EnforcementResult {
  /** True when the agent reverted one or more changes. */
  enforced: boolean;
  reason: string;
  changes?: ChangeDetection[];
  /** True when this webhook was the issue entering a locked status. */
  lockApplied?: boolean;
  dryRun?: boolean;
}

// ============================================================================
// Audit log
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  webhookId: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle: string;
  /** The locked status that was in effect when the action was evaluated. */
  lockedStatus?: string;
  actor: {
    id: string;
    email?: string;
    name: string;
    type: string;
  };
  action: 'allowed' | 'reverted' | 'detected' | 'locked';
  reason: string;
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
// Linear SDK response shapes
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

export interface LinearTeam {
  id: string;
  key: string;
  parent?: { id: string } | null;
}
