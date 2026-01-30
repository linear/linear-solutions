/**
 * Configuration for a target platform/team
 */
export interface TargetTeam {
  /** Display name used as prefix for sub-issue titles (e.g., "iOS", "Android") */
  name: string;
  /** Linear team UUID */
  teamId: string;
}

/**
 * A duplication rule that defines when and how to duplicate issues
 */
export interface DuplicationRule {
  /** Human-readable name for this rule (for logging) */
  name: string;
  /** Label name that triggers this rule */
  triggerLabelName: string;
  /** Source team ID - only issues from this team will trigger this rule */
  sourceTeamId: string;
  /** Target teams where sub-issues will be created */
  targetTeams: TargetTeam[];
}

/**
 * Application configuration loaded from environment variables
 */
export interface Config {
  linearClientId: string;
  linearClientSecret: string;
  linearWebhookSecret: string;
  linearAccessToken: string;
  /** Duplication rules defining source/destination team mappings */
  duplicationRules: DuplicationRule[];
  port: number;
}

/**
 * Linear webhook payload for Issue events
 */
export interface IssueWebhookPayload {
  action: "create" | "update" | "remove";
  type: "Issue";
  createdAt: string;
  organizationId: string;
  webhookTimestamp: number;
  webhookId: string;
  data: IssueData;
  updatedFrom?: Partial<IssueData>;
  url: string;
}

/**
 * Issue data from webhook payload
 */
export interface IssueData {
  id: string;
  createdAt: string;
  updatedAt: string;
  number: number;
  title: string;
  description?: string;
  priority: number;
  boardOrder: number;
  sortOrder: number;
  teamId: string;
  projectId?: string;
  previousIdentifiers: string[];
  creatorId: string;
  assigneeId?: string;
  stateId: string;
  priorityLabel: string;
  parentId?: string;
  subscriberIds: string[];
  labelIds: string[];
  state: {
    id: string;
    name: string;
    type: string;
  };
  team: {
    id: string;
    key: string;
    name: string;
  };
  labels: Array<{
    id: string;
    name: string;
  }>;
  identifier: string;
}

/**
 * Generic webhook payload structure
 */
export interface WebhookPayload {
  action: string;
  type: string;
  createdAt: string;
  organizationId: string;
  webhookTimestamp: number;
  webhookId: string;
  data: IssueData | Record<string, unknown>;
  updatedFrom?: Partial<IssueData> | Record<string, unknown>;
  url?: string;
}
