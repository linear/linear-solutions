export interface Config {
  linear: {
    apiKey: string;
    teamId?: string; // Optional: team key (e.g., "BK") or UUID - only sync issues from this team
    fetchAttachments?: boolean; // Optional: whether to fetch attachments (default: true)
    attachmentTimeout?: number; // Optional: timeout in ms for attachment fetching (default: 5000)
  };
  jira: {
    host: string;
    email: string;
    apiToken: string;
    projectKey?: string; // Optional: if specified, only search in this project
  };
  matching: {
    strategy: 'identifier' | 'attachment-url' | 'hybrid';
  };
  priorityMapping: PriorityMapping[];
  dryRun: boolean; // If true, don't actually update Linear issues
  rateLimiting?: RateLimitConfig; // Optional: rate limiting configuration
}

export interface RateLimitConfig {
  maxRetries?: number; // Maximum number of retries for rate-limited requests (default: 5)
  initialDelayMs?: number; // Initial delay in ms before first retry (default: 1000)
  maxDelayMs?: number; // Maximum delay in ms between retries (default: 60000)
  delayBetweenRequestsMs?: number; // Minimum delay between normal requests (default: 100)
  backoffMultiplier?: number; // Multiplier for exponential backoff (default: 2)
}

export interface PriorityMapping {
  jiraPriority: string;
  linearPriority: number; // Linear priority: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
}

export interface LinearIssue {
  id: string;
  identifier: string; // Linear's issue identifier like "ENG-123"
  title: string;
  description?: string;
  priority: number;
  priorityLabel: string;
  url: string;
  attachments?: string[]; // URLs of attachments, used for finding Jira links
  team: {
    id: string;
    name: string;
  };
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  priority: {
    name: string;
    id: string;
  };
  url: string;
}

export interface MatchResult {
  linearIssue: LinearIssue;
  jiraIssue: JiraIssue | null;
  matchScore?: number; // For fuzzy matching
  reason?: string; // Why match was successful or failed
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
