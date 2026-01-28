# Creating Issues with Labels

This guide shows how to create issues in Linear with labels, including how to manage label groups and ensure labels exist before use.

## Authentication

Linear's API supports two authentication methods:

| Method | Format | Use Case |
|--------|--------|----------|
| **OAuth** | `lin_oauth_...` | Integrations acting on behalf of users, this is typically recommended |
| **API Key** | `lin_api_...` | Personal scripts, internal tools |

Both are passed in the `Authorization` header (no "Bearer" prefix needed).

**Get credentials:**
- OAuth: [Create an application](https://developers.linear.app/docs/oauth/authentication)
- API Key: [Linear Settings → API](https://linear.app/settings/api)

---

## Finding Your Team

Teams can be referenced by **UUID** or **key**:

| Format | Example | Where to Use |
|--------|---------|--------------|
| **UUID** | `a1b2c3d4-...` | All API fields (`teamId`, filters) |
| **Key** | `ENG` | `team(id: "ENG")` query, URLs |

The `team` query accepts either format:

```graphql
# By key
query { team(id: "ENG") { id name } }

# By UUID  
query { team(id: "a1b2c3d4-...") { id name } }
```

List all teams:

```graphql
query {
  teams {
    nodes {
      id    # UUID
      key   # e.g., "ENG"
      name  # e.g., "Engineering"
    }
  }
}
```

**Note**: Input fields like `teamId` in mutations require the UUID. The key only works with the `team(id:)` query.

---

## Issue Fields Reference

When creating an issue via `issueCreate`, you can set the following fields:

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `teamId` | UUID | Target team (must be UUID, not key) |
| `title` | String | Issue title |

### Common Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | String | Markdown supported |
| `stateId` | UUID | Workflow state (defaults to team's default state) |
| `assigneeId` | UUID | Assigned user |
| `labelIds` | UUID[] | Labels to apply (see rules below) |
| `priority` | Int | `0`=none, `1`=urgent, `2`=high, `3`=medium, `4`=low |
| `estimate` | Int | Story points / estimate |
| `dueDate` | String | Format: `YYYY-MM-DD` |

### Organization Fields

| Field | Type | Description |
|-------|------|-------------|
| `projectId` | UUID | Add to a project |
| `projectMilestoneId` | UUID | Project milestone |
| `cycleId` | UUID | Add to a cycle |
| `parentId` | UUID | Parent issue (makes this a sub-issue) |

### Other Fields

| Field | Type | Description |
|-------|------|-------------|
| `subscriberIds` | UUID[] | Users to subscribe to updates |
| `templateId` | UUID | Apply an issue template |
| `sortOrder` | Float | Manual sort position |

---

## Key Concepts

### Labels Must Be Resolved First

**Critical**: Linear's `issueCreate` mutation validates `labelIds` strictly. If any ID is invalid or inaccessible, the **entire mutation fails**. Linear will not create the issue without labels as a fallback.

**Pattern**: Resolve/create labels first, then create the issue with valid IDs.

This is the same pattern Linear uses internally for imports.

---

### Label Groups

In Linear's API, **label groups are just labels with `isGroup: true`**. Child labels reference their group via `parentId`.

Example structure (labels are flexible—use whatever fits your workflow):

```
Label Group: "Platform"     (isGroup: true)
├── Label: "iOS"            (parentId: Platform's ID)
├── Label: "Android"        (parentId: Platform's ID)
└── Label: "Web"            (parentId: Platform's ID)

Label Group: "Issue Type"   (isGroup: true)
├── Label: "Bug"            (parentId: Issue Type's ID)
├── Label: "Feature"        (parentId: Issue Type's ID)
└── Label: "Task"           (parentId: Issue Type's ID)
```

**Important rules:**
- **Groups cannot be applied to issues** - Only child labels can be assigned to issues, not the group itself
- **One child per group per issue** - If you have a "Platform" group, you can only apply one platform label (iOS OR Android, not both)
- **Parent must be a group** - A label with `parentId` must point to a label that has `isGroup: true`

The code examples use "Platform" and "Issue Type" as sample label groups, but labels are generic—create whatever structure suits your needs.

---

### Workspace vs Team Labels

Labels can be scoped to:

| Scope | How | When to Use |
|-------|-----|-------------|
| **Workspace** | Omit `teamId` when creating | Shared across all teams |
| **Team** | Include `teamId` when creating | Only visible to that team |

Choose based on whether the label concept applies across teams or is team-specific.

**Note**: If using team labels, the child label's team must match the parent group's team.

---

### Workflow States

Every issue has a workflow state. Common state types:

| Type | Purpose |
|------|---------|
| `triage` | Inbox for review before prioritization |
| `backlog` | Prioritized but not started |
| `unstarted` | Ready to be worked on |
| `started` | In progress |
| `completed` | Done |
| `canceled` | Won't do |

When creating issues programmatically, consider placing them in **Triage** (if available) rather than the default—this gives teams an inbox to review before items reach the backlog.

**Tip**: Filter by `state.type` rather than name for reliability, since teams may rename their states.

---

## Implementation

See the code examples:

- **[using-sdk.ts](./using-sdk.ts)** - Using the `@linear/sdk` package
- **[using-graphql.ts](./using-graphql.ts)** - Using raw GraphQL queries

Both demonstrate:
1. Querying existing labels
2. Creating missing label groups and labels
3. Looking up workflow states (example uses Triage)
4. Creating an issue with labels and state
