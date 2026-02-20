# Linear to BigQuery ETL Pipeline (PyAirbyte)

A Python script that extracts **all available data** from [Linear](https://linear.app/) using [PyAirbyte](https://docs.airbyte.com/developers/pyairbyte/) and loads it into Google BigQuery. No Docker, Kubernetes, or Airbyte UI required — just Python.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Setup Instructions](#setup-instructions)
5. [Running the Script](#running-the-script)
6. [Configuration](#configuration)
7. [Available Data Streams](#available-data-streams)
8. [Stream Field Reference](#stream-field-reference)
9. [BigQuery Output](#bigquery-output)
10. [Troubleshooting](#troubleshooting)

---

## Overview

This pipeline uses PyAirbyte's `source-linear` connector to pull **16 data streams** from your Linear workspace and load them as individual tables in BigQuery. The connector handles all pagination and rate limiting automatically via Linear's GraphQL API.

**What this script does:**
1. Connects to Linear using your API key
2. Extracts all 16 available data streams (issues, projects, teams, users, etc.)
3. Converts each stream into a pandas DataFrame
4. Loads each DataFrame into a corresponding BigQuery table (full refresh / overwrite)

---

## Architecture

```
┌──────────┐     PyAirbyte      ┌──────────┐    BigQuery API    ┌──────────────┐
│  Linear  │ ──── (GraphQL) ──> │  Python  │ ────────────────> │   BigQuery   │
│   API    │   source-linear    │  Script  │  google-cloud-bq  │   Dataset    │
└──────────┘                    └──────────┘                    └──────────────┘
                                     │
                                DuckDB Cache
                              (temporary, local)
```

- **No Docker** — PyAirbyte source connectors run natively in Python
- **No Airbyte UI** — everything configured in code
- **No Kubernetes** — runs as a simple Python script

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Python** | 3.10 – 3.12 recommended (3.13 may work; 3.14 is **not** supported due to dependency constraints) |
| **pip** | Latest version recommended |
| **Linear API Key** | Personal API key from Linear settings |
| **Google Cloud Project** | With BigQuery API enabled |
| **GCP Service Account** | With BigQuery Data Editor and BigQuery User roles |
| **Service Account Key** | JSON key file for the service account |

---

## Setup Instructions

### Step 1: Clone or copy the script

Copy the project files to your working environment:

```
linear_to_bigquery.py    # Main ETL script
requirements.txt         # Python dependencies
README.md                # This documentation
```

### Step 2: Create a Python virtual environment (recommended)

Use Python 3.12 (PyAirbyte's dependencies don't yet support Python 3.14):

```bash
python3.12 -m venv venv
source venv/bin/activate   # macOS/Linux
# or
venv\Scripts\activate      # Windows
```

### Step 3: Install dependencies

```bash
pip install -r requirements.txt
```

This installs:
- `airbyte` — PyAirbyte library (includes the Linear source connector)
- `google-cloud-bigquery` — BigQuery Python client
- `pandas` — DataFrame handling
- `db-dtypes` — BigQuery-compatible pandas data types

### Step 4: Get your Linear API Key

1. Log in to [Linear](https://linear.app/)
2. Click your workspace name in the sidebar → **Settings**
3. Go to **Security & access** in the settings menu
4. Scroll to **Personal API keys**
5. Click **Create key** to generate a new API key
6. Copy and save the key securely

> The API key determines which data you can access. The key inherits the permissions of the user who creates it.

### Step 5: Set up Google Cloud credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **BigQuery API** for your project
3. Create a **Service Account** with these roles:
   - `BigQuery Data Editor`
   - `BigQuery User`
4. Generate a **JSON key file** for the service account
5. Download the JSON key file to your machine

### Step 6: Set environment variables

```bash
export LINEAR_API_KEY="lin_api_your_key_here"
export GCP_PROJECT_ID="your-gcp-project-id"
export BIGQUERY_DATASET="linear_data"                          # optional, defaults to "linear_data"
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

---

## Running the Script

```bash
python linear_to_bigquery.py
```

**Expected output:**

```
2026-02-20 10:00:00 [INFO] ============================================================
2026-02-20 10:00:00 [INFO] Linear -> BigQuery ETL Pipeline
2026-02-20 10:00:00 [INFO] ============================================================
2026-02-20 10:00:00 [INFO] Configuring Linear source connector...
2026-02-20 10:00:05 [INFO] Verifying connection to Linear...
2026-02-20 10:00:06 [INFO] Connection verified successfully.
2026-02-20 10:00:06 [INFO] Selected all 16 streams for extraction.
2026-02-20 10:00:06 [INFO] Starting data extraction from Linear (this may take a few minutes)...
2026-02-20 10:01:30 [INFO]   issues                    ->    523 rows,  35 columns
2026-02-20 10:01:30 [INFO]   users                     ->     42 rows,  20 columns
2026-02-20 10:01:30 [INFO]   teams                     ->      5 rows,  35 columns
...
2026-02-20 10:02:00 [INFO] All streams loaded to BigQuery dataset 'your-project.linear_data'.
2026-02-20 10:02:00 [INFO] Pipeline completed successfully.
```

---

## Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `LINEAR_API_KEY` | Yes | — | Your Linear personal API key |
| `GCP_PROJECT_ID` | Yes | — | Google Cloud project ID |
| `BIGQUERY_DATASET` | No | `linear_data` | Target BigQuery dataset name |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | — | Path to GCP service account JSON key |

---

## Available Data Streams

The connector extracts **16 streams** from Linear, covering all primary entities:

| # | Stream | BigQuery Table | Description |
|---|---|---|---|
| 1 | `issues` | `linear_data.issues` | All issues/tasks across all teams |
| 2 | `users` | `linear_data.users` | All users in the workspace |
| 3 | `teams` | `linear_data.teams` | Teams and their configuration |
| 4 | `projects` | `linear_data.projects` | Projects for organizing issues |
| 5 | `cycles` | `linear_data.cycles` | Sprint cycles for teams |
| 6 | `comments` | `linear_data.comments` | Comments on issues |
| 7 | `attachments` | `linear_data.attachments` | File attachments on issues |
| 8 | `issue_labels` | `linear_data.issue_labels` | Labels for categorizing issues |
| 9 | `issue_relations` | `linear_data.issue_relations` | Relationships between issues (blocks, duplicates, etc.) |
| 10 | `workflow_states` | `linear_data.workflow_states` | Workflow states/statuses for issues |
| 11 | `project_milestones` | `linear_data.project_milestones` | Milestones within projects |
| 12 | `project_statuses` | `linear_data.project_statuses` | Status definitions for projects |
| 13 | `customers` | `linear_data.customers` | Customer records (Linear customer features) |
| 14 | `customer_needs` | `linear_data.customer_needs` | Customer needs linked to issues |
| 15 | `customer_statuses` | `linear_data.customer_statuses` | Status definitions for customers |
| 16 | `customer_tiers` | `linear_data.customer_tiers` | Customer tier definitions |

**Sync mode:** Full Refresh — Overwrite (each run replaces all data).

---

## Stream Field Reference

Below is the complete field reference for every stream. Each field's type is listed — `nullable` means the field may be null.

---

### 1. `issues`

All issues and tasks across the workspace.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique issue ID |
| `title` | string, nullable | Issue title |
| `description` | string, nullable | Issue description (markdown) |
| `descriptionState` | string, nullable | Serialized description editor state |
| `identifier` | string, nullable | Human-readable identifier (e.g., `ENG-123`) |
| `number` | number, nullable | Issue number within its team |
| `url` | string, nullable | URL to the issue in Linear |
| `priority` | number, nullable | Priority value (0=None, 1=Urgent, 2=High, 3=Medium, 4=Low) |
| `priorityLabel` | string, nullable | Human-readable priority label |
| `prioritySortOrder` | number, nullable | Sort order for priority |
| `sortOrder` | number, nullable | Issue sort order |
| `subIssueSortOrder` | number, nullable | Sort order among sub-issues |
| `estimate` | number, nullable | Story point estimate |
| `branchName` | string, nullable | Associated Git branch name |
| `dueDate` | string, nullable | Due date |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `startedAt` | string, nullable | When work started |
| `completedAt` | string, nullable | When issue was completed |
| `canceledAt` | string, nullable | When issue was canceled |
| `addedToCycleAt` | string, nullable | When added to a cycle |
| `addedToProjectAt` | string, nullable | When added to a project |
| `addedToTeamAt` | string, nullable | When added to a team |
| `stateId` | string, nullable | FK to `workflow_states.id` — current state |
| `assigneeId` | string, nullable | FK to `users.id` — assigned user |
| `creatorId` | string, nullable | FK to `users.id` — issue creator |
| `teamId` | string, nullable | FK to `teams.id` — owning team |
| `projectId` | string, nullable | FK to `projects.id` — parent project |
| `cycleId` | string, nullable | FK to `cycles.id` — current cycle |
| `parentId` | string, nullable | FK to `issues.id` — parent issue (sub-issues) |
| `milestoneId` | string, nullable | FK to `project_milestones.id` |
| `sourceCommentId` | string, nullable | FK to `comments.id` — source comment |
| `labelIds` | array of strings, nullable | FKs to `issue_labels.id` |
| `attachmentIds` | array of strings, nullable | FKs to `attachments.id` |
| `subscriberIds` | array of strings, nullable | FKs to `users.id` — subscribers |
| `relationIds` | array of strings, nullable | FKs to `issue_relations.id` |
| `previousIdentifiers` | array of strings, nullable | Past identifiers if issue was moved |
| `reactionData` | array, nullable | Emoji reaction data |
| `customerTicketCount` | number, nullable | Number of customer tickets linked |
| `integrationSourceType` | string, nullable | Source integration type |
| `slaType` | string, nullable | SLA type |
| `_extracted_at` | string | Timestamp when data was extracted (added by script) |

---

### 2. `users`

All users in the Linear workspace.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique user ID |
| `name` | string, nullable | Full name |
| `displayName` | string, nullable | Display name |
| `email` | string, nullable | Email address |
| `initials` | string, nullable | User initials |
| `avatarUrl` | string, nullable | Profile picture URL |
| `avatarBackgroundColor` | string, nullable | Avatar background color |
| `url` | string, nullable | Profile URL in Linear |
| `active` | boolean, nullable | Whether user is active |
| `admin` | boolean, nullable | Whether user is an admin |
| `guest` | boolean, nullable | Whether user is a guest |
| `isMe` | boolean, nullable | Whether this is the authenticated user |
| `createdAt` | string, nullable | Account creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `lastSeen` | string, nullable | Last seen timestamp |
| `timezone` | string, nullable | User's timezone |
| `createdIssueCount` | number, nullable | Total issues created |
| `inviteHash` | string, nullable | Invite hash |
| `teamIds` | array of strings, nullable | FKs to `teams.id` — team memberships |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 3. `teams`

Teams and their full configuration.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique team ID |
| `name` | string, nullable | Team name |
| `key` | string, nullable | Team key (short identifier, e.g., `ENG`) |
| `description` | string, nullable | Team description |
| `icon` | string, nullable | Team icon |
| `color` | string, nullable | Team color |
| `timezone` | string, nullable | Team timezone |
| `private` | boolean, nullable | Whether team is private |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `issueCount` | number, nullable | Total issue count |
| `cyclesEnabled` | boolean, nullable | Whether cycles are enabled |
| `cycleDuration` | number, nullable | Cycle duration in weeks |
| `cycleCooldownTime` | number, nullable | Cooldown time between cycles |
| `cycleStartDay` | number, nullable | Day of week cycles start |
| `cycleLockToActive` | boolean, nullable | Whether to lock issues to active cycle |
| `cycleIssueAutoAssignCompleted` | boolean, nullable | Auto-assign completed cycle issues |
| `cycleIssueAutoAssignStarted` | boolean, nullable | Auto-assign started cycle issues |
| `cycleCalenderUrl` | string, nullable | Calendar URL for cycles |
| `upcomingCycleCount` | number, nullable | Number of upcoming cycles to create |
| `autoArchivePeriod` | number, nullable | Auto-archive period (months) |
| `autoClosePeriod` | number, nullable | Auto-close period (months) |
| `autoCloseStateId` | string, nullable | FK to `workflow_states.id` — auto-close target state |
| `defaultIssueEstimate` | number, nullable | Default estimate for new issues |
| `defaultIssueStateId` | string, nullable | FK to `workflow_states.id` — default state |
| `issueEstimationType` | string, nullable | Estimation type (e.g., `exponential`) |
| `issueEstimationAllowZero` | boolean, nullable | Allow zero estimates |
| `issueEstimationExtended` | boolean, nullable | Extended estimation enabled |
| `groupIssueHistory` | boolean, nullable | Group issue history |
| `triageEnabled` | boolean, nullable | Whether triage is enabled |
| `triageIssueStateId` | string, nullable | FK to `workflow_states.id` — triage state |
| `requirePriorityToLeaveTriage` | boolean, nullable | Require priority to leave triage |
| `setIssueSortOrderOnStateChange` | string, nullable | Sort order behavior on state change |
| `inviteHash` | string, nullable | Team invite hash |
| `scimManaged` | boolean, nullable | Whether team is SCIM-managed |
| `activeCycleId` | string, nullable | FK to `cycles.id` — current active cycle |
| `parentTeamId` | string, nullable | FK to `teams.id` — parent team |
| `markedAsDuplicateWorkflowStateId` | string, nullable | FK to `workflow_states.id` |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 4. `projects`

Projects for organizing issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique project ID |
| `name` | string, nullable | Project name |
| `description` | string, nullable | Project description |
| `content` | string, nullable | Project content/document |
| `contentState` | string, nullable | Serialized content editor state |
| `icon` | string, nullable | Project icon |
| `color` | string, nullable | Project color |
| `slugId` | string, nullable | URL slug ID |
| `url` | string, nullable | URL to project in Linear |
| `health` | string, nullable | Project health status |
| `healthUpdatedAt` | string, nullable | When health was last updated |
| `priority` | number, nullable | Project priority |
| `prioritySortOrder` | number, nullable | Priority sort order |
| `sortOrder` | number, nullable | Display sort order |
| `progress` | number, nullable | Completion progress (0-1) |
| `scope` | number, nullable | Total scope (story points) |
| `startDate` | string, nullable | Planned start date |
| `targetDate` | string, nullable | Target completion date |
| `startedAt` | string, nullable | Actual start timestamp |
| `completedAt` | string, nullable | Completion timestamp |
| `canceledAt` | string, nullable | Cancellation timestamp |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `scopeHistory` | array of numbers, nullable | Historical scope data |
| `completedScopeHistory` | array of numbers, nullable | Historical completed scope |
| `completedIssueCountHistory` | array of numbers, nullable | Historical completed issue counts |
| `inProgressScopeHistory` | array of numbers, nullable | Historical in-progress scope |
| `issueCountHistory` | array of numbers, nullable | Historical total issue counts |
| `updateRemindersDay` | string, nullable | Day for update reminders |
| `updateRemindersHour` | number, nullable | Hour for update reminders |
| `creatorId` | string, nullable | FK to `users.id` — project creator |
| `leadId` | string, nullable | FK to `users.id` — project lead |
| `statusId` | string, nullable | FK to `project_statuses.id` — current status |
| `convertedFromIssueId` | string, nullable | FK to `issues.id` — if converted from issue |
| `teamIds` | array of strings, nullable | FKs to `teams.id` — associated teams |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 5. `cycles`

Sprint cycles for teams.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique cycle ID |
| `name` | string, nullable | Cycle name |
| `description` | string, nullable | Cycle description |
| `number` | number, nullable | Cycle number |
| `progress` | number, nullable | Completion progress (0-1) |
| `startsAt` | string, nullable | Cycle start date |
| `endsAt` | string, nullable | Cycle end date |
| `completedAt` | string, nullable | Completion timestamp |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `scopeHistory` | array of numbers, nullable | Historical scope data |
| `completedScopeHistory` | array of numbers, nullable | Historical completed scope |
| `completedIssueCountHistory` | array of numbers, nullable | Historical completed issue counts |
| `inProgressScopeHistory` | array of numbers, nullable | Historical in-progress scope |
| `issueCountHistory` | array of numbers, nullable | Historical total issue counts |
| `teamId` | string, nullable | FK to `teams.id` — owning team |
| `inheritedFromId` | string, nullable | FK to `cycles.id` — if inherited |
| `uncompletedIssueIdsUponClose` | array of strings, nullable | Issue IDs not completed when cycle closed |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 6. `comments`

Comments on issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique comment ID |
| `body` | string, nullable | Comment text (markdown) |
| `bodyData` | string, nullable | Serialized rich-text comment data |
| `url` | string, nullable | URL to comment in Linear |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `editedAt` | string, nullable | Last edit timestamp |
| `issueId` | string, nullable | FK to `issues.id` — parent issue |
| `userId` | string, nullable | FK to `users.id` — comment author |
| `parentCommentId` | string, nullable | FK to `comments.id` — parent comment (threaded) |
| `resolvingCommentId` | string, nullable | FK to `comments.id` — resolving comment |
| `resolvingUserId` | string, nullable | FK to `users.id` — user who resolved |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 7. `attachments`

File attachments on issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique attachment ID |
| `title` | string, nullable | Attachment title |
| `subtitle` | string, nullable | Attachment subtitle |
| `url` | string, nullable | Attachment URL |
| `sourceType` | string, nullable | Source type (e.g., `github`, `figma`) |
| `groupBySource` | boolean, nullable | Whether to group by source |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `creatorId` | string, nullable | FK to `users.id` — creator |
| `issueId` | string, nullable | FK to `issues.id` — parent issue |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 8. `issue_labels`

Labels for categorizing issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique label ID |
| `name` | string, nullable | Label name |
| `description` | string, nullable | Label description |
| `color` | string, nullable | Label color (hex) |
| `isGroup` | boolean, nullable | Whether this is a label group |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `creatorId` | string, nullable | FK to `users.id` — creator |
| `parentLabelId` | string, nullable | FK to `issue_labels.id` — parent label group |
| `teamId` | string, nullable | FK to `teams.id` — team-specific label |
| `inheritedFromId` | string, nullable | FK to `issue_labels.id` — if inherited |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 9. `issue_relations`

Relationships between issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique relation ID |
| `type` | string, nullable | Relation type (`blocks`, `duplicate`, `related`) |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `issueId` | string, nullable | FK to `issues.id` — source issue |
| `relatedIssueId` | string, nullable | FK to `issues.id` — target issue |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 10. `workflow_states`

Workflow states (statuses) for issues.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique state ID |
| `name` | string, nullable | State name (e.g., `In Progress`) |
| `description` | string, nullable | State description |
| `color` | string, nullable | State color (hex) |
| `type` | string, nullable | State type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`) |
| `position` | number, nullable | Display position |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `teamId` | string, nullable | FK to `teams.id` — owning team |
| `inheritedFromId` | string, nullable | FK to `workflow_states.id` — if inherited |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 11. `project_milestones`

Milestones within projects.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique milestone ID |
| `name` | string, nullable | Milestone name |
| `description` | string, nullable | Milestone description |
| `descriptionState` | string, nullable | Serialized description editor state |
| `status` | string, nullable | Milestone status |
| `targetDate` | string, nullable | Target date |
| `progress` | number, nullable | Completion progress (0-1) |
| `sortOrder` | number, nullable | Display sort order |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `projectId` | string, nullable | FK to `projects.id` — parent project |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 12. `project_statuses`

Status definitions for projects.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique status ID |
| `name` | string, nullable | Status name (e.g., `Planned`, `In Progress`) |
| `description` | string, nullable | Status description |
| `color` | string, nullable | Status color (hex) |
| `type` | string, nullable | Status type |
| `position` | number, nullable | Display position |
| `indefinite` | boolean, nullable | Whether this is an indefinite/terminal state |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 13. `customers`

Customer records (requires Linear customer features).

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique customer ID |
| `name` | string, nullable | Customer name |
| `slugId` | string, nullable | URL slug ID |
| `logoUrl` | string, nullable | Customer logo URL |
| `domains` | array of strings, nullable | Associated domains |
| `externalIds` | array of strings, nullable | External system IDs |
| `revenue` | number, nullable | Customer revenue |
| `approximateNeedCount` | number, nullable | Approximate number of needs |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `statusId` | string, nullable | FK to `customer_statuses.id` |
| `tierId` | string, nullable | FK to `customer_tiers.id` |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 14. `customer_needs`

Customer needs linked to issues/projects.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique need ID |
| `priority` | number, nullable | Need priority |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `customerId` | string, nullable | FK to `customers.id` |
| `issueId` | string, nullable | FK to `issues.id` — linked issue |
| `projectId` | string, nullable | FK to `projects.id` — linked project |
| `commentId` | string, nullable | FK to `comments.id` — linked comment |
| `creatorId` | string, nullable | FK to `users.id` — creator |
| `attachmentId` | string, nullable | FK to `attachments.id` — linked attachment |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 15. `customer_statuses`

Status definitions for customers.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique status ID |
| `name` | string, nullable | Status name |
| `color` | string, nullable | Status color (hex) |
| `position` | number, nullable | Display position |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `_extracted_at` | string | Timestamp when data was extracted |

---

### 16. `customer_tiers`

Customer tier definitions.

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique tier ID |
| `name` | string, nullable | Tier internal name |
| `displayName` | string, nullable | Tier display name |
| `color` | string, nullable | Tier color (hex) |
| `position` | number, nullable | Display position |
| `createdAt` | string, nullable | Creation timestamp |
| `updatedAt` | string, nullable | Last update timestamp |
| `_extracted_at` | string | Timestamp when data was extracted |

---

## BigQuery Output

After running the script, you'll have the following in BigQuery:

- **Dataset:** `linear_data` (or your custom dataset name)
- **Tables:** One table per stream (16 total)
- **Write mode:** WRITE_TRUNCATE — each run fully replaces the data
- **Extra column:** `_extracted_at` — timestamp of when the extraction ran

### Example Query: Issues with team and status info

```sql
SELECT
    i.identifier,
    i.title,
    i.priorityLabel,
    ws.name AS status,
    ws.type AS status_type,
    t.name AS team_name,
    u.name AS assignee,
    i.createdAt,
    i.completedAt
FROM `your-project.linear_data.issues` i
LEFT JOIN `your-project.linear_data.workflow_states` ws ON i.stateId = ws.id
LEFT JOIN `your-project.linear_data.teams` t ON i.teamId = t.id
LEFT JOIN `your-project.linear_data.users` u ON i.assigneeId = u.id
ORDER BY i.createdAt DESC
```

### Entity Relationship Diagram

```
 customers ──< customer_needs >── issues ──< comments
     │                              │            │
     │                              ├── attachments
customer_tiers                      │
                                    ├──< issue_relations >── issues
customer_statuses                   │
                                    ├── issue_labels (via labelIds)
                                    │
                                    ├── workflow_states (via stateId)
                                    │
                                    ├── users (via assigneeId, creatorId)
                                    │
                                    ├── teams (via teamId)
                                    │      └── cycles
                                    │
                                    └── projects
                                           ├── project_milestones
                                           └── project_statuses (via statusId)
```

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|---|---|
| `LINEAR_API_KEY environment variable is not set` | Set the env var: `export LINEAR_API_KEY="lin_api_..."` |
| `Connection check failed` | Verify your API key is valid and not expired |
| `google.auth.exceptions.DefaultCredentialsError` | Set `GOOGLE_APPLICATION_CREDENTIALS` to your service account JSON path |
| `403 Access Denied` on BigQuery | Ensure service account has `BigQuery Data Editor` + `BigQuery User` roles |
| `Stream not found` | Some streams (e.g., customers) require specific Linear features to be enabled |
| Slow extraction | Linear rate limiting — the connector handles this automatically, just wait |

### Rate Limiting

Linear uses a leaky bucket algorithm for API rate limiting. The PyAirbyte connector handles this automatically by backing off when limits are hit. Large workspaces may take several minutes to fully extract.

### Connector Version

This script uses the `source-linear` connector (currently v0.0.33). PyAirbyte will automatically install the latest version when `install_if_missing=True` is set.
