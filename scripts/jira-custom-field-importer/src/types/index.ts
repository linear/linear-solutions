export interface CustomFieldConfig {
  jiraFieldName: string;      // Jira field key (e.g. "customfield_10014") or display name (e.g. "Acceptance Criteria")
  descriptionLabel: string;   // Heading used when appending to the Linear issue description
}

export interface Config {
  linear: {
    apiKey: string;
    teamId?: string;
    fetchAttachments?: boolean;
    attachmentTimeout?: number;
  };
  jira: {
    host: string;
    email: string;
    apiToken: string;
    projectKey?: string;
  };
  matching: {
    strategy: 'identifier' | 'attachment-url' | 'hybrid';
  };
  customFields: CustomFieldConfig[];
  dryRun: boolean;
  rateLimiting?: RateLimitConfig;
}

export interface RateLimitConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  delayBetweenRequestsMs?: number;
  backoffMultiplier?: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  attachments?: string[];
  team: {
    id: string;
    name: string;
  };
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  url: string;
  customFields: Record<string, string>; // descriptionLabel → extracted text value
}

export interface MatchResult {
  linearIssue: LinearIssue;
  jiraIssue: JiraIssue | null;
  reason?: string;
}

export interface SyncResult {
  totalLinearIssues: number;
  matchedIssues: number;
  updatedIssues: number;
  skippedIssues: number;
  errors: Array<{
    issueId: string;
    error: string;
  }>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
