"""Backup orchestration: full and incremental modes."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from linear_backup.client import LinearAPIError, LinearClient
from linear_backup.queries import ENTITIES, VIEWER_QUERY
from linear_backup.storage import (
    SCHEMA_VERSION,
    ensure_output_dir,
    load_manifest,
    save_manifest,
    upsert_jsonl,
    write_incremental_audit,
    write_jsonl,
)

log = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    # RFC 3339 / ISO 8601 with Z suffix. Linear's DateComparator accepts this.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _fetch_entity(
    client: LinearClient,
    query: str,
    connection_path: list[str],
    filter_obj: dict[str, Any] | None,
    *,
    page_size: int,
) -> list[dict[str, Any]]:
    variables: dict[str, Any] = {}
    if filter_obj is not None:
        variables["filter"] = filter_obj
    return list(
        client.paginate(
            query,
            variables,
            connection_path,
            page_size=page_size,
        )
    )


def run_full_backup(
    client: LinearClient,
    output_dir: Path,
    *,
    page_size: int = 100,
) -> dict[str, Any]:
    """Full-workspace pull. Overwrites every entity file."""
    ensure_output_dir(output_dir)
    run_started_at = _utc_now_iso()
    log.info("Starting FULL backup at %s", run_started_at)

    viewer_info = client.execute(VIEWER_QUERY, {})

    counts: dict[str, int] = {}
    for key, filename, query, connection_path in ENTITIES:
        log.info("Fetching %s ...", key)
        try:
            records = _fetch_entity(
                client, query, connection_path, None, page_size=page_size
            )
        except LinearAPIError as exc:
            log.warning("Skipping %s: %s", key, exc)
            counts[key] = 0
            write_jsonl(output_dir / filename, [])
            continue
        count = write_jsonl(output_dir / filename, records)
        counts[key] = count
        log.info("  wrote %d %s", count, key)

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "mode_last_run": "full",
        "last_synced_at": run_started_at,
        "last_full_at": run_started_at,
        "workspace": viewer_info.get("organization"),
        "counts": counts,
    }
    save_manifest(output_dir, manifest)
    log.info("FULL backup complete. Counts: %s", counts)
    return manifest


def run_incremental_backup(
    client: LinearClient,
    output_dir: Path,
    *,
    since: str | None = None,
    page_size: int = 100,
) -> dict[str, Any]:
    """Pull entities updated since the manifest's last_synced_at (or `since`).

    Upserts changed records into the existing JSONL files by id, writes a
    dated audit file under `incrementals/`, and bumps last_synced_at.
    """
    ensure_output_dir(output_dir)
    manifest = load_manifest(output_dir)
    if manifest is None and since is None:
        raise RuntimeError(
            "No manifest found. Run `--mode=full` first, or pass --since to seed "
            "the incremental cutoff manually."
        )

    effective_since = since or (manifest.get("last_synced_at") if manifest else None)
    if not effective_since:
        raise RuntimeError("Could not determine an incremental `since` timestamp.")

    run_started_at = _utc_now_iso()
    log.info(
        "Starting INCREMENTAL backup since %s (run started %s)",
        effective_since,
        run_started_at,
    )

    filter_obj = {"updatedAt": {"gt": effective_since}}
    audit: dict[str, Any] = {
        "run_started_at": run_started_at,
        "since": effective_since,
        "entities": {},
    }

    total_counts = dict((manifest or {}).get("counts") or {})

    for key, filename, query, connection_path in ENTITIES:
        log.info("Fetching %s updated since %s ...", key, effective_since)
        try:
            records = _fetch_entity(
                client, query, connection_path, filter_obj, page_size=page_size
            )
        except LinearAPIError as exc:
            log.warning("Skipping %s: %s", key, exc)
            audit["entities"][key] = {"error": str(exc)}
            continue
        added, updated, total_after = upsert_jsonl(output_dir / filename, records)
        total_counts[key] = total_after
        audit["entities"][key] = {
            "fetched": len(records),
            "added": added,
            "updated": updated,
            "total_after": total_after,
            "records": records,
        }
        log.info(
            "  %s: %d fetched (%d new, %d updated), %d total",
            key,
            len(records),
            added,
            updated,
            total_after,
        )

    write_incremental_audit(output_dir, run_started_at, audit)

    new_manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "mode_last_run": "incremental",
        "last_synced_at": run_started_at,
        "last_full_at": (manifest or {}).get("last_full_at"),
        "workspace": (manifest or {}).get("workspace"),
        "counts": total_counts,
    }
    save_manifest(output_dir, new_manifest)
    log.info("INCREMENTAL backup complete. Counts: %s", total_counts)
    return new_manifest


def summarize_entities(records_per_entity: Iterable[tuple[str, int]]) -> str:
    return ", ".join(f"{k}={v}" for k, v in records_per_entity)
