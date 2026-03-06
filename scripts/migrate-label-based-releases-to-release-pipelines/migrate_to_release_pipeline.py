#!/usr/bin/env python3
"""
Migrate label-based release pipeline to Linear's native releases.

This script takes an API key, a parent label ID, and a release pipeline ID. For each sub-label of the parent label it creates a release (same name) in the given pipeline,
and adds all issues with that label to the release. It does not delete any labels; you can delete the label group after running the script if desired.
"""

# =============================================================================
# PASTE YOUR VALUES HERE
# UUIDs: open the label group (o+l) or pipeline in Linear → Cmd+K → "copy model uuid"
# =============================================================================

API_KEY = ""
PARENT_LABEL_ID = ""
RELEASE_PIPELINE_ID = ""
RELEASE_STAGE_ID = ""
# For continuous pipelines, this is optional; we'll fallback to completed if you do not fill this field.
# If your pipeline is scheduled, set this field to the desired value. See README for how to find stage IDs.

# =============================================================================

import argparse
import os
import sys
from typing import Optional

import requests

LINEAR_GRAPHQL = "https://api.linear.app/graphql"


def graphql(api_key: str, query: str, variables: dict | None = None) -> dict:
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    r = requests.post(
        LINEAR_GRAPHQL,
        json=payload,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data.get("data", {})


def paginate(api_key: str, query: str, base_vars: dict, path: str) -> list:
    """Run paginated query; path is e.g. 'issueLabels' or 'issues'."""
    nodes, cursor = [], None
    while True:
        vars_ = {**base_vars, "after": cursor}
        page = graphql(api_key, query, vars_)[path]
        nodes.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]
    return nodes


def get_sub_labels(api_key: str, parent_label_id: str) -> list[dict]:
    q = """
    query($filter: IssueLabelFilter, $first: Int!, $after: String) {
      issueLabels(filter: $filter, first: $first, after: $after) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
    """
    return paginate(api_key, q, {"filter": {"parent": {"id": {"eq": parent_label_id}}}, "first": 100}, "issueLabels")


def get_issues_with_label(api_key: str, label_id: str) -> list[dict]:
    q = """
    query($filter: IssueFilter, $first: Int!, $after: String) {
      issues(filter: $filter, first: $first, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
    """
    return paginate(api_key, q, {"filter": {"labels": {"some": {"id": {"eq": label_id}}}}, "first": 100}, "issues")


def get_releases_in_pipeline(api_key: str, pipeline_id: str) -> list[dict]:
    """Return all releases in the pipeline (id, name, version)."""
    q = """
    query($id: String!, $first: Int!, $after: String) {
      releasePipeline(id: $id) {
        releases(first: $first, after: $after) {
          nodes { id name version }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    """
    nodes: list[dict] = []
    cursor: Optional[str] = None
    while True:
        vars_ = {"id": pipeline_id, "first": 100, "after": cursor}
        data = graphql(api_key, q, vars_)
        releases = data.get("releasePipeline") or {}
        page = releases.get("releases") or {}
        nodes.extend(page.get("nodes") or [])
        if not page.get("pageInfo", {}).get("hasNextPage"):
            break
        cursor = page["pageInfo"].get("endCursor")
    return nodes


def create_release(
    api_key: str,
    pipeline_id: str,
    name: str,
    stage_id: Optional[str] = None,
    version: Optional[str] = None,
) -> dict:
    input_: dict = {"name": name, "pipelineId": pipeline_id}
    if stage_id:
        input_["stageId"] = stage_id
    if version is not None:
        input_["version"] = version
    data = graphql(api_key, """
    mutation($input: ReleaseCreateInput!) {
      releaseCreate(input: $input) { success release { id name version } }
    }
    """, {"input": input_})
    if not data.get("releaseCreate", {}).get("success"):
        raise RuntimeError(f"releaseCreate failed: {data}")
    return data["releaseCreate"]["release"]


def add_issue_to_release(api_key: str, issue_id: str, release_id: str) -> None:
    data = graphql(api_key, """
    mutation($input: IssueToReleaseCreateInput!) {
      issueToReleaseCreate(input: $input) { success }
    }
    """, {"input": {"issueId": issue_id, "releaseId": release_id}})
    if not data.get("issueToReleaseCreate", {}).get("success"):
        raise RuntimeError(f"issueToReleaseCreate failed: {data}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--api-key", default=API_KEY or os.environ.get("LINEAR_API_KEY"))
    p.add_argument("--parent-label-id", default=PARENT_LABEL_ID or os.environ.get("PARENT_LABEL_ID"))
    p.add_argument("--pipeline-id", default=RELEASE_PIPELINE_ID or os.environ.get("RELEASE_PIPELINE_ID"))
    p.add_argument("--stage-id", default=RELEASE_STAGE_ID or os.environ.get("RELEASE_STAGE_ID"), help="Stage ID for created releases (optional; see RELEASE_STAGE_ID at top of file)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    api_key = args.api_key or sys.exit("Missing API key. Paste it at the top of this file, or set LINEAR_API_KEY.")
    parent_label_id = args.parent_label_id or sys.exit("Missing parent label ID. Paste it at the top of this file, or set PARENT_LABEL_ID.")
    pipeline_id = args.pipeline_id or sys.exit("Missing pipeline ID. Paste it at the top of this file, or set RELEASE_PIPELINE_ID.")

    release_stage_id: Optional[str] = (args.stage_id or "").strip() or None

    if not api_key.startswith(("lin_api_", "Bearer ")):
        api_key = f"Bearer {api_key}"

    sub_labels = get_sub_labels(api_key, parent_label_id)
    if not sub_labels:
        sys.exit("No sub-labels under parent label")

    existing_releases: list[dict] = []
    if not args.dry_run:
        existing_releases = get_releases_in_pipeline(api_key, pipeline_id)

    for lab in sub_labels:
        name = lab["name"]
        version = name  # continuous pipelines use version (unique per pipeline)
        issues = get_issues_with_label(api_key, lab["id"])
        print(f"{name}: {len(issues)} issue(s)")
        if not args.dry_run:
            release = None
            for r in existing_releases:
                if r.get("version") == version or r.get("name") == name:
                    release = r
                    break
            if release is None:
                release = create_release(
                    api_key, pipeline_id, name, stage_id=release_stage_id, version=version
                )
                existing_releases.append(release)
            for issue in issues:
                add_issue_to_release(api_key, issue["id"], release["id"])


if __name__ == "__main__":
    main()
