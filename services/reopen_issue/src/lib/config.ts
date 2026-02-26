import { config as dotenvConfig } from "dotenv";
import type { Config } from "../types.js";

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  dotenvConfig();

  const linearClientId = process.env.LINEAR_CLIENT_ID;
  const linearClientSecret = process.env.LINEAR_CLIENT_SECRET;
  const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  const linearAccessToken = process.env.LINEAR_ACCESS_TOKEN;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  const errors: string[] = [];

  if (!linearClientId) errors.push("LINEAR_CLIENT_ID is required");
  if (!linearClientSecret) errors.push("LINEAR_CLIENT_SECRET is required");
  if (!linearWebhookSecret) errors.push("LINEAR_WEBHOOK_SECRET is required");
  if (!linearAccessToken) errors.push("LINEAR_ACCESS_TOKEN is required");

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    linearClientId: linearClientId!,
    linearClientSecret: linearClientSecret!,
    linearWebhookSecret: linearWebhookSecret!,
    linearAccessToken: linearAccessToken!,
    port,
  };
}

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
