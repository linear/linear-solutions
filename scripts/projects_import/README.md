# Linear Project Import Tool

A config-driven CLI for importing projects, milestones, and issues from CSV/Excel files into [Linear](https://linear.app).

## Features

- **Three import modes**: Standard (flat), hierarchical (UUID-linked), and parent-task (name-linked 3-level hierarchy)
- **Config-driven**: All field mappings, status maps, and label definitions in JSON or YAML config files
- **Excel & Numbers support**: Automatically converts `.xlsx` and `.numbers` files to CSV before import (with optional sheet selection)
- **Label groups**: Auto-creates label groups and child labels from CSV column values
- **Static labels**: Apply one or more standalone labels to every imported project and/or issue
- **External links**: Attaches document URLs and other links as project resources (supports multiple comma-separated URLs per cell)
- **Lead & member assignment**: Maps CSV names/emails to Linear users with flexible matching (email, display name, fuzzy prefix)
- **Dates**: Parses start dates, target/launch dates, and due dates in multiple formats
- **Content & description**: Populates the full project body (`content`) with metadata fields and the original description; the short summary (`description`, 255-char limit) is kept separate
- **Initiative linking**: Matches project names to existing Linear initiatives and links them automatically
- **Priority bucketing**: Converts numeric rankings to Linear priority levels via configurable range buckets
- **Health tracking**: Maps source health statuses to Linear project health types and creates project updates
- **Rate limiting**: Adaptive throttling with exponential backoff and automatic retry on 429s
- **Deduplication**: Skips existing projects, milestones, and issues; idempotent re-runs update leads, members, labels, content, and links on existing projects
- **Team auto-creation**: Programmatically creates missing teams with unique key generation
- **Milestone support**: Creates project milestones from configured columns (standard mode) or from hierarchy depth (parent-task mode)
- **Blocking relations**: Imports dependency/blocking relationships between issues (UUID-based or name-based)
- **Dry-run & batch modes**: Preview changes or test with a small subset before full import

## Requirements

- Python 3.7+
- No external dependencies for core CSV functionality (standard library only)
- Optional: `openpyxl` for Excel `.xlsx` files, `numbers-parser` for Apple Numbers files, `pyyaml` for YAML configs

## Quick Start

```bash
# 1. Discover your Linear workspace (teams, statuses, labels, users)
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --discover

# 2. Dry run to preview what would be created
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.xlsx" --dry-run

# 3. Test with a small batch
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.xlsx" --batch 5

# 4. Full import
python import_linear.py --api-key YOUR_API_KEY --config configs/my_config.json --csv "data/projects.xlsx"
```

## CLI Arguments

```
python import_linear.py --api-key <KEY> --config <FILE> [OPTIONS]

Required:
  --api-key KEY       Linear API key or OAuth token
  --config FILE       Path to JSON or YAML config file

Optional:
  --csv PATTERN       CSV/XLSX/Numbers file(s) to import (glob patterns supported)
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

Two-level import using entity type and UUID columns. Rows matching `feature_type` become projects; rows matching `subfeature_type` become issues linked to their parent project via UUID. Supports per-row team assignment, priority bucketing from numeric rankings, static labels, health tracking, and blocking relations.

Requires the `hierarchy` config section to define how rows are classified and linked.

### Parent-Task Mode (`"import_mode": "parent_task"`)

Three-level hierarchy inferred from a "Parent task" name column (common in Asana/task-manager exports):

| Depth | CSV Pattern | Linear Entity |
|-------|-------------|---------------|
| 0 | No parent | Project |
| 1 | Direct child of depth-0 | Milestone (within parent project) |
| 2+ | Grandchild or deeper | Issue (linked to parent milestone) |

Supports name-based dependency resolution for blocking relations.

## Configuration

### Top-Level Fields

| Field | Description |
|-------|-------------|
| `name` | Display name for this import configuration |
| `import_mode` | `"standard"` (default), `"hierarchical"`, or `"parent_task"` |
| `xlsx_sheet` | Sheet name to use when converting `.xlsx` files (required if the workbook has multiple sheets) |

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

### Hierarchical Example

```json
{
  "name": "Productboard Migration",
  "import_mode": "hierarchical",
  "xlsx_sheet": "Export Sheet Name",

  "team": {
    "fallback_team_name": "Product Management"
  },

  "hierarchy": {
    "entity_type_column": "entity_type",
    "entity_uuid_column": "entity_uuid",
    "parent_uuid_column": "parent_entity_uuid",
    "feature_type": "Feature",
    "subfeature_type": "Subfeature"
  },

  "projects": {
    "columns": {
      "name": "entity_name",
      "description": "description",
      "status": "status_name",
      "lead": "Owner",
      "feature_owner": "Feature Owner",
      "start_date": "Timeframe start",
      "target_date": "Timeframe end",
      "ranking": "Neo4j Ranking",
      "link": "pb_url",
      "link_title": "ProductBoard",
      "team_list": "Team",
      "timeframe": "Timeframe",
      "parent_name": "parent_name"
    },
    "status_map": {
      "New Idea": "Backlog",
      "In Progress": "In Progress",
      "Done": "Completed"
    },
    "health_map": {
      "ON_TRACK": "onTrack",
      "OFF_TRACK": "offTrack",
      "AT_RISK": "atRisk"
    },
    "priority_ranges": [
      { "max": 100, "priority": 1 },
      { "max": 200, "priority": 2 },
      { "max": 500, "priority": 3 },
      { "max": 999, "priority": 4 }
    ],
    "default_priority": 0,
    "label_groups": [
      { "group_name": "Owning Team", "column": "Owning Eng Team" },
      { "group_name": "Tags", "column": "Tags", "multi_value": true, "separator": "," }
    ],
    "description_extras": [
      { "column": "Eng Dir", "label": "Eng Director" },
      { "column": "Launch Tiers", "label": "Launch Tier" }
    ],
    "static_labels": ["PB Import"]
  },

  "issues": {
    "enabled": true,
    "columns": {
      "title": "entity_name",
      "description": "description",
      "assignee": "Feature Owner",
      "status": "status_name",
      "due_date": "Timeframe end",
      "ranking": "Neo4j Ranking",
      "link": "pb_url",
      "link_title": "ProductBoard"
    },
    "status_map": {
      "Backlog": "Backlog",
      "In Progress": "In Progress",
      "Done": "Done"
    },
    "priority_ranges": [
      { "max": 100, "priority": 1 },
      { "max": 200, "priority": 2 },
      { "max": 500, "priority": 3 },
      { "max": 999, "priority": 4 }
    ],
    "default_priority": 0,
    "static_labels": ["PB Import"]
  },

  "relations": {
    "enabled": true,
    "blocking_column": "Is blocking ids",
    "uuid_separator": ", "
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
| `auto_create` | If `true`, auto-creates teams found in the team column that don't exist in Linear |

#### `hierarchy`

Used for hierarchical and parent-task import modes.

| Field | Description |
|-------|-------------|
| `entity_type_column` | Column that identifies row type (e.g., "Feature" vs "Subfeature") |
| `entity_uuid_column` | UUID column for each entity (hierarchical mode) |
| `parent_uuid_column` | Parent UUID column linking children to parents (hierarchical mode) |
| `feature_type` | Value in `entity_type_column` that identifies project rows (default `"Feature"`) |
| `subfeature_type` | Value in `entity_type_column` that identifies issue rows (default `"Subfeature"`) |
| `name_column` | Task name column (parent-task mode) |
| `parent_column` | Parent task name column (parent-task mode) |

#### `projects`

| Field | Description |
|-------|-------------|
| `source` | `"filename"` or `"column:ColumnName"` (standard mode) |
| `template` | Project template name (partial match) or `null` |
| `columns` | Field-to-column mapping (see below) |
| `lead_separator` | Separator for multi-person lead fields (e.g., `","`) -- first becomes lead, rest become members |
| `status_map` | Maps CSV status values to Linear project statuses |
| `health_map` | Maps CSV health values to Linear health types (`onTrack`, `atRisk`, `offTrack`) |
| `health_keywords` | Array of `{ "keyword", "health" }` for substring matching when `health_map` doesn't match exactly |
| `priority_ranges` | Array of `{ "max", "priority" }` buckets for numeric ranking-to-priority conversion |
| `default_priority` | Default priority when ranking is outside all ranges (default `0` = No priority) |
| `label_groups` | Array of label group definitions (auto-created) |
| `static_labels` | Array of standalone label names applied to every imported project (auto-created if missing) |
| `conditional_labels` | Array of boolean-column labels |
| `description_extras` | Array of columns to append as metadata in the project content body |
| `external_link_columns` | Array of columns containing URLs to attach as project resource links |
| `milestone_columns` | Array of columns to create as project milestones (standard mode) |
| `team_map` | Maps CSV team values to Linear team keys (for per-project team assignment) |
| `name_strip_prefix` | Prefix string to strip from project names |
| `multi_date` | If `true`, `start_date`/`target_date` use the last date in comma-separated values |

#### `projects.columns`

**Standard and shared fields:**

| Key | Description |
|-----|-------------|
| `name` | Project name |
| `description` | Base description/content text (populates the project body) |
| `lead` | Project lead (name or email) |
| `members` | Project members |
| `status` | Status value (mapped via `status_map`) |
| `health` | Health indicator |
| `team` | Per-project team assignment |
| `start_date` | Project start date |
| `target_date` | Project target/launch date |
| `update_text` | Text for a project update post |

**Hierarchical mode additional fields:**

| Key | Description |
|-----|-------------|
| `feature_owner` | Feature owner email (added as project member) |
| `ranking` | Numeric ranking column (converted to priority via `priority_ranges`) |
| `link` | URL column for external link attachment |
| `link_title` | Display label for the external link (default `"External Link"`) |
| `team_list` | Contributing teams column (included in content metadata) |
| `timeframe` | Timeframe display string (included in content metadata) |
| `parent_name` | Parent entity name (included in content metadata, default `"parent_name"`) |

#### `projects.label_groups[]`

| Field | Description |
|-------|-------------|
| `group_name` | Label group name in Linear (created if missing) |
| `column` | CSV column containing values |
| `multi_value` | If `true`, column may contain multiple values |
| `separator` | Separator for multi-value columns (default `","`) |

When `multi_value` is true, only the first value is applied as the label; the full list is added to the content body.

#### `projects.description_extras[]`

| Field | Description |
|-------|-------------|
| `column` | CSV column name |
| `label` | Display label (defaults to column name) |

Each entry appends a `**Label:** value` line to the project content body. Comma-separated values are automatically normalized with spaces.

#### `projects.external_link_columns[]`

| Field | Description |
|-------|-------------|
| `column` | CSV column containing URL(s) |
| `label` | Display label for the link (auto-numbered if multiple URLs in one cell) |
| `label_column` | Optional CSV column for per-row link labels |

Supports comma-separated URLs in a single cell. If a cell contains multiple URLs, they are split and each gets a numbered label (e.g., "Document 1", "Document 2").

#### `issues`

| Field | Description |
|-------|-------------|
| `enabled` | `true` or `false` (default `true`) |
| `template` | Issue template name (partial match) or `null` |
| `columns` | Field-to-column mapping (see below) |
| `status_map` | Maps CSV values to Linear issue state names |
| `priority_map` | Maps CSV values to Linear priority (1=Urgent, 2=High, 3=Medium, 4=Low) |
| `priority_ranges` | Array of `{ "max", "priority" }` buckets (hierarchical mode) |
| `default_priority` | Default priority when ranking is outside all ranges (default `0`) |
| `static_labels` | Array of standalone label names applied to every imported issue (auto-created if missing) |
| `label_groups` | Array of label group definitions applied as issue labels (auto-created) |
| `description_extras` | Array of columns to append as metadata in the issue description |
| `target_project` | Force all issues onto a single existing project by name (standard mode) |
| `extract_urls_from_title` | If `true`, splits multiline title cells: first line becomes title, `https://` lines become link attachments |
| `completed_column` | Column indicating completion (parent-task mode) |
| `completed_state` | Linear state to use for completed items |
| `default_state` | Default Linear state for new issues |

#### `issues.columns`

**Standard fields:**

| Key | Description |
|-----|-------------|
| `title` | Issue title |
| `description` | Issue description/body text |
| `project` | Project name for grouping (standard mode) |
| `assignee` | Assignee (name or email) |
| `status` | Status value (mapped via `status_map`) |
| `priority` | Priority value (mapped via `priority_map`) |
| `due_date` | Due date |
| `estimate` | Size estimate |
| `external_link` | URL for link attachment |
| `cycle` | Cycle name |

**Hierarchical mode additional fields:**

| Key | Description |
|-----|-------------|
| `ranking` | Numeric ranking column (converted to priority via `priority_ranges`) |
| `link` | URL column for external link attachment |
| `link_title` | Display label for the external link (default `"External Link"`) |
| `team_list` | Contributing teams column (included in description) |
| `parent_name` | Parent entity name (default `"parent_name"`) |

#### `issues.label_groups[]`

Same structure as `projects.label_groups[]`. Each entry creates an issue label group and applies the matching child label to issues based on the CSV column value.

#### `issues.description_extras[]`

Same structure as `projects.description_extras[]`. Each entry appends a `**Label:** value` line to the issue description.

#### `relations`

| Field | Description |
|-------|-------------|
| `enabled` | `true` to import blocking relations |
| `blocking_column` | CSV column with blocked-by references |
| `uuid_separator` | Separator for UUID-based dependencies (hierarchical mode, default `", "`) |
| `separator` | Separator for name-based dependencies (parent-task mode, default `","`) |
| `by_name` | If `true`, match dependencies by name instead of UUID (parent-task mode) |

## Content vs Description

Linear projects have two text fields:

- **`description`** -- a short summary shown under the project title (255-character limit)
- **`content`** -- the full rich text body shown in the Description section when viewing a project

In hierarchical mode, the importer populates `content` with metadata fields (Parent, Contributing Teams, Feature Owner, Timeframe, plus any `description_extras`) at the top, followed by the base description text from the source data. The short `description` summary is left empty so the project card stays clean.

For standard mode, the `description` field is built from the base description column plus `description_extras` metadata, truncated to 255 characters if needed, with the full text moved to `content` when it exceeds the limit.

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

- **Existing projects** are skipped (matched by name), but leads, members, labels, content, and external links are still updated
- **Existing milestones** are skipped (matched by name within project)
- **Existing issues** are skipped (matched by title within project), but labels are updated if configured
- **Label groups/labels** are only created if missing; static labels are created once and reused

This means you can re-run after inviting new users to assign leads, after updating the config with new label groups, or after fixing description_extras to update content on existing projects.

## Discovery

Run `--discover` to inspect your workspace before importing. This fetches and displays:

- Teams (with keys)
- Users (with emails)
- Project statuses and labels (workspace-level)
- Issue states and labels (team-level)
- Project and issue templates
- Initiatives
- Existing projects (for deduplication)

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
    ├── labels.py                # Label group and static label auto-creation
    ├── teams.py                 # Team auto-creation with key generation
    ├── utils.py                 # Date parsing, name truncation, XLSX/Numbers conversion
    └── importers/
        ├── projects.py          # Project, milestone, and external link creation
        └── issues.py            # Issue creation, link attachments, blocking relations
```

## Troubleshooting

**"Team not found"** -- Run `--discover` to see available teams and verify the keys in your config.

**"Project name too long"** -- Linear limits project names to 80 characters and milestone names to 80 characters. Names are automatically truncated; the full name is preserved in the description.

**"description must be shorter than or equal to 255 characters"** -- The short `description` field has a 255-char limit enforced by the Linear API. In hierarchical mode, metadata goes into `content` instead. In standard mode, long descriptions are auto-truncated with the full text moved to `content`.

**Rate limiting** -- The client automatically backs off on HTTP 429 and GraphQL rate-limit errors with exponential retry. Use `--verbose` to see throttling details. For large imports (500+ entities), the adaptive delay keeps requests within Linear's quota.

**Missing `openpyxl`** -- Install with `pip install openpyxl` to enable Excel `.xlsx` file support. The error message will indicate when this dependency is needed.
