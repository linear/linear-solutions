/**
 * Configuration loader and validator
 */

import * as fs from 'fs';
import * as path from 'path';
import { Config } from './types';

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../config/config.json');

/**
 * Load and validate configuration from file
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: Config = JSON.parse(configContent);
    
    validateConfig(config);
    
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration file not found at ${configPath}. ` +
        `Please copy config.json.example to config.json and update it with your settings.`
      );
    }
    throw new Error(`Failed to load configuration: ${(error as Error).message}`);
  }
}

/**
 * Validate configuration structure and required fields
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  // Validate protected labels
  if (!config.protectedLabels || !Array.isArray(config.protectedLabels)) {
    errors.push('protectedLabels must be an array');
  } else if (config.protectedLabels.length === 0) {
    errors.push('protectedLabels must contain at least one label name');
  }

  // Validate protected fields
  if (!config.protectedFields || typeof config.protectedFields !== 'object') {
    errors.push('protectedFields must be an object');
  }

  // Validate allowlist
  if (!config.allowlist || !Array.isArray(config.allowlist)) {
    errors.push('allowlist must be an array');
  } else if (config.allowlist.length === 0) {
    errors.push('allowlist must contain at least one user');
  } else {
    config.allowlist.forEach((user, index) => {
      if (!user.email && !user.id) {
        errors.push(`allowlist[${index}] must have either email or id`);
      }
    });
  }

  // Validate agent config
  if (!config.agent || !config.agent.name || !config.agent.identifier) {
    errors.push('agent must have name and identifier');
  }

  // Validate slack config
  if (!config.slack || typeof config.slack.enabled !== 'boolean') {
    errors.push('slack must have enabled boolean');
  }
  if (config.slack?.enabled && !config.slack.channelId) {
    errors.push('slack.channelId is required when slack is enabled');
  }

  // Validate behavior config
  if (!config.behavior || typeof config.behavior !== 'object') {
    errors.push('behavior configuration is required');
  }

  // Validate logging config
  if (!config.logging || !config.logging.level) {
    errors.push('logging configuration is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Validate environment variables
 */
export function validateEnvironment(): void {
  const required = ['LINEAR_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Please check your .env file.`
    );
  }

  // Warn about optional but recommended vars
  if (!process.env.LINEAR_WEBHOOK_SECRET) {
    console.warn('⚠️  LINEAR_WEBHOOK_SECRET not set. Webhook signature verification will be skipped (not recommended for production).');
  }
}

