# Creating a Team from Another Team's Settings

This guide shows how to create a new team that copies settings from an existing team—the same functionality as "Copy settings from existing team" in the Linear UI.

## What Gets Copied

When you create a team with `copySettingsFromTeamId`, Linear copies:

| Category | What's Copied |
|----------|---------------|
| **Workflow States** | All states (Triage, Backlog, In Progress, Done, etc.) |
| **Labels** | All labels including label groups and hierarchy |
| **Templates** | Issue and project templates, including default templates |
| **Cycle Settings** | Duration, cooldown, start day, auto-assignment rules |
| **Git Automation** | Git automation states and target branches |
| **Other Settings** | Timezone, estimation settings, auto-archive/close periods |

### What's NOT Copied

- Team members
- Actual issues, projects, or cycles
- Slack notification settings
- Integrations

---

## API Reference

### TeamCreateInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | String | Yes | Team name |
| `key` | String | No | Team key (e.g., "ENG"). Auto-generated if omitted |
| `description` | String | No | Team description |
| `icon` | String | No | Team icon emoji |
| `color` | String | No | Team color (hex code) |
| `private` | Boolean | No | Whether team is private |
| `timezone` | String | No | Team timezone |

### copySettingsFromTeamId

Pass this as a separate argument (not in the input object):

```graphql
teamCreate(
  input: { name: "New Team", key: "NEW" },
  copySettingsFromTeamId: "source-team-uuid"
)
```

---

## Finding Teams to Copy From

List teams to find the source team's UUID:

```graphql
query {
  teams {
    nodes {
      id      # Use this as copySettingsFromTeamId
      key
      name
    }
  }
}
```

Or query by key:

```graphql
query {
  team(id: "ENG") {  # Team key
    id               # UUID to use
    name
  }
}
```

---

## Sub-Teams

When creating a sub-team, it automatically inherits settings from the parent. You don't need to specify `copySettingsFromTeamId`—it's implicit:

```graphql
teamCreate(input: {
  name: "Mobile Team",
  key: "MOBILE",
  parentId: "parent-team-uuid"  # Inherits from parent
})
```

Sub-teams also inherit certain entities (labels, templates) from their parent on an ongoing basis, not just at creation time.

---

## Important Notes

### Workflow States

- Existing default states on the new team are **deleted** and replaced with the source team's states
- State IDs are mapped internally (the new team gets new UUIDs)
- Default issue state, auto-close state, and duplicate state are set correctly

### Labels

- Labels are copied with their hierarchy preserved
- Label group → child label relationships are maintained
- Team-scoped labels stay team-scoped

### Templates

- Templates are copied with state and label references remapped
- Default templates (for members, non-members, projects) are set

### Permissions

- You need permission to create teams in the workspace
- You need read access to the source team to copy from it

---

## Implementation

See the code examples:

- **[using-sdk.ts](./using-sdk.ts)** - Using the `@linear/sdk` package
- **[using-graphql.ts](./using-graphql.ts)** - Using raw GraphQL queries

Both demonstrate:
1. Finding a source team to copy from
2. Creating a new team with copied settings
3. Verifying the team was created correctly
