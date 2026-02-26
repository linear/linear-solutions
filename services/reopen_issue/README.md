# Linear Reopen Issue Agent

A webhook-driven agent for Linear that automatically reopens done issues when new comments arrive in synced threads (e.g., from Slack). When an external user comments on a synced thread attached to a completed or canceled issue, the agent moves the issue back to an active workflow state. Linear's built-in `issueReopened` notification then alerts the last assignee — no extra notification is generated.

### NOTE
This is a small automation developed by the Linear Solutions Engineering team, it is not a formal feature or integration supported by Linear. This should be used by your team as a prototype to adapt, configure, host, and maintain for your organization.

https://www.loom.com/share/4d9f1665faa845eba8b7ff8b3abff235

## How It Works

1. An external user (e.g., a customer in Slack) posts a message in a thread that is synced to a Linear issue
2. Linear fires a Comment webhook to this service
3. The service verifies the comment is from an external user (`externalUserId` present)
4. It checks whether the issue is in a **completed** or **canceled** state
5. If so, it transitions the issue to the team's first **started** workflow state (falling back to **unstarted**)
6. Linear's internal `IssueReopenedProcessor` automatically sends an `issueReopened` notification to the current assignee

### Safeguards

- **External-only**: Only comments with an `externalUserId` (synced thread messages from outside Linear) trigger a reopen
- **Done-state check**: Issues that are already active are left untouched
- **Assignee required**: Issues without an assignee are skipped (no one to notify)
- **Signature verification**: All webhooks are verified via HMAC-SHA256 before processing

## Prerequisites

- Node.js 18 or later
- A Linear workspace with admin access

## Setup

### 1. Create a Linear OAuth Application

1. Go to [Linear Settings > API > Applications](https://linear.app/settings/api/applications/new)
2. Create a new application with these settings:
   - **Name**: Reopen Issue Agent (or your preferred name)
   - **Webhooks**: Enable and select **Comments** under "Data change events"
   - **Webhook URL**: Your server's endpoint (e.g., `https://your-domain.com/reopen-issue`)
3. Click **Create**
4. Note for your .env file:
   - **Client ID** — `LINEAR_CLIENT_ID`
   - **Client Secret** — `LINEAR_CLIENT_SECRET`
   - **Developer Token** (Choose 'App') — `LINEAR_ACCESS_TOKEN`
   - **Webhook Signing Secret** — `LINEAR_WEBHOOK_SECRET`

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=your_webhook_signing_secret
LINEAR_ACCESS_TOKEN=your_developer_token
PORT=3000
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

### 5. Expose Your Webhook Endpoint

Your server needs to be publicly accessible for Linear to send webhooks.

**For local development**, use a tunnel service like ngrok:

```bash
ngrok http 3000
```

Then update your Linear OAuth application's webhook URL to: `https://your-ngrok-url.ngrok.io/reopen-issue`

**For production**, deploy to your hosting provider and use your server's public URL.

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_CLIENT_ID` | Yes | OAuth application client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth application client secret |
| `LINEAR_WEBHOOK_SECRET` | Yes | Webhook signing secret from OAuth application |
| `LINEAR_ACCESS_TOKEN` | Yes | OAuth developer token |
| `PORT` | No | Server port (default: 3000) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/reopen-issue` | POST | Linear webhook receiver |
| `/health` | GET | Health check endpoint |
| `/` | GET | Service information |

## Troubleshooting

### Webhook not receiving events

1. Verify your webhook URL is publicly accessible (try accessing `/health` endpoint)
2. Check that **Comments** is enabled in your Linear OAuth application's webhook settings
3. Verify the webhook signing secret matches your `LINEAR_WEBHOOK_SECRET`
4. Check recent webhook deliveries in your OAuth app settings

### Signature verification failing

- Ensure `LINEAR_WEBHOOK_SECRET` matches the signing secret from your Linear OAuth application
- The raw request body must be used for verification (not parsed JSON)

### Issue not being reopened

1. Check the server logs for the `Result:` line — it shows the status and reason for every webhook
2. Verify the comment is from a synced thread (must have `externalUserId` in the webhook payload)
3. Confirm the issue is in a **completed** or **canceled** state
4. Ensure the issue has an assignee
5. Verify the `LINEAR_ACCESS_TOKEN` has permission to update issues in the relevant team

### No notification sent after reopen

- The `issueReopened` notification is sent by Linear internally when the issue state transitions from done to active
- The issue must have an assignee at the time of reopen for the notification to fire
- The actor performing the reopen (your OAuth app) must differ from the assignee — Linear does not notify you about your own actions

## Development

### Project Structure

```
src/
  index.ts              # HTTP server entry point
  types.ts              # TypeScript interfaces
  lib/
    config.ts           # Environment configuration
    webhook.ts          # Webhook verification and type guards
    linear.ts           # Linear SDK wrapper
    reopen.ts           # Core reopen logic
```

### Type Checking

```bash
npm run typecheck
```

### Building

```bash
npm run build
```

## License

MIT
