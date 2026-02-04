/**
 * Run command - execute the import
 */

import { writeFileSync } from 'fs';
import { select } from '@inquirer/prompts';
import { loadConfig, loadUserMapping } from '../config/loader.js';
import { parseMondayExport, getBoardSummary } from '../parser/monday.js';
import { LinearClientWrapper } from '../linear/client.js';
import { runMondayImport, importMondayUpdates, type MondayImportResult } from '../importer/monday-engine.js';

export interface RunOptions {
  config: string;
  file: string;
  dryRun?: boolean;
  continueOnError?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const isDryRun = options.dryRun ?? false;
  
  console.log(`\n${isDryRun ? '[DRY RUN] ' : ''}Monday.com to Linear Import`);
  console.log('='.repeat(50));

  // Load and validate config
  console.log('\nLoading configuration...');
  const { config, validation } = loadConfig(options.config);
  
  if (!config) {
    console.error('\n❌ Configuration errors:');
    for (const error of validation.errors) {
      console.error(`  - ${error.path}: ${error.message}`);
    }
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    console.log('\n⚠️  Configuration warnings:');
    for (const warning of validation.warnings) {
      console.log(`  - ${warning.path}: ${warning.message}`);
    }
  }

  // Override options from CLI
  if (options.continueOnError !== undefined) {
    config.options.continueOnError = options.continueOnError;
  }
  config.options.dryRun = isDryRun;

  // Parse Monday.com export
  console.log('\nParsing Excel file...');
  const { board, updates } = parseMondayExport(options.file);
  
  const summary = getBoardSummary(board);
  console.log(`  Board name: ${board.name}`);
  console.log(`  Board sections: ${summary.totalGroups}`);
  console.log(`  Projects to import: ${summary.totalMainItems}`);
  console.log(`  Issues to import: ${summary.totalSubitems}`);
  if (updates && updates.updates.length > 0) {
    console.log(`  Updates to import: ${updates.updates.length}`);
  }

  if (summary.totalMainItems === 0) {
    console.error('\n❌ No items found in the export.');
    console.error('   This might indicate a parsing issue or empty data.');
    process.exit(1);
  }

  // Get API key
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error('\n❌ LINEAR_API_KEY environment variable not set');
    console.error('   Set it with: export LINEAR_API_KEY=lin_api_...');
    process.exit(1);
  }

  // Initialize Linear client
  console.log('\nConnecting to Linear...');
  const linearClient = new LinearClientWrapper(apiKey, config.options.rateLimitMs);

  // Discover workspace
  const workspace = await linearClient.discoverWorkspace();
  
  // Select team
  let teamId: string;
  let teamKey: string;
  
  if (config.target.team === 'prompt') {
    const teamChoices = Array.from(workspace.teams.values())
      .filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i) // dedupe
      .map(t => ({ name: `${t.name} (${t.key})`, value: t.id }));
    
    teamId = await select({
      message: 'Select Linear team:',
      choices: teamChoices,
    });
    
    const teamInfo = Array.from(workspace.teams.values()).find(t => t.id === teamId);
    teamKey = teamInfo?.key || teamId;
  } else {
    const teamInfo = workspace.teams.get(config.target.team);
    if (!teamInfo) {
      console.error(`\n❌ Team not found: ${config.target.team}`);
      console.error(`   Available teams: ${Array.from(workspace.teams.values()).map(t => t.key).join(', ')}`);
      process.exit(1);
    }
    teamId = teamInfo.id;
    teamKey = teamInfo.key;
  }

  console.log(`  Selected team: ${teamKey}`);

  // Re-discover with team context (for issue states)
  await linearClient.discoverWorkspace(teamKey);

  // Fetch existing data for deduplication
  if (config.deduplication?.enabled) {
    await linearClient.fetchExistingProjects(teamId);
    await linearClient.fetchExistingIssues(teamId);
  }

  // Load user mapping if configured
  if (config.userMapping?.file) {
    console.log('\nLoading user mapping...');
    const userMapping = loadUserMapping(config.userMapping.file);
    console.log(`  Loaded ${userMapping.size} user mappings`);
    
    // Add to workspace users
    const ws = linearClient.getWorkspace();
    if (ws) {
      for (const [mondayName, linearId] of userMapping) {
        ws.users.set(mondayName, linearId);
        ws.users.set(mondayName.toLowerCase(), linearId);
      }
    }
  }

  // Run the import
  console.log('\n' + '='.repeat(50));
  console.log(isDryRun ? 'DRY RUN - No changes will be made' : 'Starting import...');
  console.log('='.repeat(50));

  const result = await runMondayImport(board, config, linearClient, teamId, isDryRun);

  // Import updates if configured and available
  if (config.updates?.enabled && updates && updates.updates.length > 0) {
    await importMondayUpdates(updates, config, linearClient, result.mapping, isDryRun, result);
  }

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('IMPORT SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Labels created:   ${result.summary.labelsCreated}`);
  console.log(`  Projects created: ${result.summary.projectsCreated}`);
  console.log(`  Issues created:   ${result.summary.issuesCreated}`);
  console.log(`  Updates added:    ${result.summary.commentsCreated}`);
  console.log(`  Skipped:          ${result.summary.skipped}`);
  console.log(`  Failed:           ${result.summary.failed}`);
  console.log('='.repeat(50));
  console.log(`  API calls made:   ${linearClient.getApiCallCount()}`);
  console.log('='.repeat(50));

  // Save results
  if (!isDryRun) {
    writeFileSync('import-results.json', JSON.stringify(result, null, 2));
    console.log('\n✓ Results saved to: import-results.json');
    
    if (result.failures.length > 0) {
      writeFileSync('import-failures.json', JSON.stringify(result.failures, null, 2));
      console.log('✓ Failures saved to: import-failures.json');
    }
  }

  if (!result.success) {
    process.exit(1);
  }
}
