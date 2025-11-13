# Architecture Overview

## Project Structure

```
jira_cf_importer/
├── src/
│   ├── index.ts           # CLI entry point and configuration loading
│   ├── types.ts           # TypeScript type definitions
│   ├── jira-client.ts     # Jira API client
│   ├── linear-client.ts   # Linear API client (using official SDK)
│   ├── importer.ts        # Main synchronization logic
│   └── validate.ts        # Configuration validation utility
├── config.example.json    # Example configuration file
├── package.json           # npm dependencies and scripts
├── tsconfig.json          # TypeScript configuration
└── README.md             # Documentation
```

## Core Components

### 1. JiraClient (`jira-client.ts`)

**Purpose**: Handles all interactions with the Jira REST API.

**Key Methods**:
- `fetchIssue(issueKey)`: Fetches a single Jira issue by key
- `fetchIssues(issueKeys)`: Fetches multiple Jira issues using batch queries
- `extractCustomFields(issue, configs)`: Extracts custom field values from a Jira issue

**Optimization Strategy**:
- Uses batch queries (JQL with `key in (...)`) to fetch up to 50 issues at once
- Only fetches issues that are actually linked to Linear issues
- Handles 404s gracefully for deleted/inaccessible tickets

### 2. LinearClient (`linear-client.ts`)

**Purpose**: Handles all interactions with Linear using their TypeScript SDK.

**Key Methods**:
- `findIssuesWithJiraLinks()`: Searches Linear issues with filters, extracts Jira URLs from attachments
- `isJiraUrl(url)`: Checks if a URL is a Jira URL
- `extractJiraKey(url)`: Extracts issue key from Jira URL (e.g., "PROJ-123")
- `getOrCreateLabelGroup()`: Manages label groups (creates if missing)
- `getOrCreateLabel()`: Manages labels under groups (creates if missing)
- `addLabelToIssue()`: Adds a label to an issue (idempotent)
- `appendToDescription()`: Appends custom field text to issue description (with deduplication)

**Optimization Strategy**:
- Uses Linear SDK's native filtering (teams, dates) instead of fetching everything
- Caches label groups and labels to avoid redundant lookups
- Early termination not needed since we process all matching issues
- Checks for duplicate content before appending to descriptions

### 3. CustomFieldImporter (`importer.ts`)

**Purpose**: Orchestrates the entire synchronization process.

**New Linear-First Workflow**:
1. Query Linear for issues with filters (teams, dates)
2. Extract Jira keys from attachment URLs
3. Batch fetch Jira issues by keys
4. Process custom fields for each Linear issue
5. Report summary statistics

**Error Handling**:
- Individual issue failures don't stop the entire sync
- Errors are logged with context
- Summary report shows success/failure/skipped counts

### 4. Configuration System

**User-Facing Config** (`config.json`):
- **Linear section**:
  - Team filters (optional)
  - Date range filters (optional)
  - Label scope and creation settings
- **Jira section**:
  - Base URL
  - Custom field definitions with types

**Environment Variables** (`.env`):
- API credentials
- Sensitive information

## Data Flow (New Approach)

```
1. User runs: npm run sync

2. index.ts loads configuration
   ├── Reads .env for credentials
   └── Reads config.json for preferences

3. CustomFieldImporter.sync() orchestrates:
   │
   ├─> LinearClient.findIssuesWithJiraLinks()
   │   ├── Apply filters (teams, dates)
   │   ├── Fetch Linear issues
   │   ├── Check attachments for Jira URLs
   │   └── Extract Jira keys from URLs
   │   └── Returns: LinearIssueWithJira[]
   │
   ├─> Extract unique Jira keys
   │   └── Returns: string[]
   │
   ├─> JiraClient.fetchIssues(keys)
   │   ├── Batch queries (50 at a time)
   │   └── Returns: Map<key, JiraIssue>
   │
   └─> For each Linear issue:
       │
       ├─> For each linked Jira ticket:
       │   │
       │   ├─> JiraClient.extractCustomFields()
       │   │   └── Returns: CustomFieldValue[]
       │   │
       │   └─> For each custom field:
       │       │
       │       ├─> If single-select:
       │       │   ├── getOrCreateLabelGroup()
       │       │   ├── getOrCreateLabel()
       │       │   └── addLabelToIssue()
       │       │
       │       └─> If text:
       │           └── appendToDescription()
```

## Comparison: Old vs New Approach

### Old Approach (Jira-First)
1. Query Jira for all issues in projects/date range
2. Query Linear for all issues
3. Search Linear attachments for each Jira key
4. Match and process

**Problems**:
- Fetched many Jira issues that weren't linked to Linear
- Had to search through all Linear issues
- Complex matching logic
- More API calls

### New Approach (Linear-First) ✅
1. Query Linear with filters for relevant issues
2. Extract Jira keys from attachments
3. Fetch only those Jira issues
4. Process

**Benefits**:
- Only fetch Jira issues that are needed
- Use Linear's native filtering (more powerful)
- No complex matching needed
- Fewer API calls
- More intuitive for users (they care about Linear issues)

## API Call Optimization

### Linear
- **Filtered issue query**: Uses team and date filters to minimize results
- **Attachment fetching**: Fetched with issues
- **Cached label lookups**: Only query once per unique label/group
- **Description deduplication**: Check before appending to avoid duplicates

**Typical API usage**: 
- 1-5 calls for issue/attachment fetching
- 1 call per unique label group (cached)
- 1 call per unique label (cached)
- 1 call per issue update

### Jira
- **Batch queries**: Fetch up to 50 issues per request
- **Only needed issues**: Only fetch tickets linked from Linear

**Typical API usage**: 1-3 calls (depending on number of unique Jira tickets)

## Type System

All data structures are strongly typed:

```typescript
Config
├── LinearConfig
│   ├── teamIds?: string[]
│   ├── startDate?: string
│   ├── endDate?: string
│   ├── labelScope: 'workspace' | 'team'
│   └── createMissingLabels: boolean
│
└── JiraConfig
    ├── baseUrl: string
    └── customFields: CustomFieldConfig[]

LinearIssueWithJira
├── linearIssueId: string
├── linearIssueIdentifier: string
├── jiraKeys: string[]
└── jiraUrls: string[]
```

## Error Handling Strategy

1. **Configuration Errors**: Fail fast with clear messages
2. **API Connection Errors**: Fail fast (can't proceed without API access)
3. **Individual Issue Errors**: Log and continue (one bad issue shouldn't stop sync)
4. **Missing Jira Issues**: Log as "skipped" and continue (ticket may be deleted)
5. **Rate Limiting**: Not currently implemented (future enhancement)

## Extension Points

### Adding New Custom Field Types

To add support for a new Jira custom field type:

1. Add the type to `CustomFieldConfig.fieldType` in `types.ts`
2. Add extraction logic in `JiraClient.extractCustomFields()`
3. Add processing logic in `CustomFieldImporter` (similar to `processSingleSelectField`)

### Adding More Linear Filters

To add new Linear filters:

1. Add properties to `LinearConfig` in `types.ts`
2. Update filter building in `LinearClient.findIssuesWithJiraLinks()`
3. Update `config.example.json` with examples

### Adding Linear Field Mappings

To map to different Linear fields:

1. Add methods to `LinearClient` for the target field
2. Add processing methods to `CustomFieldImporter`
3. Update configuration schema

## Performance Considerations

### Time Complexity
- Linear issue fetching: O(n) where n = matching Linear issues
- Attachment parsing: O(n * a) where a = attachments per issue
- Jira issue fetching: O(j / 50) where j = unique Jira issues (batch size 50)
- Custom field processing: O(n * f) where f = fields per issue

### Space Complexity
- Linear issues in memory: O(n)
- Jira issues in memory: O(j)
- Label cache: O(unique labels)

### Bottlenecks
1. Linear attachment scanning (if many attachments)
   - Mitigated by: filtering issues first
2. Label creation API calls
   - Mitigated by: caching
3. Description updates
   - Can't be batched, one API call per issue
   - Mitigated by: deduplication check

## URL Extraction

The tool extracts Jira issue keys from URLs using pattern matching:

```typescript
// Matches URLs like:
// https://company.atlassian.net/browse/PROJ-123
// https://jira.company.com/browse/ISSUE-456

extractJiraKey(url: string): string | null {
  const match = url.match(/\/browse\/([A-Z]+-\d+)/i);
  return match ? match[1] : null;
}
```

## Security Considerations

1. **Credentials**: Never committed to git (.env in .gitignore)
2. **API Tokens**: Use environment variables
3. **Config Files**: config.json in .gitignore (may contain sensitive info)
4. **Logging**: Avoid logging sensitive data
5. **URL Parsing**: Safely handles malformed URLs

## Testing Strategy

**Manual Testing Recommended**:
1. Start with a small date range and single team
2. Test with one custom field first
3. Verify results in Linear UI
4. Check that labels are created correctly
5. Verify description appends are formatted properly
6. Gradually expand scope

**Validation Tool**:
- Run `npm run validate` before syncing
- Tests connections and configuration
- Lists available custom fields
- Shows team information

## Future Enhancements

Potential improvements:
1. Rate limiting handling with exponential backoff
2. Dry-run mode to preview changes
3. Rollback functionality
4. Incremental sync (only new/updated issues)
5. Webhook-based real-time sync
6. Support for more Jira custom field types
7. Custom mapping rules per field
8. Multi-value select field support
