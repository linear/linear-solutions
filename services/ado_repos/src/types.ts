// ---------------------------------------------------------------------------
// Azure DevOps Service Hook webhook payloads
// ---------------------------------------------------------------------------

export type AdoEventType =
  | "git.pullrequest.created"
  | "git.pullrequest.updated"
  | "git.pullrequest.merged"
  | "ms.vss-code.git-pullrequest-comment-event";

export type AdoPrStatus = "active" | "completed" | "abandoned";

export type AdoMergeStatus =
  | "succeeded"
  | "conflicts"
  | "failure"
  | "rejectedByPolicy"
  | "notSet"
  | "queued";

export interface AdoReviewer {
  id: string;
  displayName: string;
  uniqueName: string;
  url: string;
  imageUrl: string;
  vote: number; // 10=approved, 5=approved w/ suggestions, 0=no vote, -5=wait for author, -10=rejected
  isContainer: boolean;
  isRequired?: boolean;
}

export interface AdoCommitRef {
  commitId: string;
  url: string;
}

export interface AdoRepository {
  id: string;
  name: string;
  url: string;
  project: {
    id: string;
    name: string;
    url: string;
    state: string;
  };
  defaultBranch: string;
  remoteUrl: string;
}

export interface AdoPullRequestResource {
  repository: AdoRepository;
  pullRequestId: number;
  status: AdoPrStatus;
  createdBy: {
    id: string;
    displayName: string;
    uniqueName: string;
    url: string;
    imageUrl: string;
  };
  creationDate: string;
  closedDate?: string;
  title: string;
  description: string;
  sourceRefName: string; // e.g. "refs/heads/mytopic"
  targetRefName: string; // e.g. "refs/heads/main"
  mergeStatus: AdoMergeStatus;
  mergeId: string;
  isDraft?: boolean;
  lastMergeSourceCommit?: AdoCommitRef;
  lastMergeTargetCommit?: AdoCommitRef;
  lastMergeCommit?: AdoCommitRef;
  reviewers: AdoReviewer[];
  url: string;
  _links?: {
    web?: { href: string };
    statuses?: { href: string };
  };
}

export interface AdoCommentThread {
  id: number;
  publishedDate: string;
  lastUpdatedDate: string;
  comments: AdoComment[];
  status: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
  isDeleted: boolean;
}

export interface AdoComment {
  id: number;
  parentCommentId: number;
  author: {
    id: string;
    displayName: string;
    uniqueName: string;
    url: string;
    imageUrl: string;
  };
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  lastContentUpdatedDate: string;
  commentType: "text" | "codeChange" | "system" | "unknown";
  isDeleted: boolean;
}

/**
 * ADO Service Hook webhook payload.
 *
 * For PR events (created/updated/merged), `resource` IS the pull request.
 * For comment events, `resource` contains `pullRequest` (nested) and `comment`/`id` at top level.
 */
export interface AdoWebhookPayload {
  subscriptionId?: string;
  notificationId?: number;
  id: string;
  eventType: AdoEventType;
  publisherId: string;
  message: { text: string; html: string; markdown: string };
  detailedMessage: { text: string; html: string; markdown: string };
  resource: AdoPullRequestResource & {
    // For comment events, the resource IS the comment thread — `id` is the thread ID.
    // The PR is nested under `pullRequest` and the triggering comment under `comment`.
    id?: number;
    pullRequest?: AdoPullRequestResource;
    comment?: AdoComment;
  };
  resourceVersion: string;
  resourceContainers: {
    collection: { id: string; baseUrl?: string };
    account: { id: string; baseUrl?: string };
    project: { id: string; baseUrl?: string };
  };
  createdDate: string;
}

// ---------------------------------------------------------------------------
// Linear outbound webhook payloads
// ---------------------------------------------------------------------------

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove" | "restore";
  actor?: {
    id: string;
    name: string;
    type: string;
  };
  createdAt: string;
  data: {
    id: string;
    body?: string;
    issueId?: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      teamId: string;
    };
    parentId?: string;
    userId?: string;
    user?: {
      id: string;
      name: string;
    };
    botActor?: string;
    editedAt?: string;
  };
  updatedFrom?: Record<string, unknown>;
  url: string;
  type: string; // "Comment", "Issue", etc.
  organizationId: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type LinkKind = "closes" | "contributes" | "links";

export interface IssueMatch {
  identifier: string;
  linkKind: LinkKind;
}

export interface IssueMatchResult {
  closes: string[];
  contributes: string[];
  ignores: string[];
}

export interface AdoPrInfo {
  org: string;
  project: string;
  repositoryId: string;
  pullRequestId: number;
  prUrl: string;
  title: string;
}

/** Stable store key for a PR — immune to URL encoding differences across webhook types. */
export function prStoreKey(prInfo: { repositoryId: string; pullRequestId: number }): string {
  return `${prInfo.repositoryId}:${prInfo.pullRequestId}`;
}

export interface LinkedIssue {
  identifier: string;
  id: string;
  title: string;
  url: string;
  teamId: string;
  linkKind: LinkKind;
}

export interface AttachmentMetadata {
  status: string;
  pullRequestId: number;
  branch: string;
  targetBranch: string;
  isDraft: boolean;
  mergeStatus: string;
  reviewers: Array<{
    id: string;
    displayName: string;
    vote: number;
  }>;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  linkKind: LinkKind;
}
