# HubSpot to Linear Integration

Automatically sync HubSpot tickets and companies with Linear issues and customers.

## Features

- 🎫 **Ticket Sync**: Creates Linear issues when HubSpot tickets are created
- 👥 **Customer Sync**: Bi-directional or unidirectional sync between HubSpot companies and Linear customers
- 🔧 **Configurable Field Mappings**: Customize which HubSpot fields map to Linear fields
- 🎯 **Filtering**: Filter tickets by pipeline, status, priority, or category
- 🔒 **Secure**: Webhook signature verification for both HubSpot and Linear
- 🏷️ **Customizable**: Map priorities, statuses, tiers, and add labels
- 🔗 **Bidirectional Links**: 
  - Adds HubSpot ticket link as an attachment to Linear issues
  - Optionally adds a note to HubSpot tickets with Linear issue link
- ⚙️ **Feature Flags**: Enable or disable ticket creation and customer syncing independently
- 🔄 **Loop Prevention**: Smart sync locking prevents infinite update loops

## Prerequisites

- Node.js 16 or higher
- A HubSpot account with API access
- A Linear account with API access
- A publicly accessible URL for webhooks (use ngrok for local development)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp env.example .env
# Edit .env with your credentials

# 3. Start the server
npm start

# 4. For development with debug logging
DEBUG=true npm start
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file and fill in your credentials:

```bash
cp env.example .env
```

Edit `.env` with your configuration:

```env
# Required
HUBSPOT_ACCESS_TOKEN=your_hubspot_access_token
LINEAR_API_KEY=your_linear_api_key
LINEAR_TEAM_ID=your_linear_team_id

# Security (recommended for production)
HUBSPOT_CLIENT_SECRET=your_hubspot_webhook_secret
LINEAR_WEBHOOK_SECRET=your_linear_webhook_secret

# Feature Flags
ENABLE_TICKET_SYNC=true
ENABLE_CUSTOMER_SYNC=true
CUSTOMER_SYNC_DIRECTION=bidirectional

# Optional
PORT=3000
DEBUG=false
UPDATE_HUBSPOT_WITH_LINEAR_LINK=true
```

### 3. Get Your HubSpot Access Token

1. Go to **HubSpot Settings** → **Integrations** → **Private Apps**
2. Create a new private app or use an existing one
3. Grant the following scopes:

| Scope | Purpose | Required |
|-------|---------|----------|
| `tickets` | Read/write tickets | For ticket sync |
| `crm.objects.companies.read` | Read companies | For customer sync |
| `crm.objects.companies.write` | Create/update companies | For bidirectional sync |
| `crm.objects.owners.read` | Look up owner emails | For owner mapping |

4. Copy the access token to `HUBSPOT_ACCESS_TOKEN`

### 4. Get Your Linear API Key

1. Go to **Linear Settings** → **API** → **Personal API Keys**
2. Create a new API key with appropriate permissions
3. Copy the key to `LINEAR_API_KEY`

### 5. Get Your Linear Team ID

Use your team key from the Linear URL. When viewing your team, the URL looks like:
`https://linear.app/YOUR-TEAM/...`

```env
LINEAR_TEAM_ID=YOUR-TEAM
```

### 6. Set Up HubSpot Webhook

1. Go to **HubSpot Settings** → **Integrations** → **Private Apps** → Your App → **Webhooks**
2. Create webhook subscriptions for:
   - **Ticket Creation** (for ticket sync)
   - **Company Creation** (for customer sync)
   - **Company Property Change** (for customer sync)
3. Set the target URL to: `https://your-domain.com/webhooks/hubspot`
4. For company property changes, subscribe to these properties:
   - `name` (required - used for matching)
   - `domain`
   - `annualrevenue`
   - `numberofemployees`
   - `hs_lead_status`
   - `hs_ideal_customer_profile`
   - `hubspot_owner_id`
5. Copy the webhook signing secret to `HUBSPOT_CLIENT_SECRET`

**Important:** The properties you subscribe to must match your `config/field-mappings.json`. If you customize field mappings, update your webhook subscriptions accordingly.

### 7. Set Up Linear Webhook (for bidirectional sync)

If using bidirectional customer sync:

1. Go to **Linear Settings** → **API** → **Webhooks**
2. Create a new webhook
3. Set the target URL to: `https://your-domain.com/webhooks/linear`
4. Subscribe to:
   - **Customer** events (created, updated)
5. Copy the signing secret to `LINEAR_WEBHOOK_SECRET`

### 8. Configure Field Mappings

Customize field mappings by editing `config/field-mappings.json`:

```json
{
  "hubspotFields": {
    "status": "hs_lead_status",
    "tier": "hs_ideal_customer_profile",
    "owner": "hubspot_owner_id",
    "revenue": "annualrevenue",
    "size": "numberofemployees",
    "domain": "domain"
  },
  "statusMapping": {
    "hubspotToLinear": {
      "NEW": "Prospect",
      "OPEN": "Active",
      "IN_PROGRESS": "Active",
      "UNQUALIFIED": "Lost"
    },
    "linearToHubspot": {
      "Prospect": "NEW",
      "Active": "OPEN",
      "Churned": "UNQUALIFIED",
      "Lost": "UNQUALIFIED"
    }
  },
  "tierMapping": {
    "hubspotToLinear": {
      "true": "Enterprise",
      "false": "Standard"
    },
    "linearToHubspot": {
      "Enterprise": "true",
      "Tier 1": "tier_1",
      "Tier 2": "tier_2",
      "Tier 3": "tier_3"
    }
  }
}
```

### 9. Deploy and Run

**Local Development:**
```bash
# Start the server
npm start

# Start with debug logging
DEBUG=true npm start

# Use ngrok to expose your local server
ngrok http 3000
```

**Production:**
Deploy to your preferred platform (Heroku, AWS, Railway, Render, etc.).

---

## How It Works

### Ticket Sync

1. A ticket is created in HubSpot
2. HubSpot sends a webhook to your server
3. The server validates the webhook and fetches ticket details
4. If the ticket matches your filter criteria, a Linear issue is created
5. The HubSpot ticket URL is attached to the Linear issue
6. (Optional) A note is added to the HubSpot ticket with the Linear issue link

### Customer Sync

**Unidirectional (HubSpot → Linear):**
1. A company is created or updated in HubSpot
2. The server finds a matching Linear customer by name (or domain as fallback)
3. The Linear customer is created or updated with mapped fields

**Bidirectional (HubSpot ↔ Linear):**
- Same as above, plus:
- When a customer is created or updated in Linear, it syncs to HubSpot
- Loop prevention ensures updates don't bounce back and forth

### Matching Logic

Customers are matched in this order:
1. **By name** (case-insensitive)
2. **By domain** (fallback if name doesn't match)

This ensures renaming a company in HubSpot still finds the correct Linear customer.

---

## Field Mapping Reference

### Default Mapping

| Linear Field | HubSpot Property | Notes |
|--------------|------------------|-------|
| `name` | `name` | Required, used for matching |
| `domains` | `domain` | Single domain in HubSpot, array in Linear |
| `revenue` | `annualrevenue` | Numeric value |
| `size` | `numberofemployees` | Numeric employee count |
| `status` | `hs_lead_status` | Mapped via config |
| `tier` | `hs_ideal_customer_profile` | Mapped via config |
| `owner` | `hubspot_owner_id` | Matched by email |

**Note:** `logoUrl` is NOT synced because Linear only accepts logos hosted on `public.linear.app`.

### How Mapping Works

1. **Exact name match** - If HubSpot value "Active" matches Linear status "Active", it maps automatically
2. **Normalized match** - HubSpot internal values like `tier_1` are normalized to `Tier 1` for matching
3. **Config fallback** - If names differ, uses mappings from `field-mappings.json`
4. **Skip if no match** - Unmapped fields are skipped (doesn't break sync)

### Customizing HubSpot Fields

The `hubspotFields` section lets you specify which HubSpot properties to use:

| Use Case | Configuration |
|----------|---------------|
| Use owner email instead of ID | `"owner": "owneremail"` |
| Use lifecycle stage for status | `"status": "lifecyclestage"` |
| Use custom tier field | `"tier": "customer_tier"` |
| Use custom employee count | `"size": "num_employees"` |

**Owner field behavior:**
- If the value contains `@`, it's treated as an email directly
- Otherwise, it's treated as a HubSpot owner ID and the email is looked up via API

### Owner Email Mapping

If HubSpot users have different emails than Linear users, add mappings in `src/services/customerSync.js`:

```javascript
const EMAIL_MAPPING = {
  'hubspot-user@company.com': 'linear-user@company.com',
};
```

For most setups, this can remain empty if users have the same email in both systems.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | Yes | - | HubSpot private app token |
| `LINEAR_API_KEY` | Yes | - | Linear API key |
| `LINEAR_TEAM_ID` | Yes | - | Linear team key or UUID |
| `PORT` | No | 3000 | Server port |
| `DEBUG` | No | false | Enable debug logging |
| `HUBSPOT_CLIENT_SECRET` | No | - | HubSpot webhook secret |
| `LINEAR_WEBHOOK_SECRET` | No | - | Linear webhook secret |
| `ENABLE_TICKET_SYNC` | No | true | Enable ticket sync |
| `ENABLE_CUSTOMER_SYNC` | No | false | Enable customer sync |
| `CUSTOMER_SYNC_DIRECTION` | No | unidirectional | `bidirectional` or `unidirectional` |
| `UPDATE_HUBSPOT_WITH_LINEAR_LINK` | No | false | Add Linear link to HubSpot tickets |

### Ticket Filtering

```env
HUBSPOT_PIPELINE_ID=123456
HUBSPOT_TICKET_STATUS=NEW
HUBSPOT_TICKET_PRIORITY=HIGH
HUBSPOT_TICKET_CATEGORY=SUPPORT
```

### Priority Mapping (Tickets)

| HubSpot Priority | Linear Priority |
|------------------|-----------------|
| URGENT | Urgent (1) |
| HIGH | High (2) |
| MEDIUM | Medium (3) |
| LOW | Low (4) |
| (none) | No priority (0) |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/health?detailed=true` | GET | Detailed health (checks Linear API) |
| `/webhooks/hubspot` | POST | HubSpot webhook receiver |
| `/webhooks/linear` | POST | Linear webhook receiver |
| `/linear-webhook` | POST | Linear webhook (alias) |

---

## Architecture

### Security Features

- **Webhook Signature Verification**: Both HubSpot and Linear webhooks are verified using HMAC with timing-safe comparison
- **Request Tracking**: Each request gets a unique ID (`X-Request-ID` header) for debugging

### Sync Loop Prevention

Bidirectional sync uses a 10-second lock per entity to prevent infinite loops:
1. When syncing Entity A from HubSpot → Linear, a lock is set
2. Linear webhook fires for the update
3. Lock prevents syncing back to HubSpot
4. Lock expires after 10 seconds

### Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` signals, allowing in-flight requests to complete before shutting down.

---

## Testing

### Quick Health Check

```bash
# Basic health
curl http://localhost:3000/health

# Detailed health (verifies Linear API)
curl "http://localhost:3000/health?detailed=true"
```

### Integration Testing

1. Start ngrok: `ngrok http 3000`
2. Configure webhooks in HubSpot and Linear with the ngrok URL
3. Create/update entities and watch the logs

### Test Scenarios

| Action | Expected Result |
|--------|-----------------|
| Create HubSpot ticket | Linear issue created |
| Create HubSpot company | Linear customer created |
| Update HubSpot company | Linear customer updated |
| Rename company in HubSpot | Customer found by domain, name updated |
| Create Linear customer | HubSpot company created (if bidirectional) |
| Update Linear customer | HubSpot company updated (if bidirectional) |

### Debug Logging

Enable with `DEBUG=true` to see:
- Webhook payloads
- Field mapping decisions
- Status/tier mapping matches
- Owner email lookups
- API responses

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| 401 on HubSpot webhook | Check `HUBSPOT_CLIENT_SECRET` matches webhook secret |
| 401 on Linear webhook | Check `LINEAR_WEBHOOK_SECRET` matches webhook secret |
| Customer not found | Check domain matching (company may have been renamed) |
| Status/tier not syncing | Add mapping to `config/field-mappings.json` |
| Owner not mapping | Ensure emails match, or add to `EMAIL_MAPPING` |
| 403 on owner lookup | Add `crm.objects.owners.read` scope to HubSpot app |
| 400 invalid option | Check `linearToHubspot` mappings use HubSpot internal values |

### HubSpot Internal Values

HubSpot often uses internal values that differ from display names:

| Display Name | Internal Value |
|--------------|----------------|
| Tier 1 | `tier_1` |
| Tier 2 | `tier_2` |
| Tier 3 | `tier_3` |
| New | `NEW` |
| Open | `OPEN` |

When mapping from Linear → HubSpot, use the internal values in `linearToHubspot`.

### Log Levels

- `[INFO]` - Normal operations
- `[DEBUG]` - Detailed debugging (requires `DEBUG=true`)
- `[WARN]` - Non-fatal issues
- `[ERROR]` - Errors (usually recoverable)

---

## License

MIT
