import { LinearClient, Issue } from "@linear/sdk";
import type { Config } from "../types.js";

/**
 * Linear API client wrapper with helper methods for issue duplication
 */
export class LinearClientWrapper {
  private client: LinearClient;

  constructor(accessToken: string) {
    this.client = new LinearClient({ apiKey: accessToken });
  }

  /**
   * Get an issue by ID
   */
  async getIssue(issueId: string): Promise<Issue | null> {
    try {
      return await this.client.issue(issueId);
    } catch (error) {
      console.error(`Failed to fetch issue ${issueId}:`, error);
      return null;
    }
  }

  /**
   * Check if an issue has any children (sub-issues)
   */
  async hasChildren(issueId: string): Promise<boolean> {
    try {
      const issue = await this.client.issue(issueId);
      const children = await issue.children();
      return children.nodes.length > 0;
    } catch (error) {
      console.error(`Failed to check children for issue ${issueId}:`, error);
      // Default to true to prevent accidental duplication
      return true;
    }
  }

  /**
   * Get the description of an issue
   */
  async getIssueDescription(issueId: string): Promise<string | undefined> {
    try {
      const issue = await this.client.issue(issueId);
      return issue.description ?? undefined;
    } catch (error) {
      console.error(`Failed to fetch description for issue ${issueId}:`, error);
      return undefined;
    }
  }

  /**
   * Create a sub-issue linked to a parent issue
   */
  async createSubIssue(params: {
    title: string;
    description?: string;
    teamId: string;
    parentId: string;
    labelIds?: string[];
    priority?: number;
  }): Promise<Issue | null> {
    try {
      const result = await this.client.createIssue({
        title: params.title,
        description: params.description,
        teamId: params.teamId,
        parentId: params.parentId,
        labelIds: params.labelIds,
        priority: params.priority,
      });

      if (!result.success) {
        console.error("Failed to create sub-issue: operation unsuccessful");
        return null;
      }

      const issue = await result.issue;
      return issue ?? null;
    } catch (error) {
      console.error("Failed to create sub-issue:", error);
      return null;
    }
  }

  /**
   * Find a label by name in the workspace
   */
  async findLabelByName(labelName: string): Promise<{ id: string; name: string } | null> {
    try {
      const labels = await this.client.issueLabels({
        filter: {
          name: { eq: labelName },
        },
        first: 1,
      });

      const label = labels.nodes[0];
      if (!label) {
        return null;
      }

      return { id: label.id, name: label.name };
    } catch (error) {
      console.error(`Failed to find label "${labelName}":`, error);
      return null;
    }
  }

  /**
   * Get the raw Linear client for advanced operations
   */
  getRawClient(): LinearClient {
    return this.client;
  }
}

/**
 * Singleton client instance
 */
let clientInstance: LinearClientWrapper | null = null;

/**
 * Get or create the Linear client
 */
export function getLinearClient(config: Config): LinearClientWrapper {
  if (!clientInstance) {
    clientInstance = new LinearClientWrapper(config.linearAccessToken);
  }
  return clientInstance;
}

/**
 * Create a new Linear client (for testing or multi-tenant scenarios)
 */
export function createLinearClient(accessToken: string): LinearClientWrapper {
  return new LinearClientWrapper(accessToken);
}
