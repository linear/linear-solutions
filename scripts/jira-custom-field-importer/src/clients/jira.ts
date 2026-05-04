const { Version3Client } = require('jira.js');
import { JiraIssue, CustomFieldConfig, Logger, RateLimitConfig } from '../types';
import { RateLimiter } from '../utils/rate-limiter';

export class JiraApiClient {
  private client: any;
  private rateLimiter: RateLimiter;

  constructor(
    private host: string,
    private email: string,
    private apiToken: string,
    private customFields: CustomFieldConfig[],
    private logger: Logger,
    rateLimitConfig?: RateLimitConfig,
    private filterJql?: string
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

      // Fetch with ?expand=names so the response includes a fieldKey→displayName map.
      // We request summary plus all field names from the config.
      const fieldNames = ['summary', ...this.customFields.map(f => f.jiraFieldName)];

      const issue: any = await this.rateLimiter.executeWithRetry(
        () => this.client.issues.getIssue({
          issueIdOrKey: issueKey,
          fields: fieldNames,
          expand: 'names',
        }),
        `Fetching Jira issue ${issueKey}`
      );

      // Build a reverse map: displayName (lowercase) → fieldKey
      // Jira returns `issue.names` as { fieldKey: displayName, ... }
      const nameToKey: Record<string, string> = {};
      if (issue.names && typeof issue.names === 'object') {
        for (const [key, displayName] of Object.entries(issue.names)) {
          if (typeof displayName === 'string') {
            nameToKey[displayName.toLowerCase()] = key;
          }
        }
      }

      // Extract each configured custom field value
      const customFieldValues: Record<string, string> = {};
      for (const fieldConfig of this.customFields) {
        const value = this.resolveFieldValue(issue, fieldConfig.jiraFieldName, nameToKey);
        if (value !== null) {
          customFieldValues[fieldConfig.descriptionLabel] = value;
        } else {
          this.logger.debug(
            `Custom field "${fieldConfig.jiraFieldName}" not found or empty on issue ${issueKey}`
          );
        }
      }

      const jiraIssue: JiraIssue = {
        id: issue.id || '',
        key: issue.key || '',
        summary: issue.fields?.summary || '',
        url: `https://${this.host}/browse/${issue.key}`,
        customFields: customFieldValues,
      };

      this.logger.debug(`Found Jira issue: ${issueKey} - "${issue.fields?.summary}"`);
      return jiraIssue;
    } catch (error) {
      this.logger.debug(`Failed to find Jira issue by key "${issueKey}": ${error}`);
      return null;
    }
  }

  // Batch fetch up to 100 Jira issues per API call using JQL IN clause.
  // Returns a map of issueKey → JiraIssue for all keys that were found.
  async getIssuesByKeys(issueKeys: string[]): Promise<Map<string, JiraIssue>> {
    if (issueKeys.length === 0) return new Map();

    const BATCH_SIZE = 100;
    const resultMap = new Map<string, JiraIssue>();
    const fieldNames = ['summary', ...this.customFields.map(f => f.jiraFieldName)];

    for (let i = 0; i < issueKeys.length; i += BATCH_SIZE) {
      const batch = issueKeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(issueKeys.length / BATCH_SIZE);

      this.logger.debug(
        `Batch fetching ${batch.length} Jira issues (batch ${batchNum}/${totalBatches})`
      );

      try {
        const baseJql = `issueKey IN (${batch.join(',')})`;
        const jql = this.filterJql
          ? `${baseJql} AND (${this.filterJql})`
          : baseJql;

        if (this.filterJql) {
          this.logger.debug(`Applying Jira filter: ${this.filterJql}`);
        }

        const result: any = await this.rateLimiter.executeWithRetry(
          () => this.client.issueSearch.searchForIssuesUsingJql({
            jql,
            fields: fieldNames,
            expand: 'names',
            maxResults: batch.length,
          }),
          `Batch Jira fetch ${batchNum}/${totalBatches}`
        );

        // The names map is at the response level (not per-issue) when expand=names
        const nameToKey: Record<string, string> = {};
        if (result.names && typeof result.names === 'object') {
          for (const [key, displayName] of Object.entries(result.names)) {
            if (typeof displayName === 'string') {
              nameToKey[displayName.toLowerCase()] = key;
            }
          }
        }

        for (const issue of result.issues || []) {
          const customFieldValues: Record<string, string> = {};
          for (const fieldConfig of this.customFields) {
            const value = this.resolveFieldValue(issue, fieldConfig.jiraFieldName, nameToKey);
            if (value !== null) {
              customFieldValues[fieldConfig.descriptionLabel] = value;
            }
          }

          resultMap.set(issue.key, {
            id: issue.id || '',
            key: issue.key || '',
            summary: issue.fields?.summary || '',
            url: `https://${this.host}/browse/${issue.key}`,
            customFields: customFieldValues,
          });
        }

        this.logger.debug(`Batch ${batchNum}: got ${result.issues?.length ?? 0}/${batch.length} results`);
      } catch (error) {
        this.logger.error(`Batch Jira fetch ${batchNum} failed: ${error}`);
        // Don't abort — missing issues will just be unmatched
      }
    }

    return resultMap;
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

  // Resolve a field value from the Jira issue response.
  // jiraFieldName can be either a direct field key (e.g. "customfield_10014")
  // or a display name (e.g. "Acceptance Criteria") resolved via nameToKey map.
  private resolveFieldValue(
    issue: any,
    jiraFieldName: string,
    nameToKey: Record<string, string>
  ): string | null {
    // Try direct key first
    let rawValue = issue.fields?.[jiraFieldName];

    // If not found by direct key, try resolving display name → key
    if (rawValue === undefined) {
      const resolvedKey = nameToKey[jiraFieldName.toLowerCase()];
      if (resolvedKey) {
        rawValue = issue.fields?.[resolvedKey];
      }
    }

    if (rawValue === null || rawValue === undefined) return null;

    return this.extractCustomFieldValue(rawValue);
  }

  // Extract a plain-text string from various Jira field value types.
  private extractCustomFieldValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;

    if (typeof value === 'string') {
      return value.trim() || null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    // Atlassian Document Format (ADF)
    if (typeof value === 'object' && value !== null) {
      const obj = value as any;
      if (obj.type === 'doc' || obj.content) {
        const text = this.extractTextFromADF(obj);
        return text || null;
      }
      // Option fields (e.g. select lists) have a .value property
      if (typeof obj.value === 'string') {
        return obj.value.trim() || null;
      }
      // User fields have a .displayName property
      if (typeof obj.displayName === 'string') {
        return obj.displayName.trim() || null;
      }
      // Array fields (multi-select, etc.) — join values
      if (Array.isArray(value)) {
        const parts = (value as any[])
          .map(item => this.extractCustomFieldValue(item))
          .filter((v): v is string => v !== null);
        return parts.length > 0 ? parts.join(', ') : null;
      }
    }

    if (Array.isArray(value)) {
      const parts = (value as any[])
        .map(item => this.extractCustomFieldValue(item))
        .filter((v): v is string => v !== null);
      return parts.length > 0 ? parts.join(', ') : null;
    }

    return null;
  }

  private extractTextFromADF(adfContent: any): string {
    if (!adfContent || !adfContent.content) return '';
    let text = '';
    const extractText = (node: any): void => {
      if (node.text) text += node.text;
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach((child: any) => extractText(child));
      }
    };
    extractText(adfContent);
    return text.trim();
  }

  private extractKeyFromUrl(url: string): string | null {
    const patterns = [
      /\/browse\/([A-Z]+-\d+)/i,
      /\/([A-Z]+-\d+)$/i,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) return match[1].toUpperCase();
    }
    return null;
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

  async validateProject(projectKey?: string): Promise<{ found: boolean; projectName?: string }> {
    if (!projectKey) {
      this.logger.info('No project filter specified - will search across all accessible projects');
      return { found: true };
    }

    try {
      this.logger.debug(`Validating Jira project: ${projectKey}`);
      const project: any = await this.rateLimiter.executeWithRetry(
        () => this.client.projects.getProject({ projectIdOrKey: projectKey }),
        `Validating Jira project ${projectKey}`
      );

      if (!project) {
        this.logger.error(`Jira project "${projectKey}" not found or not accessible`);
        return { found: false };
      }

      this.logger.info(`✓ Found Jira project: ${project.name} (${project.key})`);
      return { found: true, projectName: project.name };
    } catch (error) {
      this.logger.error(`Jira project "${projectKey}" not found or not accessible: ${error}`);

      try {
        const projects: any = await this.rateLimiter.executeWithRetry(
          () => this.client.projects.searchProjects({ maxResults: 50 }),
          'Listing available Jira projects'
        );
        if (projects.values?.length > 0) {
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
}
