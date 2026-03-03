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
        
        if not group_name or not column:
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
                        if dry_run:
                            print(f"    → Would create label: {child_name}")
                            results["labels_created"] += 1
                            # Add placeholder to cache for dry-run resolution
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
                                    # Update workspace cache
                                    workspace.project_labels[group_name]["children"][child_name] = label["id"]
                                else:
                                    print(f"    ✗ Failed to create label: {child_name}")
                                    results["errors"].append({"label": child_name, "error": "Unknown error"})
                                client.rate_limit_delay()
                            except Exception as e:
                                print(f"    ✗ Error creating label {child_name}: {e}")
                                results["errors"].append({"label": child_name, "error": str(e)})
                else:
                    # Count existing labels as skipped
                    results["labels_skipped"] += len(existing_children)
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
                        try:
                            child_result = client.execute(CREATE_PROJECT_LABEL_MUTATION, {
                                "name": child_name,
                                "parentId": group_id
                            })
                            if child_result.get("projectLabelCreate", {}).get("success"):
                                child_label = child_result["projectLabelCreate"]["projectLabel"]
                                print(f"    ✓ Created label: {child_name}")
                                results["labels_created"] += 1
                                # Update workspace cache
                                workspace.project_labels[group_name]["children"][child_name] = child_label["id"]
                            else:
                                print(f"    ✗ Failed to create label: {child_name}")
                                results["errors"].append({"label": child_name, "error": "Unknown error"})
                            client.rate_limit_delay()
                        except Exception as e:
                            print(f"    ✗ Error creating label {child_name}: {e}")
                            results["errors"].append({"label": child_name, "error": str(e)})
                else:
                    print(f"  ✗ Failed to create group: {group_name}")
                    results["errors"].append({"group": group_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                print(f"  ✗ Error creating group {group_name}: {e}")
                results["errors"].append({"group": group_name, "error": str(e)})
    
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
    """
    issues_config = config.get("issues", {})
    label_groups = issues_config.get("label_groups", [])

    results = {
        "groups_created": 0,
        "labels_created": 0,
        "groups_skipped": 0,
        "labels_skipped": 0,
        "errors": [],
    }

    if not label_groups:
        return results

    team_id = workspace.target_team_id

    print("\n🏷️  Ensuring issue label groups exist...")

    for lg in label_groups:
        group_name = lg.get("group_name")
        column = lg.get("column")
        multi_value = lg.get("multi_value", False)
        separator = lg.get("separator", ",")

        if not group_name or not column:
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
                            try:
                                result = client.execute(CREATE_ISSUE_LABEL_MUTATION, {
                                    "name": child_name,
                                    "parentId": group_id,
                                    "teamId": team_id,
                                })
                                if result.get("issueLabelCreate", {}).get("success"):
                                    label = result["issueLabelCreate"]["issueLabel"]
                                    print(f"    ✓ Created label: {child_name}")
                                    results["labels_created"] += 1
                                    workspace.issue_labels[group_name]["children"][child_name] = label["id"]
                                else:
                                    print(f"    ✗ Failed to create label: {child_name}")
                                    results["errors"].append({"label": child_name, "error": "Unknown error"})
                                client.rate_limit_delay()
                            except Exception as e:
                                print(f"    ✗ Error creating label {child_name}: {e}")
                                results["errors"].append({"label": child_name, "error": str(e)})
                else:
                    results["labels_skipped"] += len(existing_children)
                continue

        # Group doesn't exist – create it
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
                    "teamId": team_id,
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
                        try:
                            child_result = client.execute(CREATE_ISSUE_LABEL_MUTATION, {
                                "name": child_name,
                                "parentId": group_id,
                                "teamId": team_id,
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
                            print(f"    ✗ Error creating label {child_name}: {e}")
                            results["errors"].append({"label": child_name, "error": str(e)})
                else:
                    print(f"  ✗ Failed to create group: {group_name}")
                    results["errors"].append({"group": group_name, "error": "Unknown error"})
                client.rate_limit_delay()
            except Exception as e:
                print(f"  ✗ Error creating group {group_name}: {e}")
                results["errors"].append({"group": group_name, "error": str(e)})

    if dry_run:
        print(f"\n  [DRY RUN] Would create {results['groups_created']} groups, {results['labels_created']} labels")
    else:
        print(f"\n  Created {results['groups_created']} groups, {results['labels_created']} labels")
        print(f"  Skipped {results['groups_skipped']} existing groups, {results['labels_skipped']} existing labels")

    return results
