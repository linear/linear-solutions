# Jira to Linear Custom Field Importer

A TypeScript application that synchronizes custom fields from Jira tickets to Linear issues. The tool uses a **Linear-first approach**: it queries Linear for issues (with team and date filters), extracts Jira ticket links from their attachments, then fetches those specific Jira tickets to import custom field data.

[Video Walkthrough](https://us02web.zoom.us/clips/share/VDcCpIiAQyufDifvPsFNpQ)

## Features

- ✅ **Linear-First Approach**: Start with Linear's native filters for teams and timeframes
- ✅ **Smart URL Extraction**: Automatically extracts Jira ticket keys from Linear attachments
- ✅ **Flexible Filtering**: Define which Linear issues to process by team(s) and date range
- ✅ **Custom Field Support**: 
  - Single-select fields → Label groups and labels in Linear
  - Text fields → Appended to Linear issue descriptions
- ✅ **Optimized API Usage**: Only fetches Jira tickets that are actually linked to Linear issues
- ✅ **TypeScript**: Type-safe with Linear's official TypeScript SDK

## How It Works (New Approach!)

1. **Query Linear** for issues using your filters (teams, date range)
2. **Extract Jira URLs** from Linear issue attachments
3. **Fetch specific Jira tickets** using the extracted issue keys
4. **Import custom fields** to the matched Linear issues

This approach is more efficient because:
- You only fetch Jira tickets that are linked to Linear issues
- Linear's native filtering is more powerful and flexible
- No need for complex matching logic
- Fewer total API calls

## Prerequisites

- Node.js 18+ and npm
- Jira Cloud account with API access
- Linear account with API access

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Edit `.env` with your credentials:
```
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_BASE_URL=https://your-domain.atlassian.net
LINEAR_API_KEY=your-linear-api-key
```

5. Create a `config.json` file based on `config.example.json`:
```bash
cp config.example.json config.json
```

6. Edit `config.json` with your configuration (see Configuration section below for details)

### Getting API Credentials

**Jira API Token:**
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token to your `.env` file

**Linear API Key:**
1. Go to https://linear.app/settings/api
2. Create a new Personal API key
3. Copy the key to your `.env` file

**Linear Team ID (Optional):**
1. Go to Linear and open your team
2. Run `npm run validate` after setup - it will show your team IDs

## Configuration

The application uses two configuration files:

1. **`.env`** - Contains sensitive credentials (created in step 3-4 above)
2. **`config.json`** - Contains application settings (Jira custom fields, Linear filters, etc.)

### config.json

Create a `config.json` file based on `config.example.json`:

```json
{
  "linear": {
    "teamIds": ["team-id-1"],
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "labelScope": "team",
    "createMissingLabels": true
  },
  "jira": {
    "baseUrl": "https://your-domain.atlassian.net",
    "customFields": [
      {
        "fieldId": "customfield_10001",
        "fieldName": "Environment",
        "fieldType": "single-select"
      },
      {
        "fieldId": "customfield_10002",
        "fieldName": "Root Cause",
        "fieldType": "text"
      }
    ]
  }
}
```

### Configuration Options

**Linear Section:**
- `teamIds`: (Optional) Array of Linear team IDs or team keys to filter by. You can use team keys like `["BK"]` or UUIDs. Run `npm run validate` to see your available teams. Omit to search all teams.
- `startDate`: (Optional) Start date for filtering issues (ISO format: YYYY-MM-DD)
- `endDate`: (Optional) End date for filtering issues (ISO format: YYYY-MM-DD)
- `labelScope`: `"team"` or `"workspace"` - where to create labels
- `createMissingLabels`: `true` to auto-create labels, `false` to error if they don't exist

**Jira Section:**
- `baseUrl`: Your Jira instance URL (optional if already set as `JIRA_BASE_URL` in `.env`)
- `customFields`: Array of custom field definitions:
  - `fieldId`: Jira custom field ID (e.g., "customfield_10001")
  - `fieldName`: Display name for the field
  - `fieldType`: One of:
    - `"single-select"`: Creates label groups and labels
    - `"text"`: Appends to description
    - `"multi-line-text"`: Appends to description

### Finding Jira Custom Field IDs

To find custom field IDs in Jira:

1. **Use the validation tool** (easiest):
```bash
npm run validate
```
This will list all available Jira custom fields with their IDs!

2. **Via Jira API Browser:**
   - Go to: `https://your-domain.atlassian.net/rest/api/3/field`
   - Search for your custom field name
   - Copy the `id` (e.g., "customfield_10001")

## Usage

### Validate your configuration first:
```bash
npm run validate
```

This will:
- Check all required environment variables are set
- Validate your `config.json` structure
- Test connections to both Jira and Linear
- List available Jira custom fields
- Show your Linear team information

### Build the project:
```bash
npm run build
```

### Run the sync:
```bash
npm start
```

### Or run directly without building:
```bash
npm run sync
```

## Example Output

```
Jira to Linear Custom Field Importer
=====================================

Configuration loaded successfully:
  - Jira Base URL: https://company.atlassian.net
  - Linear Teams: abc123
  - Date Range: 2024-01-01 to 2024-12-31
  - Custom Fields: 2
  - Label Scope: team

Starting Jira to Linear custom field import...

Step 1: Finding Linear issues with Jira attachments...
Checked 50 Linear issues...
Checked 100 Linear issues...
Found 45 Linear issues with Jira links (checked 120 total)

Step 2: Extracting Jira issue keys...
Found 47 unique Jira issue keys

Step 3: Fetching Jira issues...
Fetched 47 of 47 issues...
Successfully fetched 47 Jira issues

Step 4: Processing custom fields...

Processing LIN-456
  - Processing PROJ-123
    - Environment: Production (creating label)
      ✓ Label added successfully
    - Root Cause: (appending to description)
      ✓ Description updated successfully

...

============================================================
SUMMARY
============================================================
Linear issues found: 45
Unique Jira keys: 47
Jira issues fetched: 47
Successfully processed: 45
Skipped (not found): 0
Errors: 0
============================================================

Import completed successfully!
```

## API Usage Optimization

This tool is designed to minimize API calls:

- **Linear**: 
  - Uses native filters (teams, dates) to narrow results
  - Fetches issues and attachments efficiently
  - Caches label groups and labels to avoid redundant lookups

- **Jira**: 
  - Only fetches tickets that are linked to Linear issues
  - Uses batch queries (50 issues per request)
  - Minimal API calls compared to querying all Jira tickets first

## Troubleshooting

**"No Linear issues with Jira links found"**
- Ensure Jira ticket URLs are attached to Linear issues
- Check that your team IDs and date range are correct
- Verify attachments contain URLs with `/browse/` in them

**"Label group not found"**
- Set `createMissingLabels: true` in config.json
- Or manually create the label group in Linear first

**"Jira API error: 401"**
- Verify your Jira email and API token in `.env`
- Ensure the API token hasn't expired

**"Linear API error"**
- Verify your Linear API key in `.env`
- Check that you have permissions to create labels and update issues

**"Jira issue not found (404)"**
- The Jira ticket may have been deleted
- You might not have permission to view that ticket
- The URL in Linear might be incorrect

## Development

```bash
# Install dependencies
npm install

# Validate configuration
npm run validate

# Run in development mode (with auto-reload)
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start
```

## Advanced Usage

### Multiple Teams

You can sync custom fields for multiple Linear teams at once:

```json
{
  "linear": {
    "teamIds": ["team-1", "team-2", "team-3"],
    ...
  }
}
```

### Workspace-Wide Search

To search all teams, simply omit the `teamIds` field:

```json
{
  "linear": {
    "labelScope": "workspace",
    "createMissingLabels": true
  }
}
```

### Date Range Filtering

Filter by when Linear issues were updated:

```json
{
  "linear": {
    "startDate": "2024-11-01",
    "endDate": "2024-11-30"
  }
}
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
