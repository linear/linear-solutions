# SLA Enforcement Agent — Implementation Guide

This guide explains how the SLA Enforcement Agent works and how to configure it for your SLA tracking requirements. It is written for the team that will deploy and maintain the agent.

---

## How it works

The agent is a webhook listener that connects to your Linear workspace. Every time an issue is updated, Linear sends the agent a webhook describing what changed. The agent inspects the change, checks whether the person who made it is authorized to do so, and reverts any unauthorized changes automatically.

```
User edits issue in Linear
         │
         ▼
Linear sends webhook to agent (within seconds)
         │
         ▼
Agent checks: does this issue have a protected label?
         │
    ┌────┴────┐
    No        Yes
    │          │
  Ignore     What changed? (labels / SLA / priority)
                │
                ▼
            Is the actor authorized for those specific fields?
                │
         ┌──────┴──────┐
         Yes (all)     No (some or all)
         │              │
       Allow         Revert only the unauthorized fields
                     Post comment on the issue explaining what happened
                     Write to audit log
                     (Optional) Send Slack notification
```

The agent only acts on issues that carry one of the **protected labels** you configure (e.g. `oosla`). Issues without a protected label are ignored entirely.

---

## SLA clock — how it works and why it matters

Linear has five SLA fields on every issue:


| Field             | Writable?    | Meaning                     |
| ----------------- | ------------ | --------------------------- |
| `slaType`         | ✅ Yes        | Which SLA policy applies    |
| `slaStartedAt`    | ✅ Yes        | When the SLA clock started  |
| `slaBreachesAt`   | ✅ Yes        | When the SLA deadline is    |
| `slaMediumRiskAt` | ❌ Calculated | Automatically set by Linear |
| `slaHighRiskAt`   | ❌ Calculated | Automatically set by Linear |


**Requirement:** the SLA clock must always start from the issue creation date. The agent enforces this through two complementary mechanisms:

1. **General SLA protection** — if anyone unauthorized tries to change `slaBreachesAt` or `slaType`, the agent reverts the change.
2. **Baseline enforcement (`slaCreatedAtBaseline`)** — on every webhook for a protected issue, the agent compares `slaStartedAt` against the cached issue `createdAt`. If they differ, the agent corrects both `slaStartedAt` and `slaBreachesAt` using a duration-preserving calculation. This catches silent resets caused by Linear's own workflows (e.g. changing priority can silently recalculate the SLA clock).

**Why `slaStartedAt` is the most critical field:** moving the clock origin resets the entire SLA timer. Even if the deadline (`slaBreachesAt`) appears unchanged, a reset `slaStartedAt` means an out-of-SLA issue can appear in-SLA. For tracking buckets (1 week, 2 weeks, 4+ weeks out of SLA), this is the field that must be locked down most tightly.

### SLA breach date calculation

When a priority change occurs (authorized or not), the agent recalculates `slaBreachesAt` from the following sources in order:

1. **Config `slaRules` (primary)** — if a rule matches the issue (by label and/or team), the agent computes `createdAt + rule.hours(newPriority)`. This is always authoritative.
2. **Cached duration (fallback)** — if no rule matches and `slaStartedAt` has drifted, the agent uses `createdAt + (cachedSlaBreachesAt − cachedSlaStartedAt)`. The cache holds the pre-drift values from the webhook payload, before Linear's workflow ran, so the duration is reliable.
3. **Bail** — no rule and no drift means nothing reliable to act on; `slaBreachesAt` is left unchanged.

**Concrete example (rule match):**


| Field           | Linear's workflow-computed value    | Agent-corrected value             |
| --------------- | ----------------------------------- | --------------------------------- |
| `createdAt`     | April 1                             | April 1 (immutable)               |
| `slaStartedAt`  | April 14 (reset by priority change) | April 1                           |
| `slaBreachesAt` | April 15 (`+24h` from April 14)     | **April 2** (`+24h` from April 1) |

The issue shows as breached — correctly, because an Urgent (24h) issue created 13 days ago is long overdue.

### Single-update architecture

When both Linear's UI SLA rules and config.json `slaRules` are active, every priority change produces **two** updates in Linear's activity log: Linear's internal workflow fires first, then the agent corrects it 2.5 seconds later. Since the results are identical (same windows), the Linear UI rules add no value.

**Recommended:** remove Linear's UI SLA rules and use only `slaRules` in config.json. Without UI rules, Linear's workflow never fires, and the agent makes exactly one update per priority change — writing only the corrected `slaBreachesAt` anchored to `createdAt`.

### Two enforcement paths

The baseline correction applies unconditionally, but via two different code paths depending on who triggered the change:


| Actor                            | Path                  | Behavior                                                                                                            |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Any non-agent actor              | Normal enforcement    | Drift flagged as `fromBaseline: true`, forced into unauthorized-changes path regardless of `slaBaseline` permission |
| Agent / same identity as API key | `isAgentAction` block | Correction applied silently after the fact — no revert comment posted                                               |


**Key rule:** even an actor with `slaBaseline` permission cannot prevent baseline correction triggered by an indirect change (e.g. a priority bump). The `slaBaseline` permission only covers *direct*, explicit writes to `slaStartedAt`. Indirect drift is always corrected.

---

## Permission model

Authorization is field-level and hierarchical. There are four distinct permissions:


| Permission    | Controls                                                       |
| ------------- | -------------------------------------------------------------- |
| `labels`      | Can add or remove protected labels (e.g. `oosla`)              |
| `sla`         | Can modify `slaType` and `slaBreachesAt` (deadline / policy)   |
| `priority`    | Can change the issue priority                                  |
| `slaBaseline` | Can modify `slaStartedAt` (the clock origin — most restricted) |


**A user with `sla` but not `slaBaseline` can extend a deadline but cannot move the clock start.** The intended split: team leads get `sla`, only SLA admins get `slaBaseline`.

### Partial authorization

If a user is authorized for some fields but not others, only the unauthorized fields are reverted. For example:

- User has `labels` and `priority` permissions.
- They simultaneously remove the `oosla` label (needs `labels` ✅) and change `slaBreachesAt` (needs `sla` ❌).
- Result: the label removal is allowed through; the `slaBreachesAt` change is reverted.
- The agent posts a comment explaining both what was allowed and what was reverted.

---

## Configuration

All configuration lives in `config/config.json`. Copy `config/config.json.example` as a starting point.

### Allowlist structure

The allowlist supports unlimited nesting. Each entry is either a **leaf user** or a **group**.

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
    }
  ]
}
```

**Key rules:**

- `**permissions`** — the array of fields this entry grants access to. If omitted, the entry inherits the permissions of its parent group. Root entries with no `permissions` default to all four permissions (backward compatible).
- `**linearTeamId**` — if set, every member of that Linear team automatically matches this group entry. The agent fetches team membership at startup and refreshes it every 4 hours. Find your team ID in Linear under Settings → Teams → (your team) → the ID in the URL.
- `**members**` — nested users or sub-groups. Each sub-entry can have its own `permissions` override; otherwise it inherits from the parent.
- **Union resolution** — if a user matches multiple entries (e.g. they are both in a team group and listed as a flat leaf), they receive the union of all matched permission sets. More entries = more permissive.
- **Flat entries** — a leaf with no `permissions` field defaults to all permissions. This is how legacy configs continue to work without any changes.

### Multi-layer subteam example

For organizations with multiple divisions and nested teams, reflect the real hierarchy directly in the config. Each level can set its own `permissions` to narrow or widen what the level below it inherits.

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
            {
              "email": "mobile-lead@yourcompany.com",
              "name": "Mobile Lead",
              "permissions": ["labels", "sla", "priority"]
            }
          ]
        }
      ]
    }
  ]
}
```

Effective permissions for each actor:


| Who                             | How matched                                         | Effective permissions                   |
| ------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `sla-admin@yourcompany.com`     | SLA Admins                                          | `labels` `sla` `priority` `slaBaseline` |
| Any Platform team member        | `linearTeamId` on Platform Division                 | `labels` `sla`                          |
| `platform-lead@yourcompany.com` | Platform Division (team) ∪ Platform Team Leads leaf | `labels` `sla` `priority`               |
| Any Mobile team member          | `linearTeamId` on Mobile Division                   | `labels` `sla`                          |
| `mobile-lead@yourcompany.com`   | Mobile Division (team) ∪ own leaf override          | `labels` `sla` `priority`               |
| Anyone else                     | No match                                            | — (all changes reverted)                |


The key pattern: start with a narrow baseline at the division level (`labels` + `sla`), then widen it for specific roles by adding a sub-group or leaf override. Admins who need `slaBaseline` live in a separate root-level group so the elevated permission cannot accidentally propagate through inheritance.

### Finding your Linear team ID

1. Go to Linear → Settings → Teams.
2. Click on the team.
3. Look at the URL: `https://linear.app/your-org/settings/teams/TEAM-ID-HERE`

### Recommended permission structure

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
      "name": "Team Leads",
      "permissions": ["labels", "sla", "priority"],
      "members": [
        { "email": "team-lead-1@yourcompany.com", "name": "Team Lead 1" },
        { "email": "team-lead-2@yourcompany.com", "name": "Team Lead 2" }
      ]
    },
    {
      "name": "Engineering Teams (all members via Linear team)",
      "linearTeamId": "your-eng-team-id",
      "permissions": ["labels"]
    }
  ]
}
```

In this setup:

- SLA Admins can do everything, including moving the SLA clock origin.
- Team leads can extend deadlines and manage labels but cannot touch the clock start.
- All engineers can add/remove the `oosla` label but cannot touch any SLA or priority fields.

---

## Protected fields

Configure which field types the agent enforces in `config.json`:

```json
{
  "protectedFields": {
    "label": true,
    "sla": true,
    "priority": true,
    "slaCreatedAtBaseline": true
  }
}
```


| Field                  | Recommended | Effect                                                             |
| ---------------------- | ----------- | ------------------------------------------------------------------ |
| `label`                | ✅ Yes       | Prevents unauthorized removal of the `oosla` label                 |
| `sla`                  | ✅ Yes       | Reverts unauthorized changes to `slaType` and `slaBreachesAt`      |
| `priority`             | ✅ Yes       | Reverts unauthorized priority changes                              |
| `slaCreatedAtBaseline` | ✅ Yes       | Enforces that `slaStartedAt` always equals the issue creation date |


---

## Behavior modes

Use these during rollout to validate the agent before going live:


| Mode            | How to enable        | Effect                                   |
| --------------- | -------------------- | ---------------------------------------- |
| **Dry run**     | `"dryRun": true`     | Logs what would happen, makes no changes |
| **Notify only** | `"notifyOnly": true` | Posts comments but does not revert       |
| **Live**        | Both `false`         | Full enforcement — reverts and comments  |


**Recommended rollout sequence:**

1. Start with `dryRun: true` for 1–2 days. Review `logs/combined.log` to see what the agent would have reverted.
2. Switch to `notifyOnly: true` for another few days. Watch comments appear on issues.
3. Go fully live: both `false`.

---

## Setup steps

### 1. Install dependencies

```bash
cd sla_enforcement
npm install
```

### 2. Set environment variables

Create `.env` in the project root:

```bash
# Required
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Required for webhook signature verification
LINEAR_WEBHOOK_SECRET=your_webhook_secret_here

# Optional — only if using Slack notifications
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxx
```

To create a Linear API key: Linear → Settings → API → Personal API Keys.

We strongly recommend creating a **Linear OAuth App** instead of a personal key so agent actions appear as coming from a named agent (e.g. "SLA Protection Agent") rather than a person.

### 3. Configure the agent

```bash
cp config/config.json.example config/config.json
```

Edit `config/config.json` with your settings (labels, allowlist, permissions).

### 4. Start the agent

```bash
# Development
npm run dev

# Production (compile first)
npm run build
npm start
```

### 5. Expose the agent via ngrok

In a separate terminal:

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok-free.app`).

### 6. Create the webhook in Linear

1. Go to Linear → Settings → API → Webhooks → Create webhook.
2. URL: `https://abc123.ngrok-free.app/webhooks/linear`
3. Resource types: check **Issue** and **IssueSLA**.
4. Save and copy the webhook secret.
5. Add the secret to `.env` as `LINEAR_WEBHOOK_SECRET`.
6. Restart the agent.

### 7. Apply the `oosla` label to issues you want to protect

The agent only acts on issues carrying a protected label. Add `oosla` (or whatever you configured in `protectedLabels`) to the issues that should be SLA-enforced.

---

## Monitoring

### Health check

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "healthy",
  "agent": "SLA Protection Agent",
  "uptime": 3600
}
```

### Enforcement metrics

```bash
curl http://localhost:3000/metrics
```

Returns counts of enforced, allowed, and detected changes since the last restart.

### Logs


| File                | Contents                             |
| ------------------- | ------------------------------------ |
| `logs/combined.log` | All application logs                 |
| `logs/error.log`    | Errors only                          |
| `logs/audit.log`    | One JSON line per enforcement action |


### Audit log entry

```json
{
  "timestamp": "2026-04-14T00:00:00.000Z",
  "webhookId": "webhook-123",
  "issueId": "issue-456",
  "issueIdentifier": "ENG-123",
  "actor": { "email": "user@yourcompany.com", "name": "User" },
  "action": "reverted",
  "actorPermissions": ["labels"],
  "reason": "User not authorized for any changed fields",
  "changes": [
    { "field": "slaBreachesAt", "oldValue": "2026-05-01", "newValue": "2026-06-01", "reverted": true }
  ]
}
```

The `actorPermissions` field shows exactly what the actor was authorized for at the time of the event, making it easy to audit why a change was or wasn't allowed.

---

## Frequently asked questions

**Q: A user is in a Linear team that is in our allowlist, but the agent is still reverting their changes.**

The team member cache is populated at startup and refreshed every 4 hours. If the user was added to the team recently, restart the agent or wait for the next refresh cycle. You can also add the user directly as a flat leaf entry as an immediate workaround.

**Q: We need to temporarily give a user more permissions without editing the config.**

Add them as a flat leaf entry with the required permissions. Since union resolution applies, adding a more permissive entry will not reduce any existing permissions.

**Q: Can we allow someone to reset the SLA clock in an emergency?**

Yes — add the user to a group or flat entry with `slaBaseline` permission, or temporarily add them to the admins group. After the reset, remove the elevated permission.

**Q: The agent is reverting changes made by a workflow or automation.**

Check the actor in the audit log. If it is a Linear integration or automation, add its Linear user ID to the allowlist with the appropriate permissions. Integration actors can be identified by `"type": "integration"` in the webhook payload.

**Q: How do I stop the agent from acting on a specific issue?**

Remove the protected label from the issue. The agent only enforces on issues that currently carry (or previously carried) a protected label.

**Q: We want SLA enforcement but not label or priority protection.**

Set `"label": false` and `"priority": false` in `protectedFields`. The agent will only watch SLA fields.