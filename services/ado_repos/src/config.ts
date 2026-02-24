import "dotenv/config";
import { log } from "./logger.js";

function env(key: string): string | undefined {
  return process.env[key] || undefined;
}

function required(key: string): string {
  const value = env(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// -- Linear auth: OAuth client credentials (preferred) or personal API key --

const linearOauthClientId = env("LINEAR_OAUTH_CLIENT_ID");
const linearOauthClientSecret = env("LINEAR_OAUTH_CLIENT_SECRET");
const linearApiKey = env("LINEAR_API_KEY");

const hasLinearOauth = !!(linearOauthClientId && linearOauthClientSecret);
const hasLinearApiKey = !!linearApiKey;

if (!hasLinearOauth && !hasLinearApiKey) {
  throw new Error(
    "Linear auth not configured. Set either LINEAR_OAUTH_CLIENT_ID + LINEAR_OAUTH_CLIENT_SECRET (preferred) or LINEAR_API_KEY."
  );
}

// -- ADO auth: OAuth/Entra bearer token (preferred) or PAT --

const adoOauthToken = env("ADO_OAUTH_TOKEN");
const adoPat = env("ADO_PAT");

const hasAdoOauth = !!adoOauthToken;
const hasAdoPat = !!adoPat;

if (!hasAdoOauth && !hasAdoPat) {
  throw new Error(
    "ADO auth not configured. Set either ADO_OAUTH_TOKEN (preferred) or ADO_PAT."
  );
}

export const config = {
  linear: {
    authMode: (hasLinearOauth ? "oauth" : "apikey") as "oauth" | "apikey",
    apiKey: linearApiKey,
    oauthClientId: linearOauthClientId,
    oauthClientSecret: linearOauthClientSecret,
  },
  linearWebhookSecret: optional("LINEAR_WEBHOOK_SECRET", ""),

  ado: {
    authMode: (hasAdoOauth ? "oauth" : "pat") as "oauth" | "pat",
    pat: adoPat,
    oauthToken: adoOauthToken,
  },
  adoOrg: required("ADO_ORG"),
  adoProject: required("ADO_PROJECT"),

  webhookSecret: optional("WEBHOOK_SECRET", ""),

  port: parseInt(optional("PORT", "3000"), 10),

  stateMapping: {
    started: optional("LINEAR_STATE_STARTED", "In Progress"),
    inReview: optional("LINEAR_STATE_IN_REVIEW", "In Review"),
    done: optional("LINEAR_STATE_DONE", "Done"),
    cancelled: optional("LINEAR_STATE_CANCELLED", "Cancelled"),
  },
} as const;

// Log which auth modes are active (without revealing secrets)
log.info("config.auth", {
  linearAuth: config.linear.authMode,
  adoAuth: config.ado.authMode,
});
