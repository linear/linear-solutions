/**
 * Linear GraphQL client — issue reads, workflow states, generic issue updates,
 * comments, users and team membership. Uses raw GraphQL for all operations.
 */

import { LinearViewer, LinearLabel, LinearUser, LinearTeam, IssueData, IssueLabel, WorkflowState } from './types';
import logger from './utils/logger';
import { withRetry } from './utils/error-handler';

/**
 * Fields the agent can write back when reverting a change on a locked issue.
 * Mirrors Linear's IssueUpdateInput for the subset of fields we monitor.
 */
export interface IssueUpdateInput {
  title?: string;
  description?: string | null;
  priority?: number;
  estimate?: number | null;
  dueDate?: string | null;
  stateId?: string | null;
  assigneeId?: string | null;
  labelIds?: string[];
}

export class LinearClient {
  private authHeader: string;

  constructor(apiKey: string) {
    // Personal API keys start with "lin_api_" and are passed as-is.
    // OAuth access tokens require the "Bearer " prefix.
    // If the caller already included "Bearer ", don't double-add it.
    if (apiKey.startsWith('lin_api_') || apiKey.startsWith('Bearer ')) {
      this.authHeader = apiKey;
    } else {
      this.authHeader = `Bearer ${apiKey}`;
    }
  }

  /**
   * Execute raw GraphQL query/mutation
   */
  private async graphql(query: string, variables?: Record<string, any>): Promise<any> {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result: any = await response.json();

    if (result.errors) {
      logger.error('GraphQL errors', { errors: result.errors });
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  }

  /**
   * Get the current viewer (authenticated user / agent)
   */
  async getViewer(): Promise<LinearViewer> {
    return withRetry(
      async () => {
        const query = `
          query {
            viewer { id email name }
          }
        `;
        const data = await this.graphql(query);
        return { id: data.viewer.id, email: data.viewer.email, name: data.viewer.name };
      },
      { operation: 'Get viewer' }
    );
  }

  /**
   * Get an issue by ID with the fields the lock agent monitors.
   */
  async getIssue(issueId: string): Promise<IssueData> {
    return withRetry(
      async () => {
        const query = `
          query($issueId: String!) {
            issue(id: $issueId) {
              id
              title
              identifier
              description
              priority
              estimate
              dueDate
              createdAt
              updatedAt
              state { id name type color }
              assignee { id name email }
              team { id }
              labels { nodes { id name parent { id name } } }
            }
          }
        `;

        const data = await this.graphql(query, { issueId });
        const issue = data.issue;

        const labels: IssueLabel[] = issue.labels?.nodes?.map((l: any) => ({
          id: l.id,
          name: l.name,
          parent: l.parent ? { id: l.parent.id, name: l.parent.name } : undefined
        })) || [];

        return {
          id: issue.id,
          title: issue.title,
          identifier: issue.identifier,
          description: issue.description ?? null,
          priority: issue.priority,
          estimate: issue.estimate ?? null,
          dueDate: issue.dueDate ?? null,
          state: issue.state ? {
            id: issue.state.id,
            name: issue.state.name,
            type: issue.state.type,
            color: issue.state.color
          } : null,
          stateId: issue.state?.id ?? null,
          assigneeId: issue.assignee?.id ?? null,
          assignee: issue.assignee ?? null,
          labels,
          labelIds: labels.map(l => l.id),
          teamId: issue.team?.id ?? null,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt
        };
      },
      { operation: `Get issue ${issueId}` }
    );
  }

  /**
   * Fetch all workflow states (statuses) in the workspace.
   * Used at startup to build a stateId → {name, type} map so the agent can tell
   * whether an issue's *previous* status (sent as a bare stateId in the webhook's
   * updatedFrom) was a locked one.
   */
  async getWorkflowStates(): Promise<WorkflowState[]> {
    return withRetry(
      async () => {
        const query = `
          query {
            workflowStates(first: 250) {
              nodes { id name type color team { key } }
            }
          }
        `;
        const data = await this.graphql(query);
        return (data.workflowStates?.nodes ?? []).map((s: any) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          color: s.color,
          teamKey: s.team?.key
        }));
      },
      { operation: 'Get workflow states' }
    );
  }

  /**
   * Apply a generic update to an issue. Only the provided fields are written.
   * Used to revert unauthorized changes back to their previous values.
   */
  async applyIssueUpdate(issueId: string, update: IssueUpdateInput): Promise<void> {
    return withRetry(
      async () => {
        const mutation = `
          mutation($issueId: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $issueId, input: $input) {
              success
            }
          }
        `;

        // Build a clean input containing only the keys explicitly provided.
        const input: Record<string, any> = {};
        for (const [key, value] of Object.entries(update)) {
          if (value !== undefined) input[key] = value;
        }

        logger.debug('Reverting issue fields', { issueId, input });

        const data = await this.graphql(mutation, { issueId, input });

        if (!data.issueUpdate?.success) {
          throw new Error('issueUpdate returned success: false');
        }

        logger.info('Issue fields reverted successfully', { issueId, fields: Object.keys(input) });
      },
      { operation: `Update issue ${issueId}` }
    );
  }

  /**
   * Create a comment on an issue
   */
  async createComment(issueId: string, body: string): Promise<void> {
    return withRetry(
      async () => {
        const mutation = `
          mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment { id }
            }
          }
        `;
        const data = await this.graphql(mutation, { issueId, body });
        if (!data.commentCreate.success) {
          throw new Error('Failed to create comment');
        }
        logger.info('Comment created successfully', { issueId });
      },
      { operation: `Create comment on issue ${issueId}` }
    );
  }

  /**
   * Find a label by ID (used to render label-change descriptions)
   */
  async findLabelById(labelId: string): Promise<LinearLabel | null> {
    try {
      const query = `
        query($id: String!) {
          issueLabel(id: $id) { id name parent { id name } }
        }
      `;
      const data = await this.graphql(query, { id: labelId });
      if (!data.issueLabel) return null;
      return {
        id: data.issueLabel.id,
        name: data.issueLabel.name,
        parent: data.issueLabel.parent
          ? { id: data.issueLabel.parent.id, name: data.issueLabel.parent.name }
          : undefined
      };
    } catch (error) {
      logger.error('Failed to find label by ID', { labelId, error: (error as Error).message });
      return null;
    }
  }

  /**
   * Get all users (for allowlist validation)
   */
  async getUsers(): Promise<LinearUser[]> {
    return withRetry(
      async () => {
        const query = `
          query {
            users { nodes { id email name } }
          }
        `;
        const data = await this.graphql(query);
        return data.users.nodes.map((u: any) => ({ id: u.id, email: u.email, name: u.name }));
      },
      { operation: 'Get users' }
    );
  }

  /**
   * Find a user by email
   */
  async findUserByEmail(email: string): Promise<LinearUser | null> {
    try {
      const users = await this.getUsers();
      return users.find(u => u.email === email) || null;
    } catch (error) {
      logger.error('Failed to find user by email', { email, error: (error as Error).message });
      return null;
    }
  }

  /**
   * Get all members of a Linear team.
   *
   * Accepts either a UUID or a team key ("REL", "ENG"). UUIDs use the team(id:)
   * query; keys use teams(filter:{key:{eq:}}). This lets config.json use the
   * short key shown in the Linear UI rather than the internal UUID.
   */
  async getTeamMembers(teamId: string): Promise<LinearUser[]> {
    return withRetry(
      async () => {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId);

        if (isUuid) {
          const query = `
            query($teamId: String!) {
              team(id: $teamId) {
                name
                members { nodes { id email name } }
              }
            }
          `;
          const data = await this.graphql(query, { teamId });
          if (!data.team) {
            logger.warn('Team not found by UUID', { teamId });
            return [];
          }
          logger.info('Fetched team members by UUID', {
            teamId, teamName: data.team.name, memberCount: data.team.members.nodes.length
          });
          return data.team.members.nodes.map((u: any) => ({ id: u.id, email: u.email, name: u.name }));
        }

        // Team key lookup (e.g. "REL", "ENG")
        const query = `
          query($key: String!) {
            teams(filter: { key: { eq: $key } }) {
              nodes { id name members { nodes { id email name } } }
            }
          }
        `;
        const data = await this.graphql(query, { key: teamId });
        const team = data.teams?.nodes?.[0];
        if (!team) {
          logger.warn('Team not found by key', { teamKey: teamId });
          return [];
        }
        logger.info('Fetched team members by key', {
          teamKey: teamId, teamName: team.name, memberCount: team.members.nodes.length
        });
        return team.members.nodes.map((u: any) => ({ id: u.id, email: u.email, name: u.name }));
      },
      { operation: `Get team members for ${teamId}` }
    );
  }

  /**
   * Get all teams in the workspace (used to resolve allowlist team keys).
   */
  async getAllTeams(): Promise<LinearTeam[]> {
    return withRetry(
      async () => {
        const query = `
          query {
            teams { nodes { id key parent { id } } }
          }
        `;
        const data = await this.graphql(query);
        return (data.teams?.nodes ?? []).map((t: any) => ({
          id: t.id,
          key: t.key,
          parent: t.parent ? { id: t.parent.id } : null
        }));
      },
      { operation: 'Get all teams' }
    );
  }
}
