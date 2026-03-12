#!/usr/bin/env python3
"""
Migrate label-based release pipeline to Linear's native releases.

For each sub-label of the parent label: create a release (same name) in the pipeline,
then add all issues with that label to the release.
"""

# =============================================================================
# PASTE YOUR VALUES HERE (or use env vars / --flags)
# UUIDs: Cmd+K (Mac) or Ctrl+K (Windows/Linux) → "Copy model UUID"
# =============================================================================

API_KEY = ""
# ID of the label group whose sublabels should become releases in the given pipeline.
LABEL_ID = ""
RELEASE_PIPELINE_ID = ""
# This is supported only for scheduled pipelines.
RELEASE_STAGE_ID = ""

# =============================================================================

import argparse
import os
import sys
import time
from typing import Optional

import requests

LINEAR_GRAPHQL = "https://api.linear.app/graphql"


def graphql(api_key: str, query: str, variables: dict | None = None) -> dict:
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    while True:
        r = requests.post(
            LINEAR_GRAPHQL,
            json=payload,
            headers={"Authorization": api_key, "Content-Type": "application/json"},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if "errors" in data:
            if any(e.get("extensions", {}).get("code") == "RATELIMITED" for e in data["errors"]):
                reset_ms = r.headers.get("X-RateLimit-Requests-Reset")
                wait = max(0, int(reset_ms) / 1000 - time.time()) + 1 if reset_ms else 60
                print(f"Rate limited. Retrying in {wait:.0f}s...")
                time.sleep(wait)
                continue
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


def add_issue_to_release(api_key: str, issue_id: str, release_id: str) -> bool:
    """Add an issue to a release. Returns True if newly linked, False if already linked."""
    try:
        data = graphql(api_key, """
        mutation($input: IssueToReleaseCreateInput!) {
          issueToReleaseCreate(input: $input) { success }
        }
        """, {"input": {"issueId": issue_id, "releaseId": release_id}})
    except RuntimeError as e:
        if "already" in str(e).lower():
            return False
        raise
    if not data.get("issueToReleaseCreate", {}).get("success"):
        raise RuntimeError(f"issueToReleaseCreate failed: {data}")
    return True


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--api-key", default=API_KEY or os.environ.get("LINEAR_API_KEY"))
    p.add_argument("--label-id", default=LABEL_ID or os.environ.get("LABEL_ID"))
    p.add_argument("--pipeline-id", default=RELEASE_PIPELINE_ID or os.environ.get("RELEASE_PIPELINE_ID"))
    p.add_argument("--stage-id", default=RELEASE_STAGE_ID or os.environ.get("RELEASE_STAGE_ID"), help="Stage ID for created releases (scheduled pipelines only; see RELEASE_STAGE_ID at top of file)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    api_key = (args.api_key or "").strip()
    parent_label_id = (args.label_id or "").strip()
    pipeline_id = (args.pipeline_id or "").strip()
    if not api_key:
        sys.exit("Missing API key. Paste it at the top of this file, or set LINEAR_API_KEY.")
    if not api_key.startswith("lin_api_"):
        sys.exit("API key must be a Linear personal API key starting with lin_api_.")
    if not parent_label_id:
        sys.exit("Missing label ID. Paste it at the top of this file, or set LABEL_ID.")
    if not pipeline_id:
        sys.exit("Missing pipeline ID. Paste it at the top of this file, or set RELEASE_PIPELINE_ID.")

    release_stage_id: Optional[str] = (args.stage_id or "").strip() or None
    api_key = f"Bearer {api_key}"

    sub_labels = get_sub_labels(api_key, parent_label_id)
    if not sub_labels:
        sys.exit("No sub-labels under parent label")

    existing_releases: list[dict] = []
    if not args.dry_run:
        existing_releases = get_releases_in_pipeline(api_key, pipeline_id)
    else:
        print(f"Dry run: would create {len(sub_labels)} release(s) and add issues as follows:")

    releases_created = 0
    releases_reused = 0
    issues_linked = 0
    issues_skipped = 0
    issue_errors: list[str] = []

    for lab in sub_labels:
        name = lab["name"]
        version = name  # version is set to the label name (unique per pipeline)
        issues = get_issues_with_label(api_key, lab["id"])
        print(f"{name}: {len(issues)} issue(s)")
        if not args.dry_run:
            release = None
            for r in existing_releases:
                if version and r.get("version") == version:
                    release = r
                    break
                if not version and r.get("name") == name:
                    release = r
                    break
            if release is None:
                release = create_release(
                    api_key, pipeline_id, name, stage_id=release_stage_id, version=version
                )
                existing_releases.append(release)
                releases_created += 1
            else:
                releases_reused += 1
            for issue in issues:
                try:
                    if add_issue_to_release(api_key, issue["id"], release["id"]):
                        issues_linked += 1
                    else:
                        issues_skipped += 1
                except RuntimeError as e:
                    issue_errors.append(f"  {name} / {issue['id']}: {e}")

    if not args.dry_run:
        print(
            f"\nDone: {len(sub_labels)} label(s) processed, {releases_created} release(s) created, "
            f"{releases_reused} reused, {issues_linked} issue(s) linked, {issues_skipped} skipped (already linked), "
            f"{len(issue_errors)} error(s)."
        )
        if issue_errors:
            print("Failed issue associations:")
            for err in issue_errors:
                print(err)
            sys.exit(1)


if __name__ == "__main__":
    main()
