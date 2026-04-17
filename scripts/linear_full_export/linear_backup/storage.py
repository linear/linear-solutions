"""Local snapshot storage: JSONL entity files + a manifest.

Every entity type (issues, projects, ...) is persisted as a JSONL file - one
JSON object per line, keyed by `id`. Full mode overwrites the file; incremental
mode reads it, upserts the changed records by id, then rewrites it atomically.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable

MANIFEST_FILENAME = "manifest.json"
INCREMENTALS_DIR = "incrementals"
SCHEMA_VERSION = 1


def ensure_output_dir(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / INCREMENTALS_DIR).mkdir(parents=True, exist_ok=True)


def manifest_path(output_dir: Path) -> Path:
    return output_dir / MANIFEST_FILENAME


def load_manifest(output_dir: Path) -> dict[str, Any] | None:
    path = manifest_path(output_dir)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_manifest(output_dir: Path, manifest: dict[str, Any]) -> None:
    _atomic_write_text(
        manifest_path(output_dir),
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n",
    )


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> int:
    """Write an iterable of records to a JSONL file atomically. Returns count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            for record in records:
                f.write(json.dumps(record, ensure_ascii=False, default=str))
                f.write("\n")
                count += 1
        os.replace(tmp_name, path)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise
    return count


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def upsert_jsonl(path: Path, new_records: list[dict[str, Any]]) -> tuple[int, int, int]:
    """Merge `new_records` into the JSONL file at `path`, keyed by `id`.

    Returns (added, updated, total_after).
    """
    existing = read_jsonl(path)
    by_id: dict[str, dict[str, Any]] = {}
    for rec in existing:
        rid = rec.get("id")
        if rid:
            by_id[rid] = rec

    added = 0
    updated = 0
    for rec in new_records:
        rid = rec.get("id")
        if not rid:
            continue
        if rid in by_id:
            updated += 1
        else:
            added += 1
        by_id[rid] = rec

    merged = list(by_id.values())
    write_jsonl(path, merged)
    return added, updated, len(merged)


def write_incremental_audit(
    output_dir: Path, timestamp: str, payload: dict[str, Any]
) -> Path:
    filename = timestamp.replace(":", "-") + ".json"
    path = output_dir / INCREMENTALS_DIR / filename
    _atomic_write_text(
        path,
        json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n",
    )
    return path


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise
