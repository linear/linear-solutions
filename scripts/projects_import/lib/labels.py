"""Label management for Linear import (project and issue labels)."""

from .client import LinearClient
from .discovery import WorkspaceConfig

# GraphQL Mutations for project labels
CREATE_PROJECT_LABEL_GROUP_MUTATION = """
mutation CreateProjectLabelGroup($name: String!) {
  projectLabelCreate(input: {
    name: $name,
    isGroup: true
  }) {
    success
    projectLabel {
      id
      name
    }
  }
}
"""

CREATE_PROJECT_LABEL_MUTATION = """
mutation CreateProjectLabel($name: String!, $parentId: String!) {
  projectLabelCreate(input: {
    name: $name,
    parentId: $parentId
  }) {
    success
    projectLabel {
      id
      name
    }
  }
}
"""

CREATE_STANDALONE_PROJECT_LABEL_MUTATION = """
mutation CreateStandaloneProjectLabel($name: String!) {
  projectLabelCreate(input: {
    name: $name
  }) {
    success
    projectLabel {
      id
      name
    }
  }
}
"""


def ensure_label_groups(
    client: LinearClient,
    workspace: WorkspaceConfig,
    config: dict,
    csv_data: list,
    dry_run: bool = False,
) -> dict:
    """
    Ensure all configured label groups exist, creating them if needed.
    
    Returns a dict of created labels: {group_name: {label_name: label_id}}
    """
    project_config = config.get("projects", {})
    label_groups = project_config.get("label_groups", [])
    conditional_labels = project_config.get("conditional_labels", [])
    
    results = {
        "groups_created": 0,
        "labels_created": 0,
        "groups_skipped": 0,
        "labels_skipped": 0,
        "errors": [],
    }
    
    if not label_groups and not conditional_labels:
        return results
    
    print("\n🏷️  Ensuring label groups exist...")
    
    # Process label groups from columns
    for lg in label_groups:
        group_name = lg.get("group_name")
        column = lg.get("column")
        multi_value = lg.get("multi_value", False)
        separator = lg.get("separator", ",")
        value_map = lg.get("value_map", {})
        filter_unmapped = lg.get("filter_unmapped", False)
        create_empty = lg.get("create_empty", False)
        
        if not group_name:
            continue

        # Handle empty groups (create group with no children)
        if create_empty and not column:
            if group_name in workspace.project_labels:
                print(f"  ✓ {group_name}: Group exists (empty)")
                results["groups_skipped"] += 1
                continue
            if dry_run:
                print(f"  → Would create empty group: {group_name}")
                results["groups_created"] += 1
                workspace.project_labels[group_name] = {
                    "id": f"dry-run-group-{group_name}",
                    "isGroup": True,
                    "children": {}
                }
            else:
                try:
                    result = client.execute(CREATE_PROJECT_LABEL_GROUP_MUTATION, {"name": group_name})
                    if result.get("projectLabelCreate", {}).get("success"):
                        group = result["projectLabelCreate"]["projectLabel"]
                        print(f"  ✓ Created empty group: {group_name}")
                        results["groups_created"] += 1
                        workspace.project_labels[group_name] = {
                            "id": group["id"], "isGroup": True, "children": {}
                        }
                    client.rate_limit_delay()
                except Exception as e:
                    if "duplicate" in str(e).lower() or "already exists" in str(e).lower():
                        print(f"  ✓ {group_name}: Group already exists (empty)")
                        results["groups_skipped"] += 1
                    else:
                        print(f"  ✗ Error creating empty group {group_name}: {e}")
                        results["errors"].append({"group": group_name, "error": str(e)})
            continue

        if not column:
            continue
        
        # Collect unique values from CSV for this column
        unique_values = set()
        for row in csv_data:
            value = row.get(column, "").strip()
            if multi_value and value:
                for v in value.split(separator):
                    v = v.strip()
                    if v:
                        unique_values.add(v)
            elif value:
                unique_values.add(value)

        # Apply value_map: transform values and optionally filter unmapped ones
        if value_map:
            mapped_values = set()
            for v in unique_values:
                if v in value_map:
                    mapped_values.add(value_map[v])
                elif not filter_unmapped:
                    mapped_values.add(v)
            unique_values = mapped_values
        
        if not unique_values:
            print(f"  ⏭ {group_name}: No values found in column '{column}'")
            continue
        
        # Check if group exists
        if group_name in workspace.project_labels:
            group_info = workspace.project_labels[group_name]
            if group_info.get("isGroup"):
                print(f"  ✓ {group_name}: Group exists")
                results["groups_skipped"] += 1
                
                # Check for missing child labels
                existing_children = set(group_info.get("children", {}).keys())
                missing_children = unique_values - existing_children
                
                if missing_children:
                    group_id = group_info["id"]
                    for child_name in sorted(missing_children):
                        existing_id = _find_label_by_name(child_name, workspace.project_labels)
                        if existing_id:
                            workspace.project_labels[group_name]["children"][child_name] = existing_id
                            print(f"    ✓ Label already exists: {child_name}")
                            results["labels_skipped"] += 1
                            continue
                        if dry_run:
                            print(f"    → Would create label: {child_name}")
                            results["labels_created"] += 1
                            workspace.project_labels[group_name]["children"][child_name] = f"dry-run-label-{child_name}"
                        else:
                            try:
                                result = client.execute(CREATE_PROJECT_LABEL_MUTATION, {
                                    "name": child_name,
                                    "parentId": group_id
                                })
                                if result.get("projectLabelCreate", {}).get("success"):
                                    label = result["projectLabelCreate"]["projectLabel"]
                                    print(f"    ✓ Created label: {child_name}")
                                    results["labels_created"] += 1
                                    workspace.project_labels[group_name]["children"][child_name] = label["id"]
                                else:
                                    print(f"    ✗ Failed to create label: {child_name}")
                                    results["errors"].append({"label": child_name, "error": "Unknown error"})
                                client.rate_limit_delay()
                            except Exception as e:
                                error_str = str(e)
                                if "forbidden" in error_str.lower() or "not allowed" in error_str.lower():
                                    print(f"    ✗ Permission denied creating labels – skipping remaining")
                                    results["errors"].append({"label": group_name, "error": error_str})
                                    break
                                if "duplicate" in error_str.lower() and "label name" in error_str.lower():
                                    print(f"    ⚠️  Label '{child_name}' exists but not in discovered cache – skipping")
                                    results["errors"].append({"label": child_name, "error": error_str})
                                else:
                                    print(f"    ✗ Error creating label {child_name}: {e}")
                                    results["errors"].append({"label": child_name, "error": error_str})
                else:
                    results["labels_skipped"] += len(existing_children)
                continue
            else:
                parent_group, _ = _find_label_in_children(group_name, workspace.project_labels)
                conflict_detail = f" (child of '{parent_group}')" if parent_group else ""
                print(f"  ⚠️  '{group_name}' exists as a label{conflict_detail} but not as a group")
                print(f"     Creating labels as standalone...")
                _create_standalone_project_labels(
                    client, workspace, group_name, unique_values,
                    dry_run, results,
                )
                continue
        
        # Group doesn't exist - create it
        if dry_run:
            print(f"  → Would create group: {group_name}")
            results["groups_created"] += 1
            # Add placeholder entries to cache so dry-run can resolve labels
            workspace.project_labels[group_name] = {
                "id": f"dry-run-group-{group_name}",
                "isGroup": True,
                "children": {}
            }
            for child_name in sorted(unique_values):
                print(f"    → Would create label: {child_name}")
                results["labels_created"] += 1
                workspace.project_labels[group_name]["children"][child_name] = f"dry-run-label-{child_name}"
        else:
            try:
                # Create the group
                result = client.execute(CREATE_PROJECT_LABEL_GROUP_MUTATION, {
                    "name": group_name
                })
                if result.get("projectLabelCreate", {}).get("success"):
                    group = result["projectLabelCreate"]["projectLabel"]
                    group_id = group["id"]
                    print(f"  ✓ Created group: {group_name}")
                    results["groups_created"] += 1
                    
                    # Update workspace cache
                    workspace.project_labels[group_name] = {
                        "id": group_id,
                        "isGroup": True,
                        "children": {}
                    }
                    
                    # Create child labels
                    for child_name in sorted(unique_values):
                        existing_id = _find_label_by_name(child_name, workspace.project_labels)
                        if existing_id:
                            workspace.project_labels[group_name]["children"][child_name] = existing_id
                            print(f"    ✓ Label already exists: {child_name}")
                            results["labels_skipped"] += 1
                            continue
                        try:
                            child_result = client.execute(CREATE_PROJECT_LABEL_MUTATION, {
                                "name": child_name,
                                "parentId": group_id
                            })
                            if child_result.get("projectLabelCreate", {}).get("success"):
                                child_label = child_result["projectLabelCreate"]["projectLabel"]
                                print(f"    ✓ Created label: {child_name}")
                                results["labels_created"] += 1
                                workspace.project_labels[group_name]["children"][child_name] = child_label["id"]
                            else:
                                print(f"    ✗ Failed to create label: {child_name}")
                                results["errors"].append({"label": child_name, "error": "Unknown error"})
                            client.rate_limit_delay()
                        except Exception as e:
                            error_str = str(e)
                            if "forbidden" in error_str.lower() or "not allowed" in error_str.lower():
                                print(f"    ✗ Permission denied creating labels – skipping remaining")
                                results["errors"].append({"label": group_name, "error": error_str})
                                break
                            if "duplicate" in error_str.lower() and "label name" in error_str.lower():
                                print(f"    ⚠️  Label '{child_name}' exists but not in discovered cache – skipping")
                                results["errors"].append({"label": child_name, "error": error_str})
                            else:
                                print(f"    ✗ Error creating label {child_name}: {e}")
                                results["errors"].append({"label": child_name, "error": error_str})
                else:
                    print(f"  ✗ Failed to create group: {group_name}")
                    results["errors"].append({"group": group_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                error_str = str(e)
                if "duplicate label name" in error_str.lower() or "already exists" in error_str.lower():
                    parent_group, _ = _find_label_in_children(group_name, workspace.project_labels)
                    conflict_detail = f" (child of '{parent_group}')" if parent_group else ""
                    print(f"  ⚠️  Cannot create group '{group_name}': name conflict{conflict_detail}")
                    print(f"     Creating labels as standalone...")
                    _create_standalone_project_labels(
                        client, workspace, group_name, unique_values,
                        dry_run, results,
                    )
                else:
                    print(f"  ✗ Error creating group {group_name}: {e}")
                    results["errors"].append({"group": group_name, "error": error_str})
    
    # Process static labels (standalone labels applied to every item)
    static_labels = project_config.get("static_labels", [])
    for label_name in static_labels:
        if not label_name:
            continue

        if label_name in workspace.project_labels:
            print(f"  ✓ {label_name}: Static label exists")
            results["labels_skipped"] += 1
            continue

        if dry_run:
            print(f"  → Would create static label: {label_name}")
            results["labels_created"] += 1
            workspace.project_labels[label_name] = {
                "id": f"dry-run-label-{label_name}",
                "isGroup": False,
                "children": {}
            }
        else:
            try:
                result = client.execute(CREATE_STANDALONE_PROJECT_LABEL_MUTATION, {
                    "name": label_name
                })
                if result.get("projectLabelCreate", {}).get("success"):
                    label = result["projectLabelCreate"]["projectLabel"]
                    print(f"  ✓ Created static label: {label_name}")
                    results["labels_created"] += 1
                    workspace.project_labels[label_name] = {
                        "id": label["id"],
                        "isGroup": False,
                        "children": {}
                    }
                else:
                    print(f"  ✗ Failed to create static label: {label_name}")
                    results["errors"].append({"label": label_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                print(f"  ✗ Error creating static label {label_name}: {e}")
                results["errors"].append({"label": label_name, "error": str(e)})

    # Process conditional labels (standalone labels, not groups)
    for cl in conditional_labels:
        label_name = cl.get("label_name")
        if not label_name:
            continue
        
        if label_name in workspace.project_labels:
            print(f"  ✓ {label_name}: Label exists")
            results["labels_skipped"] += 1
            continue
        
        # Create standalone label
        if dry_run:
            print(f"  → Would create label: {label_name}")
            results["labels_created"] += 1
            # Add placeholder to cache for dry-run resolution
            workspace.project_labels[label_name] = {
                "id": f"dry-run-label-{label_name}",
                "isGroup": False,
                "children": {}
            }
        else:
            try:
                result = client.execute(CREATE_STANDALONE_PROJECT_LABEL_MUTATION, {
                    "name": label_name
                })
                if result.get("projectLabelCreate", {}).get("success"):
                    label = result["projectLabelCreate"]["projectLabel"]
                    print(f"  ✓ Created label: {label_name}")
                    results["labels_created"] += 1
                    # Update workspace cache
                    workspace.project_labels[label_name] = {
                        "id": label["id"],
                        "isGroup": False,
                        "children": {}
                    }
                else:
                    print(f"  ✗ Failed to create label: {label_name}")
                    results["errors"].append({"label": label_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                print(f"  ✗ Error creating label {label_name}: {e}")
                results["errors"].append({"label": label_name, "error": str(e)})
    
    # Print summary
    if dry_run:
        print(f"\n  [DRY RUN] Would create {results['groups_created']} groups, {results['labels_created']} labels")
    else:
        print(f"\n  Created {results['groups_created']} groups, {results['labels_created']} labels")
        print(f"  Skipped {results['groups_skipped']} existing groups, {results['labels_skipped']} existing labels")
    
    return results


# ── Issue label mutations ─────────────────────────────────────────────

CREATE_ISSUE_LABEL_GROUP_MUTATION = """
mutation CreateIssueLabelGroup($name: String!, $teamId: String) {
  issueLabelCreate(input: {
    name: $name,
    isGroup: true,
    teamId: $teamId
  }) {
    success
    issueLabel {
      id
      name
    }
  }
}
"""

CREATE_ISSUE_LABEL_MUTATION = """
mutation CreateIssueLabel($name: String!, $parentId: String!, $teamId: String) {
  issueLabelCreate(input: {
    name: $name,
    parentId: $parentId,
    teamId: $teamId
  }) {
    success
    issueLabel {
      id
      name
    }
  }
}
"""

CREATE_STANDALONE_ISSUE_LABEL_MUTATION = """
mutation CreateStandaloneIssueLabel($name: String!, $teamId: String) {
  issueLabelCreate(input: {
    name: $name,
    teamId: $teamId
  }) {
    success
    issueLabel {
      id
      name
    }
  }
}
"""


def _find_label_by_name(name: str, labels_dict: dict) -> str:
    """Find a label ID by name, searching top-level labels and their children.

    Returns the label ID if found, else None.
    """
    if name in labels_dict:
        return labels_dict[name]["id"]
    for group_info in labels_dict.values():
        children = group_info.get("children", {})
        if name in children:
            return children[name]
    return None


def _find_label_in_children(label_name: str, labels_dict: dict) -> tuple:
    """Search for a label name in the children of all label groups.

    Returns (parent_group_name, label_id) if found, else (None, None).
    """
    for group_name, group_info in labels_dict.items():
        children = group_info.get("children", {})
        if label_name in children:
            return group_name, children[label_name]
    return None, None


def _create_issue_child_label(
    client: LinearClient,
    workspace: WorkspaceConfig,
    group_name: str,
    group_id: str,
    child_name: str,
    results: dict,
):
    """Create a single child label under a group (workspace-scoped).

    Always attempts to create rather than reusing an existing label found
    by name, because existing labels may be scoped to a different team.
    """
    try:
        child_result = client.execute(CREATE_ISSUE_LABEL_MUTATION, {
            "name": child_name,
            "parentId": group_id,
        })
        if child_result.get("issueLabelCreate", {}).get("success"):
            child_label = child_result["issueLabelCreate"]["issueLabel"]
            print(f"    ✓ Created label: {child_name}")
            results["labels_created"] += 1
            workspace.issue_labels[group_name]["children"][child_name] = child_label["id"]
        else:
            print(f"    ✗ Failed to create label: {child_name}")
            results["errors"].append({"label": child_name, "error": "Unknown error"})
        client.rate_limit_delay()
    except Exception as e:
        error_str = str(e)
        if "forbidden" in error_str.lower() or "not allowed" in error_str.lower():
            print(f"    ✗ Permission denied creating labels – skipping")
            results["errors"].append({"label": group_name, "error": error_str})
        elif "duplicate" in error_str.lower() and "label name" in error_str.lower():
            # A workspace-scoped label with the same name exists; find and reuse it
            existing_id = _find_label_by_name(child_name, workspace.issue_labels)
            if existing_id:
                workspace.issue_labels[group_name]["children"][child_name] = existing_id
                print(f"    ✓ Label already exists (workspace): {child_name}")
                results["labels_skipped"] += 1
            else:
                print(f"    ⚠️  Label '{child_name}' exists but could not be resolved – skipping")
                results["errors"].append({"label": child_name, "error": error_str})
        elif "team mismatch" in error_str.lower():
            # Group is team-scoped but we tried without teamId; create standalone
            print(f"    ⚠️  Team mismatch for '{child_name}' – creating as standalone")
            try:
                standalone = client.execute(CREATE_STANDALONE_ISSUE_LABEL_MUTATION, {
                    "name": child_name,
                })
                if standalone.get("issueLabelCreate", {}).get("success"):
                    label = standalone["issueLabelCreate"]["issueLabel"]
                    workspace.issue_labels[group_name]["children"][child_name] = label["id"]
                    print(f"    ✓ Created standalone label: {child_name}")
                    results["labels_created"] += 1
                client.rate_limit_delay()
            except Exception as inner_e:
                print(f"    ✗ Standalone creation failed: {str(inner_e)[:80]}")
                results["errors"].append({"label": child_name, "error": str(inner_e)})
        else:
            print(f"    ✗ Error creating label {child_name}: {e}")
            results["errors"].append({"label": child_name, "error": error_str})


def _create_standalone_issue_labels(
    client: LinearClient,
    workspace: WorkspaceConfig,
    group_name: str,
    unique_values: set,
    team_id: str,
    dry_run: bool,
    results: dict,
):
    """Create labels as standalone (ungrouped) and cache them for resolution.

    When we can't create a label group (e.g. name conflict), this creates
    each child value as an independent label and stores them in the
    workspace cache under ``group_name`` so that ``prepare_issues_from_csv``
    can still resolve label IDs.
    """
    if group_name not in workspace.issue_labels:
        workspace.issue_labels[group_name] = {
            "id": None,
            "isGroup": False,
            "children": {},
        }
    children_cache = workspace.issue_labels[group_name].setdefault("children", {})

    for child_name in sorted(unique_values):
        if child_name in children_cache:
            results["labels_skipped"] += 1
            continue

        existing_id = _find_label_by_name(child_name, workspace.issue_labels)
        if existing_id:
            children_cache[child_name] = existing_id
            results["labels_skipped"] += 1
            continue

        if dry_run:
            print(f"    → Would create label: {child_name}")
            results["labels_created"] += 1
            children_cache[child_name] = f"dry-run-label-{child_name}"
            continue

        try:
            result = client.execute(CREATE_STANDALONE_ISSUE_LABEL_MUTATION, {
                "name": child_name,
            })
            if result.get("issueLabelCreate", {}).get("success"):
                label = result["issueLabelCreate"]["issueLabel"]
                print(f"    ✓ Created label: {child_name}")
                results["labels_created"] += 1
                children_cache[child_name] = label["id"]
            else:
                print(f"    ✗ Failed to create label: {child_name}")
                results["errors"].append({"label": child_name, "error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            error_str = str(e)
            if "forbidden" in error_str.lower() or "not allowed" in error_str.lower():
                print(f"    ✗ Permission denied creating labels – skipping remaining")
                results["errors"].append({"label": group_name, "error": error_str})
                break
            if "duplicate" in error_str.lower() and "label name" in error_str.lower():
                print(f"    ⚠️  Label '{child_name}' exists but not in discovered cache – skipping")
                results["errors"].append({"label": child_name, "error": error_str})
            else:
                print(f"    ✗ Error creating label {child_name}: {e}")
                results["errors"].append({"label": child_name, "error": error_str})


def _create_standalone_project_labels(
    client: LinearClient,
    workspace: WorkspaceConfig,
    group_name: str,
    unique_values: set,
    dry_run: bool,
    results: dict,
):
    """Create project labels as standalone (ungrouped) and cache for resolution."""
    if group_name not in workspace.project_labels:
        workspace.project_labels[group_name] = {
            "id": None,
            "isGroup": False,
            "children": {},
        }
    children_cache = workspace.project_labels[group_name].setdefault("children", {})

    for child_name in sorted(unique_values):
        if child_name in children_cache:
            results["labels_skipped"] += 1
            continue

        existing_id = _find_label_by_name(child_name, workspace.project_labels)
        if existing_id:
            children_cache[child_name] = existing_id
            results["labels_skipped"] += 1
            continue

        if dry_run:
            print(f"    → Would create label: {child_name}")
            results["labels_created"] += 1
            children_cache[child_name] = f"dry-run-label-{child_name}"
            continue

        try:
            result = client.execute(CREATE_STANDALONE_PROJECT_LABEL_MUTATION, {
                "name": child_name,
            })
            if result.get("projectLabelCreate", {}).get("success"):
                label = result["projectLabelCreate"]["projectLabel"]
                print(f"    ✓ Created label: {child_name}")
                results["labels_created"] += 1
                children_cache[child_name] = label["id"]
            else:
                print(f"    ✗ Failed to create label: {child_name}")
                results["errors"].append({"label": child_name, "error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            error_str = str(e)
            if "forbidden" in error_str.lower() or "not allowed" in error_str.lower():
                print(f"    ✗ Permission denied creating labels – skipping remaining")
                results["errors"].append({"label": group_name, "error": error_str})
                break
            if "duplicate" in error_str.lower() and "label name" in error_str.lower():
                print(f"    ⚠️  Label '{child_name}' already exists – skipping")
                results["labels_skipped"] += 1
            else:
                print(f"    ✗ Error creating label {child_name}: {e}")
                results["errors"].append({"label": child_name, "error": error_str})


def ensure_issue_label_groups(
    client: LinearClient,
    workspace: WorkspaceConfig,
    config: dict,
    csv_data: list,
    dry_run: bool = False,
) -> dict:
    """Ensure all issue-level label groups exist, creating them if needed.

    Reads ``config.issues.label_groups`` and mirrors the same create-or-skip
    logic used for project labels, but targets issue labels instead.

    Labels are created as workspace-scoped (no ``teamId``) so they work
    with issues across any team.  When a label with the same name already
    exists but is scoped to a different team, a new workspace-scoped label
    is created instead.
    """
    issues_config = config.get("issues", {})
    label_groups = issues_config.get("label_groups", [])
    static_labels = issues_config.get("static_labels", [])

    results = {
        "groups_created": 0,
        "labels_created": 0,
        "groups_skipped": 0,
        "labels_skipped": 0,
        "errors": [],
    }

    if not label_groups and not static_labels:
        return results

    print("\n🏷️  Ensuring issue label groups exist...")

    for lg in label_groups:
        group_name = lg.get("group_name")
        column = lg.get("column")
        multi_value = lg.get("multi_value", False)
        separator = lg.get("separator", ",")
        value_map = lg.get("value_map", {})
        filter_unmapped = lg.get("filter_unmapped", False)
        create_empty = lg.get("create_empty", False)

        if not group_name:
            continue

        if create_empty and not column:
            if group_name in workspace.issue_labels:
                print(f"  ✓ {group_name}: Group exists (empty)")
                results["groups_skipped"] += 1
                continue
            if dry_run:
                print(f"  → Would create empty group: {group_name}")
                results["groups_created"] += 1
                workspace.issue_labels[group_name] = {
                    "id": f"dry-run-group-{group_name}",
                    "isGroup": True,
                    "children": {},
                }
            else:
                try:
                    result = client.execute(CREATE_ISSUE_LABEL_GROUP_MUTATION, {"name": group_name})
                    if result.get("issueLabelCreate", {}).get("success"):
                        group = result["issueLabelCreate"]["issueLabel"]
                        print(f"  ✓ Created empty group: {group_name}")
                        results["groups_created"] += 1
                        workspace.issue_labels[group_name] = {
                            "id": group["id"], "isGroup": True, "children": {},
                        }
                    client.rate_limit_delay()
                except Exception as e:
                    if "duplicate" in str(e).lower() or "already exists" in str(e).lower():
                        print(f"  ✓ {group_name}: Group already exists (empty)")
                        results["groups_skipped"] += 1
                    else:
                        print(f"  ✗ Error creating empty group {group_name}: {e}")
                        results["errors"].append({"group": group_name, "error": str(e)})
            continue

        if not column:
            continue

        unique_values = set()
        for row in csv_data:
            value = row.get(column, "").strip()
            if multi_value and value:
                for v in value.split(separator):
                    v = v.strip()
                    if v:
                        unique_values.add(v)
            elif value:
                unique_values.add(value)

        if value_map:
            mapped_values = set()
            for v in unique_values:
                if v in value_map:
                    mapped_values.add(value_map[v])
                elif not filter_unmapped:
                    mapped_values.add(v)
            unique_values = mapped_values

        if not unique_values:
            print(f"  ⏭ {group_name}: No values found in column '{column}'")
            continue

        if group_name in workspace.issue_labels:
            group_info = workspace.issue_labels[group_name]
            if group_info.get("isGroup"):
                print(f"  ✓ {group_name}: Group exists")
                results["groups_skipped"] += 1

                existing_children = set(group_info.get("children", {}).keys())
                missing_children = unique_values - existing_children

                if missing_children:
                    group_id = group_info["id"]
                    for child_name in sorted(missing_children):
                        if dry_run:
                            print(f"    → Would create label: {child_name}")
                            results["labels_created"] += 1
                            workspace.issue_labels[group_name]["children"][child_name] = f"dry-run-label-{child_name}"
                        else:
                            _create_issue_child_label(
                                client, workspace, group_name, group_id,
                                child_name, results,
                            )
                else:
                    results["labels_skipped"] += len(existing_children)
                continue
            else:
                parent_group, _ = _find_label_in_children(group_name, workspace.issue_labels)
                conflict_detail = f" (child of '{parent_group}')" if parent_group else ""
                print(f"  ⚠️  '{group_name}' exists as a label{conflict_detail} but not as a group")
                print(f"     Creating labels as standalone...")
                _create_standalone_issue_labels(
                    client, workspace, group_name, unique_values,
                    None, dry_run, results,
                )
                continue

        # Group doesn't exist – create it (workspace-scoped)
        if dry_run:
            print(f"  → Would create group: {group_name}")
            results["groups_created"] += 1
            workspace.issue_labels[group_name] = {
                "id": f"dry-run-group-{group_name}",
                "isGroup": True,
                "children": {},
            }
            for child_name in sorted(unique_values):
                print(f"    → Would create label: {child_name}")
                results["labels_created"] += 1
                workspace.issue_labels[group_name]["children"][child_name] = f"dry-run-label-{child_name}"
        else:
            try:
                result = client.execute(CREATE_ISSUE_LABEL_GROUP_MUTATION, {
                    "name": group_name,
                })
                if result.get("issueLabelCreate", {}).get("success"):
                    group = result["issueLabelCreate"]["issueLabel"]
                    group_id = group["id"]
                    print(f"  ✓ Created group: {group_name}")
                    results["groups_created"] += 1

                    workspace.issue_labels[group_name] = {
                        "id": group_id,
                        "isGroup": True,
                        "children": {},
                    }

                    for child_name in sorted(unique_values):
                        _create_issue_child_label(
                            client, workspace, group_name, group_id,
                            child_name, results,
                        )
                else:
                    print(f"  ✗ Failed to create group: {group_name}")
                    results["errors"].append({"group": group_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                error_str = str(e)
                if "duplicate label name" in error_str.lower() or "already exists" in error_str.lower():
                    parent_group, _ = _find_label_in_children(group_name, workspace.issue_labels)
                    conflict_detail = f" (child of '{parent_group}')" if parent_group else ""
                    print(f"  ⚠️  Cannot create group '{group_name}': name conflict{conflict_detail}")
                    print(f"     Creating labels as standalone...")
                    _create_standalone_issue_labels(
                        client, workspace, group_name, unique_values,
                        None, dry_run, results,
                    )
                else:
                    print(f"  ✗ Error creating group {group_name}: {e}")
                    results["errors"].append({"group": group_name, "error": error_str})

    # Process static labels (standalone labels applied to every issue)
    for label_name in static_labels:
        if not label_name:
            continue

        if label_name in workspace.issue_labels:
            print(f"  ✓ {label_name}: Static issue label exists")
            results["labels_skipped"] += 1
            continue

        existing_id = _find_label_by_name(label_name, workspace.issue_labels)
        if existing_id:
            workspace.issue_labels[label_name] = {
                "id": existing_id,
                "isGroup": False,
                "children": {},
            }
            results["labels_skipped"] += 1
            continue

        if dry_run:
            print(f"  → Would create static issue label: {label_name}")
            results["labels_created"] += 1
            workspace.issue_labels[label_name] = {
                "id": f"dry-run-label-{label_name}",
                "isGroup": False,
                "children": {},
            }
        else:
            try:
                result = client.execute(CREATE_STANDALONE_ISSUE_LABEL_MUTATION, {
                    "name": label_name,
                })
                if result.get("issueLabelCreate", {}).get("success"):
                    label = result["issueLabelCreate"]["issueLabel"]
                    print(f"  ✓ Created static issue label: {label_name}")
                    results["labels_created"] += 1
                    workspace.issue_labels[label_name] = {
                        "id": label["id"],
                        "isGroup": False,
                        "children": {},
                    }
                else:
                    print(f"  ✗ Failed to create static issue label: {label_name}")
                    results["errors"].append({"label": label_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                print(f"  ✗ Error creating static issue label {label_name}: {e}")
                results["errors"].append({"label": label_name, "error": str(e)})

    if dry_run:
        print(f"\n  [DRY RUN] Would create {results['groups_created']} groups, {results['labels_created']} labels")
    else:
        print(f"\n  Created {results['groups_created']} groups, {results['labels_created']} labels")
        print(f"  Skipped {results['groups_skipped']} existing groups, {results['labels_skipped']} existing labels")

    return results
