# Linear Import Tool

A config-driven CLI for importing projects, milestones, and issues from CSV files into [Linear](https://linear.app).

## Features

- **Three import modes**: Standard (flat), hierarchical (UUID-linked), and parent-task (name-linked 3-level hierarchy)
- **Config-driven**: All field mappings, status maps, and label definitions in JSON config files
- **Label groups**: Auto-creates label groups and child labels from CSV column values
- **External links**: Attaches document URLs and other links as project resources (supports multiple comma-separated URLs per cell)
- **Lead & member assignment**: Maps CSV names/emails to Linear users with flexible matching (email, display name, fuzzy prefix)
- **Dates**: Parses start dates, target/launch dates, and due dates in multiple formats
- **Description enrichment**: Builds project descriptions from a base column plus configurable metadata fields
- **Rate limiting**: Adaptive throttling with exponential backoff and automatic retry on 429s
- **Deduplication**: Skips existing projects, milestones, and issues; idempotent re-runs update leads, members, and links on existing projects
- **Team auto-creation**: Programmatically creates missing teams with unique key generation
- **Milestone support**: Creates project milestones and links issues to them (parent-task mode)
- **Blocking relations**: Imports dependency/blocking relationships between issues
- **Dry-run & batch modes**: Preview changes or test with a small subset before full import
- **Apple Numbers support**: Converts `.numbers` files to CSV automatically (requires `numbers-parser`)

## Requirements

- Python 3.7+
- No external dependencies for core functionality (standard library only)
- Optional: `numbers-parser` for Apple Numbers files, `pyyaml` for YAML configs

## Quick Start

```bash
# 1. Discover your Linear workspace (teams, statuses, labels, users)
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --discover

# 2. Dry run to preview what would be created
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.csv" --dry-run

# 3. Test with a small batch
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.csv" --batch 5

# 4. Full import
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.csv"
```

## CLI Arguments

```
python import_linear.py --api-key <KEY> --config <FILE> [OPTIONS]

Required:
  --api-key KEY       Linear API key or OAuth token
  --config FILE       Path to JSON config file

Optional:
  --csv PATTERN       CSV file(s) to import (glob patterns supported)
  --discover          Discover and display workspace resources, then exit
  --dry-run           Preview what would be created without making changes
  --batch N           Limit to first N projects/issues (for testing)
  --projects-only     Only import projects, skip issues
  --issues-only       Only import issues (projects must already exist)
  --verbose           Show detailed API request/rate-limit logging
  --yes, -y           Skip confirmation prompt
```

## Import Modes

### Standard Mode (default)

Flat import where each CSV row (or each CSV file) becomes a project. Issues are optionally created under each project.

**Project source options:**
- `"source": "filename"` -- each CSV file becomes a project (name derived from filename)
- `"source": "column:ProjectName"` -- projects created from unique values in that column

### Hierarchical Mode (`"import_mode": "hierarchical"`)

Two-level import using UUID columns to link parents and children. Rows with no parent become projects; rows with a parent UUID become issues under that project. Supports per-row team assignment, priority bucketing from numeric rankings, and blocking relations.

### Parent-Task Mode (`"import_mode": "parent_task"`)

Three-level hierarchy inferred from a "Parent task" name column (common in Asana/task-manager exports):

| Depth | CSV Pattern | Linear Entity |
|-------|-------------|---------------|
| 0 | No parent | Project |
| 1 | Direct child of depth-0 | Milestone (within parent project) |
| 2+ | Grandchild or deeper | Issue (linked to parent milestone) |

Supports name-based dependency resolution for blocking relations.

## Configuration

### Minimal Example (Standard Mode)

```json
{
  "name": "My Team Import",

  "team": {
    "parent_key": "MAPS",
    "target_key": "TRAFFIC"
  },

  "projects": {
    "source": "column:Project",

    "columns": {
      "name": "Project",
      "description": "Description",
      "lead": "POCs",
      "status": "Status",
      "start_date": "Start Date",
      "target_date": "Launch Date"
    },

    "lead_separator": ",",

    "status_map": {
      "To-do": "Backlog",
      "Prioritised": "Planned",
      "In Progress": "In Progress",
      "Done": "Completed"
    },

    "label_groups": [
      { "group_name": "Domain", "column": "Domain" },
      { "group_name": "Priority", "column": "OKR" }
    ],

    "description_extras": [
      { "column": "Impact", "label": "Estimated Impact" }
    ],

    "external_link_columns": [
      { "column": "Documents", "label": "Document" },
      { "column": "Experiment Link", "label": "Experiment" }
    ]
  },

  "issues": {
    "enabled": false
  }
}
```

### Config Reference

#### `team`

| Field | Description |
|-------|-------------|
| `parent_key` | Team key for the parent team (optional) |
| `target_key` | Team key where projects/issues will be created |
| `target_name` | Team display name, used for auto-creation if `target_key` is not found |
| `team_column` | CSV column for per-row team assignment (hierarchical/parent-task modes) |
| `fallback_team_name` | Default team when per-row team column is empty |

#### `projects`

| Field | Description |
|-------|-------------|
| `source` | `"filename"` or `"column:ColumnName"` |
| `template` | Project template name (partial match) or `null` |
| `columns` | Field-to-column mapping (see below) |
| `lead_separator` | Separator for multi-person lead fields (e.g., `","`) -- first becomes lead, rest become members |
| `status_map` | Maps CSV status values to Linear project statuses |
| `label_groups` | Array of label group definitions (auto-created) |
| `conditional_labels` | Array of boolean-column labels |
| `description_extras` | Array of columns to append as metadata in the project description |
| `external_link_columns` | Array of columns containing URLs to attach as project resource links |
| `team_map` | Maps CSV team values to Linear team keys (for per-project team assignment) |
| `health_map` | Maps CSV health values to Linear health types (`onTrack`, `atRisk`, `offTrack`) |
| `priority_ranges` | Array of `{max, priority}` buckets for numeric ranking-to-priority conversion |

#### `projects.columns`

| Key | Description |
|-----|-------------|
| `name` | Project name |
| `description` | Base description text |
| `lead` | Project lead (name or email) |
| `members` | Project members |
| `status` | Status value (mapped via `status_map`) |
| `health` | Health indicator |
| `team` | Per-project team assignment |
| `start_date` | Project start date |
| `target_date` | Project target/launch date |
| `update_text` | Text for a project update post |
| `link_url` | Single external link URL (legacy; prefer `external_link_columns`) |

#### `projects.label_groups[]`

| Field | Description |
|-------|-------------|
| `group_name` | Label group name in Linear (created if missing) |
| `column` | CSV column containing values |
| `multi_value` | If `true`, column may contain multiple values |
| `separator` | Separator for multi-value columns (default `","`) |

When `multi_value` is true, only the first value is applied as the label; the full list is added to the description.

#### `projects.external_link_columns[]`

| Field | Description |
|-------|-------------|
| `column` | CSV column containing URL(s) |
| `label` | Display label for the link (auto-numbered if multiple URLs in one cell) |

Supports comma-separated URLs in a single cell. If a cell contains multiple URLs, they are split and each gets a numbered label (e.g., "Document 1", "Document 2").

#### `issues`

| Field | Description |
|-------|-------------|
| `enabled` | `true` or `false` (default `true`) |
| `template` | Issue template name (partial match) or `null` |
| `columns` | Field-to-column mapping |
| `status_map` | Maps CSV values to Linear issue state names |
| `priority_map` | Maps CSV values to Linear priority (1=Urgent, 2=High, 3=Medium, 4=Low) |
| `completed_column` | Column indicating completion (for parent-task mode) |
| `completed_state` | Linear state to use for completed items |
| `default_state` | Default Linear state for new issues |

#### `hierarchy` (hierarchical and parent-task modes)

| Field | Description |
|-------|-------------|
| `entity_uuid_column` | UUID column for hierarchical mode |
| `parent_uuid_column` | Parent UUID column for hierarchical mode |
| `name_column` | Task name column for parent-task mode |
| `parent_column` | Parent task name column for parent-task mode |
| `task_id_column` | Task ID column for parent-task mode |

#### `relations`

| Field | Description |
|-------|-------------|
| `enabled` | `true` to import blocking relations |
| `blocking_column` | CSV column with blocked-by references |
| `by_name` | If `true`, match dependencies by name instead of UUID |
| `separator` | Separator for multiple dependencies in one cell |

## User Matching

The tool matches CSV names/emails to Linear users using multiple strategies:

1. Exact email match
2. Email prefix match (e.g., `tgrover` matches `tgrover@company.com`)
3. Display name match
4. Name derived from email (e.g., `jane.doe@co.com` matches "Jane Doe")
5. Case-insensitive substring matching

All workspace users are fetched with pagination (no 250-user cap).

## Idempotent Re-runs

Re-running the same import is safe:

- **Existing projects** are skipped (matched by name), but leads, members, and external links are still updated
- **Existing milestones** are skipped (matched by name within project)
- **Existing issues** are skipped (matched by title within project)
- **Label groups/labels** are only created if missing

This means you can re-run after inviting new users to assign leads, or after updating the CSV with new URLs to add resource links.

## File Structure

```
projects_import/
├── import_linear.py             # Main CLI entry point
├── update_existing_projects.py  # Bulk-update labels/members on existing projects
├── README.md
├── configs/                     # Config files (gitignored)
├── data/                        # CSV/TSV data files (gitignored)
└── lib/
    ├── client.py                # GraphQL client with rate limiting & retry
    ├── discovery.py             # Workspace discovery (teams, users, statuses, labels)
    ├── labels.py                # Label group auto-creation
    ├── teams.py                 # Team auto-creation with key generation
    ├── utils.py                 # Date parsing, name truncation, Numbers conversion
    └── importers/
        ├── projects.py          # Project, milestone, and external link creation
        └── issues.py            # Issue creation, link attachments, blocking relations
```

## Troubleshooting

**"Team not found"** -- Run `--discover` to see available teams and verify the keys in your config.

**"Project name too long"** -- Linear limits project names to 80 characters and milestone names to 80 characters. Names are automatically truncated; the full name is preserved in the description.

**Rate limiting** -- The client automatically backs off on HTTP 429 and GraphQL rate-limit errors with exponential retry. Use `--verbose` to see throttling details. For large imports (500+ entities), the adaptive delay keeps requests within Linear's quota.
