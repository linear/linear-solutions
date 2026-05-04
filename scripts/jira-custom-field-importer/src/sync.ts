import { Config, SyncResult, LinearIssue, JiraIssue, Logger } from './types';
import { LinearApiClient } from './clients/linear';
import { JiraApiClient } from './clients/jira';
import { IssueMatcher } from './utils/matcher';
import { CheckpointManager } from './utils/checkpoint';
import * as readline from 'readline/promises';
import * as path from 'path';

const CHECKPOINT_FILE = path.join(process.cwd(), 'sync-checkpoint.json');

export class CustomFieldSync {
  private linearClient: LinearApiClient;
  private jiraClient: JiraApiClient;
  private matcher: IssueMatcher;
  private skipConfirmation: boolean = false;
  private needsAttachments: boolean;

  constructor(
    private config: Config,
    private logger: Logger,
    options?: { skipConfirmation?: boolean }
  ) {
    this.skipConfirmation = options?.skipConfirmation || false;
    this.needsAttachments = config.matching.strategy !== 'identifier';

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
      config.customFields,
      logger,
      config.rateLimiting
    );

    this.matcher = new IssueMatcher(config, this.jiraClient, logger);
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
      this.validateConfiguration();
      const validationInfo = await this.testConnections();

      // Check for an existing checkpoint and offer to resume
      let checkpoint = CheckpointManager.tryLoad(CHECKPOINT_FILE);
      if (checkpoint) {
        const resume = await this.promptResume(checkpoint);
        if (!resume) {
          checkpoint.delete();
          checkpoint = null;
        }
      }

      if (!checkpoint) {
        if (
          !this.skipConfirmation &&
          validationInfo.issueCount !== undefined &&
          validationInfo.issueCount > 0
        ) {
          const shouldContinue = await this.promptUserToContinue(validationInfo.issueCount);
          if (!shouldContinue) {
            this.logger.info('Sync cancelled by user');
            return result;
          }
        }
        checkpoint = CheckpointManager.create(CHECKPOINT_FILE);
      }

      this.logger.info('Starting custom field sync (streaming mode)...');

      // Stream one page at a time — avoids loading all issues into memory at once
      let cursor = checkpoint.cursor;
      let hasNextPage = true;
      let pageNum = 0;

      while (hasNextPage) {
        pageNum++;
        this.logger.info(`📄 Fetching page ${pageNum}...`);

        const page = await this.linearClient.fetchIssuePage(cursor, this.config.linear.teamId);
        const allIssues = page.issues;

        // Skip issues already processed in a previous (interrupted) run
        const toProcess = allIssues.filter(i => !checkpoint!.isProcessed(i.id));
        result.totalLinearIssues += toProcess.length;

        if (toProcess.length > 0) {
          await this.processPage(toProcess, result, checkpoint);
        } else {
          this.logger.info(`  All ${allIssues.length} issues on this page already processed, skipping`);
        }

        // Checkpoint the cursor so a resume skips pages we've fully processed
        checkpoint.cursor = page.pageInfo.endCursor;
        checkpoint.save();

        hasNextPage = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
      }

      // Clean up checkpoint on successful completion
      checkpoint.delete();
      this.logSyncSummary(result);
      return result;
    } catch (error) {
      this.logger.error(`Sync failed: ${error}`);
      this.logger.info('Progress saved to sync-checkpoint.json — re-run to resume from where it stopped.');
      throw error;
    }
  }

  private async processPage(
    issues: LinearIssue[],
    result: SyncResult,
    checkpoint: CheckpointManager
  ): Promise<void> {
    // Fetch attachments for this page if the matching strategy needs them
    if (this.needsAttachments && this.config.linear.fetchAttachments !== false) {
      this.logger.info(`  Fetching attachments for ${issues.length} issues...`);
      await this.linearClient.fetchAttachmentsForPage(issues);
    }

    // Collect all candidate Jira keys across this page in one pass
    const candidateKeys = new Set<string>();
    for (const issue of issues) {
      for (const key of this.matcher.resolveCandidateKeys(issue)) {
        candidateKeys.add(key);
      }
    }

    // One batch Jira API call instead of one call per issue
    this.logger.info(
      `  Batch fetching ${candidateKeys.size} Jira issues for ${issues.length} Linear issues...`
    );
    const jiraMap = candidateKeys.size > 0
      ? await this.jiraClient.getIssuesByKeys([...candidateKeys])
      : new Map<string, JiraIssue>();

    this.logger.info(`  Matched ${jiraMap.size}/${candidateKeys.size} keys in Jira`);

    // Process each issue in the page
    for (const linearIssue of issues) {
      this.logger.info(`  Processing: "${linearIssue.title}" (${linearIssue.identifier})`);
      try {
        await this.processIssue(linearIssue, jiraMap, result);
      } catch (error) {
        const errorMsg = `Failed to process issue "${linearIssue.title}": ${error}`;
        this.logger.error(errorMsg);
        result.errors.push({ issueId: linearIssue.id, error: errorMsg });
        result.skippedIssues++;
      }
      checkpoint.markProcessed(linearIssue.id);
      await this.delay(100);
    }
  }

  private async processIssue(
    linearIssue: LinearIssue,
    jiraMap: Map<string, JiraIssue>,
    result: SyncResult
  ): Promise<void> {
    const jiraIssue = this.matcher.findMatchInBatch(linearIssue, jiraMap);

    if (!jiraIssue) {
      this.logger.debug(`No Jira match for "${linearIssue.title}"`);
      result.skippedIssues++;
      return;
    }

    result.matchedIssues++;

    let description = linearIssue.description || '';
    let changed = false;

    for (const fieldConfig of this.config.customFields) {
      const value = jiraIssue.customFields[fieldConfig.descriptionLabel];

      if (!value) {
        this.logger.debug(
          `No value for "${fieldConfig.descriptionLabel}" on ${jiraIssue.key}`
        );
        continue;
      }

      const upserted = this.upsertSection(description, fieldConfig.descriptionLabel, value);
      if (upserted.changed) {
        description = upserted.description;
        changed = true;
        this.logger.info(`    Updating "${fieldConfig.descriptionLabel}"`);
      } else {
        this.logger.debug(`    "${fieldConfig.descriptionLabel}" unchanged`);
      }
    }

    const importedLabels = this.config.customFields
      .filter(f => jiraIssue.customFields[f.descriptionLabel])
      .map(f => `**${f.descriptionLabel}**`)
      .join(', ');

    const comment = `🤖 Jira Custom Field Importer synced ${importedLabels} from [${jiraIssue.key}](https://${this.config.jira.host}/browse/${jiraIssue.key}).`;

    if (changed) {
      if (!this.config.dryRun) {
        await this.linearClient.updateIssueDescription(linearIssue.id, description);
        await this.linearClient.addComment(linearIssue.id, comment);
      } else {
        this.logger.info(`    [DRY RUN] Would update description and post comment`);
      }
      result.updatedIssues++;
    } else {
      // Description already current — recover a missed activity comment if needed
      if (!this.config.dryRun && importedLabels) {
        const alreadyCommented = await this.linearClient.hasImporterComment(linearIssue.id);
        if (!alreadyCommented) {
          this.logger.info(`    Posting missing activity comment`);
          await this.linearClient.addComment(linearIssue.id, comment);
        }
      }
      result.skippedIssues++;
    }
  }

  private upsertSection(
    description: string,
    label: string,
    newValue: string
  ): { description: string; changed: boolean } {
    const heading = `**${label}**`;
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionRegex = new RegExp(
      `(\\n\\n\\*\\*${escapedLabel}\\*\\*\\n)([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`
    );

    if (description.includes(heading)) {
      const match = description.match(sectionRegex);
      const currentValue = match ? match[2].trimEnd() : '';
      if (currentValue === newValue.trimEnd()) {
        return { description, changed: false };
      }
      return { description: description.replace(sectionRegex, `$1${newValue}`), changed: true };
    }

    return { description: `${description}\n\n${heading}\n${newValue}`, changed: true };
  }

  private validateConfiguration(): void {
    this.logger.info('Validating configuration...');
    this.logger.info(`Configured custom fields (${this.config.customFields.length}):`);
    for (const field of this.config.customFields) {
      this.logger.info(
        `  - Jira field "${field.jiraFieldName}" → Linear description label "${field.descriptionLabel}"`
      );
    }
    this.logger.info('Configuration validation passed');
  }

  private async testConnections(): Promise<{ issueCount?: number }> {
    this.logger.info('Testing API connections...');

    const [linearConnected, jiraConnected] = await Promise.all([
      this.linearClient.testConnection(),
      this.jiraClient.testConnection(),
    ]);

    if (!linearConnected) throw new Error('Failed to connect to Linear API');
    if (!jiraConnected) throw new Error('Failed to connect to Jira API');

    this.logger.info('API connections successful');
    this.logger.info('Validating configuration settings...');

    const linearValidation = await this.linearClient.validateTeam(this.config.linear.teamId);
    if (!linearValidation.found) {
      throw new Error(`Linear team validation failed: team "${this.config.linear.teamId}" not found`);
    }

    const jiraValidation = await this.jiraClient.validateProject(this.config.jira.projectKey);
    if (!jiraValidation.found) {
      throw new Error(`Jira project validation failed: project "${this.config.jira.projectKey}" not found`);
    }

    this.logger.info('Configuration settings validated successfully');
    return { issueCount: linearValidation.issueCount };
  }

  private async promptResume(checkpoint: CheckpointManager): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      this.logger.info(
        `\n⚠️  Found checkpoint from ${checkpoint.startedAt} with ${checkpoint.processedCount} issues already processed.`
      );
      const answer = await rl.question('Resume from checkpoint? (yes/no — "no" starts fresh): ');
      return ['yes', 'y'].includes(answer.toLowerCase().trim());
    } finally {
      rl.close();
    }
  }

  private async promptUserToContinue(issueCount: number): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      this.logger.info(
        `\n⚠️  About to process ${issueCount} Linear issue${issueCount === 1 ? '' : 's'}`
      );
      if (this.config.dryRun) {
        this.logger.info('Running in DRY RUN mode - no changes will be made');
      }
      const answer = await rl.question('\nDo you want to continue? (yes/no): ');
      return ['yes', 'y'].includes(answer.toLowerCase().trim());
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
