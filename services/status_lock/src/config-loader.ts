/**
 * Configuration loader and validator for the Issue Lock Agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Config,
  AllowlistEntry,
  AllowlistLeaf,
  AllowlistGroup,
  isAllowlistGroup,
  MonitoredField,
  ALL_MONITORED_FIELDS
} from './types';

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../config/config.json');
const VALID_FIELDS = new Set<MonitoredField>(ALL_MONITORED_FIELDS);
const MAX_ALLOWLIST_DEPTH = 10;

/**
 * Load and validate configuration from file.
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
 * Validate configuration structure and required fields.
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  // Locked statuses — must lock by name or by type.
  const hasNames = Array.isArray(config.lockedStatuses) && config.lockedStatuses.length > 0;
  const hasTypes = Array.isArray(config.lockedStatusTypes) && config.lockedStatusTypes.length > 0;
  if (!Array.isArray(config.lockedStatuses)) {
    errors.push('lockedStatuses must be an array');
  }
  if (config.lockedStatusTypes !== undefined && !Array.isArray(config.lockedStatusTypes)) {
    errors.push('lockedStatusTypes must be an array when present');
  }
  if (!hasNames && !hasTypes) {
    errors.push('Provide at least one entry in lockedStatuses or lockedStatusTypes');
  }

  // Monitored fields
  if (!Array.isArray(config.monitoredFields) || config.monitoredFields.length === 0) {
    errors.push('monitoredFields must be a non-empty array');
  } else {
    config.monitoredFields.forEach((f, i) => {
      if (!VALID_FIELDS.has(f)) {
        errors.push(
          `monitoredFields[${i}]: "${f}" is not valid. Valid values: ${ALL_MONITORED_FIELDS.join(', ')}`
        );
      }
    });
  }

  // Allowlist (may be empty — meaning nobody can edit a locked issue except the agent)
  if (!config.allowlist || !Array.isArray(config.allowlist)) {
    errors.push('allowlist must be an array (may be empty)');
  } else {
    config.allowlist.forEach((entry, i) => {
      validateAllowlistEntry(entry, `allowlist[${i}]`, 0, errors);
    });
  }

  // Agent
  if (!config.agent || !config.agent.name || !config.agent.identifier) {
    errors.push('agent must have name and identifier');
  }

  // Slack
  if (!config.slack || typeof config.slack.enabled !== 'boolean') {
    errors.push('slack must have an enabled boolean');
  }
  if (config.slack?.enabled && !config.slack.channelId) {
    errors.push('slack.channelId is required when slack is enabled');
  }

  // Behavior
  if (!config.behavior || typeof config.behavior !== 'object') {
    errors.push('behavior configuration is required');
  }

  // Logging
  if (!config.logging || !config.logging.level) {
    errors.push('logging configuration is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

function validateAllowlistEntry(
  entry: AllowlistEntry,
  path: string,
  depth: number,
  errors: string[]
): void {
  if (depth > MAX_ALLOWLIST_DEPTH) {
    errors.push(`${path}: allowlist nesting exceeds maximum depth of ${MAX_ALLOWLIST_DEPTH}`);
    return;
  }

  if (isAllowlistGroup(entry)) {
    const group = entry as AllowlistGroup;
    if (!group.name) {
      errors.push(`${path}: group entry must have a name`);
    }
    if (!group.linearTeamId && (!group.members || group.members.length === 0)) {
      errors.push(`${path} ("${group.name}"): group must have at least one member or a linearTeamId`);
    }
    (group.members ?? []).forEach((member, i) => {
      validateAllowlistEntry(member, `${path}.members[${i}]`, depth + 1, errors);
    });
  } else {
    const leaf = entry as AllowlistLeaf;
    if (!leaf.email && !leaf.id) {
      errors.push(`${path}: leaf entry must have either email or id`);
    }
  }
}

/**
 * Validate environment variables.
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

  if (!process.env.LINEAR_WEBHOOK_SECRET) {
    console.warn(
      '⚠️  LINEAR_WEBHOOK_SECRET not set. Webhook signature verification will be skipped (not recommended for production).'
    );
  }
}
