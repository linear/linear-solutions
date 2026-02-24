import { config } from "./config.js";
import { log } from "./logger.js";
import type { AdoCommentThread } from "./types.js";

function getAuthHeader(): string {
  if (config.ado.authMode === "oauth") {
    return `Bearer ${config.ado.oauthToken}`;
  }
  return "Basic " + Buffer.from(`:${config.ado.pat}`).toString("base64");
}

function buildUrl(
  org: string,
  project: string,
  repositoryId: string,
  path: string,
  apiVersion = "7.1"
): string {
  const base = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repositoryId}`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}/${path}${separator}api-version=${apiVersion}`;
}

async function adoFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("ado.api_error", {
      url,
      status: response.status,
      statusText: response.statusText,
      body: text,
    });
    throw new Error(`ADO API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// PR comment thread operations
// ---------------------------------------------------------------------------

export async function getPullRequestThreads(
  org: string,
  project: string,
  repositoryId: string,
  pullRequestId: number
): Promise<AdoCommentThread[]> {
  const url = buildUrl(org, project, repositoryId, `pullRequests/${pullRequestId}/threads`);
  const result = await adoFetch<{ value: AdoCommentThread[] }>(url);
  return result.value;
}

export async function createCommentThread(
  org: string,
  project: string,
  repositoryId: string,
  pullRequestId: number,
  content: string
): Promise<AdoCommentThread> {
  const url = buildUrl(org, project, repositoryId, `pullRequests/${pullRequestId}/threads`);
  const thread = await adoFetch<AdoCommentThread>(url, {
    method: "POST",
    body: JSON.stringify({
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 1,
    }),
  });
  log.info("ado.thread_created", {
    pullRequestId,
    threadId: thread.id,
  });
  return thread;
}

export async function addCommentToThread(
  org: string,
  project: string,
  repositoryId: string,
  pullRequestId: number,
  threadId: number,
  content: string
): Promise<{ id: number }> {
  const url = buildUrl(
    org,
    project,
    repositoryId,
    `pullRequests/${pullRequestId}/threads/${threadId}/comments`
  );
  const comment = await adoFetch<{ id: number }>(url, {
    method: "POST",
    body: JSON.stringify({ parentCommentId: 0, content, commentType: 1 }),
  });
  return comment;
}

export async function updateComment(
  org: string,
  project: string,
  repositoryId: string,
  pullRequestId: number,
  threadId: number,
  commentId: number,
  content: string
): Promise<void> {
  const url = buildUrl(
    org,
    project,
    repositoryId,
    `pullRequests/${pullRequestId}/threads/${threadId}/comments/${commentId}`
  );
  await adoFetch<unknown>(url, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

// ---------------------------------------------------------------------------
// Linkback thread helpers
// ---------------------------------------------------------------------------

const LINKBACK_MARKER = "<!-- linear-linkback -->";

export function findLinkbackThread(
  threads: AdoCommentThread[]
): { thread: AdoCommentThread; commentId: number } | undefined {
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (comment.content?.includes(LINKBACK_MARKER)) {
        return { thread, commentId: comment.id };
      }
    }
  }
  return undefined;
}

export { LINKBACK_MARKER };
