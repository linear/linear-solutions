import "dotenv/config";
import crypto from "crypto";
import express from "express";
import { LinearClient } from "@linear/sdk";

// --- Config ---

const LINEAR_ACCESS_TOKEN = process.env.LINEAR_ACCESS_TOKEN!;
const WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET!;
const PORT = parseInt(process.env.PORT || "3000", 10);

// Only process issues from these intake sources.
// Remove any you don't use — e.g. drop "email" if you only use Slack Asks.
const ASKS_SOURCE_TYPES = new Set(["slackAsks", "asksWeb", "email"]);

// Optional: restrict to specific team IDs. Leave empty to process all teams.
const TARGET_TEAM_IDS = new Set<string>(
  process.env.TARGET_TEAM_IDS?.split(",").filter(Boolean) ?? []
);

const linear = new LinearClient({ accessToken: LINEAR_ACCESS_TOKEN });

// --- Webhook signature verification ---

function verifySignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// --- GraphQL helpers ---

async function getAsksRequester(
  issueId: string
): Promise<{ id: string; name: string } | null> {
  const response = await linear.client.rawRequest<
    {
      issue: {
        asksRequester: { id: string; name: string } | null;
        creator: { id: string; name: string } | null;
      };
    },
    { id: string }
  >(
    `query AsksRequester($id: String!) {
      issue(id: $id) {
        asksRequester { id name }
        creator { id name }
      }
    }`,
    { id: issueId }
  );
  // asksRequester is null when the creator and requester are the same person
  return response.data?.issue?.asksRequester ?? response.data?.issue?.creator ?? null;
}

async function getAsksExternalRequesterName(
  issueId: string
): Promise<string | null> {
  const response = await linear.client.rawRequest<
    {
      issue: {
        asksExternalUserRequester: { name: string } | null;
      };
    },
    { id: string }
  >(
    `query AsksExternalRequester($id: String!) {
      issue(id: $id) {
        asksExternalUserRequester { name }
      }
    }`,
    { id: issueId }
  );
  return response.data?.issue?.asksExternalUserRequester?.name ?? null;
}

async function shareIssue(issueId: string, userId: string): Promise<boolean> {
  const response = await linear.client.rawRequest<
    { issueShare: { success: boolean } },
    { id: string; userId: string }
  >(
    `mutation IssueShare($id: String!, $userId: String!) {
      issueShare(id: $id, userId: $userId) { success }
    }`,
    { id: issueId, userId }
  );
  return response.data?.issueShare?.success ?? false;
}

// --- Core logic ---

interface WebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    teamId: string;
    integrationSourceType?: string;
  };
}

async function handleIssueCreated(payload: WebhookPayload) {
  const { id, identifier, teamId, integrationSourceType } = payload.data;

  if (!integrationSourceType || !ASKS_SOURCE_TYPES.has(integrationSourceType)) {
    return;
  }

  if (TARGET_TEAM_IDS.size > 0 && !TARGET_TEAM_IDS.has(teamId)) {
    return;
  }

  console.log(`[${identifier}] Asks issue (${integrationSourceType})`);

  const requester = await getAsksRequester(id);

  if (!requester) {
    const extName = await getAsksExternalRequesterName(id);
    if (extName) {
      console.log(
        `[${identifier}] External requester (${extName}) — cannot auto-share, needs manual handling`
      );
    } else {
      console.log(`[${identifier}] No requester found, skipping`);
    }
    return;
  }

  console.log(`[${identifier}] Sharing with ${requester.name}`);

  try {
    const success = await shareIssue(id, requester.id);
    if (success) {
      console.log(`[${identifier}] Done`);
    } else {
      console.warn(`[${identifier}] issueShare returned success=false`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already") || msg.includes("access")) {
      console.log(`[${identifier}] Requester already has access`);
    } else {
      console.error(`[${identifier}] Share failed: ${msg}`);
    }
  }
}

// --- Server ---

const app = express();

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (
      !verifySignature(req.body, req.headers["linear-signature"] as string)
    ) {
      res.status(401).send("Invalid signature");
      return;
    }

    const payload: WebhookPayload = JSON.parse(req.body.toString());
    console.log(`Webhook received: action=${payload.action} type=${payload.type} integrationSourceType=${payload.data?.integrationSourceType ?? "none"} id=${payload.data?.identifier ?? "unknown"}`);
    res.status(200).send("ok");

    if (payload.action === "create" && payload.type === "Issue") {
      handleIssueCreated(payload).catch((err) => {
        console.error(`Error processing ${payload.data.identifier}:`);
        console.error(err);
      });
    }
  }
);

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`Listening on :${PORT}`));
