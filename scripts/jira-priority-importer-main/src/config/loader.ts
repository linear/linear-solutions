import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../types';

export class ConfigLoader {
  static loadFromFile(configPath: string): Config {
    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent) as Config;

      // Validate required fields
      this.validateConfig(config);

      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in configuration file: ${error.message}`);
      }
      throw error;
    }
  }

  static loadFromEnvironment(): Partial<Config> {
    const envConfig: Partial<Config> = {
      linear: {
        apiKey: process.env.LINEAR_API_KEY || '',
        teamId: process.env.LINEAR_TEAM_ID,
        fetchAttachments: process.env.LINEAR_FETCH_ATTACHMENTS !== undefined 
          ? process.env.LINEAR_FETCH_ATTACHMENTS === 'true' 
          : undefined,
        attachmentTimeout: process.env.LINEAR_ATTACHMENT_TIMEOUT 
          ? parseInt(process.env.LINEAR_ATTACHMENT_TIMEOUT, 10) 
          : undefined,
      },
      jira: {
        host: process.env.JIRA_HOST || '',
        email: process.env.JIRA_EMAIL || '',
        apiToken: process.env.JIRA_API_TOKEN || '',
        projectKey: process.env.JIRA_PROJECT_KEY,
      },
    };

    // Only set dryRun if explicitly provided in environment
    if (process.env.DRY_RUN !== undefined) {
      envConfig.dryRun = process.env.DRY_RUN === 'true';
    }

    return envConfig;
  }

  static mergeConfigs(fileConfig: Config, envConfig: Partial<Config>): Config {
    return {
      ...fileConfig,
      linear: {
        ...fileConfig.linear,
        // Only override with env values if they're not empty
        ...(envConfig.linear?.apiKey && envConfig.linear.apiKey.trim() ? { apiKey: envConfig.linear.apiKey } : {}),
        ...(envConfig.linear?.teamId ? { teamId: envConfig.linear.teamId } : {}),
        ...(envConfig.linear?.fetchAttachments !== undefined ? { fetchAttachments: envConfig.linear.fetchAttachments } : {}),
        ...(envConfig.linear?.attachmentTimeout !== undefined ? { attachmentTimeout: envConfig.linear.attachmentTimeout } : {}),
      },
      jira: {
        ...fileConfig.jira,
        // Only override with env values if they're not empty
        ...(envConfig.jira?.host && envConfig.jira.host.trim() ? { host: envConfig.jira.host } : {}),
        ...(envConfig.jira?.email && envConfig.jira.email.trim() ? { email: envConfig.jira.email } : {}),
        ...(envConfig.jira?.apiToken && envConfig.jira.apiToken.trim() ? { apiToken: envConfig.jira.apiToken } : {}),
        ...(envConfig.jira?.projectKey ? { projectKey: envConfig.jira.projectKey } : {}),
      },
      dryRun: envConfig.dryRun !== undefined ? envConfig.dryRun : fileConfig.dryRun,
    };
  }

  private static validateConfig(config: Config): void {
    const requiredFields = [
      'linear.apiKey',
      'jira.host',
      'jira.email',
      'jira.apiToken',
      'matching.strategy',
      'priorityMapping',
    ];

    for (const field of requiredFields) {
      const keys = field.split('.');
      let current: any = config;
      
      for (const key of keys) {
        if (!current || current[key] === undefined || current[key] === '') {
          throw new Error(`Missing required configuration field: ${field}`);
        }
        current = current[key];
      }
    }

    // Validate matching strategy
    const validStrategies = ['identifier', 'attachment-url', 'hybrid'];
    if (!validStrategies.includes(config.matching.strategy)) {
      throw new Error(
        `Invalid matching strategy: ${config.matching.strategy}. Must be one of: ${validStrategies.join(', ')}`
      );
    }

    // Validate priority mappings
    if (!Array.isArray(config.priorityMapping) || config.priorityMapping.length === 0) {
      throw new Error('Priority mappings must be a non-empty array');
    }

    for (let i = 0; i < config.priorityMapping.length; i++) {
      const mapping = config.priorityMapping[i];
      
      if (!mapping.jiraPriority || typeof mapping.jiraPriority !== 'string') {
        throw new Error(`Priority mapping ${i}: jiraPriority must be a non-empty string`);
      }
      
      if (typeof mapping.linearPriority !== 'number' || mapping.linearPriority < 0 || mapping.linearPriority > 4) {
        throw new Error(`Priority mapping ${i}: linearPriority must be a number between 0-4`);
      }
    }

    // Set defaults for optional fields
    config.dryRun = config.dryRun ?? false;
    config.linear.fetchAttachments = config.linear.fetchAttachments ?? true;
    config.linear.attachmentTimeout = config.linear.attachmentTimeout ?? 5000;
  }

  static createSampleConfig(outputPath: string): void {
    const sampleConfig: Config = {
      linear: {
        apiKey: "your-linear-api-key-here",
        teamId: "UUID or Friendly Key (ABC)",
        fetchAttachments: true,
        attachmentTimeout: 5000
      },
      jira: {
        host: "your-company.atlassian.net",
        email: "your-email@company.com",
        apiToken: "your-jira-api-token",
        projectKey: "ABC"
      },
      matching: {
        strategy: "attachment-url"
      },
      priorityMapping: [
        {
          jiraPriority: "Highest",
          linearPriority: 1
        },
        {
          jiraPriority: "High",
          linearPriority: 2
        },
        {
          jiraPriority: "Medium",
          linearPriority: 3
        },
        {
          jiraPriority: "Low",
          linearPriority: 4
        },
        {
          jiraPriority: "Lowest",
          linearPriority: 4
        }
      ],
      dryRun: true
    };

    fs.writeFileSync(outputPath, JSON.stringify(sampleConfig, null, 2));
  }
}
