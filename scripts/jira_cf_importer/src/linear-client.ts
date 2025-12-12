import { LinearClient as LinearSDK, Issue, IssueLabel, Team, WorkflowState } from '@linear/sdk';
import { LinearConfig, LinearIssueWithJira } from './types.js';

export class LinearClient {
  private client: LinearSDK;
  private config: LinearConfig;
  private labelCache: Map<string, IssueLabel> = new Map();
  private labelGroupCache: Map<string, { id: string; name: string }> = new Map();
  private resolvedTeamIds: string[] | undefined;
  private apiCallCount: number = 0;

  constructor(apiKey: string, config: LinearConfig) {
    this.client = new LinearSDK({ apiKey });
    this.config = config;
  }

  /**
   * Get the total number of API calls made in this session
   */
  getApiCallCount(): number {
    return this.apiCallCount;
  }

  /**
   * Track an API call (for monitoring)
   */
  private trackApiCall(): void {
    this.apiCallCount++;
  }

  /**
   * Resolve team keys or IDs to team UUIDs
   * Accepts both team keys (e.g., "BK") and team UUIDs
   */
  private async resolveTeamIds(teamIdentifiers: string[]): Promise<string[]> {
    const resolvedIds: string[] = [];
    
    // Check if identifiers are already UUIDs (contain hyphens)
    const needsResolution = teamIdentifiers.some(id => !id.includes('-'));
    
    if (!needsResolution) {
      // All identifiers look like UUIDs
      return teamIdentifiers;
    }
    
    // Fetch all teams to resolve keys to IDs
    this.trackApiCall();
    const teamsConnection = await this.client.teams();
    const teams = await teamsConnection.nodes;
    const teamMap = new Map<string, string>(); // key/id -> UUID
    
    for (const team of teams) {
      teamMap.set(team.key, team.id);
      teamMap.set(team.id, team.id);
    }
    
    // Resolve each identifier
    for (const identifier of teamIdentifiers) {
      const resolvedId = teamMap.get(identifier);
      if (!resolvedId) {
        throw new Error(`Team "${identifier}" not found. Available teams: ${Array.from(teamMap.keys()).join(', ')}`);
      }
      resolvedIds.push(resolvedId);
    }
    
    return resolvedIds;
  }

  /**
   * Find Linear issues that have Jira ticket links in their attachments
   * Uses Linear's native filters for teams and date ranges
   */
  async findIssuesWithJiraLinks(): Promise<LinearIssueWithJira[]> {
    console.log('Searching for Linear issues with Jira attachments...');
    
    // Build filter object based on configuration
    const filter: any = {};
    
    // Filter by team(s) - resolve team keys to UUIDs first
    if (this.config.teamIds && this.config.teamIds.length > 0) {
      // Resolve team keys/IDs to UUIDs (cached)
      if (!this.resolvedTeamIds) {
        this.resolvedTeamIds = await this.resolveTeamIds(this.config.teamIds);
        console.log(`Resolved team identifiers: ${this.config.teamIds.join(', ')} -> ${this.resolvedTeamIds.join(', ')}`);
      }
      
      if (this.resolvedTeamIds.length === 1) {
        filter.team = { id: { eq: this.resolvedTeamIds[0] } };
      } else {
        filter.team = { id: { in: this.resolvedTeamIds } };
      }
    }
    
    // Filter by date range
    if (this.config.startDate) {
      filter.updatedAt = { gte: new Date(this.config.startDate) };
    }
    if (this.config.endDate) {
      if (filter.updatedAt) {
        filter.updatedAt.lte = new Date(this.config.endDate);
      } else {
        filter.updatedAt = { lte: new Date(this.config.endDate) };
      }
    }

    console.log('Filter:', JSON.stringify(filter, null, 2));
    
    const issuesWithJira: LinearIssueWithJira[] = [];
    let checkedCount = 0;
    let hasMore = true;
    let cursor: string | undefined;

    // Paginate through all issues
    // Note: Fetching attachments in parallel per batch to minimize total time
    while (hasMore) {
      this.trackApiCall();
      const issuesConnection = await this.client.issues({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        first: 50,
        after: cursor,
        includeArchived: false,
      });

      const issues = await issuesConnection.nodes;
      const pageInfo = await issuesConnection.pageInfo;
      
      // Process issues in parallel for better performance
      const issuePromises = issues.map(async (issue) => {
        checkedCount++;
        if (checkedCount % 50 === 0) {
          console.log(`Checked ${checkedCount} Linear issues...`);
        }

        // Fetch attachments for this issue (1 API call per issue, but done in parallel)
        this.trackApiCall();
        const attachmentsConnection = await issue.attachments();
        const attachments = await attachmentsConnection.nodes;
        const jiraUrls: string[] = [];
        const jiraKeys: string[] = [];
        
        for (const attachment of attachments) {
          if (attachment.url) {
            // Check if the attachment URL looks like a Jira URL
            if (this.isJiraUrl(attachment.url)) {
              jiraUrls.push(attachment.url);
              
              // Extract Jira key from URL
              const jiraKey = this.extractJiraKey(attachment.url);
              if (jiraKey) {
                jiraKeys.push(jiraKey);
              }
            }
          }
        }
        
        // If this issue has Jira links, return it
        if (jiraUrls.length > 0) {
          return {
            linearIssueId: issue.id,
            linearIssueIdentifier: issue.identifier,
            jiraKeys,
            jiraUrls,
          };
        }
        return null;
      });

      // Wait for all issues in this batch to be processed
      const batchResults = await Promise.all(issuePromises);
      
      // Add non-null results
      for (const result of batchResults) {
        if (result) {
          issuesWithJira.push(result);
        }
      }

      hasMore = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    }

    return issuesWithJira;
  }

  /**
   * Check if a URL is a Jira URL
   */
  private isJiraUrl(url: string): boolean {
    return url.includes('.atlassian.net/browse/') || 
           url.includes('/browse/') ||
           url.includes('jira');
  }

  /**
   * Extract Jira issue key from URL
   * Examples:
   *   https://company.atlassian.net/browse/PROJ-123 -> PROJ-123
   *   https://jira.company.com/browse/ISSUE-456 -> ISSUE-456
   */
  private extractJiraKey(url: string): string | null {
    const match = url.match(/\/browse\/([A-Z]+-\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * Get or create a label group
   */
  async getOrCreateLabelGroup(groupName: string): Promise<string> {
    // Check cache first
    if (this.labelGroupCache.has(groupName)) {
      return this.labelGroupCache.get(groupName)!.id;
    }

    // Fetch existing label groups (cached for session)
    this.trackApiCall();
    const organization = await this.client.organization;
    const issueLabelConnection = await organization.labels();
    const labels = await issueLabelConnection.nodes;
    
    for (const label of labels) {
      if (label.isGroup && label.name === groupName) {
        this.labelGroupCache.set(groupName, { id: label.id, name: label.name });
        return label.id;
      }
    }

    // Create new label group if it doesn't exist
    if (this.config.createMissingLabels) {
      console.log(`Creating label group: ${groupName}`);
      
      const payload: any = {
        name: groupName,
        isGroup: true,
      };

      // If team-level labels, add team ID (use first resolved team)
      if (this.config.labelScope === 'team' && this.resolvedTeamIds && this.resolvedTeamIds.length > 0) {
        payload.teamId = this.resolvedTeamIds[0];
      }

      this.trackApiCall();
      const result = await this.client.createIssueLabel(payload);
      const createdLabel = await result.issueLabel;
      
      if (createdLabel) {
        this.labelGroupCache.set(groupName, { id: createdLabel.id, name: createdLabel.name });
        return createdLabel.id;
      }
    }

    throw new Error(`Label group "${groupName}" not found and createMissingLabels is false`);
  }

  /**
   * Get or create a label under a specific group
   */
  async getOrCreateLabel(labelName: string, groupId: string): Promise<string> {
    const cacheKey = `${groupId}:${labelName}`;
    
    // Check cache first
    if (this.labelCache.has(cacheKey)) {
      return this.labelCache.get(cacheKey)!.id;
    }

    // Fetch existing labels
    const organization = await this.client.organization;
    const issueLabelConnection = await organization.labels();
    const labels = await issueLabelConnection.nodes;
    
    for (const label of labels) {
      const parent = label.parent ? await label.parent : null;
      if (!label.isGroup && label.name === labelName && parent?.id === groupId) {
        this.labelCache.set(cacheKey, label);
        return label.id;
      }
    }

    // Create new label if it doesn't exist
    if (this.config.createMissingLabels) {
      console.log(`Creating label: ${labelName} under group ${groupId}`);
      
      const payload: any = {
        name: labelName,
        parentId: groupId,
      };

      // If team-level labels, add team ID (use first resolved team)
      if (this.config.labelScope === 'team' && this.resolvedTeamIds && this.resolvedTeamIds.length > 0) {
        payload.teamId = this.resolvedTeamIds[0];
      }

      this.trackApiCall();
      const result = await this.client.createIssueLabel(payload);
      const createdLabel = await result.issueLabel;
      
      if (createdLabel) {
        this.labelCache.set(cacheKey, createdLabel);
        return createdLabel.id;
      }
    }

    throw new Error(`Label "${labelName}" not found and createMissingLabels is false`);
  }

  /**
   * Add a label to a Linear issue
   */
  async addLabelToIssue(issueId: string, labelId: string): Promise<void> {
    const issue = await this.client.issue(issueId);
    
    // Get existing labels
    const existingLabelsConnection = await issue.labels();
    const existingLabels = await existingLabelsConnection.nodes;
    const existingLabelIds = new Set<string>();
    
    for (const label of existingLabels) {
      existingLabelIds.add(label.id);
    }

    // Only add if not already present
    if (!existingLabelIds.has(labelId)) {
      const labelIds = Array.from(existingLabelIds);
      labelIds.push(labelId);
      
      this.trackApiCall();
      await this.client.updateIssue(issueId, {
        labelIds,
      });
    }
  }

  /**
   * Append text to a Linear issue's description
   */
  async appendToDescription(issueId: string, fieldName: string, fieldValue: string, jiraKey?: string): Promise<void> {
    const issue = await this.client.issue(issueId);
    const currentDescription = issue.description || '';
    
    // Use generic marker to avoid Linear interpreting issue keys as Linear issues
    const marker = `**${fieldName}** (Imported from Jira)`;
    if (currentDescription.includes(marker)) {
      console.log(`      (Already in description, skipping)`);
      return;
    }
    
    // Add a separator if there's existing content
    const separator = currentDescription ? '\n\n---\n\n' : '';
    const newContent = `${marker}:\n${fieldValue}`;
    
    const updatedDescription = currentDescription + separator + newContent;
    
    this.trackApiCall();
    await this.client.updateIssue(issueId, {
      description: updatedDescription,
    });
  }

  /**
   * Get Linear issue by ID
   */
  async getIssue(issueId: string): Promise<Issue> {
    return await this.client.issue(issueId);
  }
}

