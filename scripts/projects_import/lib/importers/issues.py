"""Issue importer for Linear."""

import re

from ..client import LinearClient
from ..discovery import WorkspaceConfig, get_team_state_id
from ..utils import truncate_name, parse_date, normalize_status, normalize_priority, parse_estimate, priority_from_ranking, strip_html_tags, MAX_ISSUE_TITLE_LENGTH

CREATE_ISSUE_MUTATION = """
mutation CreateIssue(
  $title: String!,
  $description: String,
  $teamId: String!,
  $projectId: String,
  $parentId: String,
  $projectMilestoneId: String,
  $stateId: String,
  $priority: Int,
  $assigneeId: String,
  $dueDate: TimelessDate,
  $estimate: Int,
  $cycleId: String,
  $templateId: String,
  $labelIds: [String!]
) {
  issueCreate(input: {
    title: $title,
    description: $description,
    teamId: $teamId,
    projectId: $projectId,
    parentId: $parentId,
    projectMilestoneId: $projectMilestoneId,
    stateId: $stateId,
    priority: $priority,
    assigneeId: $assigneeId,
    dueDate: $dueDate,
    estimate: $estimate,
    cycleId: $cycleId,
    templateId: $templateId,
    labelIds: $labelIds
  }) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}
"""

CREATE_ISSUE_LINK_MUTATION = """
mutation CreateIssueLink($issueId: String!, $url: String!, $title: String!) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
    success
    attachment {
      id
    }
  }
}
"""

CREATE_ISSUE_RELATION_MUTATION = """
mutation CreateIssueRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: {
    issueId: $issueId,
    relatedIssueId: $relatedIssueId,
    type: $type
  }) {
    success
    issueRelation {
      id
    }
  }
}
"""

CREATE_PROJECT_RELATION_MUTATION = """
mutation CreateProjectRelation($projectId: String!, $relatedProjectId: String!, $type: String!, $anchorType: String!, $relatedAnchorType: String!) {
  projectRelationCreate(input: {
    projectId: $projectId,
    relatedProjectId: $relatedProjectId,
    type: $type,
    anchorType: $anchorType,
    relatedAnchorType: $relatedAnchorType
  }) {
    success
    projectRelation {
      id
    }
  }
}
"""

UPDATE_ISSUE_LABELS_MUTATION = """
mutation UpdateIssueLabels($id: String!, $labelIds: [String!]!) {
  issueUpdate(id: $id, input: {
    labelIds: $labelIds
  }) {
    success
  }
}
"""


def import_issues(
    client: LinearClient,
    issues: list,
    workspace: WorkspaceConfig,
    config: dict,
    project_map: dict,
    dry_run: bool = False,
    batch_size: int = None,
) -> dict:
    """Import issues into Linear."""
    
    results = {
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "errors": [],
        "created_issues": {},  # entity_uuid -> linear issue id (for relations)
    }

    issues_config = config.get("issues", {})

    # Apply batch limit
    if batch_size:
        issues = issues[:batch_size]
        print(f"\n🔢 Batch mode: Processing {len(issues)} issues")

    total = len(issues)
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Importing {total} issues...\n")

    for i, issue_data in enumerate(issues, 1):
        full_title = issue_data["title"]
        if not full_title or not full_title.strip():
            continue
            
        title = truncate_name(full_title, MAX_ISSUE_TITLE_LENGTH)
        display_title = title[:50] + "..." if len(title) > 50 else title
        
        source_file = issue_data.get("source_file", "unknown")
        print(f"[{i}/{total}] {display_title}")
        if source_file and source_file != "unknown":
            print(f"  📁 Source: {source_file}")

        # Get project ID - from issue data or project_map
        project_id = issue_data.get("project_id")
        project_name = issue_data.get("project")
        if not project_id and project_name:
            project_id = project_map.get(project_name)
        
        # Skip if project doesn't exist and we need one
        if project_name and not project_id:
            print(f"  ⚠️ Project not found: {project_name}")
        
        # Handle "dry-run" project references (can't link in dry run)
        if project_id and (project_id == "dry-run" or str(project_id).startswith("dry-run")):
            project_id = None

        # Check for duplicate - works for both existing and newly created projects
        if project_id:
            existing_in_project = workspace.existing_issues.get(project_id, {})
            existing_issue_id = existing_in_project.get(full_title.strip().lower())
            if existing_issue_id:
                print(f"  ⏭ Skipped (already exists in project)")
                results["skipped"] += 1
                # Still track for relations
                entity_uuid = issue_data.get("entity_uuid")
                if entity_uuid:
                    results["created_issues"][entity_uuid] = existing_issue_id
                # Update labels on the existing issue if we have labels to apply
                label_ids = issue_data.get("label_ids")
                if label_ids and not dry_run and existing_issue_id != "dry-run":
                    try:
                        result = client.execute(UPDATE_ISSUE_LABELS_MUTATION, {
                            "id": existing_issue_id,
                            "labelIds": label_ids,
                        })
                        if result.get("issueUpdate", {}).get("success"):
                            print(f"    🏷️  Updated {len(label_ids)} label(s)")
                        client.rate_limit_delay()
                    except Exception as e:
                        print(f"    ⚠️ Label update failed: {str(e)[:60]}")
                elif label_ids and dry_run:
                    print(f"    → Would update {len(label_ids)} label(s)")
                continue

        # Determine team ID (per-issue or workspace default)
        team_id = issue_data.get("team_id") or workspace.target_team_id

        if dry_run:
            assignee = issue_data.get("assignee", "None")
            assignee_id = issue_data.get("assignee_id")
            assignee_status = "" if not assignee or assignee == "None" else (" ✓" if assignee_id else " ⚠️ NOT FOUND")
            state = issue_data.get("state_name") or issue_data.get("state", "None")
            external_link = issue_data.get("external_link")
            link_info = f", Link: {external_link[:40]}..." if external_link else ""
            team_display = issue_data.get("team_name", "default")
            project_display = project_name or issue_data.get("project_name", "None")
            extra_display = ""
            if issue_data.get("parent_issue_id"):
                extra_display = f", Sub-issue of: {issue_data.get('parent_issue_name', '?')[:30]}"
            if issue_data.get("project_milestone_id"):
                extra_display = f", Milestone: {issue_data.get('milestone_name', '?')[:30]}"
            print(f"  → Project: {project_display}, Team: {team_display}{extra_display}")
            print(f"  → Assignee: {assignee}{assignee_status}, State: {state}{link_info}")
            if issue_data.get("label_ids"):
                print(f"  → Labels: {len(issue_data['label_ids'])} label(s)")
            for url in issue_data.get("extracted_links", []):
                print(f"  → Extracted link: {url[:70]}")
            results["success"] += 1
            entity_uuid = issue_data.get("entity_uuid")
            if entity_uuid:
                results["created_issues"][entity_uuid] = "dry-run"
            continue

        if not team_id:
            print(f"  ✗ No team ID available")
            results["failed"] += 1
            results["errors"].append({"issue": full_title, "error": "No team ID"})
            continue

        try:
            variables = {
                "title": title,
                "teamId": team_id,
            }
            
            # Description
            description_parts = []
            if full_title != title:
                description_parts.append(f"**Full Title:** {full_title}")
            if issue_data.get("description"):
                description_parts.append(issue_data["description"])
            if issue_data.get("dependencies"):
                description_parts.append(f"**Dependencies:** {issue_data['dependencies']}")
            if description_parts:
                variables["description"] = "\n\n".join(description_parts)
            
            if project_id:
                variables["projectId"] = project_id
            
            parent_issue_id = issue_data.get("parent_issue_id")
            if parent_issue_id and parent_issue_id != "dry-run":
                variables["parentId"] = parent_issue_id
            
            milestone_id = issue_data.get("project_milestone_id")
            if milestone_id and milestone_id != "dry-run" and project_id:
                variables["projectMilestoneId"] = milestone_id
            
            # Resolve state ID - per-team if needed
            state_id = issue_data.get("state_id")
            if not state_id and issue_data.get("state_name") and team_id:
                state_id = get_team_state_id(client, workspace, team_id, issue_data["state_name"])
            if state_id:
                variables["stateId"] = state_id
            
            if issue_data.get("priority") is not None:
                variables["priority"] = issue_data["priority"]
            if issue_data.get("assignee_id"):
                variables["assigneeId"] = issue_data["assignee_id"]
            if issue_data.get("due_date"):
                variables["dueDate"] = issue_data["due_date"]
            if issue_data.get("estimate") and int(issue_data["estimate"]) > 0:
                variables["estimate"] = int(issue_data["estimate"])
            if issue_data.get("cycle_id"):
                variables["cycleId"] = issue_data["cycle_id"]
            if workspace.issue_template_id:
                variables["templateId"] = workspace.issue_template_id
            label_ids = issue_data.get("label_ids")
            if label_ids:
                variables["labelIds"] = label_ids

            result = client.execute(CREATE_ISSUE_MUTATION, variables)

            issue_result = result.get("issueCreate", {})
            if issue_result.get("success"):
                issue = issue_result.get("issue", {})
                issue_id = issue.get("id")
                print(f"  ✓ Created: {issue.get('identifier')} - {issue.get('url')}")
                results["success"] += 1
                
                # Track UUID mapping for relations
                entity_uuid = issue_data.get("entity_uuid")
                if entity_uuid and issue_id:
                    results["created_issues"][entity_uuid] = issue_id
                
                # Add link attachment if external link exists
                external_link = issue_data.get("external_link")
                link_title = issue_data.get("link_title", None)
                if external_link and issue_id:
                    try:
                        add_issue_link(client, issue_id, external_link, title=link_title)
                        print(f"    📎 Added link: {link_title or 'Link'}")
                    except Exception as link_error:
                        print(f"    ⚠️ Link failed: {str(link_error)[:60]}")

                # Attach URLs extracted from the title field
                for idx, url in enumerate(issue_data.get("extracted_links", []), 1):
                    try:
                        add_issue_link(client, issue_id, url, title=f"Reference {idx}")
                        print(f"    📎 Added extracted link: {url[:60]}")
                    except Exception as link_error:
                        print(f"    ⚠️ Extracted link failed: {str(link_error)[:60]}")
                
                # Add to existing issues to prevent duplicates within same run
                if project_id:
                    if project_id not in workspace.existing_issues:
                        workspace.existing_issues[project_id] = {}
                    workspace.existing_issues[project_id][full_title.strip().lower()] = issue_id
            else:
                print(f"  ✗ Failed (unknown error)")
                results["failed"] += 1

            client.rate_limit_delay()

        except Exception as e:
            error_msg = str(e)
            print(f"  ✗ Error: {error_msg}")
            results["failed"] += 1
            results["errors"].append({"issue": full_title, "error": error_msg})

    return results


def add_issue_link(client: LinearClient, issue_id: str, url: str, title: str = None):
    """Add a link attachment to an issue."""
    if not title:
        # Extract title from URL
        if "jira" in url.lower() or "atlassian" in url.lower():
            title = "JIRA"
        else:
            title = "External Link"
    
    client.execute(CREATE_ISSUE_LINK_MUTATION, {
        "issueId": issue_id,
        "url": url,
        "title": title,
    })


def prepare_issues_from_hierarchical(
    subfeature_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
    uuid_to_project: dict,
) -> list:
    """Prepare issue data from hierarchical CSV rows (Subfeatures).
    
    Each row with entity_type=Subfeature becomes an issue.
    Parent Feature UUID is used to link to the correct project.
    Team assignment is per-issue from the Owning Eng Team column.
    """
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    team_config = config.get("team", {})
    hierarchy = config.get("hierarchy", {})
    
    # Column mappings
    title_col = columns.get("title", "entity_name")
    desc_col = columns.get("description")
    assignee_col = columns.get("assignee")
    status_col = columns.get("status")
    due_date_col = columns.get("due_date")
    ranking_col = columns.get("ranking")
    link_col = columns.get("link")
    link_title = columns.get("link_title", "External Link")
    team_list_col = columns.get("team_list")
    parent_name_col = columns.get("parent_name", "parent_name")
    description_extras = issues_config.get("description_extras", [])
    
    # Hierarchy columns
    entity_uuid_col = hierarchy.get("entity_uuid_column", "entity_uuid")
    parent_uuid_col = hierarchy.get("parent_uuid_column", "parent_entity_uuid")
    
    # Team column
    team_col = team_config.get("team_column")
    fallback_team = team_config.get("fallback_team_name")
    
    # Config maps
    status_map = issues_config.get("status_map", {})
    priority_ranges = issues_config.get("priority_ranges", [])
    default_priority = issues_config.get("default_priority", 0)
    static_labels = issues_config.get("static_labels", [])
    
    # Resolve static label IDs (standalone labels applied to every issue)
    static_label_ids = []
    for sl_name in static_labels:
        label_info = workspace.issue_labels.get(sl_name)
        if label_info and not label_info.get("isGroup"):
            static_label_ids.append(label_info["id"])
    
    issues = []
    
    for row in subfeature_rows:
        title = row.get(title_col, "").strip()
        if not title:
            continue
        
        entity_uuid = row.get(entity_uuid_col, "").strip()
        parent_uuid = row.get(parent_uuid_col, "").strip()
        
        # Resolve project from parent UUID
        project_id = uuid_to_project.get(parent_uuid)
        parent_name = row.get(parent_name_col, "").strip() if parent_name_col else ""
        
        # Resolve team
        team_name = row.get(team_col, "").strip() if team_col else ""
        team_id = None
        if team_name:
            team_id = workspace.teams_by_name.get(team_name.lower())
        if not team_id and fallback_team:
            team_id = workspace.teams_by_name.get(fallback_team.lower())
            if team_id and team_name:
                team_name = f"{team_name} → {fallback_team}"
            elif team_id:
                team_name = fallback_team
        
        # Resolve assignee (email-based matching)
        assignee = row.get(assignee_col, "").strip() if assignee_col else ""
        assignee_id = None
        if assignee:
            from .projects import resolve_user_id
            assignee_id = resolve_user_id(assignee, workspace)
            if not assignee_id:
                if not hasattr(workspace, '_unmatched_assignees'):
                    workspace._unmatched_assignees = set()
                workspace._unmatched_assignees.add(assignee)
        
        # Resolve status (store name for per-team resolution during import)
        status_value = row.get(status_col, "").strip() if status_col else ""
        state_name = None
        if status_value and status_map:
            state_name = status_map.get(status_value, status_value)
        
        # Build description: base content first, then metadata
        desc_parts = []
        if desc_col:
            base_desc = row.get(desc_col, "").strip()
            if base_desc:
                desc_parts.append(strip_html_tags(base_desc))
        
        meta_parts = []
        team_list = row.get(team_list_col, "").strip() if team_list_col else ""
        if team_list:
            meta_parts.append(f"**Contributing Teams:** {team_list}")
        
        for extra in description_extras:
            col_name = extra.get("column")
            label_text = extra.get("label", col_name)
            val = row.get(col_name, "").strip()
            if val:
                meta_parts.append(f"**{label_text}:** {val}")
        
        if meta_parts:
            desc_parts.append("---\n" + "\n".join(meta_parts) if desc_parts else "\n".join(meta_parts))
        
        # Link - as attachment
        link_url = row.get(link_col, "").strip() if link_col else ""
        external_link = link_url if link_url and link_url.startswith("http") else None
        
        issues.append({
            "title": title,
            "entity_uuid": entity_uuid,
            "project": parent_name,
            "project_id": project_id,
            "project_name": parent_name,
            "team_id": team_id,
            "team_name": team_name,
            "assignee": assignee,
            "assignee_id": assignee_id,
            "due_date": parse_date(row.get(due_date_col, "") if due_date_col else ""),
            "state_name": state_name,
            "state_id": None,
            "priority": priority_from_ranking(row.get(ranking_col, "") if ranking_col else "", priority_ranges, default_priority),
            "estimate": None,
            "external_link": external_link,
            "link_title": link_title,
            "description": "\n\n".join(desc_parts) if desc_parts else None,
            "dependencies": None,
            "cycle_id": None,
            "source_file": None,
            "label_ids": list(static_label_ids) if static_label_ids else None,
        })
    
    return issues


def create_issue_relations(
    client: LinearClient,
    all_csv_data: list,
    entity_uuid_col: str,
    blocking_col: str,
    separator: str,
    uuid_to_linear: dict,
    dry_run: bool = False,
) -> dict:
    """Create blocking relations between issues and between projects.
    
    uuid_to_linear maps source UUIDs to (type, linear_id) tuples where
    type is ``"issue"`` or ``"project"``.  Same-type pairs are created as
    blocking relations; cross-type pairs (project↔issue) are skipped.
    """
    results = {
        "created": 0,
        "skipped": 0,
        "errors": [],
    }
    
    print("\n🔗 Creating blocking relations...")
    
    issue_relations = []
    project_relations = []
    
    for row in all_csv_data:
        source_uuid = row.get(entity_uuid_col, "").strip()
        blocking_ids = row.get(blocking_col, "").strip()
        
        if not source_uuid or not blocking_ids:
            continue
        
        target_uuids = [u.strip() for u in blocking_ids.split(separator) if u.strip()]
        
        source_info = uuid_to_linear.get(source_uuid)
        if not source_info or source_info[1] is None:
            continue
        
        source_type, source_id = source_info
        
        for target_uuid in target_uuids:
            target_info = uuid_to_linear.get(target_uuid)
            if not target_info or target_info[1] is None:
                results["skipped"] += 1
                continue
            
            target_type, target_id = target_info

            if source_type == "issue" and target_type == "issue":
                issue_relations.append((source_id, target_id))
            elif source_type == "project" and target_type == "project":
                project_relations.append((source_id, target_id))
            else:
                results["skipped"] += 1
    
    if not issue_relations and not project_relations:
        print("  No blocking relations found")
        return results
    
    if issue_relations:
        print(f"  Found {len(issue_relations)} issue relations to create")
    if project_relations:
        print(f"  Found {len(project_relations)} project relations to create")
    
    for source_id, target_id in issue_relations:
        if dry_run:
            print(f"  → Would create issue relation: {source_id[:8]}... blocks {target_id[:8]}...")
            results["created"] += 1
            continue
        
        try:
            result = client.execute(CREATE_ISSUE_RELATION_MUTATION, {
                "issueId": source_id,
                "relatedIssueId": target_id,
                "type": "blocks",
            })
            if result.get("issueRelationCreate", {}).get("success"):
                results["created"] += 1
            else:
                results["errors"].append({"error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            results["errors"].append({"error": str(e)})

    for source_id, target_id in project_relations:
        if dry_run:
            print(f"  → Would create project relation: {source_id[:8]}... blocks {target_id[:8]}...")
            results["created"] += 1
            continue

        try:
            result = client.execute(CREATE_PROJECT_RELATION_MUTATION, {
                "projectId": source_id,
                "relatedProjectId": target_id,
                "type": "dependency",
                "anchorType": "end",
                "relatedAnchorType": "start",
            })
            if result.get("projectRelationCreate", {}).get("success"):
                results["created"] += 1
            else:
                results["errors"].append({"error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            results["errors"].append({"error": str(e)})
    
    print(f"  Created {results['created']} relations, skipped {results['skipped']}")
    if results["errors"]:
        print(f"  ⚠️  {len(results['errors'])} errors")
    
    return results


def _extract_title_and_urls(raw_title: str) -> tuple:
    """Split a multiline title cell into (clean_title, [urls]).

    Many spreadsheets embed ticket URLs on lines below the task name.
    This extracts them so the title stays clean and URLs can be attached
    as link resources on the issue.
    """
    lines = raw_title.split('\n')
    title_lines = []
    urls = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if re.match(r'https?://\S+$', stripped):
            urls.append(stripped)
        else:
            title_lines.append(stripped)

    title = title_lines[0] if title_lines else raw_title.strip().split('\n')[0].strip()
    return title, urls


def prepare_issues_from_csv(csv_data: list, config: dict, workspace: WorkspaceConfig) -> list:
    """Prepare issue data from CSV rows."""
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    status_map = issues_config.get("status_map", {})
    priority_map = issues_config.get("priority_map", {})
    description_extras = issues_config.get("description_extras", [])
    label_groups = issues_config.get("label_groups", [])
    extract_urls = issues_config.get("extract_urls_from_title", False)

    # Resolve a fixed target project (all issues go to one existing project)
    target_project_name = issues_config.get("target_project")
    target_project_id = None
    if target_project_name:
        target_project_id = workspace.existing_projects.get(target_project_name.strip().lower())
        if target_project_id:
            print(f"  Target project resolved: '{target_project_name}' -> {target_project_id}")
        else:
            print(f"  ⚠️  Target project '{target_project_name}' not found in workspace")
    
    issues = []
    
    for row in csv_data:
        # Get title (with optional URL extraction)
        title_col = columns.get("title", "Task")
        raw_title = row.get(title_col, "").strip()
        if not raw_title:
            continue

        extracted_links = []
        if extract_urls and '\n' in raw_title:
            title, extracted_links = _extract_title_and_urls(raw_title)
        else:
            title = raw_title
        
        # Get project name
        project_col = columns.get("project", "Project")
        project = row.get(project_col, "").strip()
        
        # Get assignee
        assignee_col = columns.get("assignee", "Assigned")
        assignee = row.get(assignee_col, "").strip()
        assignee_id = None
        assignee_matched = False
        assignee_map = issues_config.get("assignee_map", {})
        
        if assignee:
            # First check manual assignee_map from config
            mapped_assignee = assignee_map.get(assignee) or assignee_map.get(assignee.lower())
            if mapped_assignee:
                assignee_id = workspace.users.get(mapped_assignee) or workspace.users.get(mapped_assignee.lower())
                if assignee_id:
                    assignee_matched = True
            
            # Try exact match (case-insensitive)
            if not assignee_matched:
                assignee_id = workspace.users.get(assignee) or workspace.users.get(assignee.lower())
                if assignee_id:
                    assignee_matched = True
            
            # Try partial match on user names
            if not assignee_matched:
                assignee_lower = assignee.lower()
                assignee_no_spaces = assignee_lower.replace(" ", "")
                
                for user_name, user_id in workspace.users.items():
                    user_name_lower = user_name.lower()
                    # Standard partial matching
                    if assignee_lower in user_name_lower or user_name_lower in assignee_lower:
                        assignee_id = user_id
                        assignee_matched = True
                        break
                    # Try matching name without spaces (e.g., "Jane Doe" -> "janedoe")
                    if assignee_no_spaces == user_name_lower.replace(" ", ""):
                        assignee_id = user_id
                        assignee_matched = True
                        break
            
            # Track unmatched assignees for reporting
            if not assignee_matched:
                if not hasattr(workspace, '_unmatched_assignees'):
                    workspace._unmatched_assignees = set()
                workspace._unmatched_assignees.add(assignee)
        
        # Get due date
        due_date_col = columns.get("due_date", "Target Date")
        due_date = parse_date(row.get(due_date_col, ""))
        
        # Get status/state
        status_col = columns.get("status", "Status")
        status_value = row.get(status_col, "").strip()
        state_name = normalize_status(status_value, status_map)
        state_id = workspace.issue_states.get(state_name) if state_name else None
        
        # Get priority
        priority_col = columns.get("priority", "Priority")
        priority_value = row.get(priority_col, "").strip()
        priority = normalize_priority(priority_value, priority_map)
        
        # Get estimate
        estimate_col = columns.get("estimate", "Story Points")
        estimate = parse_estimate(row.get(estimate_col, ""))
        
        # Get external link
        link_col = columns.get("external_link", "JIRA")
        external_link = row.get(link_col, "").strip()
        if external_link and not external_link.startswith("http"):
            external_link = None  # Skip invalid URLs
        
        # Build description: base column + extras
        desc_col = columns.get("description", "Remarks")
        desc_parts = []
        base_desc = row.get(desc_col, "").strip()
        if base_desc:
            desc_parts.append(base_desc)
        for extra in description_extras:
            col_name = extra.get("column")
            label_text = extra.get("label", col_name)
            val = row.get(col_name, "").strip()
            if val:
                desc_parts.append(f"**{label_text}:** {val}")
        description = "\n\n".join(desc_parts) if desc_parts else ""
        
        # Get dependencies
        deps_col = columns.get("dependencies", "Dependencies")
        dependencies = row.get(deps_col, "").strip()
        
        # Get cycle
        cycle_col = columns.get("cycle", "Sprint")
        cycle_value = row.get(cycle_col, "").strip()
        cycle_id = workspace.cycles.get(cycle_value) if cycle_value else None

        # Resolve issue label IDs
        label_ids = []
        for lg in label_groups:
            group_name = lg.get("group_name")
            col = lg.get("column")
            value = row.get(col, "").strip()
            if value and group_name in workspace.issue_labels:
                children = workspace.issue_labels[group_name].get("children", {})
                if value in children:
                    label_ids.append(children[value])
        
        issues.append({
            "title": title,
            "project": project,
            "project_id": target_project_id,
            "assignee": assignee,
            "assignee_id": assignee_id,
            "due_date": due_date,
            "state": state_name,
            "state_id": state_id,
            "priority": priority,
            "estimate": estimate,
            "external_link": external_link,
            "description": description,
            "dependencies": dependencies,
            "cycle_id": cycle_id,
            "label_ids": label_ids or None,
            "extracted_links": extracted_links,
            "source_file": None,  # Will be set by caller if needed
        })
    
    return issues


def _resolve_assignee(row: dict, columns: dict, workspace: WorkspaceConfig) -> tuple:
    """Resolve assignee from email and/or name columns. Returns (display_name, user_id)."""
    from .projects import resolve_user_id

    email_col = columns.get("assignee_email", "Assignee Email")
    name_col = columns.get("assignee", "Assignee")
    email = row.get(email_col, "").strip()
    name = row.get(name_col, "").strip()

    # Try email first (more reliable), then name
    for candidate in [email, name]:
        if candidate:
            uid = resolve_user_id(candidate, workspace)
            if uid:
                return (name or email, uid)

    display = name or email or None
    if display:
        if not hasattr(workspace, "_unmatched_assignees"):
            workspace._unmatched_assignees = set()
        workspace._unmatched_assignees.add(display)
    return (display, None)


def _build_metadata_description(row: dict, columns: dict, base_notes: str = None) -> str:
    """Build issue/sub-issue description from notes + Asana metadata columns."""
    parts = []
    if base_notes:
        parts.append(base_notes)

    created_at = row.get(columns.get("created_at", "Created At"), "").strip()
    if created_at:
        parts.append(f"**Created:** {created_at}")

    last_modified = row.get(columns.get("last_modified", "Last Modified"), "").strip()
    if last_modified:
        parts.append(f"**Last Modified:** {last_modified}")

    asana_projects = row.get(columns.get("asana_projects", "Projects"), "").strip()
    if asana_projects:
        parts.append(f"**Asana Projects:** {asana_projects}")

    return "\n\n".join(parts) if parts else None


def prepare_issues_from_parent_task(
    child_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
    name_to_project_id: dict,
) -> list:
    """Prepare issue data from depth-1 rows in an Asana parent_task export.
    
    Each row whose Parent task is a top-level task becomes an issue linked
    to the corresponding project.
    """
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    completed_col = issues_config.get("completed_column", "Completed At")
    completed_state = issues_config.get("completed_state", "Done")
    default_state = issues_config.get("default_state", "Backlog")
    hierarchy = config.get("hierarchy", {})
    parent_col = hierarchy.get("parent_column", "Parent task")

    title_col = columns.get("title", "Name")
    due_date_col = columns.get("due_date", "Due Date")
    desc_col = columns.get("description", "Notes")

    issues = []

    for row in child_rows:
        title = row.get(title_col, "").strip()
        if not title:
            continue

        parent_name = row.get(parent_col, "").strip()
        project_id = name_to_project_id.get(parent_name)
        assignee_name, assignee_id = _resolve_assignee(row, columns, workspace)

        # Infer state from Completed At
        completed = row.get(completed_col, "").strip()
        state_name = completed_state if completed else default_state

        notes = row.get(desc_col, "").strip()
        description = _build_metadata_description(row, columns, notes or None)

        issues.append({
            "title": title,
            "task_name": title,
            "project": parent_name,
            "project_id": project_id,
            "project_name": parent_name,
            "parent_issue_id": None,
            "parent_issue_name": None,
            "team_id": None,
            "team_name": None,
            "assignee": assignee_name,
            "assignee_id": assignee_id,
            "due_date": parse_date(row.get(due_date_col, "")),
            "state_name": state_name,
            "state_id": None,
            "priority": 0,
            "estimate": None,
            "external_link": None,
            "link_title": None,
            "description": description,
            "dependencies": None,
            "cycle_id": None,
            "source_file": None,
        })

    return issues


def prepare_subissues_from_parent_task(
    grandchild_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
    name_to_issue_id: dict,
    name_to_project_id: dict,
    parent_name_to_project: dict,
) -> list:
    """Prepare sub-issue data from depth-2+ rows in an Asana parent_task export.
    
    Each grandchild row becomes a sub-issue using ``parentId`` to nest under
    its parent issue.  The project is inherited from the grandchild's
    top-level ancestor.
    """
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    completed_col = issues_config.get("completed_column", "Completed At")
    completed_state = issues_config.get("completed_state", "Done")
    default_state = issues_config.get("default_state", "Backlog")
    hierarchy = config.get("hierarchy", {})
    parent_col = hierarchy.get("parent_column", "Parent task")

    title_col = columns.get("title", "Name")
    due_date_col = columns.get("due_date", "Due Date")
    desc_col = columns.get("description", "Notes")

    issues = []

    for row in grandchild_rows:
        title = row.get(title_col, "").strip()
        if not title:
            continue

        parent_name = row.get(parent_col, "").strip()
        parent_issue_id = name_to_issue_id.get(parent_name)

        # Resolve project from the ancestor chain
        project_name = parent_name_to_project.get(parent_name, "")
        project_id = name_to_project_id.get(project_name)

        assignee_name, assignee_id = _resolve_assignee(row, columns, workspace)

        completed = row.get(completed_col, "").strip()
        state_name = completed_state if completed else default_state

        notes = row.get(desc_col, "").strip()
        description = _build_metadata_description(row, columns, notes or None)

        issues.append({
            "title": title,
            "task_name": title,
            "project": project_name,
            "project_id": project_id,
            "project_name": project_name,
            "parent_issue_id": parent_issue_id,
            "parent_issue_name": parent_name,
            "team_id": None,
            "team_name": None,
            "assignee": assignee_name,
            "assignee_id": assignee_id,
            "due_date": parse_date(row.get(due_date_col, "")),
            "state_name": state_name,
            "state_id": None,
            "priority": 0,
            "estimate": None,
            "external_link": None,
            "link_title": None,
            "description": description,
            "dependencies": None,
            "cycle_id": None,
            "source_file": None,
        })

    return issues


def prepare_milestone_issues_from_parent_task(
    grandchild_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
    name_to_milestone_id: dict,
    name_to_project_id: dict,
    parent_name_to_project: dict,
) -> list:
    """Prepare issue data from depth-2+ rows, linked to milestones.

    Instead of creating sub-issues under parent issues, each depth-2+ row
    becomes a regular issue associated with its parent's milestone via
    ``projectMilestoneId``.
    """
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    completed_col = issues_config.get("completed_column", "Completed At")
    completed_state = issues_config.get("completed_state", "Done")
    default_state = issues_config.get("default_state", "Backlog")
    hierarchy = config.get("hierarchy", {})
    parent_col = hierarchy.get("parent_column", "Parent task")

    title_col = columns.get("title", "Name")
    due_date_col = columns.get("due_date", "Due Date")
    desc_col = columns.get("description", "Notes")

    issues = []

    for row in grandchild_rows:
        title = row.get(title_col, "").strip()
        if not title:
            continue

        parent_name = row.get(parent_col, "").strip()

        project_name = parent_name_to_project.get(parent_name, "")
        project_id = name_to_project_id.get(project_name)

        compound_key = (parent_name, project_name)
        milestone_id = name_to_milestone_id.get(compound_key)

        assignee_name, assignee_id = _resolve_assignee(row, columns, workspace)

        completed = row.get(completed_col, "").strip()
        state_name = completed_state if completed else default_state

        notes = row.get(desc_col, "").strip()
        description = _build_metadata_description(row, columns, notes or None)

        issues.append({
            "title": title,
            "task_name": title,
            "project": project_name,
            "project_id": project_id,
            "project_name": project_name,
            "project_milestone_id": milestone_id,
            "milestone_name": parent_name,
            "parent_issue_id": None,
            "parent_issue_name": None,
            "team_id": None,
            "team_name": None,
            "assignee": assignee_name,
            "assignee_id": assignee_id,
            "due_date": parse_date(row.get(due_date_col, "")),
            "state_name": state_name,
            "state_id": None,
            "priority": 0,
            "estimate": None,
            "external_link": None,
            "link_title": None,
            "description": description,
            "dependencies": None,
            "cycle_id": None,
            "source_file": None,
        })

    return issues


def create_name_based_relations(
    client: LinearClient,
    all_rows: list,
    name_col: str,
    blocking_col: str,
    separator: str,
    name_to_linear_id: dict,
    dry_run: bool = False,
) -> dict:
    """Create blocking relations where dependencies reference task names.
    
    ``name_to_linear_id`` maps task name -> Linear issue ID for all created
    issues and sub-issues.
    """
    results = {"created": 0, "skipped": 0, "errors": []}

    print("\n🔗 Creating blocking relations (name-based)...")

    relations_to_create = []
    for row in all_rows:
        source_name = row.get(name_col, "").strip()
        deps_raw = row.get(blocking_col, "").strip()
        if not source_name or not deps_raw:
            continue

        source_id = name_to_linear_id.get(source_name)
        if not source_id:
            continue

        dep_names = [d.strip() for d in deps_raw.split(separator) if d.strip()]
        for dep_name in dep_names:
            dep_id = name_to_linear_id.get(dep_name)
            if not dep_id:
                results["skipped"] += 1
                continue
            # dep blocks source  (source is blocked by dep)
            relations_to_create.append((dep_id, source_id, dep_name, source_name))

    if not relations_to_create:
        print("  No resolvable blocking relations found")
        return results

    print(f"  Found {len(relations_to_create)} relations to create")

    for blocker_id, blocked_id, blocker_name, blocked_name in relations_to_create:
        if dry_run:
            print(f"  → \"{blocker_name[:35]}\" blocks \"{blocked_name[:35]}\"")
            results["created"] += 1
            continue

        if blocker_id == "dry-run" or blocked_id == "dry-run":
            results["skipped"] += 1
            continue

        try:
            result = client.execute(CREATE_ISSUE_RELATION_MUTATION, {
                "issueId": blocker_id,
                "relatedIssueId": blocked_id,
                "type": "blocks",
            })
            if result.get("issueRelationCreate", {}).get("success"):
                results["created"] += 1
            else:
                results["errors"].append({"error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            results["errors"].append({"error": str(e)})

    print(f"  Created {results['created']} relations, skipped {results['skipped']}")
    if results["errors"]:
        print(f"  ⚠️  {len(results['errors'])} errors")

    return results
