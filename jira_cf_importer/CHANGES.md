# What Changed: Linear-First Approach

## Overview

The application has been completely rewritten to use a **Linear-first approach** instead of querying Jira first. This is more efficient and intuitive!

## Old Approach (Jira-First) ❌

```
1. Query Jira for all issues in specified projects/dates
2. Fetch all Linear issues
3. Search Linear attachments for each Jira key
4. Match Jira→Linear
5. Process custom fields
```

**Problems:**
- Fetched many Jira issues that weren't linked to Linear
- Had to search through potentially all Linear issues
- Complex matching logic
- More API calls than necessary

## New Approach (Linear-First) ✅

```
1. Query Linear with team/date filters
2. Extract Jira keys from Linear attachment URLs
3. Fetch only those specific Jira issues
4. Process custom fields
```

**Benefits:**
- Only fetch Jira issues that are actually needed
- Use Linear's powerful native filtering
- No complex matching logic needed
- Fewer total API calls
- More intuitive (users define Linear scope, not Jira scope)

## Configuration Changes

### Before
```json
{
  "jira": {
    "projects": ["PROJ"],
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "customFields": [...]
  },
  "linear": {
    "teamId": "team-id",
    "labelScope": "team",
    "createMissingLabels": true
  }
}
```

### After
```json
{
  "linear": {
    "teamIds": ["team-id-1", "team-id-2"],
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "labelScope": "team",
    "createMissingLabels": true
  },
  "jira": {
    "baseUrl": "https://your-domain.atlassian.net",
    "customFields": [...]
  }
}
```

### Key Differences

1. **Linear comes first** in the config (it's now the primary filter)
2. **`teamIds` is now an array** - you can filter multiple teams at once!
3. **Date filters moved to Linear section** - filter by when Linear issues were updated
4. **No more Jira projects list** - we fetch Jira issues by key, not by project
5. **`jira.baseUrl` in config** - can also be set via env variable

## Code Changes

### LinearClient
- **New**: `findIssuesWithJiraLinks()` with native filtering
- **New**: `isJiraUrl()` to detect Jira URLs
- **New**: `extractJiraKey()` to parse issue keys from URLs
- **Improved**: Supports multiple teams, date ranges
- **Enhanced**: `appendToDescription()` now checks for duplicates

### JiraClient
- **New**: `fetchIssue()` for single issue lookup
- **Replaced**: `fetchIssues()` now takes issue keys and uses batch queries
- **Removed**: JQL project/date filtering (not needed anymore)

### CustomFieldImporter
- **Completely rewritten** with Linear→Jira flow
- **New workflow**:
  1. Find Linear issues with Jira links
  2. Extract unique Jira keys
  3. Batch fetch Jira issues
  4. Process custom fields
- **Better error handling**: Tracks skipped issues separately

## Migration Guide

If you have an existing `config.json`, here's how to update it:

1. **Move date filters** from `jira` to `linear` section
2. **Replace `teamId`** with `teamIds` (now an array)
3. **Remove `projects`** from jira section
4. **Add `baseUrl`** to jira section
5. **Reorder** sections (linear first, jira second)

### Example Migration

**Old config.json:**
```json
{
  "jira": {
    "projects": ["PROJ", "ISSUE"],
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "customFields": [
      {
        "fieldId": "customfield_10001",
        "fieldName": "Environment",
        "fieldType": "single-select"
      }
    ]
  },
  "linear": {
    "teamId": "abc123",
    "labelScope": "team",
    "createMissingLabels": true
  }
}
```

**New config.json:**
```json
{
  "linear": {
    "teamIds": ["abc123"],
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
      }
    ]
  }
}
```

## New Features

### Multiple Team Support
You can now sync multiple teams at once:
```json
{
  "linear": {
    "teamIds": ["team-1", "team-2", "team-3"]
  }
}
```

### Workspace-Wide Search
Omit `teamIds` to search all teams:
```json
{
  "linear": {
    "labelScope": "workspace",
    "createMissingLabels": true
  }
}
```

### Smarter URL Detection
The tool now intelligently detects Jira URLs in attachments:
- `https://company.atlassian.net/browse/PROJ-123`
- `https://jira.company.com/browse/ISSUE-456`
- Any URL containing `/browse/` and a valid issue key

### Duplicate Prevention
Text fields are now checked before appending - if the same field from the same Jira ticket was already added, it won't be added again.

## Performance Improvements

### API Calls Reduced
- **Before**: Query all Jira issues in projects → 10-100+ API calls
- **After**: Batch query specific Jira issues → 1-3 API calls

### Example Comparison

**Scenario**: 50 Linear issues with Jira links, 45 unique Jira tickets

**Old approach:**
- Jira: ~20 calls (fetching all issues in project by date)
- Linear: ~5 calls (searching all issues)
- **Total: ~25 API calls**

**New approach:**
- Linear: ~3 calls (with filters)
- Jira: ~1 call (batch query for 45 issues)
- **Total: ~4 API calls**

## Breaking Changes

⚠️ **Important**: The config file structure has changed. You'll need to update your `config.json` before running the new version.

1. Rename `teamId` → `teamIds` (make it an array)
2. Move date filters to `linear` section
3. Remove `projects` from `jira` section
4. Add `baseUrl` to `jira` section

## Validation

The validation tool has been updated to work with the new config structure:

```bash
npm run validate
```

It will now show:
- Linear team configuration
- Date range filters
- Available Jira custom fields

## Questions?

- See `README.md` for full documentation
- See `SETUP.md` for quick setup guide
- See `ARCHITECTURE.md` for technical details

