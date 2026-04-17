"""Command-line entrypoint."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from linear_backup.backup import run_full_backup, run_incremental_backup
from linear_backup.client import LinearClient


def _load_dotenv(path: Path) -> None:
    """Tiny dotenv loader so we don't need to add python-dotenv as a dep."""
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="linear_backup",
        description=(
            "Back up a Linear workspace (issues, projects, initiatives, "
            "and supporting context) to local JSONL files."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["full", "incremental"],
        default="incremental",
        help="full: overwrite everything. incremental: only entities updated "
        "since the manifest's last_synced_at (default).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backup"),
        help="Directory to write snapshot files into (default: ./backup).",
    )
    parser.add_argument(
        "--since",
        type=str,
        default=None,
        help="ISO 8601 timestamp (e.g. 2026-04-10T00:00:00Z). Overrides the "
        "manifest's last_synced_at for incremental mode.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=100,
        help="GraphQL page size for paginated connections (default: 100).",
    )
    parser.add_argument(
        "--max-rps",
        type=float,
        default=None,
        help="Optional client-side rate limit in requests per second.",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=None,
        help="Linear API key. Defaults to $LINEAR_API_KEY.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity (default: INFO).",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(".env"),
        help="Path to a .env file to load LINEAR_API_KEY from (default: ./.env).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    _load_dotenv(args.env_file)
    api_key = args.api_key or os.environ.get("LINEAR_API_KEY")
    if not api_key:
        print(
            "error: LINEAR_API_KEY is not set. Pass --api-key, export the env "
            "var, or add it to .env.",
            file=sys.stderr,
        )
        return 2

    with LinearClient(api_key, max_rps=args.max_rps) as client:
        if args.mode == "full":
            run_full_backup(client, args.output_dir, page_size=args.page_size)
        else:
            run_incremental_backup(
                client,
                args.output_dir,
                since=args.since,
                page_size=args.page_size,
            )
    return 0
