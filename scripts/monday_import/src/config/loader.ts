/**
 * Configuration loader with validation
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ImportConfig } from './schema.js';
import { DEFAULT_CONFIG } from './schema.js';
import { validateConfig, type ValidationResult } from './validator.js';

export interface LoadResult {
  config: ImportConfig | null;
  validation: ValidationResult;
}

/**
 * Load and validate configuration from a JSON file
 */
export function loadConfig(configPath: string): LoadResult {
  const absolutePath = resolve(configPath);
  
  if (!existsSync(absolutePath)) {
    return {
      config: null,
      validation: {
        valid: false,
        errors: [{ path: '', message: `Config file not found: ${absolutePath}` }],
        warnings: [],
      },
    };
  }

  let rawConfig: unknown;
  try {
    const content = readFileSync(absolutePath, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (error) {
    return {
      config: null,
      validation: {
        valid: false,
        errors: [{ 
          path: '', 
          message: `Failed to parse config file: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }],
        warnings: [],
      },
    };
  }

  // Merge with defaults
  const config = mergeWithDefaults(rawConfig as Partial<ImportConfig>);
  
  // Resolve relative paths in config
  const configDir = dirname(absolutePath);
  if (config.userMapping?.file) {
    config.userMapping.file = resolve(configDir, config.userMapping.file);
  }

  // Validate the merged config
  const validation = validateConfig(config);

  return {
    config: validation.valid ? config : null,
    validation,
  };
}

/**
 * Deep merge user config with defaults
 */
function mergeWithDefaults(userConfig: Partial<ImportConfig>): ImportConfig {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    source: {
      ...DEFAULT_CONFIG.source,
      ...userConfig.source,
      sheets: {
        ...DEFAULT_CONFIG.source?.sheets,
        ...userConfig.source?.sheets,
      },
    },
    target: {
      ...DEFAULT_CONFIG.target,
      ...userConfig.target,
    },
    dataModel: {
      ...DEFAULT_CONFIG.dataModel,
      ...userConfig.dataModel,
      items: {
        ...DEFAULT_CONFIG.dataModel?.items,
        ...userConfig.dataModel?.items,
      },
    },
    options: {
      ...DEFAULT_CONFIG.options,
      ...userConfig.options,
    },
    statusMapping: {
      ...DEFAULT_CONFIG.statusMapping,
      ...userConfig.statusMapping,
    },
    priorityMapping: {
      ...DEFAULT_CONFIG.priorityMapping,
      ...userConfig.priorityMapping,
    },
  } as ImportConfig;
}

/**
 * Load user mapping from JSON file
 */
export function loadUserMapping(filePath: string): Map<string, string> {
  const mapping = new Map<string, string>();
  
  if (!existsSync(filePath)) {
    return mapping;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, string>;
    
    for (const [mondayName, linearIdentifier] of Object.entries(data)) {
      // Skip instruction fields
      if (mondayName.startsWith('_')) continue;
      
      if (linearIdentifier && linearIdentifier !== '_skip') {
        mapping.set(mondayName, linearIdentifier);
        mapping.set(mondayName.toLowerCase(), linearIdentifier);
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to load user mapping from ${filePath}`);
  }

  return mapping;
}
