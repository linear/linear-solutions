import { LinearClient } from '@linear/sdk';
import { LinearIssue, Logger, RateLimitConfig } from '../types';
import { RateLimiter } from '../utils/rate-limiter';

export class LinearApiClient {
  private client: LinearClient;
  private attachmentCache: Map<string, string[]> = new Map();
  private fetchAttachments: boolean = true;
  private attachmentTimeout: number = 5000;
  private rateLimiter: RateLimiter;

  constructor(
    private apiKey: string, 
    private logger: Logger, 
    private jiraHost?: string,
    options?: {
      fetchAttachments?: boolean;
      attachmentTimeout?: number;
      rateLimitConfig?: RateLimitConfig;
    }
  ) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('Linear API key is empty or undefined');
    }
    
    this.client = new LinearClient({
      apiKey: this.apiKey,
    });

    if (options) {
      this.fetchAttachments = options.fetchAttachments ?? true;
      this.attachmentTimeout = options.attachmentTimeout ?? 5000;
    }
    
    this.rateLimiter = new RateLimiter(logger, options?.rateLimitConfig);
  }

  async fetchAllIssues(teamId?: string): Promise<LinearIssue[]> {
    this.logger.info('Fetching Linear issues...');
    
    const issues: LinearIssue[] = [];
    const startTime = Date.now();
    
    try {
      let hasNextPage = true;
      let cursor: string | undefined;
      let pageCount = 0;
      
      // First pass: fetch all issues without attachments for speed
      // Using optimized GraphQL query to fetch team data inline (eliminates N+1 queries)
      this.logger.info('📥 Fetching issue list from Linear...');
      
      while (hasNextPage) {
        pageCount++;
        const pageStartTime = Date.now();
        
        // Use optimized GraphQL query with team data included inline
        const result = await this.rateLimiter.executeWithRetry(
          () => this.fetchIssuesWithTeamData(cursor, teamId),
          `Fetching Linear issues page ${pageCount}`
        );

        const pageTime = Date.now() - pageStartTime;
        this.logger.info(`  Page ${pageCount}: Fetched ${result.nodes.length} issues (${pageTime}ms)`);

        // Add issues to our list (without attachments for now)
        for (const node of result.nodes) {
          issues.push({
            id: node.id,
            identifier: node.identifier,
            title: node.title,
            description: node.description || undefined,
            priority: node.priority || 0,
            priorityLabel: this.getPriorityLabel(node.priority || 0),
            url: node.url,
            attachments: [], // Will be populated in second pass
            team: {
              id: node.team?.id || '',
              name: node.team?.name || 'Unknown',
            },
          });
        }

        hasNextPage = result.pageInfo.hasNextPage;
        cursor = result.pageInfo.endCursor || undefined;
      }

      const fetchTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.info(`✓ Fetched ${issues.length} Linear issues in ${fetchTime}s`);

      // Second pass: fetch attachments if enabled
      if (this.fetchAttachments && issues.length > 0) {
        this.logger.info(`📎 Fetching attachments for ${issues.length} issues...`);
        await this.fetchAttachmentsForIssues(issues);
      } else if (!this.fetchAttachments) {
        this.logger.info('⏭️  Skipping attachment fetching (disabled in config)');
      }

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.info(`✓ Completed Linear data fetch in ${totalTime}s`);
      
      return issues;
    } catch (error) {
      this.logger.error(`Failed to fetch Linear issues: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch issues with team data included inline using optimized GraphQL query.
   * This eliminates N+1 queries by fetching team data in the same request.
   * Also supports server-side filtering by team when teamId is provided.
   */
  private async fetchIssuesWithTeamData(
    cursor?: string,
    teamId?: string
  ): Promise<{
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      description?: string;
      priority: number;
      url: string;
      team: { id: string; name: string; key: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  }> {
    // Build query options
    const queryOptions: any = {
      first: 100,
      after: cursor,
      includeArchived: false,
    };

    // If teamId is specified, add server-side filter by team (much more efficient)
    if (teamId) {
      // Try to determine if it's a UUID or a key
      const isUUID = teamId.length > 10 && teamId.includes('-');
      queryOptions.filter = {
        team: isUUID 
          ? { id: { eq: teamId } }
          : { key: { eq: teamId } }
      };
    }

    const result = await this.client.issues(queryOptions);

    // Fetch all team data in parallel for the entire page
    const nodes = await Promise.all(
      result.nodes.map(async (issue) => {
        const team = await issue.team;
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description || undefined,
          priority: issue.priority || 0,
          url: issue.url,
          team: team ? { id: team.id, name: team.name, key: team.key } : null,
        };
      })
    );

    return {
      nodes,
      pageInfo: {
        hasNextPage: result.pageInfo.hasNextPage,
        endCursor: result.pageInfo.endCursor || undefined,
      },
    };
  }

  async updateIssuePriority(issueId: string, priority: number): Promise<void> {
    this.logger.debug(`Updating Linear issue ${issueId} priority to ${priority}`);
    
    try {
      await this.rateLimiter.executeWithRetry(
        () => this.client.updateIssue(issueId, {
          priority: priority,
        }),
        `Updating issue ${issueId} priority`
      );
      
      this.logger.debug(`Successfully updated issue ${issueId} priority`);
    } catch (error) {
      this.logger.error(`Failed to update issue ${issueId} priority: ${error}`);
      throw error;
    }
  }

  private getPriorityLabel(priority: number): string {
    switch (priority) {
      case 0: return 'No priority';
      case 1: return 'Urgent';
      case 2: return 'High';
      case 3: return 'Medium';
      case 4: return 'Low';
      default: return 'Unknown';
    }
  }

  private async fetchAttachmentsForIssues(issues: LinearIssue[]): Promise<void> {
    const batchSize = 10; // Process 10 issues concurrently
    let processed = 0;
    const startTime = Date.now();
    
    for (let i = 0; i < issues.length; i += batchSize) {
      const batch = issues.slice(i, Math.min(i + batchSize, issues.length));
      
      // Process batch concurrently with timeout
      await Promise.all(
        batch.map(async (issue) => {
          issue.attachments = await this.fetchIssueAttachments(issue.id);
        })
      );
      
      processed += batch.length;
      const progress = ((processed / issues.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
      const remaining = Math.ceil((issues.length - processed) / parseFloat(rate));
      
      this.logger.info(`  Progress: ${processed}/${issues.length} (${progress}%) - ${rate} issues/s - ETA: ${remaining}s`);
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.info(`✓ Fetched attachments in ${totalTime}s`);
  }

  private async fetchIssueAttachments(issueId: string): Promise<string[]> {
    // Check cache first
    if (this.attachmentCache.has(issueId)) {
      return this.attachmentCache.get(issueId)!;
    }

    try {
      // Add timeout to prevent hanging
      const attachments = await Promise.race([
        this.fetchIssueAttachmentsWithoutTimeout(issueId),
        new Promise<string[]>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), this.attachmentTimeout)
        )
      ]);
      
      // Cache the result
      this.attachmentCache.set(issueId, attachments);
      return attachments;
    } catch (error) {
      if (error instanceof Error && error.message === 'Timeout') {
        this.logger.debug(`Timeout fetching attachments for issue ${issueId}`);
      } else {
        this.logger.debug(`Failed to fetch attachments for issue ${issueId}: ${error}`);
      }
      return [];
    }
  }

  private async fetchIssueAttachmentsWithoutTimeout(issueId: string): Promise<string[]> {
    const issue = await this.rateLimiter.executeWithRetry(
      () => this.client.issue(issueId),
      `Fetching issue ${issueId}`
    );
    const attachments = await this.rateLimiter.executeWithRetry(
      () => issue.attachments(),
      `Fetching attachments for ${issueId}`
    );
    
    const jiraUrls: string[] = [];
    
    for (const attachment of attachments.nodes) {
      const url = attachment.url;
      if (this.isJiraUrl(url)) {
        jiraUrls.push(url);
      }
    }
    
    return jiraUrls;
  }

  private isJiraUrl(url: string): boolean {
    // If user provided a Jira host, use it for precise matching
    if (this.jiraHost) {
      // Construct base URL from host (add https:// if not present)
      const baseUrl = this.jiraHost.startsWith('http') 
        ? this.jiraHost.replace(/\/$/, '') 
        : `https://${this.jiraHost}`;
      
      // Check if URL starts with the base URL and contains /browse/ with issue pattern
      if (url.startsWith(baseUrl)) {
        const issuePattern = /\/browse\/[A-Z]+-\d+/i;
        return issuePattern.test(url);
      }
      
      // If it doesn't match the provided host, it's not our Jira
      return false;
    }
    
    // Fallback to generic pattern matching if no host provided
    const jiraPatterns = [
      /https?:\/\/[^\/]+\.atlassian\.net\/browse\/[A-Z]+-\d+/i,
      /https?:\/\/jira\.[^\/]+\/browse\/[A-Z]+-\d+/i,
      /https?:\/\/[^\/]+\/jira\/browse\/[A-Z]+-\d+/i,
      /https?:\/\/[^\/]+\/browse\/[A-Z]+-\d+/i,
    ];
    
    return jiraPatterns.some(pattern => pattern.test(url));
  }

  private matchesTeam(team: any, teamFilter: string): boolean {
    // Support both team key (e.g., "BK") and team UUID
    return team.key === teamFilter || team.id === teamFilter;
  }

  async testConnection(): Promise<boolean> {
    try {
      const viewer = await this.rateLimiter.executeWithRetry(
        () => this.client.viewer,
        'Testing Linear connection'
      );
      this.logger.info(`Connected to Linear as: ${viewer.name} (${viewer.email})`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to connect to Linear: ${error}`);
      return false;
    }
  }

  async validateTeam(teamFilter?: string): Promise<{ found: boolean; teamName?: string; teamKey?: string; issueCount?: number }> {
    if (!teamFilter) {
      // If no team filter is specified, we'll be fetching all teams
      // Get total issue count across all teams
      try {
        const allIssues = await this.client.issues({
          first: 1,
          includeArchived: false,
        });
        const totalCount = await this.getTotalIssueCount();
        this.logger.info(`No team filter specified - will fetch issues from all teams (${totalCount} issues)`);
        return { found: true, issueCount: totalCount };
      } catch (error) {
        this.logger.info('No team filter specified - will fetch issues from all teams');
        return { found: true };
      }
    }

    try {
      this.logger.debug(`Validating Linear team: ${teamFilter}`);
      
      // Fetch ALL teams with pagination to find the matching one
      const allTeams = [];
      let hasNextPage = true;
      let cursor: string | undefined;
      
      while (hasNextPage) {
        const teams = await this.rateLimiter.executeWithRetry(
          () => this.client.teams({
            first: 50,
            after: cursor,
          }),
          'Fetching Linear teams'
        );
        
        allTeams.push(...teams.nodes);
        hasNextPage = teams.pageInfo.hasNextPage;
        cursor = teams.pageInfo.endCursor || undefined;
      }
      
      let matchedTeam = null;
      
      for (const team of allTeams) {
        if (team.key === teamFilter || team.id === teamFilter) {
          matchedTeam = team;
          break;
        }
      }

      if (!matchedTeam) {
        this.logger.error(`Linear team "${teamFilter}" not found`);
        this.logger.info(`Available teams (${allTeams.length} total):`);
        for (const team of allTeams) {
          this.logger.info(`  - ${team.key}: ${team.name} (ID: ${team.id})`);
        }
        return { found: false };
      }

      // Get issue count for this team
      const issueCount = await this.getTeamIssueCount(matchedTeam.id);

      this.logger.info(`✓ Found Linear team: ${matchedTeam.name} (${matchedTeam.key}) with ${issueCount} issues`);
      
      return {
        found: true,
        teamName: matchedTeam.name,
        teamKey: matchedTeam.key,
        issueCount: issueCount
      };
    } catch (error) {
      this.logger.error(`Failed to validate Linear team: ${error}`);
      return { found: false };
    }
  }

  private async getTeamIssueCount(teamId: string): Promise<number> {
    let totalCount = 0;
    let hasNextPage = true;
    let cursor: string | undefined;

    try {
      while (hasNextPage) {
        const result = await this.rateLimiter.executeWithRetry(
          () => this.client.issues({
            first: 100,
            after: cursor,
            filter: {
              team: { id: { eq: teamId } }
            },
            includeArchived: false,
          }),
          'Counting team issues'
        );

        totalCount += result.nodes.length;
        hasNextPage = result.pageInfo.hasNextPage;
        cursor = result.pageInfo.endCursor || undefined;
      }
      
      return totalCount;
    } catch (error) {
      this.logger.debug(`Failed to get team issue count: ${error}`);
      return 0;
    }
  }

  private async getTotalIssueCount(): Promise<number> {
    let totalCount = 0;
    let hasNextPage = true;
    let cursor: string | undefined;

    try {
      while (hasNextPage) {
        const result = await this.rateLimiter.executeWithRetry(
          () => this.client.issues({
            first: 100,
            after: cursor,
            includeArchived: false,
          }),
          'Counting total issues'
        );

        totalCount += result.nodes.length;
        hasNextPage = result.pageInfo.hasNextPage;
        cursor = result.pageInfo.endCursor || undefined;
      }
      
      return totalCount;
    } catch (error) {
      this.logger.debug(`Failed to get total issue count: ${error}`);
      return 0;
    }
  }
}
