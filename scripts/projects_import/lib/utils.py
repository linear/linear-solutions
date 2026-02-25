"""Utility functions for Linear import."""

import csv
import os
from datetime import datetime
import re

MAX_PROJECT_NAME_LENGTH = 80
MAX_ISSUE_TITLE_LENGTH = 255


def truncate_name(name: str, max_length: int = MAX_PROJECT_NAME_LENGTH) -> str:
    """Truncate a name to max length, adding ellipsis if needed."""
    if len(name) > max_length:
        return name[:max_length - 3] + "..."
    return name


def parse_date(date_str: str) -> str:
    """Parse various date formats to ISO format (YYYY-MM-DD)."""
    if not date_str or not date_str.strip():
        return None
    
    date_str = date_str.strip()
    
    # Try various formats
    formats = [
        "%m/%d/%Y",      # 1/5/2026
        "%m/%d/%y",      # 1/5/26
        "%Y-%m-%d",      # 2026-01-05
        "%Y/%m/%d",      # 2026/01/05
        "%d/%m/%Y",      # 05/01/2026 (European)
        "%d-%m-%Y",      # 05-01-2026
    ]
    
    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    
    return None


def normalize_status(status: str, status_map: dict) -> str:
    """Normalize a status value using the provided mapping."""
    if not status:
        return None
    
    status = status.strip()
    
    # Try exact match first
    if status in status_map:
        return status_map[status]
    
    # Try case-insensitive match
    status_lower = status.lower()
    for key, value in status_map.items():
        if key.lower() == status_lower:
            return value
    
    return None


def normalize_priority(priority: str, priority_map: dict) -> int:
    """Normalize a priority value using the provided mapping."""
    if not priority:
        return 0
    
    priority = priority.strip()
    
    # Try exact match first
    if priority in priority_map:
        return priority_map[priority]
    
    # Try case-insensitive match
    priority_lower = priority.lower()
    for key, value in priority_map.items():
        if key.lower() == priority_lower:
            return value
    
    return 0


def extract_project_name_from_filename(filename: str) -> str:
    """Extract project name from a CSV filename."""
    # Remove path
    name = filename.split("/")[-1].split("\\")[-1]
    
    # Remove extension
    name = re.sub(r"\.(csv|tsv)$", "", name, flags=re.IGNORECASE)
    
    prefixes = [
        r"^Copy of\s+",
        r"^[A-Z]{2,5}\s*-\s*Project Tracker\s+H\d+\s*\d*\s*-\s*",
        r"^Project Tracker\s*-\s*",
    ]
    for prefix in prefixes:
        name = re.sub(prefix, "", name, flags=re.IGNORECASE)
    
    return name.strip()


def parse_estimate(value: str) -> float:
    """Parse estimate value (story points or effort days)."""
    if not value:
        return None
    
    try:
        return float(value.strip())
    except (ValueError, AttributeError):
        return None


def priority_from_ranking(ranking_str: str, priority_ranges: list, default: int = 0) -> int:
    """Convert a numeric ranking value to Linear priority (0-4) using range buckets.
    
    priority_ranges is a list of dicts with 'max' and 'priority' keys:
      [{"max": 100, "priority": 1}, {"max": 200, "priority": 2}, ...]
    
    Returns the priority for the first range where ranking <= max.
    """
    if not ranking_str:
        return default
    
    try:
        ranking = float(ranking_str.strip())
    except (ValueError, AttributeError):
        return default
    
    for bucket in priority_ranges:
        if ranking <= bucket.get("max", float("inf")):
            return bucket.get("priority", default)
    
    return default


def convert_numbers_to_csv(numbers_path: str) -> str:
    """Convert an Apple Numbers file to CSV, returning the path to the new CSV.
    
    Requires the ``numbers-parser`` package (``pip install numbers-parser``).
    Converts the first table in the first sheet.  The output CSV is written
    next to the source file with a ``.csv`` extension.
    """
    try:
        from numbers_parser import Document
    except ImportError:
        raise ImportError(
            "Apple Numbers support requires numbers-parser. "
            "Install with: pip install numbers-parser"
        )

    csv_path = os.path.splitext(numbers_path)[0] + ".csv"

    print(f"  Converting {os.path.basename(numbers_path)} to CSV...")
    doc = Document(numbers_path)
    table = doc.sheets[0].tables[0]

    headers = []
    for col in range(table.num_cols):
        cell = table.cell(0, col)
        headers.append(str(cell.value) if cell.value is not None else "")

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row_idx in range(1, table.num_rows):
            row_data = {}
            for col_idx, header in enumerate(headers):
                cell = table.cell(row_idx, col_idx)
                row_data[header] = str(cell.value) if cell.value is not None else ""
            writer.writerow(row_data)

    print(f"  Converted {table.num_rows - 1} rows -> {os.path.basename(csv_path)}")
    return csv_path
