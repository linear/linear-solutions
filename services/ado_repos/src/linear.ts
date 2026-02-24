import { LinearClient } from "@linear/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { AttachmentMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// OAuth client credentials token management
// ---------------------------------------------------------------------------

let cachedAccessToken: string | undefined;

async function fetchOAuthToken(): Promise<string> {
  const { oauthClientId, oauthClientSecret } = config.linear;
  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("Linear OAuth credentials not configured");
  }

  log.info("linear.oauth.fetching_token");

  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      scope: "read,write,comments:create,issues:create",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear OAuth token request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;

  log.info("linear.oauth.token_acquired", { expiresIn: data.expires_in });
  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;
  return fetchOAuthToken();
}

/**
 * Invalidate the cached token so the next call fetches a fresh one.
 * Called on 401 errors to handle token expiry.
 */
function invalidateToken() {
  cachedAccessToken = undefined;
}

// ---------------------------------------------------------------------------
// Linear client initialization
// ---------------------------------------------------------------------------

let client: LinearClient | undefined;

async function initClient(): Promise<LinearClient> {
  if (config.linear.authMode === "oauth") {
    const accessToken = await getAccessToken();
    client = new LinearClient({ accessToken });
  } else {
    client = new LinearClient({ apiKey: config.linear.apiKey! });
  }
  return client;
}

export async function getLinearClient(): Promise<LinearClient> {
  if (client) return client;
  return initClient();
}

/**
 * Wrap a Linear SDK call with auto-retry on 401 for OAuth token expiry.
 */
async function withRetry<T>(fn: (linear: LinearClient) => Promise<T>): Promise<T> {
  const linear = await getLinearClient();
  try {
    return await fn(linear);
  } catch (err) {
    if (
      config.linear.authMode === "oauth" &&
      err instanceof Error &&
      (err.message.includes("401") || err.message.includes("Authentication required"))
    ) {
      log.info("linear.oauth.token_expired_retrying");
      invalidateToken();
      client = undefined;
      const freshClient = await initClient();
      return fn(freshClient);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find a Linear issue by its identifier string (e.g. "ENG-123").
 */
export async function findIssueByIdentifier(identifier: string) {
  return withRetry(async (linear) => {
    const result = await linear.searchIssues(identifier, { includeArchived: false });
    return result.nodes.find((issue) => issue.identifier === identifier) ?? null;
  });
}

/**
 * Get all workflow states for a team.
 */
export async function getTeamWorkflowStates(teamId: string) {
  return withRetry(async (linear) => {
    const team = await linear.team(teamId);
    const states = await team.states();
    return states.nodes;
  });
}

/**
 * Find a workflow state by name within a team.
 */
export async function findStateByName(teamId: string, stateName: string) {
  const states = await getTeamWorkflowStates(teamId);
  return states.find((s) => s.name === stateName) ?? null;
}

/**
 * Transition an issue to a new workflow state.
 */
export async function transitionIssue(issueId: string, stateId: string) {
  return withRetry(async (linear) => {
    const result = await linear.updateIssue(issueId, { stateId });
    return result.success;
  });
}

/**
 * Auto-assign PR author to an issue if it has no assignee.
 * If it already has an assignee, subscribe the user instead.
 */
export async function autoAssignIssue(
  issueId: string,
  authorEmail: string
): Promise<boolean> {
  return withRetry(async (linear) => {
    const issue = await linear.issue(issueId);
    const assignee = await issue.assignee;

    const users = await linear.users();
    const user = users.nodes.find((u) => u.email === authorEmail);
    if (!user) {
      log.info("auto_assign.user_not_found", { issueId, authorEmail });
      return false;
    }

    if (!assignee) {
      await linear.updateIssue(issueId, { assigneeId: user.id });
      log.info("auto_assign.assigned", { issueId, userId: user.id });
      return true;
    }

    const subscribers = await issue.subscribers();
    const subscriberIds = subscribers.nodes.map((s) => s.id);
    if (!subscriberIds.includes(user.id)) {
      await linear.updateIssue(issueId, { subscriberIds: [...subscriberIds, user.id] });
      log.info("auto_assign.subscribed", { issueId, userId: user.id });
    }
    return false;
  });
}

/**
 * Create or update a PR attachment on an issue.
 */
export async function createOrUpdateAttachment(
  issueId: string,
  prUrl: string,
  title: string,
  metadata: AttachmentMetadata
): Promise<string> {
  return withRetry(async (linear) => {
    const issue = await linear.issue(issueId);
    const attachments = await issue.attachments();
    const existing = attachments.nodes.find((a) => a.url === prUrl);

    if (existing) {
      const existingMeta = existing.metadata as AttachmentMetadata | undefined;

      if (
        existingMeta &&
        (existingMeta.status === "completed" || existingMeta.status === "abandoned") &&
        metadata.status === "active"
      ) {
        log.warn("attachment.skip_regression", {
          issueId,
          prUrl,
          existingStatus: existingMeta.status,
          incomingStatus: metadata.status,
        });
        return existing.id;
      }

      const updateTitle =
        existing.title.startsWith(`PR #${metadata.pullRequestId}:`)
          ? title
          : existing.title;

      await linear.updateAttachment(existing.id, {
        title: updateTitle,
        metadata: metadata as unknown as Record<string, unknown>,
      });
      log.info("attachment.updated", { issueId, attachmentId: existing.id, prUrl });
      return existing.id;
    }

    try {
      const result = await linear.createAttachment({
        issueId,
        url: prUrl,
        title,
        metadata: metadata as unknown as Record<string, unknown>,
        iconUrl: "https://cdn.vsassets.io/content/icons/favicon.ico",
      });
      const attachment = await result.attachment;
      const attachmentId = attachment?.id ?? "unknown";
      log.info("attachment.created", { issueId, attachmentId, prUrl });
      return attachmentId;
    } catch (err) {
      if (err instanceof Error && err.message.includes("Duplicate url")) {
        log.info("attachment.duplicate_race", { issueId, prUrl });
        const refreshedIssue = await linear.issue(issueId);
        const refreshedAttachments = await refreshedIssue.attachments();
        const raceWinner = refreshedAttachments.nodes.find((a) => a.url === prUrl);
        if (raceWinner) {
          await linear.updateAttachment(raceWinner.id, {
            title,
            metadata: metadata as unknown as Record<string, unknown>,
          });
          return raceWinner.id;
        }
      }
      throw err;
    }
  });
}

/**
 * Create a comment on a Linear issue, optionally as a reply to a parent comment.
 */
export async function createComment(
  issueId: string,
  body: string,
  parentId?: string
): Promise<string> {
  return withRetry(async (linear) => {
    const input: { issueId: string; body: string; parentId?: string } = { issueId, body };
    if (parentId) {
      input.parentId = parentId;
    }
    const result = await linear.createComment(input);
    const comment = await result.comment;
    return comment?.id ?? "unknown";
  });
}

/**
 * Update an existing Linear comment.
 */
export async function updateComment(commentId: string, body: string): Promise<boolean> {
  return withRetry(async (linear) => {
    const result = await linear.updateComment(commentId, { body });
    return result.success;
  });
}
