# Receiving Webhooks

This guide shows how to receive and filter webhook events from Linear.

## Overview

Linear sends webhooks when data changes in your workspace. You configure a webhook URL, and Linear POSTs events to it.

**Use cases:**
- Sync Linear issues to external systems
- Trigger workflows when issues change state
- Build real-time dashboards
- Audit logging

---

## Setting Up Webhooks

### Via UI

1. Go to **Settings → API → Webhooks**
2. Click **New webhook**
3. Enter your endpoint URL
4. Select the resource types to subscribe to
5. Optionally filter to specific teams
6. Save and note the **Signing secret**

### Via API

```graphql
mutation {
  webhookCreate(input: {
    url: "https://your-server.com/webhooks/linear"
    teamId: "team-uuid"  # Optional: filter to specific team
    resourceTypes: ["Issue", "Comment", "Project"]
    enabled: true
    label: "My Integration"
  }) {
    success
    webhook {
      id
      secret  # Save this for signature verification
    }
  }
}
```

---

## Webhook Payload Structure

All webhooks have this structure:

```json
{
  "action": "create" | "update" | "remove",
  "type": "Issue" | "Comment" | "Project" | ...,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "data": { ... },           // The resource data
  "updatedFrom": { ... },    // Previous values (for updates)
  "url": "https://linear.app/...",
  "organizationId": "org-uuid",
  "webhookTimestamp": 1705315800000,
  "webhookId": "webhook-uuid"
}
```

### Actions

| Action | When |
|--------|------|
| `create` | Resource was created |
| `update` | Resource was modified |
| `remove` | Resource was deleted/archived |

### Resource Types

| Type | Description |
|------|-------------|
| `Issue` | Issues created, updated, deleted |
| `Comment` | Comments on issues |
| `Project` | Projects |
| `ProjectUpdate` | Project status updates |
| `Cycle` | Cycles (sprints) |
| `IssueLabel` | Labels |
| `Reaction` | Emoji reactions |

---

## Signature Verification

**Always verify webhook signatures** to ensure requests come from Linear.

Linear signs webhooks using HMAC-SHA256. The signature is in the `Linear-Signature` header.

### Verification Steps

1. Get the raw request body (as string, not parsed JSON)
2. Compute HMAC-SHA256 of the body using your webhook secret
3. Compare with the `Linear-Signature` header

```typescript
import crypto from "crypto";

function verifySignature(
  body: string,        // Raw request body
  signature: string,   // Linear-Signature header
  secret: string       // Your webhook secret
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

**Important:** Use timing-safe comparison to prevent timing attacks.

---

## Filtering Events

### By Resource Type

When creating the webhook, specify which resources you care about:

```graphql
webhookCreate(input: {
  resourceTypes: ["Issue"]  # Only issue events
})
```

### By Team

Filter to events from specific teams:

```graphql
webhookCreate(input: {
  teamId: "team-uuid"  # Only this team's events
})
```

### In Your Handler

Filter events in your code for fine-grained control:

```typescript
function handleWebhook(payload: WebhookPayload) {
  // Filter by action
  if (payload.action !== "update") return;
  
  // Filter by resource type
  if (payload.type !== "Issue") return;
  
  // Filter by specific field changes
  if (!payload.updatedFrom?.stateId) return; // State didn't change
  
  // Filter by team
  if (payload.data.teamId !== "specific-team-uuid") return;
  
  // Filter by label
  const hasUrgentLabel = payload.data.labelIds?.includes("urgent-label-uuid");
  if (!hasUrgentLabel) return;
  
  // Process the event...
}
```

---

## Common Patterns

### Detect State Changes

The `updatedFrom` field shows previous values:

```typescript
function handleStateChange(payload: WebhookPayload) {
  if (payload.action !== "update") return;
  if (payload.type !== "Issue") return;
  
  const oldStateId = payload.updatedFrom?.stateId;
  const newStateId = payload.data.stateId;
  
  if (!oldStateId || oldStateId === newStateId) return;
  
  console.log(`Issue ${payload.data.identifier} moved from state ${oldStateId} to ${newStateId}`);
}
```

### Detect Assignment Changes

```typescript
function handleAssignmentChange(payload: WebhookPayload) {
  if (payload.action !== "update") return;
  if (payload.type !== "Issue") return;
  
  // Check if assigneeId changed (could be in updatedFrom even if set to null)
  if (!("assigneeId" in (payload.updatedFrom || {}))) return;
  
  const oldAssignee = payload.updatedFrom?.assigneeId;
  const newAssignee = payload.data.assigneeId;
  
  if (newAssignee && !oldAssignee) {
    console.log(`Issue ${payload.data.identifier} was assigned`);
  } else if (!newAssignee && oldAssignee) {
    console.log(`Issue ${payload.data.identifier} was unassigned`);
  } else {
    console.log(`Issue ${payload.data.identifier} was reassigned`);
  }
}
```

### Detect Priority Changes

```typescript
function handlePriorityChange(payload: WebhookPayload) {
  if (payload.action !== "update") return;
  if (payload.type !== "Issue") return;
  
  const oldPriority = payload.updatedFrom?.priority;
  const newPriority = payload.data.priority;
  
  if (oldPriority === undefined || oldPriority === newPriority) return;
  
  // Priority increased (lower number = higher priority)
  if (newPriority < oldPriority) {
    console.log(`Issue ${payload.data.identifier} priority increased to ${newPriority}`);
  }
}
```

---

## Webhook Data Fields

### Issue Webhook Data

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Issue ID |
| `identifier` | String | e.g., "ENG-123" |
| `title` | String | Issue title |
| `description` | String | Markdown content |
| `priority` | Int | 0-4 |
| `stateId` | UUID | Workflow state |
| `assigneeId` | UUID | Assigned user |
| `teamId` | UUID | Team |
| `projectId` | UUID | Project |
| `cycleId` | UUID | Cycle |
| `labelIds` | UUID[] | Labels |
| `creatorId` | UUID | Who created it |
| `createdAt` | DateTime | Creation time |
| `updatedAt` | DateTime | Last update |

### Comment Webhook Data

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Comment ID |
| `body` | String | Comment text |
| `issueId` | UUID | Parent issue |
| `userId` | UUID | Author |
| `createdAt` | DateTime | Creation time |

---

## Error Handling

### Retry Behavior

Linear retries failed webhooks with exponential backoff:
- Retries on 5xx errors
- Retries on timeouts
- Does NOT retry on 4xx errors

**Return 200** for successfully processed webhooks, even if you choose to ignore the event.

### Idempotency

Webhooks may be delivered more than once. Use the `webhookId` or resource `id` + `updatedAt` to deduplicate:

```typescript
const processedWebhooks = new Set<string>();

function handleWebhook(payload: WebhookPayload) {
  // Simple deduplication
  if (processedWebhooks.has(payload.webhookId)) {
    return { status: "duplicate" };
  }
  processedWebhooks.add(payload.webhookId);
  
  // Process...
}
```

---

## Implementation

See the code examples:

- **[server.ts](./server.ts)** - Example webhook receiver with signature verification
- **[filters.ts](./filters.ts)** - Common filtering patterns
