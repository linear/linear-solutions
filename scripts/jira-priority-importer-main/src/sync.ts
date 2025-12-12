import { Config, SyncResult, MatchResult, Logger } from './types';
import { LinearApiClient } from './clients/linear';
import { JiraApiClient } from './clients/jira';
import { IssueMatcher } from './utils/matcher';
import { PriorityMapper } from './utils/priority-mapper';
import * as readline from 'readline/promises';

export class PrioritySync {
  private linearClient: LinearApiClient;
  private jiraClient: JiraApiClient;
  private matcher: IssueMatcher;
  private priorityMapper: PriorityMapper;
  private skipConfirmation: boolean = false;

  constructor(private config: Config, private logger: Logger, options?: { skipConfirmation?: boolean }) {
    this.skipConfirmation = options?.skipConfirmation || false;
    this.linearClient = new LinearApiClient(
      config.linear.apiKey, 
      logger, 
      config.jira.host,
      {
        fetchAttachments: config.linear.fetchAttachments,
        attachmentTimeout: config.linear.attachmentTimeout,
        rateLimitConfig: config.rateLimiting,
      }
    );
    this.jiraClient = new JiraApiClient(
      config.jira.host,
      config.jira.email,
      config.jira.apiToken,
      logger,
      config.rateLimiting
    );
    this.matcher = new IssueMatcher(config, this.jiraClient, logger);
    this.priorityMapper = new PriorityMapper(config, logger);
  }

  async run(): Promise<SyncResult> {
    const result: SyncResult = {
      totalLinearIssues: 0,
      matchedIssues: 0,
      updatedIssues: 0,
      skippedIssues: 0,
      errors: [],
    };

    try {
      // Validate configuration
      await this.validateConfiguration();

      // Test API connections and get issue count
      const validationInfo = await this.testConnections();

      // Ask for confirmation before proceeding
      if (!this.skipConfirmation && validationInfo.issueCount !== undefined && validationInfo.issueCount > 0) {
        const shouldContinue = await this.promptUserToContinue(validationInfo.issueCount);
        if (!shouldContinue) {
          this.logger.info('Sync cancelled by user');
          return result;
        }
      }

      // Get all Linear issues
      this.logger.info('Starting priority sync...');
      const linearIssues = await this.linearClient.fetchAllIssues(this.config.linear.teamId);
      result.totalLinearIssues = linearIssues.length;

      if (linearIssues.length === 0) {
        this.logger.warn('No Linear issues found to sync');
        return result;
      }

      this.logger.info(`Processing ${linearIssues.length} Linear issues...`);

      // Process each Linear issue
      for (let i = 0; i < linearIssues.length; i++) {
        const linearIssue = linearIssues[i];
        const progressMsg = `[${i + 1}/${linearIssues.length}] Processing: "${linearIssue.title}"`;
        this.logger.info(progressMsg);

        try {
          const matchResult = await this.matcher.findBestMatch(linearIssue);
          
          if (matchResult.jiraIssue) {
            result.matchedIssues++;
            
            // Map Jira priority to Linear priority
            const newLinearPriority = this.priorityMapper.mapJiraToLinearPriority(
              matchResult.jiraIssue.priority.name
            );

            if (newLinearPriority !== null) {
              // Check if priority needs to be updated
              if (linearIssue.priority !== newLinearPriority) {
                if (!this.config.dryRun) {
                  await this.linearClient.updateIssuePriority(linearIssue.id, newLinearPriority);
                  this.logger.info(
                    `Updated issue "${linearIssue.title}" priority: ${linearIssue.priorityLabel} -> ${this.priorityMapper.getLinearPriorityLabel(newLinearPriority)}`
                  );
                  result.updatedIssues++;
                } else {
                  this.logger.info(
                    `[DRY RUN] Would update issue "${linearIssue.title}" priority: ${linearIssue.priorityLabel} -> ${this.priorityMapper.getLinearPriorityLabel(newLinearPriority)}`
                  );
                }
              } else {
                this.logger.debug(`Issue "${linearIssue.title}" already has correct priority`);
                result.skippedIssues++;
              }
            } else {
              this.logger.warn(
                `No priority mapping found for Jira priority "${matchResult.jiraIssue.priority.name}" (issue: "${linearIssue.title}")`
              );
              result.skippedIssues++;
            }
          } else {
            this.logger.debug(`No match found for issue "${linearIssue.title}": ${matchResult.reason}`);
            result.skippedIssues++;
          }
        } catch (error) {
          const errorMsg = `Failed to process issue "${linearIssue.title}": ${error}`;
          this.logger.error(errorMsg);
          result.errors.push({
            issueId: linearIssue.id,
            error: errorMsg,
          });
          result.skippedIssues++;
        }

        // Add a small delay to avoid rate limiting
        await this.delay(100);
      }

      this.logSyncSummary(result);
      return result;
    } catch (error) {
      this.logger.error(`Sync failed: ${error}`);
      throw error;
    }
  }

  private async validateConfiguration(): Promise<void> {
    this.logger.info('Validating configuration...');

    // Validate priority mappings
    const mappingIssues = this.priorityMapper.validateMappings();
    if (mappingIssues.length > 0) {
      this.logger.error('Configuration validation failed:');
      for (const issue of mappingIssues) {
        this.logger.error(`  - ${issue.jiraPriority}: ${issue.issue}`);
      }
      throw new Error('Invalid priority mappings in configuration');
    }

    this.logger.info(this.priorityMapper.getMappingSummary());
    this.logger.info('Configuration validation passed');
  }

  private async testConnections(): Promise<{ issueCount?: number }> {
    this.logger.info('Testing API connections...');

    const [linearConnected, jiraConnected] = await Promise.all([
      this.linearClient.testConnection(),
      this.jiraClient.testConnection(),
    ]);

    if (!linearConnected) {
      throw new Error('Failed to connect to Linear API');
    }

    if (!jiraConnected) {
      throw new Error('Failed to connect to Jira API');
    }

    this.logger.info('API connections successful');

    // Validate team and project configurations
    this.logger.info('Validating configuration settings...');
    
    const linearValidation = await this.linearClient.validateTeam(this.config.linear.teamId);
    if (!linearValidation.found) {
      throw new Error(`Linear team validation failed: team "${this.config.linear.teamId}" not found`);
    }

    const jiraValidation = await this.jiraClient.validateProject(this.config.jira.projectKey);
    if (!jiraValidation.found) {
      throw new Error(`Jira project validation failed: project "${this.config.jira.projectKey}" not found or not accessible`);
    }

    this.logger.info('Configuration settings validated successfully');
    
    return { issueCount: linearValidation.issueCount };
  }

  private async promptUserToContinue(issueCount: number): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      this.logger.info(`\n⚠️  About to process ${issueCount} Linear issue${issueCount === 1 ? '' : 's'}`);
      if (this.config.dryRun) {
        this.logger.info('Running in DRY RUN mode - no changes will be made');
      }
      
      const answer = await rl.question('\nDo you want to continue? (yes/no): ');
      const normalizedAnswer = answer.toLowerCase().trim();
      
      return normalizedAnswer === 'yes' || normalizedAnswer === 'y';
    } finally {
      rl.close();
    }
  }

  private logSyncSummary(result: SyncResult): void {
    this.logger.info('\n=== SYNC SUMMARY ===');
    this.logger.info(`Total Linear issues processed: ${result.totalLinearIssues}`);
    this.logger.info(`Issues matched with Jira: ${result.matchedIssues}`);
    this.logger.info(`Issues updated: ${result.updatedIssues}`);
    this.logger.info(`Issues skipped: ${result.skippedIssues}`);
    this.logger.info(`Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      this.logger.error('\nErrors encountered:');
      for (const error of result.errors) {
        this.logger.error(`  - ${error.error}`);
      }
    }

    const matchRate = result.totalLinearIssues > 0 
      ? ((result.matchedIssues / result.totalLinearIssues) * 100).toFixed(1)
      : '0.0';
    
    this.logger.info(`Match rate: ${matchRate}%`);

    if (this.config.dryRun) {
      this.logger.info('\nThis was a DRY RUN - no actual updates were made to Linear');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
