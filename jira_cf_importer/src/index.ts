import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { CustomFieldImporter } from './importer.js';
import { Config } from './types.js';

// Load environment variables
dotenv.config();

async function main() {
  console.log('Jira to Linear Custom Field Importer');
  console.log('=====================================\n');

  // Validate environment variables
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraApiToken = process.env.JIRA_API_TOKEN;
  const linearApiKey = process.env.LINEAR_API_KEY;

  if (!jiraEmail || !jiraApiToken || !linearApiKey) {
    console.error('Error: Missing required environment variables.');
    console.error('Please ensure the following are set in your .env file:');
    console.error('  - JIRA_EMAIL');
    console.error('  - JIRA_API_TOKEN');
    console.error('  - LINEAR_API_KEY');
    process.exit(1);
  }

  // Load configuration
  const configPath = path.join(process.cwd(), 'config.json');
  
  if (!fs.existsSync(configPath)) {
    console.error('Error: config.json not found.');
    console.error('Please create a config.json file based on config.example.json');
    process.exit(1);
  }

  let config: Config;
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (error) {
    console.error('Error: Failed to parse config.json');
    console.error(error);
    process.exit(1);
  }

  // Validate configuration
  if (!config.jira || !config.linear) {
    console.error('Error: Invalid config.json structure');
    console.error('Please ensure config.json has both "jira" and "linear" sections');
    process.exit(1);
  }

  if (!config.jira.baseUrl) {
    console.error('Error: jira.baseUrl is required in config.json');
    process.exit(1);
  }

  if (!config.jira.customFields || config.jira.customFields.length === 0) {
    console.error('Error: No custom fields specified in config.json');
    process.exit(1);
  }

  // Allow JIRA_BASE_URL from env to override config
  const jiraBaseUrl = process.env.JIRA_BASE_URL || config.jira.baseUrl;

  console.log('Configuration loaded successfully:');
  console.log(`  - Jira Base URL: ${jiraBaseUrl}`);
  console.log(`  - Linear Teams: ${config.linear.teamIds?.join(', ') || 'all teams'}`);
  console.log(`  - Date Range: ${config.linear.startDate || 'any'} to ${config.linear.endDate || 'any'}`);
  console.log(`  - Custom Fields: ${config.jira.customFields.length}`);
  console.log(`  - Label Scope: ${config.linear.labelScope}`);
  console.log('');

  // Create importer and run
  const importer = new CustomFieldImporter(
    jiraBaseUrl,
    jiraEmail,
    jiraApiToken,
    linearApiKey,
    config
  );

  try {
    await importer.sync();
    console.log('\nImport completed successfully!');
  } catch (error) {
    console.error('\nImport failed with error:');
    console.error(error);
    process.exit(1);
  }
}

main();
