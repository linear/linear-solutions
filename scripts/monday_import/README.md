# Monday.com to Linear Importer

A config-driven CLI tool for importing Monday.com Excel exports into Linear. Supports flexible field mappings, label groups, subitems, project updates, and more.

## Features

- **Config-driven**: Define your own field mappings via JSON configuration
- **Interactive wizard**: Auto-detect columns and generate config interactively
- **Flexible data model**: Import main items as Projects with subitems as Issues
- **Separate label systems**: Properly handles Linear's separate Project Labels and Issue Labels
- **Label groups**: Automatically create hierarchical label groups for organization
- **Multi-source descriptions**: Combine multiple columns into rich descriptions
- **Timeline support**: Auto-split date range columns into start/end dates
- **Project updates**: Import Monday.com updates as Linear project updates
- **Status mapping**: Separate mappings for project statuses and issue statuses
- **Excel date handling**: Properly parses Excel serial dates
- **Deduplication**: Safely re-run imports without creating duplicates
- **Dry-run mode**: Preview changes before executing

## Installation

```bash
# Install dependencies
npm install

# Build (optional, for distribution)
npm run build
```

## Quick Start

```bash
# 1. Set your Linear API key (choose one method)

# Option A: Environment variable
export LINEAR_API_KEY=lin_api_your_key_here

# Option B: Create a .env file
echo "LINEAR_API_KEY=lin_api_your_key_here" > .env

# 2. Generate config from your Monday.com export
npx tsx src/index.ts init ~/Downloads/monday-export.xlsx

# 3. Generate user mapping template
npx tsx src/index.ts users -f ~/Downloads/monday-export.xlsx -o user-mapping.json

# 4. Edit user-mapping.json to map Monday names to Linear emails

# 5. Validate your configuration
npx tsx src/index.ts validate -c import-config.json -f ~/Downloads/monday-export.xlsx

# 6. Preview the import (dry run)
npx tsx src/index.ts dry-run -c import-config.json -f ~/Downloads/monday-export.xlsx

# 7. Execute the import
npx tsx src/index.ts run -c import-config.json -f ~/Downloads/monday-export.xlsx
```

## Configuration

### Complete Example

```json
{
  "version": "1.0",
  "source": {
    "sheets": {
      "items": "Projects",
      "updates": "Projects-updates"
    },
    "headerRow": 1
  },
  "target": {
    "team": "prompt",
    "createMissingLabels": true
  },
  "dataModel": {
    "items": {
      "importAs": "project",
      "subitems": {
        "enabled": true,
        "importAs": "issue",
        "sourceColumn": "Subitems",
        "delimiter": "\n"
      }
    }
  },
  "fieldMappings": {
    "project": {
      "name": { "source": "Name" },
      "description": { "source": "Description" },
      "state": { "source": "Status", "transform": "statusMap" },
      "lead": { "source": "Owner", "transform": "user" },
      "startDate": { "source": "Timeline", "transform": "timelineStart" },
      "targetDate": { "source": "Timeline", "transform": "timelineEnd" }
    },
    "issue": {
      "title": { "source": "Name" },
      "description": { "source": "Details" },
      "state": { "source": "Status", "transform": "issueStatusMap" },
      "assignee": { "source": "Assignee", "transform": "user" },
      "dueDate": { "source": "Due Date" }
    }
  },
  "statusMapping": {
    "Not Started": "Backlog",
    "Planning": "Planned",
    "In Progress": "Started",
    "On Hold": "Paused",
    "Done": "Completed",
    "Cancelled": "Canceled",
    "_default": "Backlog"
  },
  "issueStatusMapping": {
    "Not Started": "Backlog",
    "In Progress": "In Progress",
    "Completed": "Done",
    "_default": "Backlog"
  },
  "labels": [
    {
      "sourceColumn": "Category",
      "groupName": "Category",
      "createGroup": true
    }
  ],
  "groups": {
    "enabled": true,
    "sourceColumn": "_group",
    "groupName": "Department"
  },
  "updates": {
    "enabled": true,
    "dateColumn": "Created At",
    "authorColumn": "User",
    "contentColumn": "Update Content",
    "linkColumn": "Item Name",
    "sortOrder": "asc",
    "authorFallback": "prepend"
  },
  "deduplication": {
    "enabled": true,
    "matchBy": "name",
    "onDuplicate": "skip"
  },
  "options": {
    "continueOnError": true,
    "rateLimitMs": 100,
    "skipEmpty": true
  }
}
```

### Key Sections

#### Source
Defines which sheets contain your data and where headers are located.

```json
{
  "source": {
    "sheets": {
      "items": "Sheet1",
      "updates": "Sheet1-updates"
    },
    "headerRow": 3
  }
}
```

#### Data Model
Controls how Monday.com items map to Linear entities.

```json
{
  "dataModel": {
    "items": {
      "importAs": "project",
      "subitems": {
        "enabled": true,
        "importAs": "issue",
        "sourceColumn": "Subitems",
        "delimiter": "\n"
      }
    }
  }
}
```

#### Field Mappings
Map Monday.com columns to Linear fields. Separate mappings for projects and issues.

**Project fields:**
- `name` - Project name
- `description` - Project description (supports templates)
- `state` - Project status (use `statusMap` transform)
- `lead` - Project lead (use `user` transform)
- `startDate` - Project start date
- `targetDate` - Project target date

**Issue fields:**
- `title` - Issue title
- `description` - Issue description
- `state` - Issue status (use `issueStatusMap` transform)
- `assignee` - Issue assignee (use `user` transform)
- `dueDate` - Issue due date
- `estimate` - Issue estimate

#### Status Mappings

**Project statuses** (Linear's project statuses):
- `Backlog`, `Planned`, `Started`, `Paused`, `Completed`, `Canceled`

```json
{
  "statusMapping": {
    "Not Started": "Backlog",
    "In Progress": "Started",
    "Done": "Completed",
    "_default": "Backlog"
  }
}
```

**Issue statuses** (varies by team workflow):
- Typically: `Backlog`, `Todo`, `In Progress`, `Done`, `Canceled`

```json
{
  "issueStatusMapping": {
    "Not Started": "Backlog",
    "Active": "In Progress",
    "Completed": "Done",
    "_default": "Backlog"
  }
}
```

#### Labels

Linear has **separate label systems** for Projects and Issues. The importer creates Project Labels for projects.

```json
{
  "labels": [
    {
      "sourceColumn": "Category",
      "groupName": "Category",
      "createGroup": true
    },
    {
      "sourceColumn": "Priority Tag",
      "flat": true
    }
  ]
}
```

- `createGroup: true` - Creates a label group with child labels for each unique value
- `flat: true` - Creates standalone labels (no grouping)

#### Groups (Monday.com Groups → Labels)

Convert Monday.com board groups into a label group.

```json
{
  "groups": {
    "enabled": true,
    "sourceColumn": "_group",
    "groupName": "Department"
  }
}
```

#### Project Updates

Import Monday.com updates as Linear project updates.

```json
{
  "updates": {
    "enabled": true,
    "dateColumn": "Created At",
    "authorColumn": "User",
    "contentColumn": "Update Content",
    "linkColumn": "Item Name",
    "sortOrder": "asc",
    "authorFallback": "prepend"
  }
}
```

#### Description Templates

Combine multiple columns into a single description:

```json
{
  "description": {
    "sources": ["Description", "Notes", "Requirements"],
    "template": "## Description\n{{Description}}\n\n## Notes\n{{Notes}}\n\n## Requirements\n{{Requirements}}"
  }
}
```

### Transform Types

- `statusMap` - Map through `statusMapping` (for projects)
- `issueStatusMap` - Map through `issueStatusMapping` (for issues)
- `priorityMap` - Map through `priorityMapping`
- `date` - Parse as date
- `timelineStart` - Extract start date from date range
- `timelineEnd` - Extract end date from date range
- `user` - Resolve to Linear user ID via `user-mapping.json`
- `number` - Parse as number

### Special Template Variables

- `{{ColumnName}}` - Value from any column
- `{{_mondayId}}` - Monday.com item ID
- `{{_importDate}}` - Import timestamp
- `{{_rowNumber}}` - Row number in Excel

## CLI Commands

### `init <excel-file>`
Analyze Excel and generate config via interactive wizard.

```bash
npx tsx src/index.ts init export.xlsx -o my-config.json
```

The wizard will:
1. Detect sheets and header rows
2. Show columns with Excel-style lettering (A, B, C...)
3. Guide you through mapping fields
4. Generate a complete configuration file

### `users`
Generate user mapping template from Excel.

```bash
npx tsx src/index.ts users -f export.xlsx -o user-mapping.json
```

Edit the generated file to map Monday.com names to Linear email addresses:

```json
{
  "John Smith": "john@company.com",
  "Jane Doe": "jane@company.com",
  "Contractor": "_skip"
}
```

Use `"_skip"` for users you don't want to map.

### `validate`
Validate config and Excel compatibility.

```bash
npx tsx src/index.ts validate -c config.json -f export.xlsx
```

### `dry-run`
Preview import without making changes.

```bash
npx tsx src/index.ts dry-run -c config.json -f export.xlsx
```

### `run`
Execute the import.

```bash
npx tsx src/index.ts run -c config.json -f export.xlsx
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LINEAR_API_KEY` | Your Linear API key | Yes |

You can set this via:
- Environment variable: `export LINEAR_API_KEY=lin_api_...`
- `.env` file in the project root

## Output Files

- `import-results.json` - Full import report with Monday ID → Linear ID mapping
- `import-failures.json` - List of failed items for retry

## Important Notes

### Linear Label Systems
Linear has **separate label systems** for Projects and Issues:
- **Project Labels** - Created via `projectLabelCreate` mutation
- **Issue Labels** - Created via `issueLabelCreate` mutation

This importer correctly handles both, creating Project Labels for projects and Issue Labels for issues.

### Label Conflicts
If you see errors like "Label already exists but is not a label group", you need to:
1. Go to Linear Settings → Labels
2. Delete or rename the conflicting label
3. Re-run the import

The importer will not automatically convert existing labels to groups.

### Excel Date Handling
The importer properly handles Excel serial dates (stored as numbers like `45123`) and converts them to ISO date strings.

### Rate Limiting
The importer includes automatic rate limiting (default 100ms between API calls) to avoid hitting Linear's API limits.

## Troubleshooting

**"LINEAR_API_KEY not set"**
- Set the environment variable or create a `.env` file

**"Label already exists but is not a label group"**
- Delete the conflicting label in Linear and re-run

**Dates showing as year 5473 or similar**
- This was a bug with Excel serial date parsing (now fixed)

**Projects created but no labels applied**
- Ensure labels are defined in the config and `createMissingLabels: true`

## License

MIT
