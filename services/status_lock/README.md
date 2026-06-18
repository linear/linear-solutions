# Linear Issue Lock Agent

A configurable Linear agent that **freezes an issue once it reaches a locked status** (e.g. *Ready for Deployment*, *Closed*, *Cancelled*). Once an issue is locked, any change made by a non-authorized user is **automatically reverted**, the user is **notified in a comment**, and the action is recorded in an **audit trail**.

This is a focused prototype built to demonstrate how status-based controls — the kind enforced today through Jira workflow conditions, validators, and post-functions — can be implemented in Linear as a self-hosted programmatic automation. It is meant as a starting point, not a finished product.

> **How it works at a glance:** the agent runs as a small service you host yourself. Linear sends it a webhook whenever an issue changes. If the issue is in a locked status and the change came from someone who isn't authorized, the agent writes the previous values back, comments on the issue, and logs the event. No AI, no data leaving your environment.

## Why this approach

Linear takes a different approach to automation than Jira. Rather than blocking an action *before* it happens with a validator, this agent detects the change *after* it lands and reverts it — the net effect is the same (the issue stays frozen), with a complete audit trail of who tried to change what and when.

The trigger is the issue's **status**, and the protection covers the **whole issue** (any monitored field). Reverting uses the previous values Linear includes in every webhook (`updatedFrom`), so the agent does not need to keep a snapshot of every issue in your workspace.

## Use cases

- **Freeze on "Ready for Deployment"** — once a story has been tested and signed off for production, its fields are frozen so the release reflects exactly what was approved.
- **Freeze terminal states** — *Closed*, *Cancelled* (and *Backed Out*) issues can no longer be edited, so historical records stay accurate.
- **Read-only enforcement** — point `lockedStatuses` at every status of an issue type (or use `lockedStatusTypes`) to make a whole class of issues effectively read-only.
- **Audit traceability** — every revert (and every allowed edit by an authorized user) is written to `logs/audit.log` as newline-delimited JSON.

## What gets protected

While an issue is in a locked status, the agent watches these fields (configurable via `monitoredFields`):

| Field | Notes |
| ----- | ----- |
| `title` | |
| `description` | |
| `priority` | |
| `estimate` | |
| `assignee` | |
| `labels` | added/removed labels are restored |
| `state` | covers attempts to drag the issue *out* of its locked status |
| `dueDate` | |

Authorized users (the `allowlist` — admins / release managers) can edit a locked issue freely, including moving it out of the locked status.

## Behavior modes

| Mode | Effect |
| ---- | ------ |
| `dryRun: true` | Log what *would* be reverted without changing anything — safe for testing |
| `notifyOnly: true` | Post a comment when a locked issue is changed, but don't revert |
| `mentionUser: true` | Name the actor in the revert comment |
| `announceLock: true` | Post a "🔒 locked" comment when an issue first enters a locked status |

## Getting started

### Prerequisites

- Node.js 18+
- A Linear workspace with admin access
- A Linear OAuth token or personal API key ([create one here](https://linear.app/settings/api))
  - An **OAuth app** is recommended so the comments and actions appear to come from an agent (e.g. "Issue Lock Agent") rather than a person.

### 1. Install

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file:

```bash
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxx        # or an OAuth access token
LINEAR_WEBHOOK_SECRET=your_webhook_secret_here      # for signature verification
# SLACK_BOT_TOKEN=xoxb-...                           # optional
```

### 3. Configure the agent

```bash
cp config/config.json.example config/config.json
```

Then edit `config/config.json`:

```json
{
  "lockedStatuses": ["Ready for Deployment", "Closed", "Cancelled"],
  "lockedStatusTypes": [],
  "monitoredFields": ["title", "description", "priority", "estimate", "assignee", "labels", "state", "dueDate"],
  "allowlist": [
    {
      "name": "Release Managers",
      "linearTeamId": "REL",
      "members": [{ "email": "release-admin@yourcompany.com", "name": "Release Admin" }]
    }
  ],
  "agent": { "name": "Issue Lock Agent", "identifier": "🔒 [LOCK]" },
  "slack": { "enabled": false, "channelId": "C0123456789" },
  "behavior": { "dryRun": false, "notifyOnly": false, "mentionUser": true, "announceLock": true },
  "logging": { "level": "info", "auditTrail": true, "auditLogPath": "./logs/audit.log" }
}
```

### 4. Run

```bash
npm run dev
```

On startup the agent connects to Linear, loads your workflow states, and logs exactly which statuses will lock an issue — a quick sanity check that your `lockedStatuses` names match.

### 5. Expose with ngrok

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok-free.app`).

### 6. Create the webhook in Linear

1. **Linear Settings → API → Webhooks → Create webhook**
2. URL: `https://abc123.ngrok-free.app/webhooks/linear`
3. Resource types: **Issue**
4. Save and copy the signing secret into `.env` as `LINEAR_WEBHOOK_SECRET`, then restart.

### 7. Try it

1. Move an issue into **Ready for Deployment** → the agent posts a "🔒 locked" comment.
2. As a non-authorized user, change the title (or assignee, priority, or drag it back to *In Progress*).
3. Watch the agent revert the change and comment explaining what it restored.
4. As an allowlisted user, make the same edit → it's allowed.

See [DEMO.md](DEMO.md) for a step-by-step recording script.

## Configuration reference

### `lockedStatuses` / `lockedStatusTypes`

- `lockedStatuses` — status **names**, matched case-insensitively against your workflow states (e.g. `"Ready for Deployment"`).
- `lockedStatusTypes` — Linear workflow **state types**, useful to lock by category regardless of custom name. Values: `backlog`, `unstarted`, `started`, `completed`, `canceled`, `triage`. For example `["completed", "canceled"]` locks every Done/Cancelled-style status.

Provide at least one of the two. An issue is locked if its status matches *either*.

### `allowlist`

Who may edit a locked issue. Each entry is either:

- a **leaf user** — `{ "email": "..." }` or `{ "id": "..." }`, or
- a **group** — `{ "name": "...", "linearTeamId": "REL", "members": [ ... ] }`. Every member of the referenced Linear team is authorized (team membership is fetched at startup and refreshed every 4 hours). `linearTeamId` accepts the team **key** (e.g. `"REL"`) or a UUID.

Leave the allowlist empty to lock the issue for everyone except the agent itself.

### Endpoints

| Endpoint | Method | Description |
| -------- | ------ | ----------- |
| `/health` | GET | Health check |
| `/metrics` | GET | Audit statistics (reverted / allowed / detected / locked counts) |
| `/config` | GET | Current configuration (redacted) |
| `/webhooks/linear` | POST | Linear webhook endpoint |

## Audit log

`logs/audit.log` is newline-delimited JSON, one entry per action:

```json
{
  "timestamp": "2026-06-18T10:30:00.000Z",
  "webhookId": "webhook-123",
  "issueId": "issue-456",
  "issueIdentifier": "ENG-123",
  "issueTitle": "Payment service hotfix",
  "lockedStatus": "Ready for Deployment",
  "actor": { "email": "dev@example.com", "name": "Dev Person", "type": "user" },
  "action": "reverted",
  "reason": "Unauthorized change to a locked issue",
  "changes": [
    { "field": "title", "oldValue": "Payment service hotfix", "newValue": "edited title", "reverted": true }
  ]
}
```

`action` is one of: `locked` (issue entered a locked status), `reverted` (unauthorized change undone), `allowed` (authorized user edited a locked issue), or `detected` (dry-run / notify-only).

## Security

- **Webhook verification** — all webhooks are verified with HMAC-SHA256 (`LINEAR_WEBHOOK_SECRET`).
- **Timestamp validation** — webhooks older than 60 seconds are rejected (replay protection).
- **Self-hosted** — the agent runs entirely in your environment. No AI services and no issue data leaves your infrastructure.

## Testing

```bash
npm test
```

The suite covers the lock decision logic: locking by name and type, authorization (including Linear-team membership), reverting single and multiple fields, blocking unlock attempts, dry-run/notify-only modes, loop prevention, and ignoring unmonitored fields.

## Project structure

```
├── src/
│   ├── index.ts               # Entry point & Express server
│   ├── status-lock-engine.ts  # Core lock/revert logic
│   ├── webhook-handler.ts      # Webhook validation & parsing
│   ├── linear-client.ts        # Linear GraphQL client
│   ├── startup-validator.ts    # Startup checks, workflow-state & team caches
│   ├── slack-notifier.ts       # Optional Slack alerts
│   ├── config-loader.ts        # Configuration loading & validation
│   ├── types.ts                # TypeScript types
│   └── utils/                  # logger, audit-trail, error-handler
├── tests/
├── config/
└── package.json
```

## License

MIT

---

Built following [Linear's Agent Interaction Guidelines](https://linear.app/developers/aig). Derived from the Linear Issue Protection Agent (SLA/label enforcement); this branch focuses solely on status-based locking.
