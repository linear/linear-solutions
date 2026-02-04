#!/usr/bin/env node

/**
 * Monday.com to Linear Import CLI
 * 
 * A config-driven tool for importing Monday.com Excel exports to Linear.
 */

// Load .env file before anything else
import 'dotenv/config';

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { usersCommand } from './commands/users.js';

const program = new Command();

program
  .name('monday-import')
  .description('Import Monday.com exports to Linear')
  .version('1.0.0');

// Init command - generate config via wizard
program
  .command('init <excel-file>')
  .description('Analyze Excel and generate config via interactive wizard')
  .option('-o, --output <path>', 'Output config path', 'import-config.json')
  .action(async (excelFile, options) => {
    try {
      await initCommand(excelFile, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Validate command - validate config against Excel
program
  .command('validate')
  .description('Validate config and Excel compatibility')
  .requiredOption('-c, --config <path>', 'Config file path')
  .requiredOption('-f, --file <path>', 'Excel file path')
  .action(async (options) => {
    try {
      await validateCommand(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Dry-run command - preview import
program
  .command('dry-run')
  .description('Preview import without making changes')
  .requiredOption('-c, --config <path>', 'Config file path')
  .requiredOption('-f, --file <path>', 'Excel file path')
  .action(async (options) => {
    try {
      await runCommand({ ...options, dryRun: true });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Run command - execute import
program
  .command('run')
  .description('Execute the import')
  .requiredOption('-c, --config <path>', 'Config file path')
  .requiredOption('-f, --file <path>', 'Excel file path')
  .option('--continue-on-error', 'Continue if individual items fail', true)
  .action(async (options) => {
    try {
      await runCommand(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Users command - generate user mapping template
program
  .command('users')
  .description('Generate user mapping template from Excel')
  .requiredOption('-f, --file <path>', 'Excel file path')
  .option('-o, --output <path>', 'Output file path', 'user-mapping.json')
  .option('-s, --sheet <name>', 'Sheet name to analyze')
  .action(async (options) => {
    try {
      await usersCommand(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
