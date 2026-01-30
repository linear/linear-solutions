# Linear Issue Duplication Agent

A webhook-driven agent for Linear that automatically duplicates issues to multiple teams when a specific label is applied. This is useful for cross-platform development scenarios where the same work needs to be tracked separately by different teams (e.g., iOS and Android).

[Video Walkthrough](https://www.loom.com/share/1ec3abc5515a405e8e7b8e9bdd9100de)

## How It Works

1. When a configured trigger label (e.g., "Multi-Platform") is added to an issue in a source team
2. The agent finds matching duplication rules for that team and label
3. For each matching rule, it creates sub-issues in the configured target teams
4. Sub-issues are linked as children of the original issue
5. Titles are prefixed with the team name (e.g., "iOS: Original Title")
6. Description and priority are copied from the parent issue

### Rule Isolation

Each duplication rule is scoped to a specific source team. This means:
- **Team A** using the "Multi-Platform" label creates sub-issues only for **Team A's** configured destinations
- **Team B** using the same "Multi-Platform" label creates sub-issues only for **Team B's** configured destinations
- Rules are completely isolated from each other

### Safeguards

- **Source team constraint**: Only issues from the configured source team trigger each rule
- **No duplicate children**: If the issue already has sub-issues, duplication is skipped
- **Skip own team**: If the source team is also in the target teams, no sub-issue is created for it
- **Sub-issue protection**: Issues that are already sub-issues (have a parent) are not processed

## Prerequisites

- Node.js 18 or later
- A Linear workspace with admin access

## Setup

### 1. Create a Linear OAuth Application

1. Go to [Linear Settings > API > Applications](https://linear.app/settings/api/applications/new)
2. Create a new application with these settings:
   - **Name**: Issue Duplication Agent (or your preferred name)

   - **Webhooks**: Enable and select **Issues** under "Data change events"
   - **Webhook URL**: Your server's endpoint (e.g., `https://your-domain.com/issue-duplication`)
3. Click **Create**
4. Note for your .env file:
   - **Client ID** - `LINEAR_CLIENT_ID`
   - **Client Secret** - `LINEAR_CLIENT_SECRET`
   - **Developer Token** (Choose 'App') - `LINEAR_ACCESS_TOKEN`
   - **Webhook Signing Secret** - `LINEAR_WEBHOOK_SECRET`

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# From Step 1 - OAuth Application
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=your_webhook_signing_secret

# From Step 2 - API Token
LINEAR_ACCESS_TOKEN=your_developer_token

# Your duplication rules (see Configuration Reference below)
DUPLICATION_RULES=[...]

# Server port
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

Then update your Linear OAuth application's webhook URL to: `https://your-ngrok-url.ngrok.io/issue-duplication`

**For production**, deploy to your hosting provider and use your server's public URL.

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_CLIENT_ID` | Yes | OAuth application client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth application client secret |
| `LINEAR_WEBHOOK_SECRET` | Yes | Webhook signing secret from OAuth application |
| `LINEAR_ACCESS_TOKEN` | Yes | OAuth developer token |
| `DUPLICATION_RULES` | Yes | JSON array of duplication rules (see below) |
| `PORT` | No | Server port (default: 3000) |

### Duplication Rules Format

The `DUPLICATION_RULES` environment variable is a JSON array where each rule defines:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable name for logging and identification |
| `triggerLabelName` | string | Label name that triggers this rule (case-insensitive) |
| `sourceTeamId` | string | Linear team UUID - only issues from this team trigger this rule |
| `targetTeams` | array | Array of target teams to create sub-issues in |

Each target team has:
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name used as prefix for sub-issue titles |
| `teamId` | string | Linear team UUID |

### Example Configuration

**Single rule (Mobile platforms):**

```json
[
  {
    "name": "Mobile Platform Duplication",
    "triggerLabelName": "Multi-Platform",
    "sourceTeamId": "mobile-team-uuid",
    "targetTeams": [
      {"name": "iOS", "teamId": "ios-team-uuid"},
      {"name": "Android", "teamId": "android-team-uuid"}
    ]
  }
]
```

**Multiple rules (isolated by source team):**

Both Team A and Team B can use the same "Multi-Platform" label, but issues are duplicated only to their respective target teams:

```json
[
  {
    "name": "Team A Mobile Duplication",
    "triggerLabelName": "Multi-Platform",
    "sourceTeamId": "team-a-uuid",
    "targetTeams": [
      {"name": "iOS", "teamId": "team-a-ios-uuid"},
      {"name": "Android", "teamId": "team-a-android-uuid"}
    ]
  },
  {
    "name": "Team B Mobile Duplication",
    "triggerLabelName": "Multi-Platform",
    "sourceTeamId": "team-b-uuid",
    "targetTeams": [
      {"name": "iOS", "teamId": "team-b-ios-uuid"},
      {"name": "Android", "teamId": "team-b-android-uuid"}
    ]
  }
]
```

**Multiple labels:**

Different labels can trigger different duplication patterns:

```json
[
  {
    "name": "Mobile Platform Duplication",
    "triggerLabelName": "Multi-Platform",
    "sourceTeamId": "product-team-uuid",
    "targetTeams": [
      {"name": "iOS", "teamId": "ios-team-uuid"},
      {"name": "Android", "teamId": "android-team-uuid"}
    ]
  },
  {
    "name": "Web Framework Duplication",
    "triggerLabelName": "Multi-Framework",
    "sourceTeamId": "product-team-uuid",
    "targetTeams": [
      {"name": "React", "teamId": "react-team-uuid"},
      {"name": "Vue", "teamId": "vue-team-uuid"}
    ]
  }
]
```

### Finding Team IDs

You can find team IDs in Linear:
1. Go to **Settings > Teams > [Your Team]**
2. Click the **...** menu
3. Select **Copy ID**

Or via the Linear API/GraphQL.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/issue-duplication` | POST | Linear webhook receiver |
| `/health` | GET | Health check endpoint |
| `/` | GET | Service information |

## Troubleshooting

### Webhook not receiving events

1. Verify your webhook URL is publicly accessible (try accessing `/health` endpoint)
2. Check that **Issues** is enabled in your Linear OAuth application's webhook settings
3. Verify the webhook signing secret matches your `LINEAR_WEBHOOK_SECRET`
4. Check recent webhook deliveries in your OAuth app settings

### Signature verification failing

- Ensure `LINEAR_WEBHOOK_SECRET` matches the signing secret from your Linear OAuth application
- The raw request body must be used for verification (not parsed JSON)

### Sub-issues not being created

1. Check the server logs for error messages
2. Verify the `LINEAR_ACCESS_TOKEN` has permission to create issues in the target teams
3. Confirm source team ID is correct - issues must be in the source team to trigger the rule
4. Ensure the trigger label name matches exactly (case-insensitive)
5. Check target team IDs are correct

### Issue already has sub-issues

The agent intentionally skips issues that already have children to prevent duplicate sub-issues. This is a safety feature.

### Wrong rule triggered / issues going to wrong teams

- Verify the `sourceTeamId` in each rule matches the correct team
- Rules are isolated by source team - only issues FROM that team will trigger that specific rule
- Check the server logs to see which rules matched

## Development

### Project Structure

```
src/
  index.ts              # HTTP server entry point
  types.ts              # TypeScript interfaces
  lib/
    config.ts           # Environment configuration
    webhook.ts          # Webhook verification and rule matching
    linear.ts           # Linear SDK wrapper
    duplication.ts      # Core duplication logic
```

### Running Tests

```bash
npm run typecheck
```

### Building

```bash
npm run build
```

## License

MIT
