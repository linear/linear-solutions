/**
 * Application configuration loaded from environment variables
 */
export interface Config {
  linearClientId: string;
  linearClientSecret: string;
  linearWebhookSecret: string;
  linearAccessToken: string;
  port: number;
}

/**
 * Nested issue data included in Comment webhook payloads
 */
export interface IssueChildData {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  assigneeId?: string;
  stateId: string;
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
}

/**
 * Comment data from webhook payload
 */
export interface CommentData {
  id: string;
  body: string;
  issueId?: string;
  issue?: IssueChildData;
  parentId?: string;
  userId?: string;
  user?: {
    id: string;
    name: string;
  };
  externalUserId?: string;
  externalUser?: {
    id: string;
    name: string;
    email?: string;
  };
  botActor?: string;
  syncedWith?: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Linear webhook payload for Comment events
 */
export interface CommentWebhookPayload {
  action: "create" | "update" | "remove" | "restore";
  type: "Comment";
  createdAt: string;
  organizationId: string;
  webhookTimestamp: number;
  webhookId: string;
  data: CommentData;
  url?: string;
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
  data: CommentData | Record<string, unknown>;
  url?: string;
}

/**
 * Result of processing a comment webhook
 */
export interface ProcessResult {
  status: "reopened" | "ignored" | "error";
  reason?: string;
  issueId?: string;
  issueIdentifier?: string;
}
