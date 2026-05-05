import * as fs from 'fs';
import { Config, CustomFieldConfig } from '../types';

export class ConfigLoader {
  static loadFromFile(configPath: string): Config {
    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent) as Config;

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
        filterJql: process.env.JIRA_FILTER_JQL,
      },
    };

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
        ...(envConfig.linear?.apiKey?.trim() ? { apiKey: envConfig.linear.apiKey } : {}),
        ...(envConfig.linear?.teamId ? { teamId: envConfig.linear.teamId } : {}),
        ...(envConfig.linear?.fetchAttachments !== undefined
          ? { fetchAttachments: envConfig.linear.fetchAttachments }
          : {}),
        ...(envConfig.linear?.attachmentTimeout !== undefined
          ? { attachmentTimeout: envConfig.linear.attachmentTimeout }
          : {}),
      },
      jira: {
        ...fileConfig.jira,
        ...(envConfig.jira?.host?.trim() ? { host: envConfig.jira.host } : {}),
        ...(envConfig.jira?.email?.trim() ? { email: envConfig.jira.email } : {}),
        ...(envConfig.jira?.apiToken?.trim() ? { apiToken: envConfig.jira.apiToken } : {}),
        ...(envConfig.jira?.projectKey ? { projectKey: envConfig.jira.projectKey } : {}),
        ...(envConfig.jira?.filterJql ? { filterJql: envConfig.jira.filterJql } : {}),
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
      'customFields',
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

    const validStrategies = ['identifier', 'attachment-url', 'hybrid'];
    if (!validStrategies.includes(config.matching.strategy)) {
      throw new Error(
        `Invalid matching strategy: ${config.matching.strategy}. Must be one of: ${validStrategies.join(', ')}`
      );
    }

    if (!Array.isArray(config.customFields) || config.customFields.length === 0) {
      throw new Error('customFields must be a non-empty array');
    }

    for (let i = 0; i < config.customFields.length; i++) {
      const field = config.customFields[i];
      if (!field.jiraFieldName || typeof field.jiraFieldName !== 'string') {
        throw new Error(`customFields[${i}]: jiraFieldName must be a non-empty string`);
      }
      if (!field.descriptionLabel || typeof field.descriptionLabel !== 'string') {
        throw new Error(`customFields[${i}]: descriptionLabel must be a non-empty string`);
      }
    }

    // Set defaults
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
        attachmentTimeout: 5000,
        // projectName: "Q2 Migration",         // Optional: only issues in this Linear project
        // labels: ["needs-import"],             // Optional: only issues with these labels
        // states: ["In Progress", "Todo"],      // Optional: only issues in these states
      },
      jira: {
        host: "your-company.atlassian.net",
        email: "your-email@company.com",
        apiToken: "your-jira-api-token",
        projectKey: "ABC",
        // filterJql: "sprint = 'Sprint 5'",    // Optional: additional JQL filter
      },
      matching: {
        strategy: "attachment-url",
      },
      customFields: [
        {
          jiraFieldName: "customfield_10014",
          descriptionLabel: "Acceptance Criteria",
        },
        {
          jiraFieldName: "customfield_10020",
          descriptionLabel: "Business Value",
        },
      ],
      dryRun: true,
    };

    fs.writeFileSync(outputPath, JSON.stringify(sampleConfig, null, 2));
  }
}
