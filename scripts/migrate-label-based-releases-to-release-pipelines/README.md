# Migrate label-based release pipeline to Linear releases

This script helps teams that previously modeled release pipelines with **labels** (e.g. a parent label "Releases" with sub-labels per release) migrate to Linear's native **Releases & release pipelines** feature.

## What it does

- For each **sub-label** of the parent label: creates a **release** in your pipeline (same name as the label), sets **version** to that name (for continuous pipelines), and adds all issues with that label to the release.
- **Idempotent:** if a release with the same name or version already exists in the pipeline, the script reuses it instead of creating a duplicate. Safe to re-run after a partial failure.
- Supports optional **release stage ID** (for continuous vs scheduled pipelines) and **version** (set to the release name by default).

## Prerequisites

- Python 3 with `requests` installed: `pip install requests`
- A **release pipeline** already created in Linear (the script only creates releases inside an existing pipeline).
- A **parent label** whose sub-labels represent releases; each sub-label's name becomes a release name (and version).

## Setup

1. **Get your UUIDs** in Linear: open the label group (O+L) or pipeline, press **Cmd+K**, choose "Copy model UUID" and select the value.
2. At the top of `migrate_label_pipeline_to_releases.py`, paste:
   - **API_KEY** – Linear API key (or set `LINEAR_API_KEY` env var).
   - **LABEL_GROUP_ID** (or **PARENT_LABEL_ID** in some copies) – parent label whose sub-labels are the releases.
   - **RELEASE_PIPELINE_ID** – pipeline where releases will be created.
   - **RELEASE_STAGE_ID** (optional) – For continuous pipelines this sets the stage of new releases; for scheduled pipelines set this to avoid releases defaulting to a completed stage. To find pipeline stage IDs, use the [Linear API explorer](https://studio.apollographql.com/public/Linear-API/variant/current/explorer?explorerURLState=N4IgJg9gxgrgtgUwHYBcQC4QEcYIE4CeABAA4CWJCANmUggMooCGA5ggM4AUAJHtQk3YIAChWq0EASTDoijPLRYBCAJTAAOkiJE%2BVAUNGUadTmRlFe-QSLHGpYFUQ1btRdszbsnm166QQwDm8XX20kJkQfUO0zKN8AXziiRJcU%2BJB4oA).
3. Run with `--dry-run` first to see what would be created:
   ```bash
   python3 migrate_label_pipeline_to_releases.py --dry-run
   ```
4. Run for real:
   ```bash
   python3 migrate_label_pipeline_to_releases.py
   ```

## CLI options

| Option | Env var | Description |
|--------|---------|-------------|
| `--api-key` | `LINEAR_API_KEY` | Linear API key |
| `--parent-label-id` | `PARENT_LABEL_ID` or `LABEL_GROUP_ID` | Parent label UUID |
| `--pipeline-id` | `RELEASE_PIPELINE_ID` | Release pipeline UUID |
| `--stage-id` | `RELEASE_STAGE_ID` | Optional stage ID for new releases |
| `--dry-run` | — | List sub-labels and issue counts only; no creates |

## Notes

- The script does **not** delete labels; you can remove the label group in Linear after migration if you want. You can bulk delete labels or label groups in the UI.
- Re-running is safe: existing releases (matched by name or version) are reused; only missing ones are created.
- New releases get **version** set to the same value as the name (for continuous pipelines). If the API returns an error about stages, add a stage to your pipeline in Linear or set **RELEASE_STAGE_ID**.
