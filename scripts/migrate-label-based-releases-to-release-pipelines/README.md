# Migrate label-based release pipeline to Linear releases

This script helps teams that previously modeled release pipelines with **labels** (e.g. a parent label "Releases" with sub-labels per release) migrate to Linear’s native **Releases & release pipelines** feature.

## What it does

- For each **sub-label** of the parent label: creates a **release** in your pipeline (same name as the label), sets **version** to that name, and adds all issues with that label to the release.
- **Idempotent:** if a release with the same version already exists in the pipeline (or same name if version is empty), the script reuses it instead of creating a duplicate. Safe to re-run after a partial failure — per-issue errors are collected and reported at the end rather than stopping the migration mid-run.
- Supports optional **release stage ID** (scheduled pipelines only).

## Prerequisites

- Python 3 with `requests` installed: `pip install requests`
- A **release pipeline** already created in Linear (the script only creates releases inside an existing pipeline).
- A **parent label** whose sub-labels represent releases; each sub-label’s name becomes a release name (and version).

## Setup

1. **Get your UUIDs:**
   - **LABEL_ID** — Open the **label group with O+L** (the label group that contains your release-named sub-labels) in Linear, then **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) → "Copy model UUID".
   - **RELEASE_PIPELINE_ID** — Query it in the [Linear API explorer](https://studio.apollographql.com/public/Linear-API/variant/current/explorer?explorerURLState=N4IgJg9gxgrgtgUwHYBcQC4QEcYIE4CeABAA4CWJCANmUggJJgDORwAOkkUXtQgIZMEABQrVaCFu05ciSCGAmsOMmUj6JlKopq4BfTfqS6QuoA).
2. At the top of `migrate_label_pipeline_to_releases.py`, paste:
   - **API_KEY** – Linear personal API key starting with `lin_api_` (or set `LINEAR_API_KEY` env var). **Do not use a pipeline access key.** Create one in Linear: [Settings → API](https://linear.app/settings/account/security).
   - **LABEL_ID** – ID of the label group whose sublabels should become releases in the given pipeline.
   - **RELEASE_PIPELINE_ID** – pipeline where releases will be created.
   - **RELEASE_STAGE_ID** (optional, scheduled pipelines only) – sets the stage of new releases. In the [Linear API explorer](https://studio.apollographql.com/public/Linear-API/variant/current/explorer?explorerURLState=N4IgJg9gxgrgtgUwHYBcQC4QEcYIE4CeABAA4CWJCANmUggMooCGA5ggM4AUAJHtQk3YIAChWq0EASTDoijPLRYBCAJTAAOkiJE%2BVAUNGUadTmRlFe-QSLHGpYFUQ1btRdszbsnm166QQwDm8XX20kJkQfUO0zKN8AXziiRJcU%2BJB4oA), query your release pipeline by ID and read the pipeline's stages to get stage IDs.
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
| `--label-id` | `LABEL_ID` | Label ID (of the label group whose sublabels become releases) |
| `--pipeline-id` | `RELEASE_PIPELINE_ID` | Release pipeline UUID |
| `--stage-id` | `RELEASE_STAGE_ID` | Optional stage ID for new releases (scheduled pipelines only) |
| `--dry-run` | — | List sub-labels and issue counts only; no creates |

## Notes

- The script does **not** delete labels; you can remove the label group in Linear after migration if you want.
- Re-running is safe: existing releases (matched by version, or by name if version is empty) are reused; only missing ones are created.
- New releases get **version** set to the same value as the name.
- If the migration finishes with errors, the script prints a summary of failed issue associations and exits with a non-zero code. Fix the issues and re-run — already-linked issues will be skipped automatically.

## Troubleshooting

- If you get an error: confirm your **API key** is valid (Linear Settings → API).
- Confirm **LABEL_ID** is the **label group (parent)** UUID, not a sub-label.
- Confirm the **release pipeline** exists and you have access.
