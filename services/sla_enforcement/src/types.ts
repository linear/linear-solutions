/**
 * TypeScript type definitions for Linear Vulnerability Protection Agent
 */

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
  };
  allowlist: AllowlistUser[];
  agent: AgentConfig;
  slack: SlackConfig;
  behavior: BehaviorConfig;
  logging: LoggingConfig;
}

export interface AllowlistUser {
  email?: string;
  id?: string;
  name?: string;
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
  [key: string]: any; // Allow other fields
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
}

export interface EnforcementResult {
  enforced: boolean;
  reason: string;
  changes?: ChangeDetection[];
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
  action: 'allowed' | 'reverted' | 'detected';
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

