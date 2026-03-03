"""Project importer for Linear."""

from ..client import LinearClient
from ..discovery import WorkspaceConfig
from ..utils import truncate_name, parse_date, normalize_status, normalize_priority, priority_from_ranking, MAX_PROJECT_NAME_LENGTH

CREATE_PROJECT_MUTATION = """
mutation CreateProject(
  $name: String!,
  $description: String,
  $teamIds: [String!]!,
  $statusId: String,
  $priority: Int,
  $startDate: TimelessDate,
  $targetDate: TimelessDate,
  $labelIds: [String!],
  $templateId: String,
  $leadId: String
) {
  projectCreate(input: {
    name: $name,
    description: $description,
    teamIds: $teamIds,
    statusId: $statusId,
    priority: $priority,
    startDate: $startDate,
    targetDate: $targetDate,
    labelIds: $labelIds,
    templateId: $templateId,
    leadId: $leadId
  }) {
    success
    project {
      id
      name
      url
    }
  }
}
"""

UPDATE_PROJECT_MEMBERS_MUTATION = """
mutation UpdateProjectMembers($id: String!, $memberIds: [String!]!) {
  projectUpdate(id: $id, input: {
    memberIds: $memberIds
  }) {
    success
  }
}
"""

GET_PROJECT_TEAMS_QUERY = """
query GetProjectTeams($id: String!) {
  project(id: $id) {
    id
    teams {
      nodes {
        id
      }
    }
  }
}
"""

UPDATE_PROJECT_TEAMS_MUTATION = """
mutation UpdateProjectTeams($id: String!, $teamIds: [String!]!) {
  projectUpdate(id: $id, input: {
    teamIds: $teamIds
  }) {
    success
  }
}
"""

UPDATE_PROJECT_LEAD_MUTATION = """
mutation UpdateProjectLead($id: String!, $leadId: String!) {
  projectUpdate(id: $id, input: {
    leadId: $leadId
  }) {
    success
  }
}
"""

CREATE_PROJECT_UPDATE_MUTATION = """
mutation CreateProjectUpdate(
  $projectId: String!,
  $body: String!,
  $health: ProjectUpdateHealthType
) {
  projectUpdateCreate(input: {
    projectId: $projectId,
    body: $body,
    health: $health
  }) {
    success
    projectUpdate {
      id
    }
  }
}
"""

FETCH_PROJECT_MILESTONES_QUERY = """
query FetchProjectMilestones($projectId: String!) {
  project(id: $projectId) {
    projectMilestones {
      nodes {
        id
        name
      }
    }
  }
}
"""

CREATE_PROJECT_MILESTONE_MUTATION = """
mutation CreateProjectMilestone(
  $name: String!,
  $projectId: String!,
  $description: String,
  $targetDate: TimelessDate
) {
  projectMilestoneCreate(input: {
    name: $name,
    projectId: $projectId,
    description: $description,
    targetDate: $targetDate
  }) {
    success
    projectMilestone {
      id
      name
    }
  }
}
"""

CREATE_PROJECT_LINK_MUTATION = """
mutation CreateProjectLink($url: String!, $label: String!, $projectId: String!) {
  entityExternalLinkCreate(input: {
    url: $url,
    label: $label,
    projectId: $projectId
  }) {
    success
    entityExternalLink {
      id
    }
  }
}
"""


def _update_existing_project(client: LinearClient, project_id: str, project_data: dict, target_team_id: str = None):
    """Update lead, members, links, and team association on an existing project."""
    # Ensure the target team is associated with the project so issues can be linked
    if target_team_id:
        try:
            result = client.execute(GET_PROJECT_TEAMS_QUERY, {"id": project_id})
            current_team_ids = {
                t["id"] for t in result.get("project", {}).get("teams", {}).get("nodes", [])
            }
            if target_team_id not in current_team_ids:
                all_team_ids = list(current_team_ids | {target_team_id})
                update_result = client.execute(UPDATE_PROJECT_TEAMS_MUTATION, {
                    "id": project_id,
                    "teamIds": all_team_ids,
                })
                if update_result.get("projectUpdate", {}).get("success"):
                    print(f"    🔗 Added target team to project")
        except Exception as e:
            print(f"    ⚠️ Team association failed: {str(e)[:60]}")

    lead_id = project_data.get("lead_id")
    if lead_id:
        try:
            result = client.execute(UPDATE_PROJECT_LEAD_MUTATION, {
                "id": project_id,
                "leadId": lead_id,
            })
            if result.get("projectUpdate", {}).get("success"):
                print(f"    👤 Updated lead: {project_data.get('lead')}")
        except Exception as e:
            print(f"    ⚠️ Lead update failed: {str(e)[:60]}")

    member_ids = project_data.get("member_ids", [])
    if member_ids:
        try:
            result = client.execute(UPDATE_PROJECT_MEMBERS_MUTATION, {
                "id": project_id,
                "memberIds": member_ids,
            })
            if result.get("projectUpdate", {}).get("success"):
                print(f"    👤 Updated {len(member_ids)} member(s)")
        except Exception as e:
            print(f"    ⚠️ Member update failed: {str(e)[:60]}")

    _add_external_links(client, project_id, project_data)


def _add_external_links(client: LinearClient, project_id: str, project_data: dict):
    """Add external links (single legacy + multi-column) to a project."""
    # Legacy single link
    link_url = project_data.get("link_url")
    if link_url:
        try:
            result = client.execute(CREATE_PROJECT_LINK_MUTATION, {
                "url": link_url,
                "label": project_data.get("link_title") or "External Link",
                "projectId": project_id,
            })
            if result.get("entityExternalLinkCreate", {}).get("success"):
                print(f"    🔗 Added link: {project_data.get('link_title') or 'Link'}")
        except Exception as e:
            print(f"    ⚠️ Link failed: {str(e)[:60]}")

    # Multi-column external links
    for link in project_data.get("external_links", []):
        try:
            result = client.execute(CREATE_PROJECT_LINK_MUTATION, {
                "url": link["url"],
                "label": link["label"],
                "projectId": project_id,
            })
            if result.get("entityExternalLinkCreate", {}).get("success"):
                print(f"    🔗 Added link: {link['label']}")
        except Exception as e:
            print(f"    ⚠️ Link failed: {str(e)[:60]}")


def import_projects(
    client: LinearClient,
    projects: list,
    workspace: WorkspaceConfig,
    config: dict,
    dry_run: bool = False,
    batch_size: int = None,
) -> dict:
    """Import projects into Linear."""
    
    results = {
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "errors": [],
        "created_projects": {},  # name -> id mapping for issue linking
    }

    project_config = config.get("projects", {})
    labels_config = config.get("labels", {})

    # Apply batch limit
    if batch_size:
        projects = projects[:batch_size]
        print(f"\n🔢 Batch mode: Processing {len(projects)} projects")

    total = len(projects)
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Importing {total} projects...\n")

    for i, project_data in enumerate(projects, 1):
        full_name = project_data["name"]
        name = truncate_name(full_name, MAX_PROJECT_NAME_LENGTH)
        display_name = name[:50] + "..." if len(name) > 50 else name
        
        source_file = project_data.get("source_file", "unknown")
        print(f"[{i}/{total}] {display_name}")
        print(f"  📁 Source: {source_file}")

        # Check for duplicate - get existing project ID if it exists
        existing_project_id = workspace.existing_projects.get(full_name.strip().lower())
        if existing_project_id:
            print(f"  ⏭ Skipped (already exists)")
            results["skipped"] += 1
            results["created_projects"][full_name] = existing_project_id
            if not dry_run:
                _update_existing_project(client, existing_project_id, project_data, target_team_id=workspace.target_team_id)
            continue

        # Build team IDs - use per-project teams if available, otherwise fall back to workspace defaults
        team_ids = []
        if project_data.get("team_ids"):
            # Use project-specific teams
            team_ids = list(project_data["team_ids"])
            # Also add parent team if configured
            if workspace.parent_team_id and workspace.parent_team_id not in team_ids:
                team_ids.insert(0, workspace.parent_team_id)
        else:
            # Fall back to workspace default teams
            if workspace.parent_team_id:
                team_ids.append(workspace.parent_team_id)
            if workspace.target_team_id and workspace.target_team_id not in team_ids:
                team_ids.append(workspace.target_team_id)

        # Build label IDs from various sources
        label_ids = []
        
        # Legacy single label group support
        if labels_config.get("group") and project_data.get("label"):
            label_group = workspace.project_labels.get(labels_config["group"], {})
            label_value = project_data["label"]
            # Apply value mapping if configured
            value_map = labels_config.get("value_map", {})
            if label_value in value_map:
                label_value = value_map[label_value]
            # Find label in group children
            children = label_group.get("children", {})
            if label_value in children:
                label_ids.append(children[label_value])

        # New: Multiple label groups support
        for label_data in project_data.get("label_ids", []):
            if label_data and label_data not in label_ids:
                label_ids.append(label_data)
        
        # New: Conditional labels support
        for cond_label_id in project_data.get("conditional_label_ids", []):
            if cond_label_id and cond_label_id not in label_ids:
                label_ids.append(cond_label_id)

        if dry_run:
            lead = project_data.get("lead", "None")
            lead_id = project_data.get("lead_id")
            lead_status = "" if not lead or lead == "None" else (" ✓" if lead_id else " ⚠️ NOT FOUND")
            members = project_data.get("members", [])
            member_ids = project_data.get("member_ids", [])
            health = project_data.get("health", "None")
            status = project_data.get("status", "None")
            team_name = project_data.get("team_name", "")
            
            # Show team assignment
            team_display = team_name if team_name else "(parent team)"
            if project_data.get("team_ids"):
                team_display += " ✓"
            elif team_name:
                team_display += " ⚠️ NOT FOUND → parent"
            
            print(f"  → Team: {team_display}, Labels: {len(label_ids)}")
            print(f"  → Lead: {lead}{lead_status}, Members: {len(members)} ({len(member_ids)} matched)")
            print(f"  → Health: {health}, Status: {status}")
            start = project_data.get("start_date")
            target = project_data.get("target_date")
            if start or target:
                print(f"  → Start: {start or '-'}, Target: {target or '-'}")
            
            if project_data.get("update_text"):
                update_preview = project_data["update_text"][:50] + "..." if len(project_data.get("update_text", "")) > 50 else project_data.get("update_text", "")
                print(f"  → Update: {update_preview}")
            
            if project_data.get("link_url"):
                print(f"  → Link: {project_data['link_title'] or 'Link'} ({project_data['link_url'][:50]}...)")
            for link in project_data.get("external_links", []):
                print(f"  → Link: {link['label']} ({link['url'][:60]}...)")
            
            results["success"] += 1
            results["created_projects"][full_name] = "dry-run"
            continue

        try:
            # Use project-specific description if provided, else use full name
            description = project_data.get("description") or full_name
            if full_name != name and full_name not in description:
                description = f"**Full Name:** {full_name}\n\n{description}"
            # Linear project description max is 255 characters
            if len(description) > 255:
                description = description[:252] + "..."
            
            variables = {
                "name": name,
                "description": description,
                "teamIds": team_ids,
            }
            
            if project_data.get("status_id"):
                variables["statusId"] = project_data["status_id"]
            if project_data.get("priority") is not None:
                variables["priority"] = project_data["priority"]
            if project_data.get("start_date"):
                variables["startDate"] = project_data["start_date"]
            if project_data.get("target_date"):
                variables["targetDate"] = project_data["target_date"]
            if label_ids:
                variables["labelIds"] = label_ids
            if workspace.project_template_id:
                variables["templateId"] = workspace.project_template_id
            if project_data.get("lead_id"):
                variables["leadId"] = project_data["lead_id"]

            result = client.execute(CREATE_PROJECT_MUTATION, variables)

            project_result = result.get("projectCreate", {})
            if project_result.get("success"):
                project = project_result.get("project", {})
                project_id = project.get("id")
                print(f"  ✓ Created: {project.get('url', project_id)}")
                results["success"] += 1
                results["created_projects"][full_name] = project_id
                # Add to existing projects to prevent duplicates within same run
                workspace.existing_projects[full_name.strip().lower()] = project_id
                
                # Add project members via projectUpdate
                member_ids = project_data.get("member_ids", [])
                if member_ids:
                    try:
                        add_member_result = client.execute(UPDATE_PROJECT_MEMBERS_MUTATION, {
                            "id": project_id,
                            "memberIds": member_ids
                        })
                        if add_member_result.get("projectUpdate", {}).get("success"):
                            print(f"    👤 Added {len(member_ids)} member(s)")
                    except Exception as member_error:
                        print(f"    ⚠️ Member add failed: {str(member_error)[:50]}")
                
                # Add external links as project resources
                _add_external_links(client, project_id, project_data)

                # Create project update if health or update text exists
                health = project_data.get("health")
                update_text = project_data.get("update_text")
                if health or update_text:
                    try:
                        # Body is required for project updates
                        body = update_text if update_text else f"Project status: {health}"
                        update_vars = {
                            "projectId": project_id,
                            "body": body
                        }
                        if health:
                            # Map health value to Linear enum
                            health_map = project_config.get("health_map", {
                                "On Track": "onTrack",
                                "At Risk": "atRisk", 
                                "Off Track": "offTrack"
                            })
                            linear_health = health_map.get(health)
                            if linear_health:
                                update_vars["health"] = linear_health
                        
                        update_result = client.execute(CREATE_PROJECT_UPDATE_MUTATION, update_vars)
                        if update_result.get("projectUpdateCreate", {}).get("success"):
                            print(f"    📊 Added project update (health: {health or 'N/A'})")
                    except Exception as update_error:
                        print(f"    ⚠️ Update failed: {str(update_error)[:50]}")
                
            else:
                print(f"  ✗ Failed (unknown error)")
                results["failed"] += 1

            client.rate_limit_delay()

        except Exception as e:
            error_msg = str(e)
            print(f"  ✗ Error: {error_msg}")
            results["failed"] += 1
            results["errors"].append({"project": full_name, "error": error_msg})

    return results


def prepare_projects_from_csv(csv_data: list, config: dict, workspace: WorkspaceConfig) -> list:
    """Prepare project data from CSV rows."""
    project_config = config.get("projects", {})
    columns = project_config.get("columns", {})
    
    # Get column mappings
    name_col = columns.get("name", project_config.get("source", "column:Project").replace("column:", ""))
    name_strip_prefix = project_config.get("name_strip_prefix", "")
    health_col = columns.get("health")
    lead_col = columns.get("lead")
    members_col = columns.get("members")
    status_col = columns.get("status")
    update_col = columns.get("update_text")
    team_col = columns.get("team")
    desc_col = columns.get("description")
    start_date_col = columns.get("start_date")
    target_date_col = columns.get("target_date")
    description_extras = project_config.get("description_extras", [])
    lead_separator = project_config.get("lead_separator")
    
    # Get team mapping config
    team_map = project_config.get("team_map", {})
    
    # Get label group configs
    label_groups = project_config.get("label_groups", [])
    conditional_labels = project_config.get("conditional_labels", [])
    status_map = project_config.get("status_map", {})
    
    # Track unmatched users
    unmatched_leads = set()
    unmatched_members = set()
    
    # Build projects - each row is a separate project
    projects = []
    seen_names = set()
    
    for row in csv_data:
        # Get project name
        raw_name = row.get(name_col, "").strip()
        if not raw_name:
            continue
        
        # Strip prefix if configured
        name = raw_name
        if name_strip_prefix and name.startswith(name_strip_prefix):
            name = name[len(name_strip_prefix):].strip()
        
        # Skip duplicates within CSV
        if name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        
        project = {
            "name": name,
            "priority": 0,
            "status_id": None,
            "start_date": None,
            "target_date": None,
            "label": None,
            "label_ids": [],
            "conditional_label_ids": [],
            "lead": None,
            "lead_id": None,
            "members": [],
            "member_ids": [],
            "health": None,
            "update_text": None,
            "status": None,
            "team_ids": [],  # Per-project team assignment
            "team_name": None,  # For display
        }
        
        # Resolve team from column
        if team_col:
            team_value = row.get(team_col, "").strip()
            project["team_name"] = team_value
            if team_value:
                # Try to map through team_map first
                team_key = team_map.get(team_value)
                if team_key and team_key in workspace.teams:
                    team_info = workspace.teams[team_key]
                    project["team_ids"].append(team_info["id"])
                else:
                    # Try to find team by name directly
                    for key, info in workspace.teams.items():
                        if info["name"].lower() == team_value.lower():
                            project["team_ids"].append(info["id"])
                            break
        
        # Get health
        if health_col:
            project["health"] = row.get(health_col, "").strip()
        
        # Get lead and resolve to user ID
        if lead_col:
            lead_raw = row.get(lead_col, "").strip()
            if lead_raw:
                sep = lead_separator or ("\n" if "\n" in lead_raw else None)
                if sep:
                    parts = [p.strip() for p in lead_raw.split(sep) if p.strip()]
                else:
                    parts = [lead_raw]
                lead = parts[0]
                project["lead"] = lead
                lead_id = resolve_user_id(lead, workspace)
                if lead_id:
                    project["lead_id"] = lead_id
                else:
                    unmatched_leads.add(lead)
                for extra_poc in parts[1:]:
                    project["members"].append(extra_poc)
                    member_id = resolve_user_id(extra_poc, workspace)
                    if member_id:
                        project["member_ids"].append(member_id)
                    else:
                        unmatched_members.add(extra_poc)
        
        # Get members and resolve to user IDs
        if members_col:
            members_raw = row.get(members_col, "").strip()
            if members_raw:
                # Split by newlines or spaces (for multiple names)
                members = []
                for part in members_raw.replace("\n", " ").split(" "):
                    part = part.strip()
                    if part and len(part) > 2:  # Filter out initials
                        members.append(part)
                
                # Try to parse as full names
                if len(members) >= 2:
                    # Check if it looks like "FirstName LastName" pairs
                    parsed_members = []
                    i = 0
                    while i < len(members):
                        if i + 1 < len(members):
                            # Check if this could be "FirstName LastName"
                            potential_name = f"{members[i]} {members[i+1]}"
                            if resolve_user_id(potential_name, workspace):
                                parsed_members.append(potential_name)
                                i += 2
                                continue
                        parsed_members.append(members[i])
                        i += 1
                    members = parsed_members
                
                for member in members:
                    project["members"].append(member)
                    member_id = resolve_user_id(member, workspace)
                    if member_id:
                        project["member_ids"].append(member_id)
                    else:
                        unmatched_members.add(member)
        
        # Get status and map to status ID
        if status_col:
            status = row.get(status_col, "").strip()
            project["status"] = status
            if status:
                # Try direct mapping first
                mapped_status = status_map.get(status, status)
                if mapped_status in workspace.project_statuses:
                    project["status_id"] = workspace.project_statuses[mapped_status]
        
        # Get update text
        if update_col:
            project["update_text"] = row.get(update_col, "").strip()
        
        # Resolve label groups
        for lg in label_groups:
            group_name = lg.get("group_name")
            col = lg.get("column")
            value = row.get(col, "").strip()
            
            if value and group_name in workspace.project_labels:
                label_group = workspace.project_labels[group_name]
                children = label_group.get("children", {})
                if value in children:
                    project["label_ids"].append(children[value])
        
        # Resolve conditional labels
        for cl in conditional_labels:
            col = cl.get("column")
            true_value = cl.get("true_value", "TRUE")
            label_name = cl.get("label_name")
            
            cell_value = row.get(col, "").strip()
            if cell_value.upper() == true_value.upper():
                # Look for the label in project_labels
                if label_name in workspace.project_labels:
                    label_info = workspace.project_labels[label_name]
                    if not label_info.get("isGroup"):
                        project["conditional_label_ids"].append(label_info["id"])

        # Dates
        if start_date_col:
            project["start_date"] = parse_date(row.get(start_date_col, ""))
        if target_date_col:
            project["target_date"] = parse_date(row.get(target_date_col, ""))

        # Description: base text + extra metadata fields
        desc_parts = []
        if desc_col:
            base_desc = row.get(desc_col, "").strip()
            if base_desc:
                desc_parts.append(base_desc)
        for extra in description_extras:
            col_name = extra.get("column")
            label_text = extra.get("label", col_name)
            val = row.get(col_name, "").strip()
            if val:
                desc_parts.append(f"**{label_text}:** {val}")
        if desc_parts:
            description = "\n\n".join(desc_parts)
            if len(description) > 255:
                description = description[:252] + "..."
            project["description"] = description

        # Single external link (legacy)
        link_col = columns.get("link_url")
        link_title_col = columns.get("link_title")
        if link_col:
            url = row.get(link_col, "").strip()
            if url and url.startswith("http"):
                project["link_url"] = url
                project["link_title"] = row.get(link_title_col, "").strip() if link_title_col else "Link"

        # Multiple external link columns (comma-separated URLs per cell)
        external_links = []
        for elc in project_config.get("external_link_columns", []):
            col_name = elc.get("column")
            label_prefix = elc.get("label", col_name)
            raw = row.get(col_name, "").strip()
            if not raw:
                continue
            urls = [u.strip() for u in raw.split(",") if u.strip().startswith("http")]
            if len(urls) == 1:
                external_links.append({"url": urls[0], "label": label_prefix})
            else:
                for idx, u in enumerate(urls, 1):
                    external_links.append({"url": u, "label": f"{label_prefix} {idx}"})
        if external_links:
            project["external_links"] = external_links

        projects.append(project)
    
    # Report unmatched users
    if unmatched_leads:
        print(f"\n  ⚠️  Unmatched leads: {', '.join(sorted(unmatched_leads))}")
    if unmatched_members:
        print(f"  ⚠️  Unmatched members: {', '.join(sorted(unmatched_members))}")
    
    return projects


def resolve_user_id(name: str, workspace: WorkspaceConfig) -> str:
    """Resolve a user name/email to a Linear user ID."""
    if not name:
        return None
    
    # Try exact match first
    if name in workspace.users:
        return workspace.users[name]
    
    # Try lowercase
    if name.lower() in workspace.users:
        return workspace.users[name.lower()]
    
    # Try partial match (case-insensitive)
    normalized_name = name.lower().replace(" ", "").replace(".", "")
    for user_key, user_id in workspace.users.items():
        normalized_key = user_key.lower().replace(" ", "").replace(".", "")
        if normalized_name in normalized_key or normalized_key in normalized_name:
            return user_id
    
    return None


def prepare_project_from_filename(filename: str, config: dict, workspace: WorkspaceConfig) -> dict:
    """Prepare project data from a filename."""
    from ..utils import extract_project_name_from_filename
    
    name = extract_project_name_from_filename(filename)
    
    return {
        "name": name,
        "priority": 0,
        "status_id": None,
        "start_date": None,
        "target_date": None,
        "label": None,
        "label_ids": [],
        "conditional_label_ids": [],
        "lead": None,
        "lead_id": None,
        "members": [],
        "member_ids": [],
        "health": None,
        "update_text": None,
        "status": None,
        "team_ids": [],
        "team_name": None,
    }


def prepare_projects_from_hierarchical(
    feature_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
) -> list:
    """Prepare project data from hierarchical CSV rows (Features).
    
    Each row with entity_type=Feature becomes a project.
    Team assignment is per-project from the Owning Eng Team column.
    """
    project_config = config.get("projects", {})
    columns = project_config.get("columns", {})
    team_config = config.get("team", {})
    
    # Column mappings
    name_col = columns.get("name", "entity_name")
    status_col = columns.get("status", "status_name")
    lead_col = columns.get("lead", "Owner")
    feature_owner_col = columns.get("feature_owner", "Feature Owner")
    start_date_col = columns.get("start_date", "Timeframe start")
    target_date_col = columns.get("target_date", "Timeframe end")
    ranking_col = columns.get("ranking")
    link_col = columns.get("link")
    link_title = columns.get("link_title", "External Link")
    team_list_col = columns.get("team_list")
    timeframe_col = columns.get("timeframe")
    parent_name_col = columns.get("parent_name", "parent_name")
    
    # Team column for assignment
    team_col = team_config.get("team_column")
    fallback_team = team_config.get("fallback_team_name")
    
    # Config maps
    status_map = project_config.get("status_map", {})
    priority_ranges = project_config.get("priority_ranges", [])
    default_priority = project_config.get("default_priority", 0)
    label_groups = project_config.get("label_groups", [])
    
    unmatched_leads = set()
    projects = []
    seen_names = set()
    
    for row in feature_rows:
        name = row.get(name_col, "").strip()
        if not name:
            continue
        
        # Skip duplicates within CSV
        if name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        
        project = {
            "name": name,
            "priority": priority_from_ranking(row.get(ranking_col, "") if ranking_col else "", priority_ranges, default_priority),
            "status_id": None,
            "start_date": parse_date(row.get(start_date_col, "") if start_date_col else ""),
            "target_date": parse_date(row.get(target_date_col, "") if target_date_col else ""),
            "label": None,
            "label_ids": [],
            "conditional_label_ids": [],
            "lead": None,
            "lead_id": None,
            "members": [],
            "member_ids": [],
            "health": None,
            "update_text": None,
            "status": None,
            "team_ids": [],
            "team_name": None,
            "link_url": None,
            "link_title": link_title,
        }
        
        # Resolve team from column
        team_name = row.get(team_col, "").strip() if team_col else ""
        project["team_name"] = team_name
        if team_name:
            team_id = workspace.teams_by_name.get(team_name.lower())
            if team_id:
                project["team_ids"].append(team_id)
        
        # Fallback team if no team found
        if not project["team_ids"] and fallback_team:
            fallback_id = workspace.teams_by_name.get(fallback_team.lower())
            if fallback_id:
                project["team_ids"].append(fallback_id)
                project["team_name"] = f"{team_name or '(none)'} → {fallback_team}"
        
        # Resolve status
        status_value = row.get(status_col, "").strip()
        project["status"] = status_value
        if status_value:
            mapped_status = status_map.get(status_value, status_value)
            if mapped_status in workspace.project_statuses:
                project["status_id"] = workspace.project_statuses[mapped_status]
        
        # Resolve lead (Owner column - name-based)
        lead_name = row.get(lead_col, "").strip()
        if lead_name:
            project["lead"] = lead_name
            lead_id = resolve_user_id(lead_name, workspace)
            if lead_id:
                project["lead_id"] = lead_id
            else:
                unmatched_leads.add(lead_name)
        
        # Feature Owner (email) as project member
        feature_owner = row.get(feature_owner_col, "").strip()
        if feature_owner:
            project["members"].append(feature_owner)
            member_id = resolve_user_id(feature_owner, workspace)
            if member_id:
                project["member_ids"].append(member_id)
        
        # Build description with metadata
        desc_parts = []
        parent_name = row.get(parent_name_col, "").strip() if parent_name_col else ""
        if parent_name:
            desc_parts.append(f"**Parent:** {parent_name}")
        
        team_list = row.get(team_list_col, "").strip() if team_list_col else ""
        if team_list:
            desc_parts.append(f"**Contributing Teams:** {team_list}")
        
        if feature_owner:
            desc_parts.append(f"**Feature Owner:** {feature_owner}")
        
        timeframe = row.get(timeframe_col, "").strip() if timeframe_col else ""
        if timeframe:
            desc_parts.append(f"**Timeframe:** {timeframe}")
        
        # Store link URL for project resource (not in description - 255 char limit)
        link_url = row.get(link_col, "").strip() if link_col else ""
        if link_url and link_url.startswith("http"):
            project["link_url"] = link_url
        
        # Resolve label groups BEFORE building description
        # (multi-value groups add extra info to desc_parts)
        for lg in label_groups:
            group_name = lg.get("group_name")
            col = lg.get("column")
            multi_value = lg.get("multi_value", False)
            separator = lg.get("separator", ",")
            
            raw_value = row.get(col, "").strip()
            if not raw_value:
                continue
            
            if multi_value:
                values = [v.strip() for v in raw_value.split(separator) if v.strip()]
                # Apply only the first value as the label (Linear allows one per group)
                first_value = values[0] if values else None
                # If there are multiple values, note the full list in description
                if len(values) > 1:
                    desc_parts.append(f"**{group_name}:** {', '.join(values)}")
                if first_value and group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if first_value in children:
                        label_id = children[first_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)
            else:
                if group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if raw_value in children:
                        label_id = children[raw_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)
        
        # Build final description (after label loop may have added multi-value info)
        if desc_parts:
            description = "\n\n".join(desc_parts)
            # Linear project description max is 255 characters
            if len(description) > 255:
                description = description[:252] + "..."
            project["description"] = description
        
        projects.append(project)
    
    # Report unmatched users
    if unmatched_leads:
        print(f"\n  ⚠️  Unmatched leads: {', '.join(sorted(unmatched_leads))}")
    
    return projects


def reconcile_project_teams(
    client: LinearClient,
    project_results: dict,
    subfeature_teams_by_parent: dict,
    feature_rows: list,
    entity_uuid_col: str,
    name_col: str,
    dry_run: bool = False,
) -> int:
    """Ensure each project includes all teams its subfeature issues need.
    
    This handles the case where a project was created before its subfeature
    teams were known, or was skipped (already existed) from a prior run.
    
    Returns the number of projects updated.
    """
    updates = 0
    created_projects = project_results.get("created_projects", {})
    
    if not created_projects or not subfeature_teams_by_parent:
        return 0
    
    print("\n🔄 Reconciling project teams with subfeature teams...")
    
    for row in feature_rows:
        feat_name = row.get(name_col, "").strip()
        feat_uuid = row.get(entity_uuid_col, "").strip()
        project_id = created_projects.get(feat_name)
        
        if not project_id or not feat_uuid:
            continue
        if project_id == "dry-run" or str(project_id).startswith("dry-run"):
            continue
        
        required_teams = subfeature_teams_by_parent.get(feat_uuid, set())
        if not required_teams:
            continue
        
        if dry_run:
            print(f"  → {feat_name}: would add {len(required_teams)} subfeature team(s)")
            updates += 1
            continue
        
        try:
            # Get current teams on the project
            result = client.execute(GET_PROJECT_TEAMS_QUERY, {"id": project_id})
            current_team_ids = {
                t["id"] for t in result.get("project", {}).get("teams", {}).get("nodes", [])
            }
            
            missing = required_teams - current_team_ids
            if not missing:
                continue
            
            # Merge and update
            all_team_ids = list(current_team_ids | required_teams)
            update_result = client.execute(UPDATE_PROJECT_TEAMS_MUTATION, {
                "id": project_id,
                "teamIds": all_team_ids,
            })
            if update_result.get("projectUpdate", {}).get("success"):
                print(f"  ✓ {feat_name}: added {len(missing)} team(s) (now {len(all_team_ids)} total)")
                updates += 1
            
            client.rate_limit_delay()
        except Exception as e:
            print(f"  ⚠️ {feat_name}: team update failed: {str(e)[:60]}")
    
    if updates == 0:
        print("  ✓ All projects already have correct teams")
    
    return updates


def prepare_projects_from_parent_task(
    top_level_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
) -> list:
    """Prepare project data from top-level rows in an Asana-style parent_task export.
    
    Each row with no Parent task value becomes a project.
    """
    project_config = config.get("projects", {})
    columns = project_config.get("columns", {})

    name_col = columns.get("name", "Name")
    status_col = columns.get("status", "Section/Column")
    desc_col = columns.get("description", "Notes")
    target_date_col = columns.get("target_date", "Due Date")
    start_date_col = columns.get("start_date", "Start Date")
    created_at_col = columns.get("created_at", "Created At")
    last_modified_col = columns.get("last_modified", "Last Modified")
    asana_projects_col = columns.get("asana_projects", "Projects")

    status_map = project_config.get("status_map", {})
    label_groups = project_config.get("label_groups", [])

    projects = []
    seen_names = set()
    unmatched_leads = set()

    for row in top_level_rows:
        name = row.get(name_col, "").strip()
        if not name or name.lower() in seen_names:
            continue
        seen_names.add(name.lower())

        team_ids = [workspace.target_team_id] if workspace.target_team_id else []

        project = {
            "name": name,
            "priority": 0,
            "status_id": None,
            "start_date": parse_date(row.get(start_date_col, "")),
            "target_date": parse_date(row.get(target_date_col, "")),
            "label": None,
            "label_ids": [],
            "conditional_label_ids": [],
            "lead": None,
            "lead_id": None,
            "members": [],
            "member_ids": [],
            "health": None,
            "update_text": None,
            "status": None,
            "team_ids": team_ids,
            "team_name": None,
            "link_url": None,
            "link_title": None,
        }

        # Resolve status
        status_value = row.get(status_col, "").strip()
        project["status"] = status_value
        if status_value:
            mapped = status_map.get(status_value, status_value)
            if mapped in workspace.project_statuses:
                project["status_id"] = workspace.project_statuses[mapped]

        # Build description: Notes first, then metadata
        desc_parts = []
        notes = row.get(desc_col, "").strip()
        if notes:
            desc_parts.append(notes)

        created_at = row.get(created_at_col, "").strip()
        if created_at:
            desc_parts.append(f"**Created:** {created_at}")

        last_modified = row.get(last_modified_col, "").strip()
        if last_modified:
            desc_parts.append(f"**Last Modified:** {last_modified}")

        asana_projects = row.get(asana_projects_col, "").strip()
        if asana_projects:
            desc_parts.append(f"**Asana Projects:** {asana_projects}")

        # Resolve label groups
        for lg in label_groups:
            group_name = lg.get("group_name")
            col = lg.get("column")
            multi_value = lg.get("multi_value", False)
            separator = lg.get("separator", ",")
            raw_value = row.get(col, "").strip()
            if not raw_value:
                continue

            if multi_value:
                values = [v.strip() for v in raw_value.split(separator) if v.strip()]
                first_value = values[0] if values else None
                if len(values) > 1:
                    desc_parts.append(f"**{group_name}:** {', '.join(values)}")
                if first_value and group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if first_value in children:
                        label_id = children[first_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)
            else:
                if group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if raw_value in children:
                        label_id = children[raw_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)

        if desc_parts:
            description = "\n\n".join(desc_parts)
            if len(description) > 255:
                description = description[:252] + "..."
            project["description"] = description

        projects.append(project)

    if unmatched_leads:
        print(f"\n  ⚠️  Unmatched leads: {', '.join(sorted(unmatched_leads))}")

    return projects


def prepare_milestones_from_parent_task(
    child_rows: list,
    config: dict,
    workspace: WorkspaceConfig,
    name_to_project_id: dict,
) -> list:
    """Prepare milestone data from depth-1 rows in an Asana parent_task export.

    Each row whose Parent task is a top-level task becomes a project milestone
    linked to the corresponding project.
    """
    issues_config = config.get("issues", {})
    columns = issues_config.get("columns", {})
    hierarchy = config.get("hierarchy", {})
    parent_col = hierarchy.get("parent_column", "Parent task")

    title_col = columns.get("title", "Name")
    due_date_col = columns.get("due_date", "Due Date")
    desc_col = columns.get("description", "Notes")

    milestones = []

    for row in child_rows:
        name = row.get(title_col, "").strip()
        if not name:
            continue

        parent_name = row.get(parent_col, "").strip()
        project_id = name_to_project_id.get(parent_name)
        notes = row.get(desc_col, "").strip() or None

        milestones.append({
            "name": name,
            "project_name": parent_name,
            "project_id": project_id,
            "target_date": parse_date(row.get(due_date_col, "")),
            "description": notes,
        })

    return milestones


def import_milestones(
    client: LinearClient,
    milestones: list,
    dry_run: bool = False,
) -> dict:
    """Create project milestones in Linear.

    Returns a dict with ``created``, ``skipped``, ``errors``,
    and ``name_to_id`` (milestone name -> Linear milestone ID).
    """
    results = {"created": 0, "skipped": 0, "errors": [], "name_to_id": {}}

    # Pre-fetch existing milestones per project for dedup
    existing_milestones = {}  # project_id -> {name_lower: milestone_id}
    project_ids = {ms.get("project_id") for ms in milestones if ms.get("project_id") and ms.get("project_id") != "dry-run"}
    for pid in project_ids:
        try:
            data = client.execute(FETCH_PROJECT_MILESTONES_QUERY, {"projectId": pid})
            nodes = data.get("project", {}).get("projectMilestones", {}).get("nodes", [])
            existing_milestones[pid] = {n["name"].lower(): n["id"] for n in nodes}
        except Exception:
            existing_milestones[pid] = {}

    for ms in milestones:
        orig_name = ms["name"]
        project_id = ms.get("project_id")
        project_name = ms.get("project_name", "?")
        compound_key = (orig_name, project_name)

        if dry_run:
            print(f"  [DRY RUN] Milestone: {orig_name[:60]}")
            print(f"    → Project: {project_name[:40]}, Date: {ms.get('target_date', 'None')}")
            results["name_to_id"][compound_key] = "dry-run"
            results["created"] += 1
            continue

        if not project_id or project_id == "dry-run":
            results["skipped"] += 1
            continue

        # Dedup: check if milestone already exists on this project
        truncated_name = orig_name[:77] + "..." if len(orig_name) > 80 else orig_name
        proj_existing = existing_milestones.get(project_id, {})
        existing_id = proj_existing.get(truncated_name.lower()) or proj_existing.get(orig_name.lower())
        if existing_id:
            results["name_to_id"][compound_key] = existing_id
            results["skipped"] += 1
            continue

        name = orig_name
        if len(name) > 80:
            name = name[:77] + "..."

        variables = {"name": name, "projectId": project_id}
        if ms.get("target_date"):
            variables["targetDate"] = ms["target_date"]
        if ms.get("description"):
            desc = ms["description"]
            if len(desc) > 10000:
                desc = desc[:9997] + "..."
            variables["description"] = desc

        try:
            result = client.execute(CREATE_PROJECT_MILESTONE_MUTATION, variables)
            payload = result.get("projectMilestoneCreate", {})
            if payload.get("success"):
                ms_data = payload.get("projectMilestone", {})
                ms_id = ms_data.get("id")
                results["name_to_id"][compound_key] = ms_id
                results["created"] += 1
                if project_id not in existing_milestones:
                    existing_milestones[project_id] = {}
                existing_milestones[project_id][name.lower()] = ms_id
                print(f"  ✓ Milestone: {name[:50]} → project {project_name[:30]}")
            else:
                results["errors"].append({"name": orig_name, "error": "Unknown error"})
            client.rate_limit_delay()
        except Exception as e:
            err_str = str(e)
            if "name not unique" in err_str.lower():
                # Milestone already exists -- resolve its ID for downstream linking
                try:
                    data = client.execute(FETCH_PROJECT_MILESTONES_QUERY, {"projectId": project_id})
                    for node in data.get("project", {}).get("projectMilestones", {}).get("nodes", []):
                        if node["name"].lower() == name.lower():
                            results["name_to_id"][compound_key] = node["id"]
                            if project_id not in existing_milestones:
                                existing_milestones[project_id] = {}
                            existing_milestones[project_id][name.lower()] = node["id"]
                            break
                except Exception:
                    pass
                results["skipped"] += 1
            else:
                results["errors"].append({"name": orig_name, "error": err_str})

    return results
