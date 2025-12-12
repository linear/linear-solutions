# HubSpot to Linear Integration

Automatically create Linear tickets in your team's triage queue when specific HubSpot tickets are created.

[Video Walkthrough](https://us02web.zoom.us/clips/share/ldegdTl1QwyrAnU7PqUGQA)

## Features

- 🔄 **Automatic Sync**: Creates Linear issues when HubSpot tickets are created
- 🎯 **Filtering**: Filter tickets by pipeline, status, priority, or category
- 🔒 **Secure**: Webhook signature verification (v1 and v3)
- 🏷️ **Customizable**: Map priorities, add labels, and customize issue format
- 🔗 **Bidirectional Links**: 
  - Adds HubSpot ticket link as an attachment to Linear issues
  - Optionally adds a note to HubSpot tickets with Linear issue link

## Prerequisites

- Node.js 16 or higher
- A HubSpot account with API access
- A Linear account with API access
- A publicly accessible URL for webhooks (use ngrok for local development)

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

# Optional
PORT=3000
DEBUG=false
HUBSPOT_CLIENT_SECRET=your_webhook_secret
UPDATE_HUBSPOT_WITH_LINEAR_LINK=true
```

### 3. Get Your HubSpot Access Token

1. Go to HubSpot Settings → Integrations → Private Apps
2. Create a new private app or use an existing one
3. Grant the following scopes:
   - `tickets` (Read and Write)
   - `crm.objects.contacts.read` (optional, for contact info)
4. Copy the access token

**Note:** If you want to add notes to HubSpot tickets (UPDATE_HUBSPOT_WITH_LINEAR_LINK=true), the app will need additional permissions. If this fails, it will log an error but continue processing.

### 4. Get Your Linear API Key

1. Go to Linear Settings → API → Personal API Keys
2. Create a new API key
3. Copy the key

### 5. Get Your Linear Team ID

**Easy way:** Just use your team key from the URL!

When you view your team in Linear, the URL looks like: `https://linear.app/AUT/...`

The team key is the part after the domain (e.g., `AUT`, `ENG`, `PRODUCT`).

Set it in your `.env`:
```env
LINEAR_TEAM_ID=AUT
```

The app will automatically look up and convert it to the full UUID. You can also use the full UUID if you prefer, but the team key is simpler!

### 6. Set Up HubSpot Webhook

1. Go to HubSpot Settings → Integrations → Webhooks
2. Create a new webhook subscription
3. Set the target URL to: `https://your-domain.com/webhooks/hubspot`
4. Subscribe to: **Ticket Creation**
5. Save the webhook

### 7. Deploy and Run

**Local Development:**
```bash
# Start the server
npm start

# Or use watch mode for development
npm run dev

# Use ngrok to expose your local server
ngrok http 3000
```

**Production:**

Deploy to your preferred platform (Heroku, AWS, Railway, etc.). Make sure to:
- Set environment variables
- Use a persistent process manager (PM2, systemd, etc.)
- Set up SSL/HTTPS for the webhook endpoint

## Usage

Once set up, the integration works automatically:

1. A ticket is created in HubSpot
2. HubSpot sends a webhook to your server
3. The server validates the webhook (signature verification) and fetches ticket details
4. If the ticket matches your filter criteria, a Linear issue is created
5. The HubSpot ticket URL is automatically added as an attachment to the Linear issue
6. (Optional) A note is added to the HubSpot ticket with the Linear issue link

## Filtering Tickets

You can filter which tickets trigger Linear issue creation by setting environment variables:

```env
# Only process tickets from a specific pipeline
HUBSPOT_PIPELINE_ID=123456

# Only process tickets with a specific status
HUBSPOT_TICKET_STATUS=NEW

# Only process tickets with a specific priority
HUBSPOT_TICKET_PRIORITY=HIGH

# Only process tickets with a specific category
HUBSPOT_TICKET_CATEGORY=SUPPORT
```

If no filters are set, all tickets will be processed.

## Priority Mapping

HubSpot priorities are automatically mapped to Linear priorities:

| HubSpot Priority | Linear Priority |
|-----------------|-----------------|
| URGENT          | Urgent (1)      |
| HIGH            | High (2)        |
| MEDIUM          | Medium (3)      |
| LOW             | Low (4)         |
| (none)          | No priority (0) |

## API Endpoints

### Health Check
```
GET /health
```

Returns the service status.

### HubSpot Webhook
```
POST /webhooks/hubspot
```

Receives webhook events from HubSpot.

Set `DEBUG=true` in your `.env` file to see detailed logs.
