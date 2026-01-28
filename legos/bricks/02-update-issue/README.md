# Updating Issues

This guide shows how to update existing issues in Linear via the API.

## Issue Fields Reference

When updating an issue via `issueUpdate`, you can modify any of these fields:

### Common Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Issue title |
| `description` | String | Markdown supported |
| `stateId` | UUID | Workflow state |
| `assigneeId` | UUID | Assigned user (null to unassign) |
| `labelIds` | UUID[] | Replace all labels |
| `priority` | Int | `0`=none, `1`=urgent, `2`=high, `3`=medium, `4`=low |
| `estimate` | Int | Story points |
| `dueDate` | String | Format: `YYYY-MM-DD` (null to clear) |

### Organization Fields

| Field | Type | Description |
|-------|------|-------------|
| `projectId` | UUID | Move to a project (null to remove) |
| `projectMilestoneId` | UUID | Project milestone |
| `cycleId` | UUID | Move to a cycle (null to remove) |
| `parentId` | UUID | Parent issue (makes this a sub-issue) |
| `teamId` | UUID | Move to a different team |

### Other Fields

| Field | Type | Description |
|-------|------|-------------|
| `subscriberIds` | UUID[] | Replace all subscribers |
| `sortOrder` | Float | Manual sort position |
| `boardOrder` | Float | Position on board view |
| `subIssueSortOrder` | Float | Position among sub-issues |
| `trashed` | Boolean | Move to trash |
| `snoozedUntilAt` | DateTime | Snooze notifications until |

---

## Key Concepts

### Finding Issues

Issues can be found by:

| Method | Example | Notes |
|--------|---------|-------|
| **UUID** | `issue(id: "uuid-here")` | Direct lookup |
| **Identifier** | `issue(id: "ENG-123")` | Team key + number |
| **Filter** | `issues(filter: {...})` | Search by criteria |

Both UUID and identifier work in the `issue(id:)` query and in `issueUpdate`.

### Partial Updates

`issueUpdate` performs partial updates—only fields you include are modified. Omitted fields remain unchanged.

```graphql
# Only updates the title, everything else stays the same
issueUpdate(id: "ENG-123", input: { title: "New title" })
```

### Label Behavior

`labelIds` **replaces** all labels on the issue. To add/remove a single label:

1. Fetch current labels
2. Modify the array
3. Send the complete new array

```typescript
// Adding a label
const issue = await getIssue("ENG-123");
const currentLabelIds = issue.labels.nodes.map(l => l.id);
await updateIssue("ENG-123", { 
  labelIds: [...currentLabelIds, newLabelId] 
});
```

### Moving Issues Between Teams

When changing `teamId`:
- The issue gets a new identifier (e.g., ENG-123 → PLATFORM-456)
- Workflow state must be valid for the new team (or it resets to default)
- Team-scoped labels may be lost if they don't exist in the new team

---

## Batch Updates

Use `issueUpdate` in a loop or `issueBatchUpdate` for multiple issues:

```graphql
mutation {
  issueBatchUpdate(
    ids: ["uuid-1", "uuid-2", "uuid-3"],
    input: { priority: 1 }
  ) {
    success
  }
}
```

---

## Implementation

See the code examples:

- **[using-sdk.ts](./using-sdk.ts)** - Using the `@linear/sdk` package
- **[using-graphql.ts](./using-graphql.ts)** - Using raw GraphQL queries

Both demonstrate:
1. Finding an issue by identifier
2. Updating common fields
3. Managing labels (add/remove)
4. Batch updates
