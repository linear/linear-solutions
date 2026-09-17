# Auto-Share Linear Asks Issues on Private Teams

[Video Walkthrough](https://share.linear.app/bSm2zgwM)

## What this does

When someone submits an Ask (via Slack, email, or web form) to a private team, this automatically shares the issue back to the person who requested it, so they can track progress without being a member of the private team.

## How it works

```
Requester submits Ask → Issue created on private team → Webhook fires
→ Service checks: is this an Asks issue? → Fetches the requester
→ Calls issueShare to grant them access → Requester can now see the issue
```

## Prerequisites

- **Issue sharing enabled** on the private team (Team Settings → General → Issue sharing)
- **Issue sharing permission set to "All members"** on the private team (Team Settings → Security → Issue sharing). By default this is "Owners only”, the OAuth app is a team member, not an owner, so this must be changed.
- **An OAuth application** with access to the private team (see step 1 below)
- **Asks** configured on the private team (Slack, email, or web form intake)

## Setup

### 1. Create an OAuth application with a webhook

Go to **Settings → API → OAuth applications → New application**.

- Give it a name (e.g. "Asks Auto-Share")
- Set the redirect URI to your service's callback URL
- Under the app's **Webhooks** section, add a webhook:
  - **URL**: `https://your-host.com/webhook`
  - **Resource types**: check `Issues`
  - **Team**: select your private team (or leave blank for all teams and use `TARGET_TEAM_IDS` to filter)
- After creating it, a workspace admin needs to **authorize the app** and grant it access to the private team

From the OAuth app you'll get:
- An **access token** → use as `LINEAR_ACCESS_TOKEN`
- A webhook **signing secret** → use as `LINEAR_WEBHOOK_SECRET`

### 2. Configure environment variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

```bash
LINEAR_ACCESS_TOKEN=lin_oauth_xxxxx   # OAuth access token from step 1
LINEAR_WEBHOOK_SECRET=xxxxx           # webhook signing secret from step 1
PORT=3000                             # optional, default 3000
TARGET_TEAM_IDS=                      # optional, comma-separated team UUIDs (not team keys)
```

`TARGET_TEAM_IDS` accepts team **UUIDs** (e.g. `a1b2c3d4-e5f6-...`), not team keys (e.g. `LEG`). You can find a team's UUID via the API, in the URL when viewing the team's settings, or by pressing `CMD + K` or `CTRL + K` and using the `Copy model UUID` selection. Leave it blank if your webhook is already scoped to a specific team.

### 3. Install and run

```bash
npm install
npm run dev     # development (auto-reload)
npm run build   # compile
npm start       # production
```

The service reads from `.env` at startup. If you're integrating into an existing service, just make sure `LINEAR_ACCESS_TOKEN` and `LINEAR_WEBHOOK_SECRET` are set in whatever environment config you already use.

## Testing locally

Use a tunnel (ngrok, Cloudflare Tunnel, etc.) to expose your local server:

```bash
ngrok http 3000
```

Update the webhook URL in Linear to your tunnel URL (e.g. `https://abc123.ngrok.io/webhook`).

Then submit a test Ask to the private team via Slack or email. You should see logs like:

```
[LEG-42] Asks issue (slackAsks)
[LEG-42] Sharing with Jane Doe
[LEG-42] Done
```

Verify by checking the issue in Linear, the requester should now appear under "Shared with" on the issue.
