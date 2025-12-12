# Jira Priority Importer

A CLI tool that syncs priorities from Jira issues to Linear issues. The tool searches for matching issues between the two platforms and updates Linear priorities based on configurable mappings.

## Features

- ✅ Connects to both Linear and Jira APIs
- ✅ Multiple matching strategies: identifier-based, attachment URL-based, or hybrid
- ✅ Configurable priority mappings
- ✅ Dry run mode for testing
- ✅ Comprehensive logging and error handling
- ✅ CLI interface with multiple commands
- ✅ Real-time progress indicators with time estimates
- ✅ Optimized attachment fetching with batching and caching
- ✅ Configurable timeouts to prevent hanging
- ✅ Optional attachment fetching for better performance
- ✅ Team and project validation with issue count display
- ✅ Interactive confirmation prompts before sync
- ✅ Comprehensive rate limiting protection with automatic retry
- ✅ Exponential backoff and Retry-After header support
- ✅ Optimized GraphQL queries with parallel data fetching (eliminates N+1 queries)
- ✅ Server-side filtering for team-specific queries (dramatically faster for filtered syncs)

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```

## Setup

### 1. Generate API Credentials

**Linear API Key:**
1. Go to Linear Settings → API
2. Create a new OAuth application (recommended) or a personal API key
3. Copy the key

**Jira API Token:**
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Create a new API token
3. Copy the token

### 2. Create Configuration

Generate a sample configuration file:
```bash
npm run dev -- init
```

This creates a `config.json` file with the following structure:

```json
{
  "linear": {
    "apiKey": "your-linear-api-key-here",
    "teamId": "UUID or Friendly Key (ABC)",
    "fetchAttachments": true,
    "attachmentTimeout": 5000
  },
  "jira": {
    "host": "your-company.atlassian.net",
    "email": "your-email@company.com",
    "apiToken": "your-jira-api-token",
    "projectKey": "ABC"
  },
  "matching": {
    "strategy": "attachment-url"
  },
  "priorityMapping": [
    {
      "jiraPriority": "Highest",
      "linearPriority": 1
    },
    {
      "jiraPriority": "High",
      "linearPriority": 2
    },
    {
      "jiraPriority": "Medium",
      "linearPriority": 3
    },
    {
      "jiraPriority": "Low",
      "linearPriority": 4
    },
    {
      "jiraPriority": "Lowest",
      "linearPriority": 4
    }
  ],
  "rateLimiting": {
    "maxRetries": 5,
    "initialDelayMs": 1000,
    "maxDelayMs": 60000,
    "delayBetweenRequestsMs": 100,
    "backoffMultiplier": 2
  },
  "dryRun": true
}
```

### 3. Configure Settings

Edit the `config.json` file:

1. **API Credentials**: Replace placeholder values with your actual API keys
2. **Team/Project Filtering** (optional):
   - `linear.teamId`: Only sync issues from this Linear team (use team key like "BK" or team UUID). Leave empty to sync all teams.
   - `jira.projectKey`: Only search in this Jira project. Leave empty to search all accessible projects.
3. **Performance Options** (optional):
   - `linear.fetchAttachments`: Whether to fetch attachments (default: `true`). Set to `false` for faster syncs if not using attachment-url strategy
   - `linear.attachmentTimeout`: Timeout in milliseconds for attachment fetching (default: `5000`). Prevents hanging on slow API calls
4. **Matching Strategy**: Choose how to match Linear issues with Jira issues:
   - `"attachment-url"`: Finds Jira issue URLs in Linear issue attachments 
   - `"identifier"`: Direct matching using Linear identifier as Jira issue key (e.g., "ENG-123")
   - `"hybrid"`: Tries identifier first, falls back to attachment URL if no match found
5. **Priority Mappings**: Map Jira priority names to Linear priority numbers:
   - Linear priorities: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
6. **Rate Limiting & Retry** (optional, all values have sensible defaults):
   - `maxRetries`: Maximum retry attempts for transient errors (rate limits, network issues) (default: `5`)
   - `initialDelayMs`: Initial delay before first retry in milliseconds (default: `1000`)
   - `maxDelayMs`: Maximum delay cap in milliseconds (default: `60000`)
   - `delayBetweenRequestsMs`: Minimum delay between all requests (default: `100`)
   - `backoffMultiplier`: Exponential backoff multiplier (default: `2`)
   - **Note**: Automatically retries rate limits AND network errors (timeouts, connection failures). Won't retry auth/validation errors.

## Usage

### Validate Configuration
Validates your config and tests API connections. Shows team/project info and issue counts.
```bash
npm run dev -- validate
```

Example output:
```
✓ Found Linear team: Engineering (ENG) with 127 issues
✓ Found Jira project: Engineering Project (ENG)
Configuration is valid and API connections work!
```

### Dry Run (**HIGHLY** Recommended First)
Test the sync without making any changes. Shows what would be updated.
```bash
npm run dev -- sync --dry-run
# Or use the dedicated script:
npm run dev:dry
```

The tool will show you how many issues will be processed and ask for confirmation:
```
⚠️  About to process 127 Linear issues
Running in DRY RUN mode - no changes will be made

Do you want to continue? (yes/no):
```

### Full Sync
Run the actual sync to update Linear issues.
```bash
npm run dev -- sync
```

**Note:** The tool will always ask for confirmation before processing issues, showing you the exact count.

### Command Line Options

```bash
# Use custom config file
npm run dev -- sync --config ./my-config.json

# Enable verbose logging
npm run dev -- sync --verbose

# Force dry run mode
npm run dev -- sync --dry-run
```

> **Note:** The `--` separator is required when passing arguments through npm scripts. It tells npm to pass all remaining arguments directly to the underlying command.

## Environment Variables

You can override configuration values using environment variables:

```bash
# Linear
LINEAR_API_KEY=your_key_here
LINEAR_TEAM_ID=BK
LINEAR_FETCH_ATTACHMENTS=true
LINEAR_ATTACHMENT_TIMEOUT=5000

# Jira
JIRA_HOST=company.atlassian.net
JIRA_EMAIL=user@company.com
JIRA_API_TOKEN=your_token_here
JIRA_PROJECT_KEY=PROJ

# Options
DRY_RUN=true
```

## Validation & Feedback

The tool provides comprehensive validation and feedback:

### Team & Project Validation
- Validates that specified Linear team exists and shows issue count
- Validates that specified Jira project is accessible
- Lists available teams/projects if validation fails
- Example:
  ```
  ✓ Found Linear team: Engineering (ENG) with 127 issues
  ✓ Found Jira project: Engineering Project (ENG)
  ```

### Interactive Confirmation
- Before syncing, shows exactly how many issues will be processed
- Requires explicit "yes" to continue
- Prevents accidental bulk updates
- Shows dry-run mode status clearly

### Rate Limiting & Error Resilience
- Automatically detects and handles rate limits from both APIs
- Automatically retries transient network errors (timeouts, connection failures, DNS issues)
- Smart error classification: won't retry auth errors (401/403) or validation errors (400/422)
- Exponential backoff with configurable retry attempts
- Respects `Retry-After` headers from APIs
- Adds jitter to prevent thundering herd
- Clear logging of retry attempts with error context:
  ```
  ⚠️  Rate limit hit for Fetching Linear issues page 37. Waiting 2.1s before retry 1/5...
  ✓ Fetching Linear issues page 37 succeeded after 1 retry
  
  ⚠️  Network error for Fetching Linear issues page 42: Fetch failed. Retrying in 1.0s (1/5)...
  ✓ Fetching Linear issues page 42 succeeded after 1 retry
  ```

## How It Works

The tool supports three matching strategies to connect Linear issues with Jira issues:

### 1. Attachment URL Strategy (`"attachment-url"`)
- **Best for**: Teams that link Jira issues as attachments in Linear
- **How it works**: Scans Linear issue attachments for Jira URLs that match your configured Jira host
- **Process**: Finds URLs like `https://company.atlassian.net/browse/PROJ-123`, extracts key, fetches issue
- **Pros**: Flexible, works with any naming scheme, leverages existing attachments
- **Cons**: Requires Jira URLs to be attached to Linear issues
- **Note**: Uses your `jira.host` config for precise URL matching

### 2. Identifier Strategy (`"identifier"`)
- **Best for**: Teams with consistent naming conventions
- **How it works**: Uses Linear's issue identifier (e.g., "ENG-123") directly as the Jira issue key
- **Process**: Makes direct API call `GET /rest/api/2/issue/ENG-123`
- **Pros**: Fast, accurate, no setup required
- **Cons**: Requires identical issue identifiers in both systems

### 3. Hybrid Strategy (`"hybrid"`)
- **Best for**: Mixed environments or migration scenarios
- **How it works**: Tries identifier matching first, falls back to attachment URL scanning
- **Process**: Attempts both strategies in sequence
- **Pros**: Maximum compatibility, handles both scenarios
- **Cons**: Slightly slower due to dual approach

### Priority Mapping Process
Once issues are matched (regardless of strategy):
- Maps Jira priority to Linear priority using your configuration
- Updates Linear issue only if priority differs
- Skips issues without valid priority mappings

## Troubleshooting

### Connection Issues
- Verify API credentials are correct
- Ensure Jira host format: `company.atlassian.net` (no https://)
- Check network connectivity and firewall settings
- Use the `validate` command to test connections and see detailed error messages

### Team/Project Not Found
If validation fails with "team not found" or "project not found":
- The tool will list all available teams/projects
- Verify your `teamId` or `projectKey` matches exactly
- Team IDs can be either the key (e.g., "ENG") or the UUID
- Leave these fields empty to sync across all teams/projects

### Slow Performance / Hanging on "Fetching Linear Issues"
If the sync hangs or takes too long during the Linear fetch phase:
- **Large workspaces**: If you have 1000+ issues, attachment fetching can take a while. The tool now shows real-time progress with ETA
- **Disable attachments**: If using `"identifier"` or `"hybrid"` strategies, set `"fetchAttachments": false` in config for much faster syncs
- **Adjust timeout**: Increase `"attachmentTimeout"` if you have slow network connectivity, or decrease it to skip slow requests faster
- **Filter by team**: Use `"teamId"` to only sync issues from specific teams

Performance improvements in latest version:
- ✅ **Optimized GraphQL queries**: Team data fetched in parallel per page (eliminates N+1 query problem)
- ✅ **Server-side filtering**: When filtering by team, only fetches matching issues from Linear's API
- ✅ Two-phase fetching: Issues first, then attachments in parallel batches
- ✅ Progress indicators showing items/second and estimated time remaining
- ✅ Automatic timeout handling to prevent indefinite hangs
- ✅ Caching to avoid redundant API calls

**Performance impact for large workspaces:**
- Without team filter: ~10-50x faster team data fetching (parallel vs sequential)
- With team filter: ~100-1000x faster overall (server-side filtering reduces data transfer dramatically)

### No Matches Found
- Verify Linear issue identifiers match Jira issue keys exactly (e.g., "ENG-123")
- Check that Jira issues exist with the expected keys
- Verify team/project filtering isn't too restrictive
- Ensure Linear identifiers follow standard Jira key format (PROJECT-NUMBER)
- If using attachment-url strategy, verify Jira URLs are actually attached to Linear issues

### Priority Mapping Issues
- Ensure Jira priority names in config match exactly
- Use the validate command to check configuration
- Check Jira priority names in your instance (they may be customized)

### Rate Limiting & Network Errors
If you're experiencing rate limits or network errors:
- The tool handles both automatically with retries and exponential backoff
- **Rate limits**: The tool detects HTTP 429 errors and respects Retry-After headers
- **Network errors**: Automatically retries timeouts, connection failures, and DNS issues
- **Configuration options**:
  - Increase `delayBetweenRequestsMs` to slow down requests and reduce rate limit hits
  - Adjust `maxRetries` if you need more or fewer retry attempts (default: 5)
  - Increase `maxDelayMs` for very slow/unreliable networks
- The tool won't retry auth errors (401/403) or validation errors (400/422) as these require fixing the configuration

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run built version
npm start
```

## License

MIT
