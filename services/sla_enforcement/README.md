# Linear Issue Protection Agent

A configurable Linear agent that protects issues from unauthorized changes. Automatically reverts modifications to protected labels, SLA fields, and priority when made by non-authorized users.

## Use Cases

- **Security Compliance**: Prevent unauthorized removal of security/vulnerability labels
- **SLA Enforcement**: Protect SLA fields from accidental or unauthorized modifications
- **Priority Control**: Ensure critical issue priorities remain stable
- **Audit Requirements**: Maintain complete audit trail of all enforcement actions

## Features


| Feature                       | Description                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Protected Labels**          | Configure any labels (e.g., "Vulnerability", "Security Critical") that cannot be removed by unauthorized users                          |
| **SLA Protection**            | Monitors all 5 SLA fields: type, start date, medium risk, high risk, breach date                                                        |
| **SLA Created-At Baseline**   | Enforces that `slaStartedAt` always equals the issue's creation date — catches silent resets from priority changes or workflow triggers |
| **Priority Protection**       | Prevent unauthorized priority changes (Urgent, High, Normal, Low)                                                                       |
| **Label Hierarchy**           | Detects labels in both top-level and label groups                                                                                       |
| **Hierarchical Allowlist**    | Define authorization as nested groups with unlimited depth — org → team → sub-team → individual                                         |
| **Field-Level Permissions**   | Grant users access to specific fields only: `labels`, `sla`, `priority`, or `slaBaseline` (the clock anchor)                            |
| **Linear Team Authorization** | Reference a `linearTeamId` to automatically authorize all members of a Linear team — no need to list individuals                        |
| **Partial Authorization**     | Only the fields an actor isn't permitted to change are reverted — authorized field changes pass through                                 |
| **Dry Run Mode**              | Test without making changes—logs what would happen                                                                                      |
| **Notify Only Mode**          | Post comments without reverting (monitoring mode)                                                                                       |
| **Slack Notifications**       | Optional alerts when unauthorized changes are detected                                                                                  |
| **Audit Trail**               | Complete log of all enforcement actions in JSON format                                                                                  |


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
    "priority": true,
    "slaCreatedAtBaseline": false
  },
  "allowlist": [
    {
      "name": "Admins",
      "permissions": ["labels", "sla", "priority", "slaBaseline"],
      "members": [
        { "email": "admin@yourcompany.com", "name": "Admin" }
      ]
    },
    {
      "name": "Security Team",
      "linearTeamId": "your-linear-team-id",
      "permissions": ["labels", "sla", "priority"],
      "members": [
        {
          "name": "Security Leads",
          "permissions": ["labels", "sla", "priority", "slaBaseline"],
          "members": [
            { "email": "security-lead@yourcompany.com", "name": "Security Lead" }
          ]
        }
      ]
    }
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
    "priority": true,
    "slaCreatedAtBaseline": false
  }
}
```

Set individual fields to `false` to disable protection for that field type.

#### `slaCreatedAtBaseline`

When set to `true`, the agent enforces that `slaStartedAt` always equals the issue's `createdAt` (the date the issue was created in Linear). This is the strictest form of SLA clock protection.

**Why this matters:** Linear can silently reset `slaStartedAt` when other fields change — for example, changing an issue's priority may trigger a workflow that recalculates and overwrites the SLA start date. The standard `sla` protection only catches changes that appear explicitly in the webhook's `updatedFrom` payload. `slaCreatedAtBaseline` catches *all* drift, including silent resets, by comparing the current `slaStartedAt` against the cached `createdAt` on every webhook.

**How the SLA calculation works:**

When an authorized priority change occurs (or drift is detected), the agent recalculates `slaBreachesAt` from the following sources in priority order:

1. **Config `slaRules` (primary)** — if a rule in `slaRules` matches the issue (by label and/or team), the agent computes `createdAt + rule.hours(priority)`. This is always authoritative, regardless of what Linear's workflow computed.
2. **Cached duration (fallback)** — if no rule matches but `slaStartedAt` has drifted, the agent uses the cached pre-drift duration: `createdAt + (cachedSlaBreachesAt − cachedSlaStartedAt)`.
3. **Bail** — if no rule matches and there is no drift, the agent leaves `slaBreachesAt` unchanged.

**Example:** An issue is created on April 1. On April 14, an admin sets the priority to Urgent. A matching `slaRule` declares Urgent = 24h. The agent computes:

```
correctSlaBreachesAt = April 1 + 24h = April 2
```

The issue now shows as breached, correctly reflecting that an Urgent issue created 13 days ago has long exceeded its 24-hour SLA.

**Enforcement applies unconditionally.** Baseline drift is always corrected regardless of who triggered it:

- **Other actors** — drift detected via the baseline check is flagged with `fromBaseline: true` and forced into the unauthorized-changes path. Even an actor with `slaBaseline` permission cannot prevent a baseline correction triggered by an indirect change (e.g. priority bump).
- **Agent / authorized identity** — when the actor's change is itself agent-initiated (or made by the same identity as the API key), the agent silently applies the correction after the fact rather than reverting.

The `sla` permission lets a user change `slaBreachesAt` directly (e.g. to extend a deadline). If that change also causes `slaStartedAt` to drift, the baseline correction still fires — the new `slaBreachesAt` is reanchored to `createdAt + new duration`. This ensures no SLA change, authorized or not, can move the clock origin.

**Cache and startup behavior:**

1. On startup, the agent fetches `createdAt` for every issue with a protected label and stores it as an immutable baseline in its cache.
2. On every subsequent webhook for a protected issue, the agent compares `slaStartedAt` against the cached `createdAt`.
3. If they differ, the agent applies the duration-preserving correction and updates `slaBreachesAt` accordingly.
4. The `createdAt` baseline is never overwritten — even authorized changes do not update the `createdAt` target.

**When to use:** Enable this when you need to guarantee that the SLA clock always reflects the true issue creation date and cannot be gamed by indirect changes (e.g., priority bumps, label swaps, or workflow triggers).

### Allowlist

The allowlist supports unlimited nesting. Each entry is either a **leaf user** (identified by `email` or `id`) or a **group** (identified by `name`, with optional `linearTeamId` and nested `members`).

```json
{
  "allowlist": [
    {
      "name": "Org Admins",
      "permissions": ["labels", "sla", "priority", "slaBaseline"],
      "members": [
        { "email": "admin@yourcompany.com", "name": "Admin" }
      ]
    },
    {
      "name": "Engineering Team",
      "linearTeamId": "your-linear-team-id",
      "permissions": ["labels", "sla", "priority"],
      "members": [
        {
          "name": "Engineering Leads",
          "permissions": ["labels", "sla", "priority", "slaBaseline"],
          "members": [
            { "email": "eng-lead@yourcompany.com", "name": "Engineering Lead" }
          ]
        }
      ]
    },
    {
      "email": "individual@yourcompany.com",
      "name": "Individual (flat entry — backward compatible)"
    }
  ]
}
```

#### Permissions

Each entry can carry a `permissions` array controlling which protected fields the user or group is authorized to modify:


| Permission    | Controls                                                            |
| ------------- | ------------------------------------------------------------------- |
| `labels`      | Can add or remove protected labels                                  |
| `sla`         | Can modify `slaType` and `slaBreachesAt` (deadline / policy fields) |
| `priority`    | Can change issue priority                                           |
| `slaBaseline` | Can modify `slaStartedAt` (the clock anchor — most restricted)      |


`slaBaseline` is intentionally separate from `sla`. Changing `slaStartedAt` resets the SLA clock origin — the most impactful operation — so it should be restricted to admins only, while team leads may have `sla` to extend deadlines.

**Key rules:**

- **Inheritance** — if `permissions` is omitted, the entry inherits from its parent group. Root entries with no `permissions` default to all permissions (backward compatible with flat configs).
- **Union resolution** — if a user matches multiple entries, they receive the union (most permissive) of all matched permission sets.
- `**linearTeamId`** — all members of the referenced Linear team automatically match the group. Membership is fetched at startup and refreshed every 4 hours. Use this instead of listing individual emails when you want permissions to follow team membership — new hires are covered automatically, no config changes needed. You can still add a `members` array alongside `linearTeamId` to give specific individuals within the team elevated or narrowed permissions; the union rule applies.
- **Partial authorization** — if an actor is authorized for some changed fields but not others, only the unauthorized fields are reverted. Authorized changes pass through unchanged.
- **Flat entries** — a leaf with no `permissions` field defaults to all permissions, so existing configs continue to work without modification.

#### Multi-layer subteam example

For organizations with deep team hierarchies, nest groups to reflect the real structure. Permissions narrow or widen at each level — set `permissions` on an entry to override the parent, or omit it to inherit.

```json
{
  "allowlist": [
    {
      "name": "SLA Admins",
      "permissions": ["labels", "sla", "priority", "slaBaseline"],
      "members": [
        { "email": "sla-admin@yourcompany.com", "name": "SLA Admin" }
      ]
    },
    {
      "name": "Engineering Org",
      "permissions": ["labels"],
      "members": [
        {
          "name": "Platform Division",
          "linearTeamId": "team-platform-id",
          "permissions": ["labels", "sla"],
          "members": [
            {
              "name": "Platform Team Leads",
              "permissions": ["labels", "sla", "priority"],
              "members": [
                { "email": "platform-lead@yourcompany.com", "name": "Platform Lead" }
              ]
            }
          ]
        },
        {
          "name": "Mobile Division",
          "linearTeamId": "team-mobile-id",
          "permissions": ["labels", "sla"],
          "members": [
            { "email": "mobile-lead@yourcompany.com", "name": "Mobile Lead",
              "permissions": ["labels", "sla", "priority"] }
          ]
        }
      ]
    }
  ]
}
```

Effective permissions for each actor in this config:


| Who                              | How matched                                             | Effective permissions                   |
| -------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `sla-admin@yourcompany.com`      | SLA Admins leaf                                         | `labels` `sla` `priority` `slaBaseline` |
| Any member of `team-platform-id` | Platform Division `linearTeamId`                        | `labels` `sla`                          |
| `platform-lead@yourcompany.com`  | Platform Division (via team) ∪ Platform Team Leads leaf | `labels` `sla` `priority`               |
| Any member of `team-mobile-id`   | Mobile Division `linearTeamId`                          | `labels` `sla`                          |
| `mobile-lead@yourcompany.com`    | Mobile Division (via team) ∪ own override               | `labels` `sla` `priority`               |
| Anyone else                      | No match                                                | — (all changes reverted)                |


Note that `platform-lead` appears in both the `linearTeamId` match (granting `labels` + `sla`) and the Platform Team Leads sub-group (granting `labels` + `sla` + `priority`). The union of both gives them `priority` on top of the division baseline — without needing to remove them from the team.

### SLA Rules (per-team, per-label, per-priority)

#### Linear API limitation

Linear's GraphQL API does **not** expose SLA policy definitions. The policies you configure in Linear's UI — e.g. "Urgent = 4 hours, High = 24 hours" — are never returned by the API. The only SLA data accessible on an issue is the *computed result*:

| Readable field   | What it is                                   |
| ---------------- | -------------------------------------------- |
| `slaType`        | Policy ID or `"all"` — not the rule itself   |
| `slaStartedAt`   | When the SLA clock started                   |
| `slaMediumRiskAt`| Computed medium-risk timestamp (read-only)   |
| `slaHighRiskAt`  | Computed high-risk timestamp (read-only)     |
| `slaBreachesAt`  | Computed breach deadline (writable)          |

Because the rule is opaque, the agent cannot automatically know that a 7-day `slaBreachesAt` is wrong for an Urgent issue — unless you declare the expected windows yourself.

#### Declaring SLA rules in config.json

The `slaRules` array lets you declare the expected SLA window for each priority level, optionally scoped by team and/or label. The enforcement engine uses these declarations to validate that `slaBreachesAt` is consistent with an issue's priority when it arrives via webhook.

Each rule set specifies:

| Field             | Required | Description |
| ----------------- | -------- | ----------- |
| `name`            | yes      | Human-readable name, used in logs and audit entries |
| `teamId`          | no       | Linear team ID or key — limits the rule to one team |
| `labels`          | no       | Issue must carry **all** listed labels to match |
| `priorityWindows` | yes      | Per-priority expected SLA durations |

**Matching:** All specified conditions must be satisfied (AND logic). When multiple rules match an issue, the most specific one wins (most conditions specified). Priorities not listed in a rule's `priorityWindows` are not validated by that rule.

**Priority values:** Either the Linear integer (`1`–`4`) or a human-readable string:

| String        | Integer | Linear label  |
| ------------- | ------- | ------------- |
| `"urgent"`    | `1`     | Urgent        |
| `"high"`      | `2`     | High          |
| `"normal"`    | `3`     | Normal        |
| `"low"`       | `4`     | Low           |
| `"no_priority"` | `0`   | No priority   |

**Example config:**

```json
{
  "slaRules": [
    {
      "name": "OoSLA Issues",
      "labels": ["oosla"],
      "priorityWindows": [
        { "priority": "urgent", "hours": 24 },
        { "priority": "high",   "hours": 168 },
        { "priority": "normal", "hours": 672 },
        { "priority": "low",    "hours": 2880 }
      ]
    },
    {
      "name": "Delivery Bug SLA",
      "teamId": "DELIVERY",
      "labels": ["Bug"],
      "priorityWindows": [
        { "priority": "urgent", "hours": 24 },
        { "priority": "high",   "hours": 168 },
        { "priority": "normal", "hours": 720 },
        { "priority": "low",    "hours": 2880 }
      ]
    },
    {
      "name": "Security Vulnerability SLA",
      "labels": ["Vulnerability"],
      "priorityWindows": [
        { "priority": "urgent", "hours": 4 },
        { "priority": "high",   "hours": 24 },
        { "priority": "normal", "hours": 72 }
      ]
    },
    {
      "name": "Platform Default SLA",
      "teamId": "PLATFORM",
      "priorityWindows": [
        { "priority": "urgent", "hours": 8 },
        { "priority": "high",   "hours": 72 },
        { "priority": "normal", "hours": 336 },
        { "priority": "low",    "hours": 1440 }
      ]
    }
  ]
}
```

In this example:
- Any `oosla` issue at Urgent must breach in 24 hours (applies across all teams)
- A Delivery `Bug` issue at Urgent must breach in 24 hours (teamId + label — higher specificity than label-only)
- A `Vulnerability` issue at Urgent must breach in 4 hours (applies to all teams)
- Any Platform issue with no label match falls back to the Platform default rule
- Issues not matched by any rule are not validated for duration (SLA fields are still protected from unauthorized changes)

> **Recommended: disable Linear's built-in UI SLA rules when using `slaRules` in config.json.**
>
> When both are active, you see two updates per priority change: Linear's internal workflow fires first, then the agent corrects. Since the agent's `slaRules` are the authoritative source, the Linear UI rules serve no additional purpose. Removing them means only the agent writes SLA fields — one update, fully config-controlled, no race conditions.

### Behavior Modes


| Mode                | Effect                                           |
| ------------------- | ------------------------------------------------ |
| `dryRun: true`      | Log what would happen without making any changes |
| `notifyOnly: true`  | Post comments but don't revert changes           |
| `mentionUser: true` | @mention the user in revert comments             |


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


| Endpoint           | Method | Description                      |
| ------------------ | ------ | -------------------------------- |
| `/health`          | GET    | Health check and status          |
| `/metrics`         | GET    | Enforcement statistics           |
| `/config`          | GET    | Current configuration (redacted) |
| `/webhooks/linear` | POST   | Webhook endpoint for Linear      |


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


| File                | Contents                                 |
| ------------------- | ---------------------------------------- |
| `logs/combined.log` | All application logs                     |
| `logs/error.log`    | Error logs only                          |
| `logs/audit.log`    | Enforcement actions (JSON, one per line) |


### Audit Log Format

```json
{
  "timestamp": "2025-01-08T10:30:00.000Z",
  "webhookId": "webhook-123",
  "issueId": "issue-456",
  "issueIdentifier": "SEC-123",
  "actor": { "email": "user@example.com", "name": "User" },
  "action": "reverted",
  "actorPermissions": ["labels"],
  "reason": "User not authorized for any changed fields",
  "changes": [
    { "field": "labels", "oldValue": ["Vulnerability"], "newValue": [], "reverted": false },
    { "field": "slaBreachesAt", "oldValue": "2025-02-01", "newValue": "2025-03-01", "reverted": true }
  ]
}
```

The `action` field reflects the outcome: `allowed` (fully authorized), `reverted` (fully unauthorized), `partial` (some fields allowed, others reverted), or `detected` (dry run / notify-only mode). The `actorPermissions` field records exactly what the actor was authorized for, making it straightforward to audit why each field was or wasn't reverted.

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

### Team member not recognized despite being in a Linear team

Team membership is fetched at startup and cached for 4 hours. If a user was recently added to the team, restart the agent to force a fresh fetch, or add the user directly as a leaf entry as an immediate workaround.

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