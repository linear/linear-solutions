#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { ConfigLoader } from './config/loader';
import { PrioritySync } from './sync';
import { ConsoleLogger } from './utils/logger';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('jira-priority-importer')
  .description('Sync priorities from Jira issues to Linear issues')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync priorities from Jira to Linear')
  .option('-c, --config <path>', 'Path to configuration file', './config.json')
  .option('-d, --dry-run', 'Perform a dry run without making changes')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const logger = new ConsoleLogger(options.verbose);
    
    try {
      logger.info('Starting Jira Priority Importer...');

      // Load configuration
      logger.info(`Loading configuration from: ${options.config}`);
      const fileConfig = ConfigLoader.loadFromFile(options.config);
      const envConfig = ConfigLoader.loadFromEnvironment();
      const config = ConfigLoader.mergeConfigs(fileConfig, envConfig);

      // Override dry run if specified as command line option
      if (options.dryRun) {
        config.dryRun = true;
      }

      if (config.dryRun) {
        logger.info('Running in DRY RUN mode - no changes will be made to Linear');
      }

      // Run the sync
      const sync = new PrioritySync(config, logger);
      const result = await sync.run();

      // Exit with appropriate code
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
      console.log('2. Adjust the priority mappings as needed');
      console.log('3. Run: npx jira-priority-importer sync');
    } catch (error) {
      console.error(`Failed to create configuration file: ${error}`);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate configuration file')
  .option('-c, --config <path>', 'Path to configuration file', './config.json')
  .action(async (options) => {
    const logger = new ConsoleLogger(true);
    
    try {
      logger.info('Validating configuration...');
      const fileConfig = ConfigLoader.loadFromFile(options.config);
      const envConfig = ConfigLoader.loadFromEnvironment();
      const config = ConfigLoader.mergeConfigs(fileConfig, envConfig);

      // Test API connections
      const { PrioritySync } = await import('./sync');
      const sync = new PrioritySync(config, logger, { skipConfirmation: true });
      
      // This will validate config and test connections but not run sync
      await sync['validateConfiguration']();
      await sync['testConnections']();
      
      logger.info('Configuration is valid and API connections work!');
    } catch (error) {
      logger.error(`Configuration validation failed: ${error}`);
      process.exit(1);
    }
  });

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

program.parse();
