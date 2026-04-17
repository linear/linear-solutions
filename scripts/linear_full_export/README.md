# linear-backup

A small Python script that snapshots an entire Linear workspace to local JSONL
files via the Linear GraphQL API. Intended to be run as a cron job for disaster
recovery / compliance backups where the Linear UI's CSV export (issues only)
isn't enough.

## What gets exported

One JSONL file per entity:

- `issues.jsonl` - all issues, including archived, with scalar fields and
  foreign-key IDs for team / state / assignee / project / cycle / labels
- `projects.jsonl` - projects (scalar fields + creator / lead / status IDs)
- `project_milestones.jsonl` - milestones, each linked to its project by id
- `initiatives.jsonl` - initiatives and their linked project IDs
- `teams.jsonl`, `users.jsonl`, `labels.jsonl`, `workflow_states.jsonl`,
  `cycles.jsonl` - supporting context so the issue/project data is meaningful
  offline
- `comments.jsonl` - comments on issues and project updates
- `attachments.jsonl` - attachment metadata (title, URL, source)
- `project_updates.jsonl`, `initiative_updates.jsonl` - status updates
- `manifest.json` - schema version, workspace info, `last_synced_at`,
  per-entity counts
- `incrementals/<timestamp>.json` - audit record for each incremental run
  (exactly which records came back from Linear that run)

## Install

Requires Python 3.10+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

Create a Linear API key:

1. In Linear, open **Settings -> Security & access -> Personal API keys**.
2. Create a new key.
3. For a workspace-wide backup that includes **private teams**, the key must
   belong to an admin user or a dedicated service account with admin access.
   (A regular user's key will only see the teams that user is a member of.)

Put the key in a `.env` file next to the script:

```bash
cp .env.example .env
# then edit .env and set LINEAR_API_KEY=lin_api_...
```

Or export it in the shell:

```bash
export LINEAR_API_KEY=lin_api_...
```

## Usage

### Initial full export

Run once to seed the snapshot. For very large workspaces, ask Linear to
temporarily bump your API rate/complexity limits before doing this.

```bash
python -m linear_backup --mode=full --output-dir ./backup
```

### Incremental updates

Pulls only entities where `updatedAt > manifest.last_synced_at`, upserts them
into the existing JSONL files by id, and bumps the manifest timestamp.

```bash
python -m linear_backup --mode=incremental --output-dir ./backup
```

Useful flags:

- `--since 2026-04-10T00:00:00Z` override the manifest cutoff (e.g. to re-run
  a specific window for debugging)
- `--max-rps 5` client-side rate limit, in requests per second
- `--page-size 50` drop the GraphQL page size if you're seeing complexity
  limit errors
- `--log-level DEBUG` verbose output

### Example crontab

Daily incremental at 02:00 UTC, plus a weekly full reconciliation at 03:00
UTC on Sunday (catches hard-deleted records that incremental can't see -
see limitations below):

```cron
0 2 * * *  cd /opt/linear-backup && /opt/linear-backup/.venv/bin/python -m linear_backup --mode=incremental --output-dir /var/lib/linear-backup >> /var/log/linear-backup.log 2>&1
0 3 * * 0  cd /opt/linear-backup && /opt/linear-backup/.venv/bin/python -m linear_backup --mode=full        --output-dir /var/lib/linear-backup >> /var/log/linear-backup.log 2>&1
```

### Shipping the backup off the host

The script writes everything under `--output-dir`. How it ends up in S3 /
GCS / a zip archive / whatever is up to the operator. For example:

```bash
# after each run
aws s3 sync /var/lib/linear-backup s3://my-linear-backups/$(date -u +%F)/
```

## Output format

Each `.jsonl` file is one JSON object per line, keyed by `id`. Example
(`issues.jsonl`):

```json
{"id":"abc-123","identifier":"ENG-42","title":"Fix login","state":{"id":"...","name":"Done","type":"completed"},"team":{"id":"..."},"assignee":{"id":"..."},"createdAt":"2026-01-14T...","updatedAt":"2026-04-10T..."}
```

`manifest.json` tracks the watermark used by incremental mode:

```json
{
  "schema_version": 1,
  "mode_last_run": "incremental",
  "last_synced_at": "2026-04-17T09:00:00.000Z",
  "last_full_at":   "2026-04-14T03:00:00.000Z",
  "workspace": { "id": "...", "name": "Scout24", "urlKey": "scout24" },
  "counts": { "issues": 18234, "projects": 412, "initiatives": 22, "...": 0 }
}
```

## Limitations (v1)

- **Hard deletes are not detected.** Incremental mode relies on `updatedAt`
  filters; a record that is permanently deleted never appears in the response
  and won't be removed from the snapshot. Run `--mode=full` periodically
  (weekly cron above) to reconcile. Archived records are covered - they're
  pulled with `includeArchived: true`.
- **Attachment binaries are not downloaded** - only the attachment URL and
  metadata. If you need the file contents themselves, fetch them from the
  URLs as a separate step.
- **No Linear-side import.** Linear doesn't currently support importing a
  workspace back from a dump, so this is a read-only backup for disaster
  recovery, not a restore-in-place tool.
- **Initiative updates** depend on the `initiativeUpdates` query being
  available on your workspace. If it isn't, that file will be empty and the
  run will still succeed.

## Repo layout

```
linear_full_export/
  README.md
  requirements.txt
  .env.example
  linear_backup/
    __init__.py
    __main__.py       # python -m linear_backup ...
    cli.py            # argparse entrypoint
    client.py         # GraphQL client, pagination, backoff, rate-limit
    queries.py        # per-entity GraphQL query strings
    backup.py         # full + incremental orchestration
    storage.py        # JSONL read/write, upsert-by-id, manifest handling
```
