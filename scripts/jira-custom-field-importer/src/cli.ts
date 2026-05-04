#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { ConfigLoader } from './config/loader';
import { CustomFieldSync } from './sync';
import { ConsoleLogger } from './utils/logger';

dotenv.config();

const program = new Command();

program
  .name('jira-custom-field-importer')
  .description('Import Jira custom field values into Linear issue descriptions')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync Jira custom fields into Linear issue descriptions')
  .option('-c, --config <path>', 'Path to configuration file', './config.json')
  .option('-d, --dry-run', 'Perform a dry run without making changes')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const logger = new ConsoleLogger(options.verbose);

    try {
      logger.info('Starting Jira Custom Field Importer...');

      logger.info(`Loading configuration from: ${options.config}`);
      const fileConfig = ConfigLoader.loadFromFile(options.config);
      const envConfig = ConfigLoader.loadFromEnvironment();
      const config = ConfigLoader.mergeConfigs(fileConfig, envConfig);

      if (options.dryRun) {
        config.dryRun = true;
      }

      if (config.dryRun) {
        logger.info('Running in DRY RUN mode - no changes will be made to Linear');
      }

      const sync = new CustomFieldSync(config, logger);
      const result = await sync.run();

      if (result.errors.length > 0) {
        logger.error('Sync completed with errors');
        process.exit(1);
      } else {
        logger.info('Sync completed successfully');
        process.exit(0);
      }
    } catch (error) {
      logger.error(`Sync failed: ${error}`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <path>', 'Output path for configuration file', './config.json')
  .action((options) => {
    try {
      ConfigLoader.createSampleConfig(options.output);
      console.log(`Sample configuration created at: ${options.output}`);
      console.log('\nNext steps:');
      console.log('1. Edit the configuration file with your API credentials');
      console.log('2. Specify the Jira custom fields you want to import');
      console.log('3. Run: npm run dev -- sync --dry-run');
    } catch (error) {
      console.error(`Failed to create configuration file: ${error}`);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate configuration file and test API connections')
  .option('-c, --config <path>', 'Path to configuration file', './config.json')
  .action(async (options) => {
    const logger = new ConsoleLogger(true);

    try {
      logger.info('Validating configuration...');
      const fileConfig = ConfigLoader.loadFromFile(options.config);
      const envConfig = ConfigLoader.loadFromEnvironment();
      const config = ConfigLoader.mergeConfigs(fileConfig, envConfig);

      const sync = new CustomFieldSync(config, logger, { skipConfirmation: true });
      await sync['validateConfiguration']();
      await sync['testConnections']();

      logger.info('Configuration is valid and API connections work!');
    } catch (error) {
      logger.error(`Configuration validation failed: ${error}`);
      process.exit(1);
    }
  });

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

program.parse();
