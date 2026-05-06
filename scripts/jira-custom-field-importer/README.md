# Jira Custom Field Importer

Imports Jira custom field values (e.g. Acceptance Criteria) into the description of matching Linear issues. After each update, a comment is posted on the Linear issue linking back to the source Jira ticket.

## How it works

1. Streams Linear issues one page at a time (100 per page)
2. For each page, resolves Jira issue keys and fetches all of them in a single batch API call
3. Upserts each configured custom field as a labeled section in the Linear description — appends if missing, replaces in-place if the Jira value has changed, skips if unchanged
4. Posts an activity comment on the Linear issue confirming what was imported
5. Saves progress to a checkpoint file after each page — if the run is interrupted, re-running resumes from where it stopped

Re-runs are safe and always reflect the latest Jira content. If a field value changes in Jira, the next sync updates it in Linear automatically.

## Performance

The tool is designed to handle large workspaces efficiently:

| Workspace size | Estimated runtime |
|---|---|
| ~500 issues | 2–3 min |
| ~5,000 issues | 15–20 min |
| ~30,000 issues | 20–30 min |

**Key optimizations:**
- **Batch Jira lookups** — one JQL `IN()` API call per 100 issues instead of one call per issue (~100x fewer Jira API requests)
- **Streaming** — issues are fetched and processed one page at a time, so memory usage stays flat regardless of workspace size
- **Checkpoint/resume** — progress is saved after every page; crashes or interruptions don't require starting over

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
| `linear.projectName` | No | Only process Linear issues in this project (exact name match) |
| `linear.labels` | No | Only process issues with at least one of these labels (array of strings) |
| `linear.states` | No | Only process issues in these workflow states (e.g. `["In Progress"]`) |
| `jira.host` | Yes | Your Jira domain without `https://` (e.g. `company.atlassian.net`) |
| `jira.email` | Yes | Email address associated with your Jira API token |
| `jira.apiToken` | Yes | Your Jira API token |
| `jira.projectKey` | No | Jira project key (e.g. `PROJ`) — used to validate the project exists |
| `jira.filterJql` | No | Additional JQL filter applied to every Jira batch query (e.g. `status = "In Progress"`) |
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

## Checkpoint and resume

For large workspaces, the sync saves a `sync-checkpoint.json` file in the working directory after every page of issues. If the run is interrupted (network error, crash, manual stop), simply re-run the same command:

```bash
npm run dev -- sync
```

The tool detects the checkpoint and asks:

```
⚠️  Found checkpoint from 2026-05-04T10:00:00Z with 12400 issues already processed.
Resume from checkpoint? (yes/no — "no" starts fresh):
```

- **yes** — picks up from the exact page it stopped at, skipping already-processed issues
- **no** — deletes the checkpoint and starts over from the beginning

The checkpoint file is automatically deleted when a run completes successfully.

## Scoping a batch import

You can limit which issues get processed using filters on either side — Linear, Jira, or both at the same time. This is the recommended approach when running the importer on a subset of a large workspace.

### Filter by Linear issue state

Add `states` to the `linear` block to only process issues in specific workflow states:

```json
"linear": {
  "apiKey": "lin_api_...",
  "teamId": "ENG",
  "fetchAttachments": true,
  "states": ["In Progress"]
}
```

Other examples: `["Todo", "In Progress"]`, `["In Review"]`. State names must match exactly as they appear in Linear.

### Filter by Jira status (or any JQL)

Add `filterJql` to the `jira` block to restrict which Jira issues are considered a valid match:

```json
"jira": {
  "host": "your-company.atlassian.net",
  "email": "you@company.com",
  "apiToken": "your-jira-api-token",
  "filterJql": "status = \"In Progress\""
}
```

This filter is ANDed into every Jira batch query. Any Jira issue that doesn't satisfy it will not match, even if a Linear issue links to it. You can use any valid JQL expression:

| Goal | `filterJql` value |
|---|---|
| Only in-progress Jira issues | `status = "In Progress"` |
| A specific sprint | `sprint = "Sprint 12"` |
| Recently updated | `updated >= -7d` |
| Multiple statuses | `status in ("In Progress", "In Review")` |

### Combining both filters

Use both together for the most precise scope — only Linear issues in a given state that also have a matching Jira issue in a given status:

```json
"linear": {
  "teamId": "ENG",
  "fetchAttachments": true,
  "states": ["In Progress"]
},
"jira": {
  "host": "your-company.atlassian.net",
  "email": "you@company.com",
  "apiToken": "your-jira-api-token",
  "filterJql": "status = \"In Progress\""
}
```

With this config, a Linear issue is only updated if it is "In Progress" in Linear **and** its linked Jira issue is also "In Progress" in Jira. This is useful for keeping both systems in sync incrementally without processing the entire backlog.

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

## Running as a background agent (OAuth)

By default, the importer authenticates with a personal API key, so all activity (issue description updates, comments) is attributed to your user account. If you want the sync to appear as an automated integration — attributing changes to an OAuth app rather than a person — use a Linear OAuth access token instead.

This is the recommended approach when:
- Running the importer on a schedule or as part of a CI/CD pipeline
- You want a clean audit trail that distinguishes automated imports from manual edits
- Multiple team members may trigger the sync and you want a single consistent actor

### Getting an OAuth token

1. Go to **Settings → API → OAuth applications** and create a new application (or use an existing one)
2. Under the application, go to **Developer tokens** and generate a personal access token scoped to your workspace
3. Copy the token — it starts with `lin_oauth_` (not `lin_api_`)

Alternatively, if you're integrating this into a server-side agent flow, implement the standard OAuth 2.0 authorization code grant to obtain a user-delegated access token. The Linear OAuth docs cover this at https://developers.linear.app/docs/oauth/authentication.

### Configuring the token

Replace `linear.apiKey` in `config.json` with the OAuth token:

```json
"linear": {
  "apiKey": "lin_oauth_...",
  "teamId": "ENG",
  "fetchAttachments": true
}
```

Or set it via the environment variable — no config change needed:

```bash
LINEAR_API_KEY=lin_oauth_... npm run dev -- sync
```

The OAuth token is a drop-in replacement for the personal API key. All scoping, filtering, and checkpoint behaviour works identically.

## Troubleshooting

**No issues are matching**
- With `attachment-url` strategy: confirm the Linear issues have Jira URLs attached (visible as links on the issue). These are added automatically by Linear's native Jira integration.
- With `identifier` strategy: confirm the Linear issue key (e.g. `ENG-123`) exactly matches the Jira issue key.
- Run with `--verbose` to see what attachment URLs are found on each issue.

**Custom field value is empty / not found**
- Verify the field key using the `curl` command in step 3 above.
- The tool also accepts the field's display name as `jiraFieldName` — make sure the spelling matches exactly.
- Confirm the field is populated on the specific Jira issues being processed.

**Sync interrupted — how to resume**
- If `sync-checkpoint.json` exists in the working directory, re-running `npm run dev -- sync` will detect it and offer to resume.
- If the checkpoint file is missing or corrupted, the tool starts fresh automatically.

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

For very large workspaces on Jira Cloud (which enforces ~10 req/s per API token), setting `delayBetweenRequestsMs` to `150`–`200` helps avoid sustained rate limit errors.
