"""
Linear to BigQuery ETL Script using PyAirbyte

Extracts all available data streams from Linear via the PyAirbyte connector
and loads them into Google BigQuery. No Docker or Kubernetes required --
just Python packages installed via pip.

Usage:
    python linear_to_bigquery.py              # Full run: extract + load to BigQuery
    python linear_to_bigquery.py --dry-run    # Extract only: test Linear connection, skip BigQuery

Environment Variables:
    LINEAR_API_KEY          - Your Linear personal API key (required)
    GCP_PROJECT_ID          - Your Google Cloud project ID (required unless --dry-run)
    BIGQUERY_DATASET        - Target BigQuery dataset name (default: "linear_data")
    GOOGLE_APPLICATION_CREDENTIALS - Path to GCP service account JSON key file (required unless --dry-run)
"""

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone

import airbyte as ab
import pandas as pd

logger = logging.getLogger("linear_to_bigquery")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
logger.addHandler(_handler)

ALL_STREAMS = [
    "issues",
    "users",
    "teams",
    "projects",
    "cycles",
    "comments",
    "attachments",
    "issue_labels",
    "issue_relations",
    "workflow_states",
    "project_milestones",
    "project_statuses",
    "customers",
    "customer_needs",
    "customer_statuses",
    "customer_tiers",
]


def get_config(dry_run: bool = False):
    """Load configuration from environment variables."""
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        logger.error("LINEAR_API_KEY environment variable is not set.")
        sys.exit(1)

    project_id = os.environ.get("GCP_PROJECT_ID")
    if not project_id and not dry_run:
        logger.error("GCP_PROJECT_ID environment variable is not set.")
        sys.exit(1)

    dataset = os.environ.get("BIGQUERY_DATASET", "linear_data")

    return {
        "api_key": api_key,
        "project_id": project_id,
        "dataset": dataset,
    }


def extract_linear_data(api_key: str) -> dict[str, pd.DataFrame]:
    """
    Connect to Linear via PyAirbyte and extract all available streams
    into pandas DataFrames.
    """
    logger.info("Configuring Linear source connector...")
    source = ab.get_source(
        "source-linear",
        config={"api_key": api_key},
        install_if_missing=True,
    )

    # Workaround for PyAirbyte 0.38.0 bug: DeclarativeExecutor creates the
    # ConcurrentDeclarativeSource with an empty config dict, so the auth token
    # interpolation produces an empty string. Injecting the real config into the
    # executor's _config_dict ensures it reaches the connector's authenticator.
    if hasattr(source, "executor") and hasattr(source.executor, "_config_dict"):
        source.executor._config_dict.update({"api_key": api_key})

    logger.info("Verifying connection to Linear...")
    source.check()
    logger.info("Connection verified successfully.")

    source.select_all_streams()
    logger.info("Selected all %d streams for extraction.", len(ALL_STREAMS))

    logger.info("Starting data extraction from Linear (this may take a few minutes)...")
    read_result = source.read()

    dataframes: dict[str, pd.DataFrame] = {}
    for stream_name in ALL_STREAMS:
        try:
            df = read_result[stream_name].to_pandas()
            row_count = len(df)
            col_count = len(df.columns)
            logger.info(
                "  %-25s -> %6d rows, %3d columns",
                stream_name,
                row_count,
                col_count,
            )
            dataframes[stream_name] = df
        except KeyError:
            logger.warning("  %-25s -> stream not found (may not have data)", stream_name)
        except Exception as e:
            logger.warning("  %-25s -> error reading: %s", stream_name, e)

    logger.info("Extraction complete. %d streams retrieved.", len(dataframes))
    return dataframes


def flatten_column(value):
    """Convert dicts/lists in a cell to JSON strings for BigQuery compatibility."""
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return value


def prepare_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Prepare a DataFrame for BigQuery loading:
    - Serialize nested objects (dicts/lists) to JSON strings
    - Add an _extracted_at timestamp column
    """
    df = df.copy()

    for col in df.columns:
        if df[col].apply(lambda x: isinstance(x, (dict, list))).any():
            df[col] = df[col].apply(flatten_column)

    # Drop PyAirbyte internal metadata columns if present
    internal_cols = [c for c in df.columns if c.startswith("_airbyte_")]
    if internal_cols:
        df = df.drop(columns=internal_cols)

    df["_extracted_at"] = datetime.now(timezone.utc).isoformat()
    return df


def load_to_bigquery(
    dataframes: dict[str, pd.DataFrame],
    project_id: str,
    dataset_id: str,
):
    """Load all DataFrames into BigQuery, one table per stream."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project_id)

    dataset_ref = f"{project_id}.{dataset_id}"
    logger.info("Ensuring BigQuery dataset '%s' exists...", dataset_ref)
    dataset = bigquery.Dataset(dataset_ref)
    dataset.location = "US"
    client.create_dataset(dataset, exists_ok=True)

    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        autodetect=True,
    )

    for stream_name, df in dataframes.items():
        if df.empty:
            logger.info("  %-25s -> skipped (empty)", stream_name)
            continue

        table_id = f"{dataset_ref}.{stream_name}"
        prepared_df = prepare_dataframe(df)

        logger.info(
            "  %-25s -> loading %d rows to %s",
            stream_name,
            len(prepared_df),
            table_id,
        )

        job = client.load_table_from_dataframe(prepared_df, table_id, job_config=job_config)
        job.result()

        table = client.get_table(table_id)
        logger.info(
            "  %-25s -> loaded successfully (%d rows)",
            stream_name,
            table.num_rows,
        )

    logger.info("All streams loaded to BigQuery dataset '%s'.", dataset_ref)


def print_stream_summary(dataframes: dict[str, pd.DataFrame]):
    """Print a summary table of extracted data."""
    logger.info("")
    logger.info("=" * 60)
    logger.info("EXTRACTION SUMMARY")
    logger.info("=" * 60)
    total_rows = 0
    for name, df in sorted(dataframes.items()):
        rows = len(df)
        total_rows += rows
        cols = ", ".join(c for c in df.columns if not c.startswith("_airbyte_"))
        logger.info("  %s (%d rows)", name, rows)
        logger.info("    Columns: %s", cols)
    logger.info("-" * 60)
    logger.info("  Total: %d streams, %d rows", len(dataframes), total_rows)
    logger.info("=" * 60)


def parse_args():
    parser = argparse.ArgumentParser(description="Extract Linear data and load to BigQuery.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Extract data from Linear and print summary without loading to BigQuery. "
        "Only LINEAR_API_KEY is required.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    mode = "DRY RUN (extract only)" if args.dry_run else "Full Pipeline"
    logger.info("=" * 60)
    logger.info("Linear -> BigQuery ETL Pipeline [%s]", mode)
    logger.info("=" * 60)

    config = get_config(dry_run=args.dry_run)

    dataframes = extract_linear_data(config["api_key"])

    if not dataframes:
        logger.error("No data extracted from Linear. Exiting.")
        sys.exit(1)

    print_stream_summary(dataframes)

    if args.dry_run:
        logger.info("Dry run complete. Skipping BigQuery load.")
        logger.info("Re-run without --dry-run to load data to BigQuery.")
    else:
        load_to_bigquery(dataframes, config["project_id"], config["dataset"])
        logger.info("Pipeline completed successfully.")


if __name__ == "__main__":
    main()
