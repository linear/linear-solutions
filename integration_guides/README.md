# Linear Integration Guide

Code examples demonstrating how to integrate with Linear's API. Each guide focuses on Linear-specific patterns, best practices, and API usage.

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

## Bricks

### [01 - Creating Issues with Labels](./bricks/01-create-issue-with-labels/)

How to create issues in Linear with dynamically managed labels and label groups.

**Covers:**
- Creating issues via the API
- Understanding label groups vs labels
- Workspace labels vs team labels
- Setting workflow state (Triage)
- The "resolve labels first" pattern

### [02 - Updating Issues](./bricks/02-update-issue/)

How to update existing issues, manage labels, and batch update multiple issues.

**Covers:**
- Finding issues by identifier or UUID
- Partial updates (only change what you need)
- Adding/removing labels
- Batch updating multiple issues

### [03 - Receiving Webhooks](./bricks/03-webhooks/)

How to receive, verify, and filter webhook events from Linear.

**Covers:**
- Webhook payload structure
- Signature verification
- Filtering by action, type, and field changes
- Common patterns (state changes, assignments, priority)

### [04 - Creating Teams from Templates](./bricks/04-create-team-from-template/)

How to create a new team that copies settings from an existing team.

**Covers:**
- What gets copied (workflow states, labels, templates, cycle settings)
- Finding source teams
- Creating sub-teams
- Verifying copied settings

## Resources

- [Linear API Documentation](https://developers.linear.app/docs)
- [Linear GraphQL Reference](https://developers.linear.app/docs/graphql/working-with-the-graphql-api)
- [Linear OAuth Guide](https://developers.linear.app/docs/oauth/authentication)
- [@linear/sdk on npm](https://www.npmjs.com/package/@linear/sdk)
