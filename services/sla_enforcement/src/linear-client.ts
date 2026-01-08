/**
 * Linear GraphQL client - uses raw GraphQL for all operations
 */

import { LinearViewer, LinearLabel, LinearUser, IssueData, IssueLabel } from './types';
import logger from './utils/logger';
import { withRetry } from './utils/error-handler';

export class LinearClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Execute raw GraphQL query/mutation
   */
  private async graphql(query: string, variables?: Record<string, any>): Promise<any> {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.apiKey,
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
   * Get the current viewer (authenticated user)
   */
  async getViewer(): Promise<LinearViewer> {
    return withRetry(
      async () => {
        const query = `
          query {
            viewer {
              id
              email
              name
            }
          }
        `;
        
        const data = await this.graphql(query);
        return {
          id: data.viewer.id,
          email: data.viewer.email,
          name: data.viewer.name
        };
      },
      { operation: 'Get viewer' }
    );
  }

  /**
   * Get an issue by ID with full details including SLA fields and priority
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
              priority
              slaType
              slaStartedAt
              slaMediumRiskAt
              slaHighRiskAt
              slaBreachesAt
              createdAt
              updatedAt
              labels {
                nodes {
                  id
                  name
                  parent {
                    id
                    name
                  }
                }
              }
            }
          }
        `;
        
        const data = await this.graphql(query, { issueId });
        const issue = data.issue;
        
        const labelData: IssueLabel[] = issue.labels?.nodes?.map((l: any) => ({
          id: l.id,
          name: l.name,
          parent: l.parent ? { id: l.parent.id, name: l.parent.name } : undefined
        })) || [];
        
        return {
          id: issue.id,
          title: issue.title,
          identifier: issue.identifier,
          labels: labelData,
          priority: issue.priority,
          slaType: issue.slaType || null,
          slaStartedAt: issue.slaStartedAt || null,
          slaMediumRiskAt: issue.slaMediumRiskAt || null,
          slaHighRiskAt: issue.slaHighRiskAt || null,
          slaBreachesAt: issue.slaBreachesAt || null,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt
        };
      },
      { operation: `Get issue ${issueId}` }
    );
  }

  /**
   * Get issue history (placeholder - Linear doesn't expose full history via API)
   */
  async getIssueHistory(issueId: string): Promise<any[]> {
    logger.debug('Issue history not fully supported by Linear API', { issueId });
    return [];
  }

  /**
   * Find a label by ID
   */
  async findLabelById(labelId: string): Promise<LinearLabel | null> {
    try {
      const query = `
        query($id: String!) {
          issueLabel(id: $id) {
            id
            name
            parent {
              id
              name
            }
          }
        }
      `;
      
      const data = await this.graphql(query, { id: labelId });
      
      if (!data.issueLabel) {
        return null;
      }
      
      return {
        id: data.issueLabel.id,
        name: data.issueLabel.name,
        parent: data.issueLabel.parent ? { id: data.issueLabel.parent.id, name: data.issueLabel.parent.name } : undefined
      };
    } catch (error) {
      logger.error('Failed to find label by ID', {
        labelId,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Find a label by name (searches both top-level and nested labels)
   */
  async findLabelByName(labelName: string): Promise<LinearLabel | null> {
    try {
      const query = `
        query {
          issueLabels {
            nodes {
              id
              name
              parent {
                id
                name
              }
            }
          }
        }
      `;
      
      const data = await this.graphql(query);
      
      for (const label of data.issueLabels.nodes) {
        if (label.name === labelName) {
          return {
            id: label.id,
            name: label.name,
            parent: label.parent ? { id: label.parent.id, name: label.parent.name } : undefined
          };
        }
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to find label', {
        labelName,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Update an issue using raw GraphQL
   * Properly handles slaType as enum for values like "all"
   */
  async updateIssue(issueId: string, update: {
    labelIds?: string[];
    priority?: number;
    slaType?: string | null;
    slaStartedAt?: Date | null;
    slaMediumRiskAt?: Date | null;
    slaHighRiskAt?: Date | null;
    slaBreachesAt?: Date | null;
  }): Promise<void> {
    return withRetry(
      async () => {
        // Build the input object for GraphQL
        const inputParts: string[] = [];
        
        if (update.labelIds !== undefined) {
          const labelIdsStr = JSON.stringify(update.labelIds);
          inputParts.push(`labelIds: ${labelIdsStr}`);
        }
        
        // Handle priority (0-4: No priority, Urgent, High, Normal, Low)
        if (update.priority !== undefined) {
          inputParts.push(`priority: ${update.priority}`);
        }
        
        if (update.slaType !== undefined) {
          // Handle slaType as enum (no quotes) for values like "all"
          // or as string for UUID values
          if (update.slaType === null) {
            inputParts.push(`slaType: null`);
          } else if (update.slaType === 'all' || update.slaType.match(/^[a-z]+$/i)) {
            // Simple string values like "all" are enum values (no quotes)
            inputParts.push(`slaType: ${update.slaType}`);
          } else {
            // UUID or complex values go as strings (with quotes)
            inputParts.push(`slaType: "${update.slaType}"`);
          }
        }
        
        if (update.slaStartedAt !== undefined) {
          if (update.slaStartedAt === null) {
            inputParts.push(`slaStartedAt: null`);
          } else {
            const dateStr = update.slaStartedAt instanceof Date 
              ? update.slaStartedAt.toISOString() 
              : update.slaStartedAt;
            inputParts.push(`slaStartedAt: "${dateStr}"`);
          }
        }
        
        if (update.slaBreachesAt !== undefined) {
          if (update.slaBreachesAt === null) {
            inputParts.push(`slaBreachesAt: null`);
          } else {
            const dateStr = update.slaBreachesAt instanceof Date 
              ? update.slaBreachesAt.toISOString() 
              : update.slaBreachesAt;
            inputParts.push(`slaBreachesAt: "${dateStr}"`);
          }
        }
        
        // NOTE: slaMediumRiskAt and slaHighRiskAt are truly read-only
        // Linear calculates them automatically and rejects them in updates (HTTP 400)
        // Only slaType, slaStartedAt, and slaBreachesAt are writable
        
        const inputStr = inputParts.join(', ');
        
        const mutation = `
          mutation {
            issueUpdate(
              id: "${issueId}"
              input: { ${inputStr} }
            ) {
              success
              issue {
                id
                priority
                slaType
                slaStartedAt
                slaBreachesAt
              }
            }
          }
        `;
        
        logger.debug('Executing GraphQL mutation', {
          issueId,
          mutation: mutation.replace(/\s+/g, ' ').trim(),
          updateInput: update
        });
        
        const data = await this.graphql(mutation);
        
        const success = data.issueUpdate.success;
        const updatedIssue = data.issueUpdate.issue;
        
        logger.info('Issue updated successfully', {
          issueId,
          success,
          sentValues: {
            priority: update.priority,
            slaType: update.slaType,
            slaStartedAt: update.slaStartedAt instanceof Date ? update.slaStartedAt.toISOString() : update.slaStartedAt,
            slaBreachesAt: update.slaBreachesAt instanceof Date ? update.slaBreachesAt.toISOString() : update.slaBreachesAt,
            labelIds: update.labelIds
          },
          verificationAfterUpdate: {
            priority: updatedIssue?.priority,
            slaType: updatedIssue?.slaType || null,
            slaStartedAt: updatedIssue?.slaStartedAt || null,
            slaMediumRiskAt: updatedIssue?.slaMediumRiskAt || null,
            slaHighRiskAt: updatedIssue?.slaHighRiskAt || null,
            slaBreachesAt: updatedIssue?.slaBreachesAt || null
          }
        });
        
        if (!success) {
          throw new Error('GraphQL mutation returned success: false');
        }
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
            commentCreate(input: {
              issueId: $issueId
              body: $body
            }) {
              success
              comment {
                id
              }
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
   * Get users (for allowlist validation)
   */
  async getUsers(): Promise<LinearUser[]> {
    return withRetry(
      async () => {
        const query = `
          query {
            users {
              nodes {
                id
                email
                name
              }
            }
          }
        `;
        
        const data = await this.graphql(query);
        
        return data.users.nodes.map((user: any) => ({
          id: user.id,
          email: user.email,
          name: user.name
        }));
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
      return users.find(user => user.email === email) || null;
    } catch (error) {
      logger.error('Failed to find user by email', {
        email,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Get all issue labels
   */
  async getIssueLabels(): Promise<LinearLabel[]> {
    return withRetry(
      async () => {
        const query = `
          query {
            issueLabels {
              nodes {
                id
                name
                parent {
                  id
                  name
                }
              }
            }
          }
        `;
        
        const data = await this.graphql(query);
        
        return data.issueLabels.nodes.map((label: any) => ({
          id: label.id,
          name: label.name,
          parent: label.parent ? { id: label.parent.id, name: label.parent.name } : undefined
        }));
      },
      { operation: 'Get issue labels' }
    );
  }

  /**
   * Check if a label exists (with hierarchy support)
   */
  async findLabelInHierarchy(labelName: string): Promise<boolean> {
    try {
      const labels = await this.getIssueLabels();
      return labels.some(label => label.name === labelName);
    } catch (error) {
      logger.error('Failed to search label hierarchy', {
        labelName,
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Get all issues with a specific label (for proactive caching)
   */
  async getIssuesWithLabel(labelId: string): Promise<IssueData[]> {
    return withRetry(
      async () => {
        const query = `
          query($labelId: ID!) {
            issues(filter: { labels: { id: { eq: $labelId } } }, first: 100) {
              nodes {
                id
                title
                identifier
                priority
                slaType
                slaStartedAt
                slaMediumRiskAt
                slaHighRiskAt
                slaBreachesAt
                labels {
                  nodes {
                    id
                    name
                  }
                }
              }
            }
          }
        `;
        
        const data = await this.graphql(query, { labelId });
        
        return data.issues.nodes.map((issue: any) => ({
          id: issue.id,
          title: issue.title,
          identifier: issue.identifier,
          priority: issue.priority,
          slaType: issue.slaType || null,
          slaStartedAt: issue.slaStartedAt || null,
          slaMediumRiskAt: issue.slaMediumRiskAt || null,
          slaHighRiskAt: issue.slaHighRiskAt || null,
          slaBreachesAt: issue.slaBreachesAt || null,
          labels: issue.labels?.nodes?.map((l: any) => ({
            id: l.id,
            name: l.name
          })) || []
        }));
      },
      { operation: `Get issues with label ${labelId}` }
    );
  }

  /**
   * Extract SLA fields from issue data
   */
  getSlaFields(issue: IssueData): {
    slaType?: string | null;
    slaStartedAt?: string | null;
    slaMediumRiskAt?: string | null;
    slaHighRiskAt?: string | null;
    slaBreachesAt?: string | null;
  } {
    return {
      slaType: issue.slaType,
      slaStartedAt: issue.slaStartedAt,
      slaMediumRiskAt: issue.slaMediumRiskAt,
      slaHighRiskAt: issue.slaHighRiskAt,
      slaBreachesAt: issue.slaBreachesAt
    };
  }
}
