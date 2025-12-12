import { JiraClient } from './jira-client.js';
import { LinearClient } from './linear-client.js';
import { Config, JiraIssue, LinearIssueWithJira, CustomFieldValue } from './types.js';

export class CustomFieldImporter {
  private jiraClient: JiraClient;
  private linearClient: LinearClient;
  private config: Config;

  constructor(
    jiraBaseUrl: string,
    jiraEmail: string,
    jiraApiToken: string,
    linearApiKey: string,
    config: Config
  ) {
    this.jiraClient = new JiraClient(jiraBaseUrl, jiraEmail, jiraApiToken);
    this.linearClient = new LinearClient(linearApiKey, config.linear);
    this.config = config;
  }

  /**
   * Main synchronization method - Linear-first approach
   */
  async sync(): Promise<void> {
    console.log('Starting Jira to Linear custom field import...\n');

    // Step 1: Find Linear issues with Jira links
    console.log('Step 1: Finding Linear issues with Jira attachments...');
    const linearIssues = await this.linearClient.findIssuesWithJiraLinks();
    console.log(`Found ${linearIssues.length} Linear issues with Jira attachments\n`);

    if (linearIssues.length === 0) {
      console.log('No Linear issues with Jira links found. Exiting.');
      return;
    }

    // Step 2: Extract all unique Jira keys
    console.log('Step 2: Extracting Jira issue keys...');
    const allJiraKeys = new Set<string>();
    linearIssues.forEach(issue => {
      issue.jiraKeys.forEach(key => allJiraKeys.add(key));
    });
    const jiraKeys = Array.from(allJiraKeys);
    console.log(`Found ${jiraKeys.length} unique Jira issue keys\n`);

    // Step 3: Fetch Jira issues by keys
    console.log('Step 3: Fetching Jira issues...');
    const jiraIssueMap = await this.jiraClient.fetchIssues(jiraKeys);
    console.log(`Successfully fetched ${jiraIssueMap.size} Jira issues\n`);

    // Step 4: Process custom fields for each Linear issue
    console.log('Step 4: Processing custom fields...');
    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const linearIssue of linearIssues) {
      try {
        console.log(`\nProcessing ${linearIssue.linearIssueIdentifier}`);
        
        // Process each Jira ticket linked to this Linear issue
        for (const jiraKey of linearIssue.jiraKeys) {
          const jiraIssue = jiraIssueMap.get(jiraKey);
          
          if (!jiraIssue) {
            console.log(`  - ${jiraKey}: Not found in Jira (skipping)`);
            skippedCount++;
            continue;
          }

          console.log(`  - Processing ${jiraKey}`);
          
          // Extract custom field values
          const customFieldValues = this.jiraClient.extractCustomFields(
            jiraIssue,
            this.config.jira.customFields
          );

          // Process each custom field
          for (const fieldValue of customFieldValues) {
            if (fieldValue.value === null || fieldValue.value === '') {
              console.log(`    - ${fieldValue.fieldName}: (empty, skipping)`);
              continue;
            }

            if (fieldValue.fieldType === 'single-select') {
              await this.processSingleSelectField(linearIssue.linearIssueId, fieldValue);
            } else if (fieldValue.fieldType === 'text' || fieldValue.fieldType === 'multi-line-text') {
              await this.processTextField(linearIssue.linearIssueId, fieldValue, jiraKey);
            }
          }
        }

        processedCount++;
      } catch (error) {
        errorCount++;
        console.error(`Error processing ${linearIssue.linearIssueIdentifier}:`, error);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Linear issues found: ${linearIssues.length}`);
    console.log(`Unique Jira keys: ${jiraKeys.length}`);
    console.log(`Jira issues fetched: ${jiraIssueMap.size}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Skipped (not found): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('='.repeat(60));
    console.log('API USAGE');
    console.log('='.repeat(60));
    console.log(`Linear API calls: ${this.linearClient.getApiCallCount()}`);
    console.log(`Jira API calls: ${this.jiraClient.getApiCallCount()}`);
    console.log(`Total API calls: ${this.linearClient.getApiCallCount() + this.jiraClient.getApiCallCount()}`);
    console.log('='.repeat(60));
  }

  /**
   * Process a single-select custom field (create label group and label)
   */
  private async processSingleSelectField(
    linearIssueId: string,
    fieldValue: CustomFieldValue
  ): Promise<void> {
    console.log(`    - ${fieldValue.fieldName}: ${fieldValue.value} (creating label)`);
    
    // Get or create label group
    const groupId = await this.linearClient.getOrCreateLabelGroup(fieldValue.fieldName);
    
    // Get or create label
    const labelId = await this.linearClient.getOrCreateLabel(fieldValue.value!, groupId);
    
    // Add label to issue
    await this.linearClient.addLabelToIssue(linearIssueId, labelId);
    
    console.log(`      ✓ Label added successfully`);
  }

  /**
   * Process a text custom field (append to description)
   */
  private async processTextField(
    linearIssueId: string,
    fieldValue: CustomFieldValue,
    jiraKey: string
  ): Promise<void> {
    console.log(`    - ${fieldValue.fieldName}: (appending to description)`);
    
    await this.linearClient.appendToDescription(
      linearIssueId,
      fieldValue.fieldName,
      fieldValue.value!,
      jiraKey
    );
    
    console.log(`      ✓ Description updated successfully`);
  }
}
