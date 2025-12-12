const { Version3Client } = require('jira.js');
import { JiraIssue, Logger, RateLimitConfig } from '../types';
import { RateLimiter } from '../utils/rate-limiter';

export class JiraApiClient {
  private client: any;
  private rateLimiter: RateLimiter;

  constructor(
    private host: string,
    private email: string,
    private apiToken: string,
    private logger: Logger,
    rateLimitConfig?: RateLimitConfig
  ) {
    this.client = new Version3Client({
      host: `https://${this.host}`,
      authentication: {
        basic: {
          email: this.email,
          apiToken: this.apiToken,
        },
      },
    });
    
    this.rateLimiter = new RateLimiter(logger, rateLimitConfig);
  }


  async getIssueByKey(issueKey: string): Promise<JiraIssue | null> {
    try {
      this.logger.debug(`Fetching Jira issue by key: ${issueKey}`);

      const issue: any = await this.rateLimiter.executeWithRetry(
        () => this.client.issues.getIssue({
          issueIdOrKey: issueKey,
          fields: ['summary', 'description', 'priority']
        }),
        `Fetching Jira issue ${issueKey}`
      );

      // Handle different description formats
      let description = undefined;
      if (issue.fields?.description) {
        if (typeof issue.fields.description === 'string') {
          description = issue.fields.description;
        } else if (issue.fields.description.content) {
          // ADF (Atlassian Document Format) - extract plain text
          description = this.extractTextFromADF(issue.fields.description);
        }
      }

      const jiraIssue: JiraIssue = {
        id: issue.id || '',
        key: issue.key || '',
        summary: issue.fields?.summary || '',
        description,
        priority: {
          name: issue.fields?.priority?.name || 'Unknown',
          id: issue.fields?.priority?.id || '',
        },
        url: `https://${this.host}/browse/${issue.key}`,
      };

      this.logger.debug(`Found Jira issue: ${issueKey} - "${issue.fields?.summary}"`);
      return jiraIssue;
    } catch (error) {
      this.logger.debug(`Failed to find Jira issue by key "${issueKey}": ${error}`);
      return null;
    }
  }

  async getIssueByUrl(jiraUrl: string): Promise<JiraIssue | null> {
    const issueKey = this.extractKeyFromUrl(jiraUrl);
    if (!issueKey) {
      this.logger.debug(`Could not extract issue key from URL: ${jiraUrl}`);
      return null;
    }

    this.logger.debug(`Extracted key "${issueKey}" from URL: ${jiraUrl}`);
    return this.getIssueByKey(issueKey);
  }

  private extractKeyFromUrl(url: string): string | null {
    // Extract issue key from various Jira URL formats
    // Examples:
    // https://company.atlassian.net/browse/PROJ-123
    // https://jira.company.com/browse/PROJ-123  
    // https://company.com/jira/browse/PROJ-123
    const patterns = [
      /\/browse\/([A-Z]+-\d+)/i,
      /\/([A-Z]+-\d+)$/i,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1].toUpperCase();
      }
    }

    return null;
  }

  private extractTextFromADF(adfContent: any): string {
    if (!adfContent || !adfContent.content) return '';
    
    let text = '';
    const extractText = (node: any): void => {
      if (node.text) {
        text += node.text;
      }
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach((child: any) => extractText(child));
      }
    };
    
    extractText(adfContent);
    return text.trim();
  }

  async testConnection(): Promise<boolean> {
    try {
      const result: any = await this.rateLimiter.executeWithRetry(
        () => this.client.myself.getCurrentUser(),
        'Testing Jira connection'
      );
      this.logger.info(`Connected to Jira as: ${result.displayName} (${result.emailAddress})`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to connect to Jira: ${error}`);
      return false;
    }
  }

  async validateProject(projectKey?: string): Promise<{ found: boolean; projectName?: string; projectKey?: string }> {
    if (!projectKey) {
      // If no project key is specified, user will query issues across all projects
      this.logger.info('No project filter specified in config - will search across all accessible projects');
      return { found: true };
    }

    try {
      this.logger.debug(`Validating Jira project: ${projectKey}`);
      
      const project: any = await this.rateLimiter.executeWithRetry(
        () => this.client.projects.getProject({
          projectIdOrKey: projectKey
        }),
        `Validating Jira project ${projectKey}`
      );

      if (!project) {
        this.logger.error(`Jira project "${projectKey}" not found or not accessible`);
        return { found: false };
      }

      this.logger.info(`✓ Found Jira project: ${project.name} (${project.key})`);
      
      return {
        found: true,
        projectName: project.name,
        projectKey: project.key || projectKey
      };
    } catch (error) {
      this.logger.error(`Jira project "${projectKey}" not found or not accessible: ${error}`);
      
      // Try to list available projects
      try {
        const projects: any = await this.rateLimiter.executeWithRetry(
          () => this.client.projects.searchProjects({
            maxResults: 50
          }),
          'Listing available Jira projects'
        );
        
        if (projects.values && projects.values.length > 0) {
          this.logger.info('Available projects:');
          for (const proj of projects.values) {
            this.logger.info(`  - ${proj.key}: ${proj.name}`);
          }
        }
      } catch (listError) {
        this.logger.debug(`Could not list available projects: ${listError}`);
      }
      
      return { found: false };
    }
  }

  async getPriorities(): Promise<Array<{ id: string; name: string }>> {
    try {
      const priorities: any = await this.rateLimiter.executeWithRetry(
        () => this.client.issuePriorities.getPriorities(),
        'Fetching Jira priorities'
      );
      return priorities.map((priority: any) => ({
        id: priority.id || '',
        name: priority.name || '',
      }));
    } catch (error) {
      this.logger.error(`Failed to get Jira priorities: ${error}`);
      throw error;
    }
  }
}
