/**
 * Configuration loader and validator
 */

import * as fs from 'fs';
import * as path from 'path';
import { Config, AllowlistEntry, AllowlistLeaf, AllowlistGroup, isAllowlistGroup, Permission, ALL_PERMISSIONS } from './types';

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../config/config.json');
const VALID_PERMISSIONS = new Set<Permission>(['labels', 'sla', 'priority', 'slaBaseline']);
const MAX_ALLOWLIST_DEPTH = 10;

/**
 * Load and validate configuration from file.
 * Normalises legacy flat allowlist entries for backward compatibility.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(configContent);

    // Normalize legacy flat allowlist entries before validation
    if (Array.isArray(raw.allowlist)) {
      raw.allowlist = normalizeLegacyAllowlist(raw.allowlist);
    }

    const config: Config = raw;
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
 * Coerce legacy flat AllowlistUser entries (no `members`, no `linearTeamId`)
 * into AllowlistLeaf objects. New-style entries pass through unchanged.
 *
 * A legacy entry looks like: { email, id, name }
 * It becomes:                { email, id, name, permissions: undefined }
 * which the engine interprets as "all permissions" — fully backward-compatible.
 */
export function normalizeLegacyAllowlist(entries: any[]): AllowlistEntry[] {
  return entries.map(entry => {
    if (entry.members !== undefined || entry.linearTeamId !== undefined) {
      // Already a group — recurse into members
      if (entry.members) {
        entry.members = normalizeLegacyAllowlist(entry.members);
      }
      return entry as AllowlistGroup;
    }
    // Legacy flat entry — treat as leaf, preserve all existing fields
    return entry as AllowlistLeaf;
  });
}

/**
 * Validate configuration structure and required fields.
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];

  // Protected labels
  if (!config.protectedLabels || !Array.isArray(config.protectedLabels)) {
    errors.push('protectedLabels must be an array');
  } else if (config.protectedLabels.length === 0) {
    errors.push('protectedLabels must contain at least one label name');
  }

  // Protected fields
  if (!config.protectedFields || typeof config.protectedFields !== 'object') {
    errors.push('protectedFields must be an object');
  }

  // Allowlist — hierarchical validation
  if (!config.allowlist || !Array.isArray(config.allowlist)) {
    errors.push('allowlist must be an array');
  } else if (config.allowlist.length === 0) {
    errors.push('allowlist must contain at least one entry');
  } else {
    config.allowlist.forEach((entry, i) => {
      validateAllowlistEntry(entry, `allowlist[${i}]`, 0, errors);
    });
  }

  // Agent config
  if (!config.agent || !config.agent.name || !config.agent.identifier) {
    errors.push('agent must have name and identifier');
  }

  // Slack config
  if (!config.slack || typeof config.slack.enabled !== 'boolean') {
    errors.push('slack must have enabled boolean');
  }
  if (config.slack?.enabled && !config.slack.channelId) {
    errors.push('slack.channelId is required when slack is enabled');
  }

  // Behavior config
  if (!config.behavior || typeof config.behavior !== 'object') {
    errors.push('behavior configuration is required');
  }

  // Logging config
  if (!config.logging || !config.logging.level) {
    errors.push('logging configuration is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Recursively validate an allowlist entry.
 * Detects cycles via the path argument (same group name appearing twice in
 * the same ancestor chain).
 */
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

  // Validate permissions if present
  if ('permissions' in entry && entry.permissions !== undefined) {
    if (!Array.isArray(entry.permissions)) {
      errors.push(`${path}.permissions must be an array`);
    } else {
      entry.permissions.forEach((p, i) => {
        if (!VALID_PERMISSIONS.has(p as Permission)) {
          errors.push(
            `${path}.permissions[${i}]: "${p}" is not a valid permission. ` +
            `Valid values: ${Array.from(VALID_PERMISSIONS).join(', ')}`
          );
        }
      });
    }
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
    console.warn('⚠️  LINEAR_WEBHOOK_SECRET not set. Webhook signature verification will be skipped (not recommended for production).');
  }
}
