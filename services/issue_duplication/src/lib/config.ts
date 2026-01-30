import { config as dotenvConfig } from "dotenv";
import type { Config, DuplicationRule, TargetTeam } from "../types.js";

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  // Load .env file if present
  dotenvConfig();

  const linearClientId = process.env.LINEAR_CLIENT_ID;
  const linearClientSecret = process.env.LINEAR_CLIENT_SECRET;
  const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  const linearAccessToken = process.env.LINEAR_ACCESS_TOKEN;
  const duplicationRulesJson = process.env.DUPLICATION_RULES;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Validate required fields
  const errors: string[] = [];

  if (!linearClientId) {
    errors.push("LINEAR_CLIENT_ID is required");
  }
  if (!linearClientSecret) {
    errors.push("LINEAR_CLIENT_SECRET is required");
  }
  if (!linearWebhookSecret) {
    errors.push("LINEAR_WEBHOOK_SECRET is required");
  }
  if (!linearAccessToken) {
    errors.push("LINEAR_ACCESS_TOKEN is required");
  }
  if (!duplicationRulesJson) {
    errors.push("DUPLICATION_RULES is required");
  }

  // Parse and validate DUPLICATION_RULES
  let duplicationRules: DuplicationRule[] = [];
  if (duplicationRulesJson) {
    try {
      const parsed = JSON.parse(duplicationRulesJson);
      if (!Array.isArray(parsed)) {
        errors.push("DUPLICATION_RULES must be a JSON array");
      } else {
        duplicationRules = parsed.map((rule, ruleIndex) => {
          const ruleErrors = validateRule(rule, ruleIndex);
          errors.push(...ruleErrors);
          return {
            name: rule.name || `Rule ${ruleIndex + 1}`,
            triggerLabelName: rule.triggerLabelName,
            sourceTeamId: rule.sourceTeamId,
            targetTeams: (rule.targetTeams || []).map((t: TargetTeam) => ({
              name: t.name,
              teamId: t.teamId,
            })),
          };
        });

        if (duplicationRules.length === 0) {
          errors.push("DUPLICATION_RULES must contain at least one rule");
        }
      }
    } catch {
      errors.push("DUPLICATION_RULES must be valid JSON");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    linearClientId: linearClientId!,
    linearClientSecret: linearClientSecret!,
    linearWebhookSecret: linearWebhookSecret!,
    linearAccessToken: linearAccessToken!,
    duplicationRules,
    port,
  };
}

/**
 * Validate a single duplication rule
 */
function validateRule(rule: Record<string, unknown>, index: number): string[] {
  const errors: string[] = [];
  const prefix = `DUPLICATION_RULES[${index}]`;

  if (!rule.triggerLabelName || typeof rule.triggerLabelName !== "string") {
    errors.push(`${prefix}.triggerLabelName must be a non-empty string`);
  }

  if (!rule.sourceTeamId || typeof rule.sourceTeamId !== "string") {
    errors.push(`${prefix}.sourceTeamId must be a non-empty string`);
  }

  if (!Array.isArray(rule.targetTeams)) {
    errors.push(`${prefix}.targetTeams must be an array`);
  } else if (rule.targetTeams.length === 0) {
    errors.push(`${prefix}.targetTeams must contain at least one team`);
  } else {
    rule.targetTeams.forEach((team: Record<string, unknown>, teamIndex: number) => {
      if (!team.name || typeof team.name !== "string") {
        errors.push(`${prefix}.targetTeams[${teamIndex}].name must be a non-empty string`);
      }
      if (!team.teamId || typeof team.teamId !== "string") {
        errors.push(`${prefix}.targetTeams[${teamIndex}].teamId must be a non-empty string`);
      }
    });
  }

  return errors;
}

/**
 * Singleton config instance
 */
let configInstance: Config | null = null;

/**
 * Get the configuration, loading it if necessary
 */
export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
