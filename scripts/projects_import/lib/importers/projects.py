"""Project importer for Linear."""

from ..client import LinearClient
from ..discovery import WorkspaceConfig
from ..utils import truncate_name, parse_date, parse_last_date, parse_datetime, normalize_status, normalize_priority, priority_from_ranking, strip_html_tags, MAX_PROJECT_NAME_LENGTH

CREATE_PROJECT_MUTATION = """
mutation CreateProject(
  $name: String!,
  $description: String,
  $content: String,
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
    content: $content,
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

UPDATE_PROJECT_LABELS_MUTATION = """
mutation UpdateProjectLabels($id: String!, $labelIds: [String!]!) {
  projectUpdate(id: $id, input: {
    labelIds: $labelIds
  }) {
    success
  }
}
"""

UPDATE_PROJECT_CONTENT_MUTATION = """
mutation UpdateProjectContent($id: String!, $description: String, $content: String) {
  projectUpdate(id: $id, input: {
    description: $description,
    content: $content
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

FETCH_PROJECT_LINKS_QUERY = """
query FetchProjectLinks($projectId: String!) {
  project(id: $projectId) {
    externalLinks {
      nodes {
        id
        url
        label
      }
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

INITIATIVE_TO_PROJECT_CREATE_MUTATION = """
mutation InitiativeToProjectCreate($projectId: String!, $initiativeId: String!) {
  initiativeToProjectCreate(input: {
    projectId: $projectId,
    initiativeId: $initiativeId
  }) {
    success
  }
}
"""

UPDATE_EXTERNAL_LINK_MUTATION = """
mutation UpdateExternalLink($id: String!, $label: String!) {
  entityExternalLinkUpdate(id: $id, input: {
    label: $label
  }) {
    success
  }
}
"""

FORCE_UPDATE_PROJECT_MUTATION = """
mutation ForceUpdateProject(
  $id: String!,
  $statusId: String,
  $priority: Int,
  $startDate: TimelessDate,
  $targetDate: TimelessDate,
  $content: String,
  $description: String
) {
  projectUpdate(id: $id, input: {
    statusId: $statusId,
    priority: $priority,
    startDate: $startDate,
    targetDate: $targetDate,
    content: $content,
    description: $description
  }) {
    success
  }
}
"""


def _update_existing_project(client: LinearClient, project_id: str, project_data: dict, target_team_id: str = None, force_update: bool = False):
    """Update lead, members, links, and team association on an existing project."""
    if force_update:
        update_vars = {"id": project_id}
        if project_data.get("status_id"):
            update_vars["statusId"] = project_data["status_id"]
        if project_data.get("priority") is not None:
            update_vars["priority"] = project_data["priority"]
        if project_data.get("start_date"):
            update_vars["startDate"] = project_data["start_date"]
        if project_data.get("target_date"):
            update_vars["targetDate"] = project_data["target_date"]
        content = project_data.get("content")
        description = project_data.get("description")
        if description and len(description) > 255:
            if not content:
                content = description
            description = description[:252] + "..."
        if content:
            update_vars["content"] = content
        if description:
            update_vars["description"] = description
        if len(update_vars) > 1:
            try:
                result = client.execute(FORCE_UPDATE_PROJECT_MUTATION, update_vars)
                if result.get("projectUpdate", {}).get("success"):
                    fields = [k for k in update_vars if k != "id"]
                    print(f"    🔄 Force-updated: {', '.join(fields)}")
            except Exception as e:
                print(f"    ⚠️ Force update failed: {str(e)[:80]}")

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

    # Update labels (combine label_ids + conditional_label_ids)
    label_ids = list(project_data.get("label_ids", []))
    for cond_id in project_data.get("conditional_label_ids", []):
        if cond_id and cond_id not in label_ids:
            label_ids.append(cond_id)
    if label_ids:
        try:
            result = client.execute(UPDATE_PROJECT_LABELS_MUTATION, {
                "id": project_id,
                "labelIds": label_ids,
            })
            if result.get("projectUpdate", {}).get("success"):
                print(f"    🏷️  Updated {len(label_ids)} label(s)")
        except Exception as e:
            print(f"    ⚠️ Label update failed: {str(e)[:60]}")

    content = project_data.get("content")
    description = project_data.get("description")
    if content or description:
        try:
            update_vars = {"id": project_id}
            if description:
                if len(description) > 255:
                    description = description[:252] + "..."
                update_vars["description"] = description
            if content:
                update_vars["content"] = content
            result = client.execute(UPDATE_PROJECT_CONTENT_MUTATION, update_vars)
            if result.get("projectUpdate", {}).get("success"):
                print(f"    📝 Updated description/content")
        except Exception as e:
            print(f"    ⚠️ Content update failed: {str(e)[:60]}")

    _add_external_links(client, project_id, project_data)
    _add_milestones(client, project_id, project_data)
    _add_initiative_parent(client, project_id, project_data)


def _add_initiative_parent(client: LinearClient, project_id: str, project_data: dict):
    """Link project to a matching initiative if one was resolved."""
    initiative = project_data.get("initiative")
    if not initiative:
        return
    init_id = initiative["id"]
    # Skip if project is already linked to this initiative
    if project_id in initiative.get("project_ids", set()):
        return
    try:
        result = client.execute(INITIATIVE_TO_PROJECT_CREATE_MUTATION, {
            "projectId": project_id,
            "initiativeId": init_id,
        })
        if result.get("initiativeToProjectCreate", {}).get("success"):
            print(f"    📌 Linked to initiative: {initiative['name']}")
            initiative["project_ids"].add(project_id)
    except Exception as e:
        err = str(e)
        if "already exists" in err.lower():
            pass
        else:
            print(f"    ⚠️ Initiative link failed: {err[:60]}")


def _add_milestones(client: LinearClient, project_id: str, project_data: dict):
    """Create project milestones from milestone_columns config."""
    milestones = project_data.get("milestones", [])
    if not milestones:
        return

    # Fetch existing milestones on this project for dedup
    existing = {}
    try:
        result = client.execute(FETCH_PROJECT_MILESTONES_QUERY, {"projectId": project_id})
        for node in result.get("project", {}).get("projectMilestones", {}).get("nodes", []):
            existing[node["name"].lower()] = node["id"]
    except Exception:
        pass

    for ms in milestones:
        ms_name = ms["name"]
        if ms_name.lower() in existing:
            continue
        try:
            variables = {"name": ms_name, "projectId": project_id}
            if ms.get("target_date"):
                variables["targetDate"] = ms["target_date"]
            result = client.execute(CREATE_PROJECT_MILESTONE_MUTATION, variables)
            if result.get("projectMilestoneCreate", {}).get("success"):
                print(f"    🏁 Milestone: {ms_name} ({ms.get('target_date') or ms.get('raw_date', 'no date')})")
        except Exception as e:
            print(f"    ⚠️ Milestone '{ms_name}' failed: {str(e)[:60]}")


def _add_external_links(client: LinearClient, project_id: str, project_data: dict):
    """Add external links (single legacy + multi-column) to a project, deduping by URL."""
    all_links = []

    # Legacy single link
    link_url = project_data.get("link_url")
    if link_url:
        all_links.append({"url": link_url, "label": project_data.get("link_title") or "External Link"})

    # Multi-column external links
    all_links.extend(project_data.get("external_links", []))

    if not all_links:
        return

    # Fetch existing links on this project for URL-based dedup/update
    existing_by_url = {}  # normalized_url -> {id, label}
    try:
        result = client.execute(FETCH_PROJECT_LINKS_QUERY, {"projectId": project_id})
        for node in result.get("project", {}).get("externalLinks", {}).get("nodes", []):
            norm_url = node.get("url", "").rstrip("/")
            existing_by_url[norm_url] = {"id": node["id"], "label": node.get("label", "")}
    except Exception:
        pass

    for link in all_links:
        norm_url = link["url"].rstrip("/")
        existing = existing_by_url.get(norm_url)
        if existing:
            if existing["label"] != link["label"]:
                try:
                    result = client.execute(UPDATE_EXTERNAL_LINK_MUTATION, {
                        "id": existing["id"],
                        "label": link["label"],
                    })
                    if result.get("entityExternalLinkUpdate", {}).get("success"):
                        print(f"    🔗 Updated link: {existing['label']} → {link['label']}")
                except Exception as e:
                    print(f"    ⚠️ Link update failed: {str(e)[:60]}")
            continue
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


def _dedupe_labels_by_group(label_ids: list, workspace: WorkspaceConfig) -> list:
    """Keep only the first label from each group to satisfy Linear's exclusivity rule."""
    id_to_group = {}
    for group_name, group_info in workspace.project_labels.items():
        if not group_info.get("isGroup"):
            continue
        for child_name, child_id in group_info.get("children", {}).items():
            id_to_group[child_id] = group_name

    seen_groups = set()
    result = []
    for lid in label_ids:
        group = id_to_group.get(lid)
        if group:
            if group in seen_groups:
                continue
            seen_groups.add(group)
        result.append(lid)
    return result


def import_projects(
    client: LinearClient,
    projects: list,
    workspace: WorkspaceConfig,
    config: dict,
    dry_run: bool = False,
    batch_size: int = None,
    force_update: bool = False,
    allow_duplicates: bool = False,
) -> dict:
    """Import projects into Linear."""
    
    results = {
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "duplicates": 0,
        "errors": [],
        "created_projects": {},  # name -> id mapping for issue linking
    }

    project_config = config.get("projects", {})
    labels_config = config.get("labels", {})

    duplicate_label_id = None
    if allow_duplicates:
        dup_label = workspace.project_labels.get("Duplicate")
        if dup_label and not dup_label.get("isGroup"):
            duplicate_label_id = dup_label["id"]
        elif not dry_run:
            try:
                from ..labels import CREATE_STANDALONE_PROJECT_LABEL_MUTATION
                result = client.execute(CREATE_STANDALONE_PROJECT_LABEL_MUTATION, {"name": "Duplicate"})
                if result.get("projectLabelCreate", {}).get("success"):
                    label = result["projectLabelCreate"]["projectLabel"]
                    duplicate_label_id = label["id"]
                    workspace.project_labels["Duplicate"] = {"id": label["id"], "isGroup": False, "children": {}}
                    print("🏷️  Created 'Duplicate' label for duplicate tracking")
            except Exception as e:
                print(f"⚠️ Could not create 'Duplicate' label: {str(e)[:80]}")
        else:
            duplicate_label_id = "dry-run-duplicate-label"
            print("🏷️  Would create 'Duplicate' label for duplicate tracking")

    # Apply batch limit
    if batch_size:
        projects = projects[:batch_size]
        print(f"\n🔢 Batch mode: Processing {len(projects)} projects")

    total = len(projects)
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Importing {total} projects...\n")

    for i, project_data in enumerate(projects, 1):
        full_name = " ".join(project_data["name"].split())
        name = truncate_name(full_name, MAX_PROJECT_NAME_LENGTH)
        display_name = name[:50] + "..." if len(name) > 50 else name
        
        source_file = project_data.get("source_file", "unknown")
        print(f"[{i}/{total}] {display_name}")
        print(f"  📁 Source: {source_file}")

        # Check for duplicate - get existing project ID if it exists
        existing_project_id = workspace.existing_projects.get(full_name.strip().lower())
        is_duplicate = False
        if existing_project_id:
            if allow_duplicates:
                print(f"  🔁 Creating duplicate (original exists)")
                is_duplicate = True
                results["duplicates"] += 1
            elif force_update:
                print(f"  🔄 Updating (already exists)")
                results["skipped"] += 1
                results["created_projects"][full_name] = existing_project_id
                if dry_run:
                    all_label_ids = list(project_data.get("label_ids", []))
                    for cond_id in project_data.get("conditional_label_ids", []):
                        if cond_id and cond_id not in all_label_ids:
                            all_label_ids.append(cond_id)
                    if all_label_ids:
                        print(f"    → Would update {len(all_label_ids)} label(s)")
                    print(f"    → Would force-update status, priority, dates, content")
                else:
                    _update_existing_project(client, existing_project_id, project_data, target_team_id=workspace.target_team_id, force_update=True)
                continue
            else:
                print(f"  ⏭ Skipped (already exists)")
                results["skipped"] += 1
                results["created_projects"][full_name] = existing_project_id
                if dry_run:
                    all_label_ids = list(project_data.get("label_ids", []))
                    for cond_id in project_data.get("conditional_label_ids", []):
                        if cond_id and cond_id not in all_label_ids:
                            all_label_ids.append(cond_id)
                    if all_label_ids:
                        print(f"    → Would update {len(all_label_ids)} label(s)")
                else:
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

        if is_duplicate and duplicate_label_id and duplicate_label_id not in label_ids:
            label_ids.append(duplicate_label_id)

        label_ids = _dedupe_labels_by_group(label_ids, workspace)

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
                ts_display = f" @ {project_data['health_updated_at']}" if project_data.get("health_updated_at") else ""
                print(f"  → Update: {update_preview}{ts_display}")
            
            if project_data.get("link_url"):
                print(f"  → Link: {project_data['link_title'] or 'Link'} ({project_data['link_url'][:50]}...)")
            for link in project_data.get("external_links", []):
                print(f"  → Link: {link['label']} ({link['url'][:60]}...)")
            for ms in project_data.get("milestones", []):
                print(f"  → Milestone: {ms['name']} ({ms.get('target_date') or ms.get('raw_date') or 'no date'})")
            if project_data.get("initiative"):
                print(f"  → Initiative: {project_data['initiative']['name']}")
            
            results["success"] += 1
            results["created_projects"][full_name] = "dry-run"
            continue

        try:
            description = project_data.get("description")
            content = project_data.get("content")
            if not description and full_name != name:
                description = f"**Full Name:** {full_name}"
            if description and len(description) > 255:
                if not content:
                    content = description
                description = description[:252] + "..."
            variables = {
                "name": name,
                "teamIds": team_ids,
            }
            if description:
                variables["description"] = description
            if content:
                variables["content"] = content
            
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
                if not is_duplicate:
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

                # Create milestones from milestone_columns
                _add_milestones(client, project_id, project_data)

                # Link to parent initiative if matched
                _add_initiative_parent(client, project_id, project_data)

                # Create project update if health or update text exists
                health = project_data.get("health")
                update_text = project_data.get("update_text")
                if health or update_text:
                    try:
                        body = _format_update_body(update_text) if update_text else f"Project status: {health}"
                        health_ts = project_data.get("health_updated_at")
                        if health_ts:
                            body = f"*Original update: {health_ts}*\n\n{body}"
                        update_vars = {
                            "projectId": project_id,
                            "body": body
                        }
                        if health:
                            linear_health = _resolve_health(health, project_config)
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
            if not col:
                continue
            lg_value_map = lg.get("value_map", {})
            lg_filter_unmapped = lg.get("filter_unmapped", False)
            multi_value = lg.get("multi_value", False)
            separator = lg.get("separator", ",")
            value = row.get(col, "").strip()
            
            if not value or group_name not in workspace.project_labels:
                continue

            children = workspace.project_labels[group_name].get("children", {})

            if multi_value:
                values = [v.strip() for v in value.split(separator) if v.strip()]
                if lg_value_map:
                    mapped = []
                    for v in values:
                        if v in lg_value_map:
                            mv = lg_value_map[v]
                            if mv not in mapped:
                                mapped.append(mv)
                        elif not lg_filter_unmapped:
                            mapped.append(v)
                    values = mapped
                for v in values:
                    if v in children:
                        lid = children[v]
                        if lid not in project["label_ids"]:
                            project["label_ids"].append(lid)
            else:
                label_value = value
                if lg_value_map:
                    if value in lg_value_map:
                        label_value = lg_value_map[value]
                    elif lg_filter_unmapped:
                        continue
                if label_value in children:
                    project["label_ids"].append(children[label_value])
        
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

        # Dates (use parse_last_date when multi_date is enabled)
        multi_date = project_config.get("multi_date", False)
        date_fn = parse_last_date if multi_date else parse_date
        if start_date_col:
            project["start_date"] = date_fn(row.get(start_date_col, ""))
        if target_date_col:
            project["target_date"] = date_fn(row.get(target_date_col, ""))

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
            project["description"] = "\n\n".join(desc_parts)

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
            label_fallback = elc.get("label", col_name)
            label_col = elc.get("label_column")
            dynamic_label = row.get(label_col, "").strip() if label_col else ""
            label_prefix = dynamic_label or label_fallback
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

        # Milestone columns → list of {name, target_date} for post-creation.
        # Always created (even without a date) so every project gets the milestone.
        # Uses parse_last_date to handle comma-separated multi-date values.
        milestones = []
        for mc in project_config.get("milestone_columns", []):
            ms_col = mc.get("column")
            ms_name = mc.get("name", ms_col)
            date_str = row.get(ms_col, "").strip()
            milestones.append({
                "name": ms_name,
                "target_date": parse_last_date(date_str) if date_str else None,
                "raw_date": date_str,
            })
        if milestones:
            project["milestones"] = milestones

        # Match project name to an initiative
        if workspace.initiatives:
            init_match = workspace.initiatives.get(name.strip().lower())
            if init_match:
                project["initiative"] = init_match

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


def _format_update_body(raw_text: str) -> str:
    """Clean up raw project-update text so it renders well in Linear's markdown.

    Turns inline section headers (``Highlights / Completed ✅: …``) into
    bold headings on their own line, and strips placeholder template text.
    """
    import re

    if not raw_text or not raw_text.strip():
        return raw_text

    text = raw_text.strip()

    # Turn "Section Header: content" into "**Section Header**\ncontent"
    # by matching common emoji-annotated header patterns at start-of-line.
    header_re = re.compile(
        r'^((?:Highlights\s*/\s*Completed\s*✅|'
        r'Progress\s*&\s*Plans\s*🔄|'
        r'Lowlight\s*/\s*Blocked\s*🚫|'
        r'Flags\s*\+\s*Path\s*to\s*Green(?:\s*\(Optional\))?)'
        r')\s*[:]\s*',
        re.MULTILINE | re.IGNORECASE,
    )
    text = header_re.sub(r'**\1**\n', text)

    # Strip placeholder template lines
    placeholder_re = re.compile(
        r'<[^>]*(?:Short summary|What\'s in progress|What\'s blocked)[^>]*>',
        re.IGNORECASE,
    )
    text = placeholder_re.sub('', text)

    # Collapse runs of 3+ blank lines down to 2
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


def _resolve_health(health_raw: str, project_config: dict) -> str:
    """Resolve a raw health/status string to a Linear ProjectUpdateHealthType enum.

    Tries exact match against ``health_map`` first.  Falls back to
    ``health_keywords`` (a list of ``{keyword, health}`` dicts checked in
    priority order) for substring matching, which handles composite values
    like ``"🟡 At Risk, ⭕ Delayed"``.
    """
    if not health_raw:
        return None

    health_map = project_config.get("health_map", {
        "On Track": "onTrack",
        "At Risk": "atRisk",
        "Off Track": "offTrack",
    })

    # Exact match
    if health_raw in health_map:
        return health_map[health_raw]

    # Keyword (substring) matching
    health_keywords = project_config.get("health_keywords", [])
    for entry in health_keywords:
        kw = entry.get("keyword", "")
        if kw and kw.lower() in health_raw.lower():
            return entry.get("health")

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
    desc_col = columns.get("description")
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
    health_col = columns.get("health")
    update_text_col = columns.get("update_text")
    health_updated_at_col = columns.get("health_updated_at")
    comment_col = columns.get("comment")
    description_extras = project_config.get("description_extras", [])
    
    # Team column for assignment
    team_col = team_config.get("team_column")
    fallback_team = team_config.get("fallback_team_name")
    
    # Config maps
    status_map = project_config.get("status_map", {})
    priority_ranges = project_config.get("priority_ranges", [])
    default_priority = project_config.get("default_priority", 0)
    label_groups = project_config.get("label_groups", [])
    static_labels = project_config.get("static_labels", [])
    
    # Resolve static label IDs (standalone labels applied to every project)
    static_label_ids = []
    for sl_name in static_labels:
        label_info = workspace.project_labels.get(sl_name)
        if label_info and not label_info.get("isGroup"):
            static_label_ids.append(label_info["id"])
    
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

        # Health status and project update fields
        if health_col:
            project["health"] = row.get(health_col, "").strip()
        if update_text_col:
            raw_update = row.get(update_text_col, "").strip()
            if raw_update:
                project["update_text"] = strip_html_tags(raw_update)
        if health_updated_at_col:
            project["health_updated_at"] = parse_datetime(
                row.get(health_updated_at_col, "")
            )
        
        # Build content: meta fields at top, then PB description below
        meta_parts = []
        parent_name = row.get(parent_name_col, "").strip() if parent_name_col else ""
        if parent_name:
            meta_parts.append(f"**Parent:** {parent_name}")
        
        team_list = row.get(team_list_col, "").strip() if team_list_col else ""
        if team_list:
            team_list = ", ".join(t.strip() for t in team_list.split(","))
            meta_parts.append(f"**Contributing Teams:** {team_list}")
        
        if feature_owner:
            meta_parts.append(f"**Feature Owner:** {feature_owner}")
        
        timeframe = row.get(timeframe_col, "").strip() if timeframe_col else ""
        if timeframe:
            meta_parts.append(f"**Timeframe:** {timeframe}")
        
        for extra in description_extras:
            col_name = extra.get("column")
            label_text = extra.get("label", col_name)
            val = row.get(col_name, "").strip()
            if val:
                if "," in val:
                    val = ", ".join(v.strip() for v in val.split(","))
                meta_parts.append(f"**{label_text}:** {val}")

        # Append Comment field to description
        if comment_col:
            comment_val = row.get(comment_col, "").strip()
            if comment_val:
                meta_parts.append(f"**Comment:** {strip_html_tags(comment_val)}")
        
        content_parts = []
        if meta_parts:
            content_parts.append("\n".join(meta_parts))
        if desc_col:
            base_desc = row.get(desc_col, "").strip()
            if base_desc:
                content_parts.append(strip_html_tags(base_desc))
        
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
            lg_value_map = lg.get("value_map", {})
            lg_filter_unmapped = lg.get("filter_unmapped", False)
            
            if not col:
                continue
            raw_value = row.get(col, "").strip()
            if not raw_value:
                continue
            
            if multi_value:
                values = [v.strip() for v in raw_value.split(separator) if v.strip()]
                # Apply value_map to transform/filter values for label resolution
                if lg_value_map:
                    mapped_values = []
                    for v in values:
                        if v in lg_value_map:
                            mv = lg_value_map[v]
                            if mv not in mapped_values:
                                mapped_values.append(mv)
                        elif not lg_filter_unmapped:
                            mapped_values.append(v)
                    label_values = mapped_values
                else:
                    label_values = values
                if len(values) > 1:
                    content_parts.append(f"**{group_name}:** {', '.join(values)}")
                for lv in label_values:
                    if group_name in workspace.project_labels:
                        children = workspace.project_labels[group_name].get("children", {})
                        if lv in children:
                            label_id = children[lv]
                            if label_id not in project["label_ids"]:
                                project["label_ids"].append(label_id)
            else:
                label_value = raw_value
                if lg_value_map:
                    if raw_value in lg_value_map:
                        label_value = lg_value_map[raw_value]
                    elif lg_filter_unmapped:
                        continue
                if group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if label_value in children:
                        label_id = children[label_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)
        
        full_content = "\n\n".join(content_parts) if content_parts else None
        if full_content:
            project["content"] = full_content
        
        # Add static labels (applied to every project)
        for sl_id in static_label_ids:
            if sl_id not in project["label_ids"]:
                project["label_ids"].append(sl_id)
        
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
            if not col:
                continue
            multi_value = lg.get("multi_value", False)
            separator = lg.get("separator", ",")
            lg_value_map = lg.get("value_map", {})
            lg_filter_unmapped = lg.get("filter_unmapped", False)
            raw_value = row.get(col, "").strip()
            if not raw_value:
                continue

            if multi_value:
                values = [v.strip() for v in raw_value.split(separator) if v.strip()]
                if lg_value_map:
                    mapped = []
                    for v in values:
                        if v in lg_value_map:
                            mv = lg_value_map[v]
                            if mv not in mapped:
                                mapped.append(mv)
                        elif not lg_filter_unmapped:
                            mapped.append(v)
                    label_values = mapped
                else:
                    label_values = values
                if len(values) > 1:
                    desc_parts.append(f"**{group_name}:** {', '.join(values)}")
                for lv in label_values:
                    if group_name in workspace.project_labels:
                        children = workspace.project_labels[group_name].get("children", {})
                        if lv in children:
                            label_id = children[lv]
                            if label_id not in project["label_ids"]:
                                project["label_ids"].append(label_id)
            else:
                label_value = raw_value
                if lg_value_map:
                    if raw_value in lg_value_map:
                        label_value = lg_value_map[raw_value]
                    elif lg_filter_unmapped:
                        continue
                if group_name in workspace.project_labels:
                    children = workspace.project_labels[group_name].get("children", {})
                    if label_value in children:
                        label_id = children[label_value]
                        if label_id not in project["label_ids"]:
                            project["label_ids"].append(label_id)

        if desc_parts:
            project["description"] = "\n\n".join(desc_parts)

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
