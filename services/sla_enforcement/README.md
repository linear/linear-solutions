# Linear Issue Protection Agent

A configurable Linear agent that protects issues from unauthorized changes. Automatically reverts modifications to protected labels, SLA fields, and priority when made by non-authorized users.

## Use Cases

- **Security Compliance**: Prevent unauthorized removal of security/vulnerability labels
- **SLA Enforcement**: Protect SLA fields from accidental or unauthorized modifications
- **Priority Control**: Ensure critical issue priorities remain stable
- **Audit Requirements**: Maintain complete audit trail of all enforcement actions

## Features

| Feature | Description |
|---------|-------------|
| **Protected Labels** | Configure any labels (e.g., "Vulnerability", "Security Critical") that cannot be removed by unauthorized users |
| **SLA Protection** | Monitors all 5 SLA fields: type, start date, medium risk, high risk, breach date |
| **Priority Protection** | Prevent unauthorized priority changes (Urgent, High, Normal, Low) |
| **Label Hierarchy** | Detects labels in both top-level and label groups |
| **Allowlist** | Define authorized users by email or Linear user ID |
| **Dry Run Mode** | Test without making changes—logs what would happen |
| **Notify Only Mode** | Post comments without reverting (monitoring mode) |
| **Slack Notifications** | Optional alerts when unauthorized changes are detected |
| **Audit Trail** | Complete log of all enforcement actions in JSON format |

## Getting Started

### Prerequisites

- Node.js 18 or higher
- A Linear workspace with admin access
- Linear OAuth token or API key with admin scope ([create one here](https://linear.app/settings/api))
    - We would highly recommend creating an OAuth app so that the messages and actions look like they're coming from an Agent as opposed to a person. e.g. "Vulnerability Protection Agent"

### 1. Clone/Download Repo and Install

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Required
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Required for webhook signature verification
LINEAR_WEBHOOK_SECRET=your_webhook_secret_here

# Optional - only if using Slack notifications
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Configure the Agent

Copy and customize the configuration:

```bash
cp config/config.json.example config/config.json
```

Edit `config/config.json`:

```json
{
  "protectedLabels": ["Vulnerability", "Security Critical"],
  "checkLabelGroups": true,
  "protectedFields": {
    "label": true,
    "sla": true,
    "priority": true
  },
  "allowlist": [
    { "email": "security-lead@yourcompany.com", "name": "Security Lead" },
    { "email": "admin@yourcompany.com" }
  ],
  "agent": {
    "name": "Issue Protection Agent",
    "identifier": "🤖 [AGENT]"
  },
  "slack": {
    "enabled": false,
    "channelId": "C0123456789"
  },
  "behavior": {
    "dryRun": false,
    "notifyOnly": false,
    "mentionUser": true
  },
  "logging": {
    "level": "info",
    "auditTrail": true,
    "auditLogPath": "./logs/audit.log"
  }
}
```

### 4. Run the Agent

Start the agent:

```bash
npm run dev
```

### 5. Expose with ngrok

In a separate terminal, create a tunnel to expose your local server:

```bash
ngrok http 3000
```

Copy the HTTPS URL from ngrok (e.g., `https://abc123.ngrok-free.app`).

### 6. Create Webhook in Linear

1. Go to **Linear Settings → API → Webhooks**
2. Click **"Create webhook"**
3. Enter your ngrok URL with the webhook path: `https://abc123.ngrok-free.app/webhooks/linear`
4. Select resource types: **Issue** and **IssueSLA**
5. Save and copy the webhook secret
6. Add the secret to your `.env` file as `LINEAR_WEBHOOK_SECRET`
7. Restart the agent

### 7. Test It

1. Create a test issue in Linear
2. Add one of your protected labels (e.g., "Vulnerability")
3. Try to remove the label as a non-allowlisted user
4. Watch the agent automatically revert the change and post a comment

## Configuration Reference

### Protected Labels

```json
{
  "protectedLabels": ["Vulnerability", "Security Critical", "Compliance"]
}
```

Add any label names you want to protect. Case-sensitive.

### Protected Fields

```json
{
  "protectedFields": {
    "label": true,
    "sla": true,
    "priority": true
  }
}
```

Set individual fields to `false` to disable protection for that field type.

### Allowlist

Users who are authorized to make changes to protected fields:

```json
{
  "allowlist": [
    { "email": "user@example.com", "name": "User Name" },
    { "id": "linear-user-id", "name": "Another User" },
    { "email": "team@example.com" }
  ]
}
```

You can identify users by `email` or Linear `id`. The `name` field is optional and for documentation only.

### Behavior Modes

| Mode | Effect |
|------|--------|
| `dryRun: true` | Log what would happen without making any changes |
| `notifyOnly: true` | Post comments but don't revert changes |
| `mentionUser: true` | @mention the user in revert comments |

### Slack Integration

To enable Slack notifications:

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add the `chat:write` bot scope
3. Install to your workspace
4. Copy the Bot Token (starts with `xoxb-`)
5. Add to `.env` as `SLACK_BOT_TOKEN`
6. Update config:

```json
{
  "slack": {
    "enabled": true,
    "channelId": "C0123456789"
  }
}
```

## Production Usage

For production, build the TypeScript and run the compiled JavaScript:

```bash
npm run build
npm start
```

The agent exposes the following endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check and status |
| `/metrics` | GET | Enforcement statistics |
| `/config` | GET | Current configuration (redacted) |
| `/webhooks/linear` | POST | Webhook endpoint for Linear |

### Health Check Response

```json
{
  "status": "healthy",
  "agent": "Issue Protection Agent",
  "version": "1.0.0",
  "uptime": 3600,
  "timestamp": "2025-01-08T10:30:00.000Z"
}
```

## Logs

| File | Contents |
|------|----------|
| `logs/combined.log` | All application logs |
| `logs/error.log` | Error logs only |
| `logs/audit.log` | Enforcement actions (JSON, one per line) |

### Audit Log Format

```json
{
  "timestamp": "2025-01-08T10:30:00.000Z",
  "webhookId": "webhook-123",
  "issueId": "issue-456",
  "issueIdentifier": "SEC-123",
  "actor": { "email": "user@example.com", "name": "User" },
  "action": "reverted",
  "reason": "User not in allowlist",
  "changes": [
    { "field": "labels", "oldValue": ["Vulnerability"], "newValue": [], "reverted": true }
  ]
}
```

## Security

### Webhook Verification

All incoming webhooks are verified using HMAC-SHA256 signatures. Set `LINEAR_WEBHOOK_SECRET` in your environment.

### Timestamp Validation

Webhooks older than 60 seconds are rejected to prevent replay attacks.

### Linear IP Addresses

For additional security, you can whitelist Linear's webhook IPs:

- 35.231.147.226
- 35.243.134.228
- 34.140.253.14
- 34.38.87.206
- 34.134.222.122
- 35.222.25.142

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Safe Testing with Dry Run

Set `behavior.dryRun: true` in your config to test the agent without making any changes. Monitor `logs/combined.log` to see what would be enforced.

## Troubleshooting

### Agent not reverting changes

1. Check that `dryRun` and `notifyOnly` are both `false`
2. Verify the user making changes is not in the allowlist
3. Confirm the protected labels exist and match exactly (case-sensitive)
4. Check `logs/combined.log` for errors

### Webhook not being received

1. Verify ngrok is running and the URL is correct
2. Confirm `LINEAR_WEBHOOK_SECRET` matches the secret from Linear
3. Check webhook is enabled in Linear Settings
4. Ensure webhook includes `Issue` and `IssueSLA` resource types

### "Label not found" warning

This is informational—the protected label doesn't exist in your workspace yet. Create it in Linear and restart the agent.

### Infinite loop warnings

Normal behavior—the agent detects and skips its own actions automatically.

## Project Structure

```
├── src/
│   ├── index.ts              # Entry point & Express server
│   ├── enforcement-engine.ts # Core protection logic
│   ├── webhook-handler.ts    # Webhook validation
│   ├── linear-client.ts      # Linear SDK wrapper
│   ├── slack-notifier.ts     # Slack integration
│   ├── startup-validator.ts  # Startup checks
│   ├── config-loader.ts      # Configuration
│   ├── types.ts              # TypeScript types
│   └── utils/
│       ├── logger.ts         # Winston logging
│       ├── audit-trail.ts    # Audit persistence
│       └── error-handler.ts  # Error handling
├── tests/                    # Test suites
├── config/                   # Configuration files
└── package.json
```

## License

MIT

---

Built following [Linear's Agent Interaction Guidelines (AIG)](https://linear.app/developers/aig)
