# Customer Request Intake

This guide shows how to attach customer requests to issues created from an external system (e.g., HubSpot), and how to use Triage Intelligence to handle de-duplication.

## Context

If you're already creating issues in Linear from an external system—via API calls in a workflow, webhook handler, or custom integration—you can extend that flow to also create customer requests. This links real customer feedback to the issues your team works on, giving product teams visibility into who's asking for what.

The pattern is straightforward: when creating an issue, also upsert the customer and attach a customer request to the newly created issue.

---

## Authentication

Linear's API supports two authentication methods:

| Method | Format | Use Case |
|--------|--------|----------|
| **OAuth** | `lin_oauth_...` | Integrations acting on behalf of users |
| **API Key** | `lin_api_...` | Personal scripts, internal tools |

Both are passed in the `Authorization` header (no "Bearer" prefix needed).

**Get credentials:**
- OAuth: [Create an application](https://developers.linear.app/docs/oauth/authentication)
- API Key: [Linear Settings → API](https://linear.app/settings/api)

---

## Data Model

Customer requests rely on two objects:

### `Customer`

Represents an external company or organization. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Company name |
| `domains` | String[] | Email domains (e.g., `["acme.com"]`) |
| `externalIds` | String[] | IDs from external systems (e.g., HubSpot company ID) |
| `tierId` | UUID | Customer tier (Enterprise, Pro, etc.) |
| `revenue` | Number | Customer revenue |
| `size` | Number | Company size |

### `CustomerNeed`

Represents a customer request. Attached to an `Issue` and to a `Customer`.

| Field | Type | Description |
|-------|------|-------------|
| `issueId` | UUID | The issue this request is associated with |
| `customerId` | UUID | The customer in Linear |
| `customerExternalId` | String | External customer ID (alternative to `customerId`) |
| `body` | String | Request content, markdown supported |
| `priority` | Number | `0` = not important, `1` = important |
| `attachmentUrl` | String | Source URL (creates a linked attachment) |

---

## Key Concepts

### Upserting Customers

When your external system creates issues in Linear, the customer likely already exists—either created manually, by another integration (Intercom, Zendesk, etc.), or by a previous run of your own workflow. The `customerUpsert` mutation handles this gracefully:

- **Customer doesn't exist** → creates a new one
- **Customer exists** (matched by domain) → merges `domains` and `externalIds` into the existing record

This means you don't need to check whether a customer exists before creating one. Just upsert every time.

```graphql
mutation {
  customerUpsert(input: {
    domains: ["acme.com"]
    externalId: "hubspot-company-12345"
  }) {
    success
    customer { id name }
  }
}
```

**Why this matters**: If another integration (e.g., Intercom) already created the customer, a plain `customerCreate` would fail on the domain uniqueness constraint. `customerUpsert` avoids this entirely.

### Linking Requests via External ID

Once you've upserted a customer with an `externalId`, you can reference that ID when creating requests instead of looking up the Linear customer UUID:

```graphql
mutation {
  customerNeedCreate(input: {
    issueId: "issue-uuid"
    customerExternalId: "hubspot-company-12345"
    body: "Request details..."
  }) {
    success
  }
}
```

This is particularly useful when your external system has its own customer/company identifiers.

### Attaching Source URLs

When a request originates from a specific record in your external system (e.g., a HubSpot ticket), include the `attachmentUrl` to create a link back to the source:

```graphql
mutation {
  customerNeedCreate(input: {
    issueId: "issue-uuid"
    customerExternalId: "hubspot-company-12345"
    body: "Request details..."
    attachmentUrl: "https://app.hubspot.com/contacts/12345/ticket/67890"
  }) {
    success
  }
}
```

This creates an attachment on the issue that links directly to the source record.

---

## The Full Flow

When your external system (e.g., HubSpot workflow) triggers issue creation:

1. **Create the issue** with labels and triage state (see [Creating Issues with Labels](../01-create-issue-with-labels/))
2. **Upsert the customer** using their domain and your system's company ID
3. **Create the customer request** attached to the issue, referencing the customer

```
HubSpot Ticket Created
  │
  ├─→ issueCreate          (issue with labels, placed in Triage)
  │     │
  │     └─→ returns issueId
  │
  ├─→ customerUpsert        (find-or-create the customer)
  │
  └─→ customerNeedCreate    (attach request to issue + customer)
```

The `customerUpsert` and `issueCreate` calls are independent—they can run in parallel. The `customerNeedCreate` depends on the issue ID from `issueCreate`.

---

## CustomerNeedCreate Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | UUID | **Yes** | Issue to attach the request to |
| `body` | String | No | Request content (markdown) |
| `customerId` | UUID | No* | Linear customer UUID |
| `customerExternalId` | String | No* | External customer identifier |
| `priority` | Number | No | `0` = normal, `1` = important |
| `attachmentUrl` | String | No | URL to source (creates an attachment) |

*Provide either `customerId` or `customerExternalId` to associate with a customer.

---

## Segmentation with Labels

If you have multiple teams or products, use labels at the issue level to segment customer requests. For example:

```
Label Group: "Product"
├── "Product A"
└── "Product B"

Label Group: "Source"
├── "HubSpot"
└── "Intercom"
```

When creating issues from your external system, apply the appropriate labels. Teams can then build [custom views](https://linear.app/docs/custom-views) filtered by these labels combined with customer attributes (tier, revenue, request count) to surface what matters most.

This approach keeps customer requests unified in Linear while giving each team a tailored view of their relevant requests.

---

## Triage Intelligence & De-duplication

When external systems push issues into Linear, duplicates are inevitable—multiple customers report the same problem, or the same issue comes in through different channels. [Triage Intelligence](https://linear.app/docs/triage-intelligence) automates the detection and consolidation of these duplicates.

> **Note**: Triage Intelligence is available on Business and Enterprise plans.

### How It Works

When enabled, every issue that enters Triage is analyzed against existing issues using semantic similarity. If a likely duplicate is found, Triage Intelligence surfaces a suggestion with an explanation of why the issues are related.

For customer requests, this is powerful: if five different customers report the same bug through HubSpot, Triage Intelligence identifies that these are the same underlying issue. Each customer's request is preserved (maintaining the voice of the customer), but the issues are consolidated so engineering sees one item to work on with five customer signals attached.

### Setup

1. Navigate to **Settings → AI** and toggle Triage Intelligence on (requires admin)
2. The feature is enabled workspace-wide by default; disable for specific teams in that team's triage settings if needed
3. Optionally scope suggestions to within a team and its sub-teams using the "Include suggestions from" setting

### Duplicate Handling Modes

Per team, configure how duplicate suggestions are handled:

| Mode | Behavior |
|------|----------|
| **Suggest** | Surfaces a suggestion for a human to accept or dismiss |
| **Auto-apply** | Automatically marks duplicates and consolidates |
| **Hidden** | Disables duplicate detection for that team |

For high-volume intake from external systems, **auto-apply** can significantly reduce manual triage effort. Start with **suggest** to build confidence in the detection quality, then move to auto-apply once you're satisfied.

### What Happens When a Duplicate Is Accepted

When a duplicate suggestion is accepted (or auto-applied):
- The new issue is marked as a duplicate of the existing issue
- The new issue moves to **Canceled** status
- Customer requests from the new issue are preserved and remain linked to the customer
- The existing issue accumulates customer signals, making it easy to see how many customers are affected

### Refining Suggestions

If you notice persistent incorrect suggestions, add guidance in triage settings at the workspace, team, or sub-team level. This is best used reactively rather than during initial setup. More local guidance (sub-team) takes priority over broader guidance (workspace).

### Manual Trigger

Triage Intelligence can also be triggered on issues outside of Triage. Use the `Cmd`/`Ctrl` + `K` menu and search for **Find Suggestions** to run detection on any issue.

---

## Implementation

See the code examples:

- **[using-sdk.ts](./using-sdk.ts)** — Using the `@linear/sdk` package
- **[using-graphql.ts](./using-graphql.ts)** — Using raw GraphQL queries

Both demonstrate:
1. Upserting a customer from external system data
2. Creating an issue with labels in Triage
3. Attaching a customer request to the issue
