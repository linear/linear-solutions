# Jira Custom Field Importer

Imports Jira custom field values (e.g. Acceptance Criteria) into the description of matching Linear issues. After each update, a comment is posted on the Linear issue linking back to the source Jira ticket.

## How it works

1. Fetches all Linear issues from a configured team
2. For each issue, finds the matching Jira issue via the Jira URL stored on the Linear issue (from Linear's native Jira sync)
3. Reads the configured custom fields from the Jira issue
4. Appends any missing fields to the Linear issue description as labeled sections
5. Posts a comment on the Linear issue confirming what was imported

Re-runs are safe — a field section is only appended if the heading doesn't already exist in the description.

## Prerequisites

- Node.js 18+
- A Linear workspace with the native Jira integration enabled (so Linear issues have Jira URLs attached)
- A Jira API token

## Setup

### 1. Install dependencies

```bash
cd scripts/jira-custom-field-importer
npm install
```

### 2. Get your credentials

**Linear API key**
Settings → API → Personal API keys → Create key

**Jira API token**
https://id.atlassian.com/manage-profile/security/api-tokens → Create API token

### 3. Find your Jira custom field key

Custom fields in Jira use keys like `customfield_10014`. To find the key for a specific field, run:

```bash
curl -u your-email@company.com:YOUR_JIRA_API_TOKEN \
  "https://your-company.atlassian.net/rest/api/3/issue/PROJ-1?expand=names" \
  | python3 -m json.tool | grep -i "acceptance"
```

Replace `PROJ-1` with any issue that has the field populated. The `names` object in the response maps field keys to display names.

Alternatively, if your Atlassian workspace has **Rovo** enabled, you can ask it directly:

> _"What is the Jira custom field key for Acceptance Criteria in our workspace?"_

Rovo has access to your Jira schema and will return the field key (e.g. `customfield_10316`) without needing API access.

### 4. Create your config

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "linear": {
    "apiKey": "lin_api_...",
    "teamId": "ENG",
    "fetchAttachments": true,
    "attachmentTimeout": 5000
  },
  "jira": {
    "host": "your-company.atlassian.net",
    "email": "you@company.com",
    "apiToken": "your-jira-api-token",
    "projectKey": "PROJ"
  },
  "matching": {
    "strategy": "attachment-url"
  },
  "customFields": [
    {
      "jiraFieldName": "customfield_10014",
      "descriptionLabel": "Acceptance Criteria"
    }
  ],
  "dryRun": true
}
```

#### Config reference

| Field | Required | Description |
|---|---|---|
| `linear.apiKey` | Yes | Your Linear personal API key |
| `linear.teamId` | No | Team key (e.g. `ENG`) or UUID — omit to process all teams |
| `linear.fetchAttachments` | No | Whether to fetch issue attachment URLs (default: `true`) |
| `linear.attachmentTimeout` | No | Timeout in ms for attachment fetching (default: `5000`) |
| `jira.host` | Yes | Your Jira domain without `https://` (e.g. `company.atlassian.net`) |
| `jira.email` | Yes | Email address associated with your Jira API token |
| `jira.apiToken` | Yes | Your Jira API token |
| `jira.projectKey` | No | Jira project key (e.g. `PROJ`) — used to validate the project exists |
| `matching.strategy` | Yes | `attachment-url`, `identifier`, or `hybrid` (see below) |
| `customFields` | Yes | Array of fields to import (see below) |
| `dryRun` | No | If `true`, logs changes without writing to Linear (default: `false`) |

#### `customFields` entries

| Field | Description |
|---|---|
| `jiraFieldName` | Jira field key (e.g. `customfield_10014`) or display name (e.g. `Acceptance Criteria`) |
| `descriptionLabel` | Heading shown in the Linear description (e.g. `Acceptance Criteria`) |

#### Matching strategies

| Strategy | How it works | When to use |
|---|---|---|
| `attachment-url` | Reads the Jira URL stored on Linear issues by the native Jira sync | **Recommended** — works when Linear was synced from Jira |
| `identifier` | Uses the Linear issue key directly as the Jira issue key | Only when both systems share the same project key |
| `hybrid` | Tries identifier first, falls back to attachment-url | Mixed environments |

## Usage

### Validate your config and test API connections

```bash
npm run dev -- validate
```

### Dry run (no changes made)

```bash
npm run dev -- sync --dry-run --verbose
```

Review the output to confirm the right issues are matched and the right fields would be appended.

### Live sync

```bash
npm run dev -- sync
```

You'll be asked to confirm before any changes are made. After each updated issue, a comment is posted on the Linear issue:

> 🤖 Jira Custom Field Importer synced **Acceptance Criteria** from [ST-12](https://your-company.atlassian.net/browse/ST-12).

### Generate a fresh sample config

```bash
npm run dev -- init -o config.json
```

## Environment variables

All config values can be overridden with environment variables. These take precedence over `config.json`.

| Variable | Config equivalent |
|---|---|
| `LINEAR_API_KEY` | `linear.apiKey` |
| `LINEAR_TEAM_ID` | `linear.teamId` |
| `LINEAR_FETCH_ATTACHMENTS` | `linear.fetchAttachments` |
| `LINEAR_ATTACHMENT_TIMEOUT` | `linear.attachmentTimeout` |
| `JIRA_HOST` | `jira.host` |
| `JIRA_EMAIL` | `jira.email` |
| `JIRA_API_TOKEN` | `jira.apiToken` |
| `JIRA_PROJECT_KEY` | `jira.projectKey` |
| `DRY_RUN` | `dryRun` |

## Troubleshooting

**No issues are matching**
- With `attachment-url` strategy: confirm the Linear issues have Jira URLs attached (visible as links on the issue). These are added automatically by Linear's native Jira integration.
- With `identifier` strategy: confirm the Linear issue key (e.g. `ENG-123`) exactly matches the Jira issue key.
- Run with `--verbose` to see what attachment URLs are found on each issue.

**Custom field value is empty / not found**
- Verify the field key using the `curl` command in step 3 above.
- The tool also accepts the field's display name as `jiraFieldName` — make sure the spelling matches exactly.
- Confirm the field is populated on the specific Jira issues being processed.

**Rate limiting**
- The tool includes automatic retry with exponential backoff. Add a `rateLimiting` block to `config.json` to tune the behaviour:

```json
"rateLimiting": {
  "maxRetries": 5,
  "initialDelayMs": 1000,
  "maxDelayMs": 60000,
  "delayBetweenRequestsMs": 200
}
```
