"""Workspace discovery for Linear import."""

from .client import LinearClient

# GraphQL Queries
DISCOVER_TEAMS_QUERY = """
query DiscoverTeams($after: String) {
  teams(first: 250, after: $after) {
    nodes {
      id
      name
      key
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""

DISCOVER_TEAM_TEMPLATES_QUERY = """
query DiscoverTeamTemplates($teamId: String!) {
  team(id: $teamId) {
    templates {
      nodes {
        id
        name
        type
      }
    }
  }
}
"""

DISCOVER_WORKSPACE_QUERY = """
query DiscoverWorkspace {
  projectStatuses(first: 50) {
    nodes {
      id
      name
      type
    }
  }
}
"""

DISCOVER_PROJECT_LABELS_QUERY = """
query DiscoverProjectLabels($after: String) {
  projectLabels(first: 100, after: $after) {
    nodes {
      id
      name
      isGroup
      children {
        nodes {
          id
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""

DISCOVER_ISSUE_LABELS_QUERY = """
query DiscoverIssueLabels($after: String) {
  issueLabels(first: 100, after: $after) {
    nodes {
      id
      name
      isGroup
      children {
        nodes {
          id
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""

DISCOVER_TEAM_STATES_QUERY = """
query DiscoverTeamStates($teamId: String!) {
  team(id: $teamId) {
    states {
      nodes {
        id
        name
        type
      }
    }
  }
}
"""

DISCOVER_TEAM_CYCLES_QUERY = """
query DiscoverTeamCycles($teamId: String!) {
  team(id: $teamId) {
    cycles(first: 50) {
      nodes {
        id
        name
        number
        startsAt
        endsAt
      }
    }
  }
}
"""

DISCOVER_TEAM_USERS_QUERY = """
query DiscoverUsers($after: String) {
  users(first: 250, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      displayName
      email
      active
    }
  }
}
"""

DISCOVER_INITIATIVES_QUERY = """
query DiscoverInitiatives($after: String) {
  initiatives(first: 250, after: $after) {
    nodes {
      id
      name
      projects {
        nodes {
          id
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""

FETCH_EXISTING_PROJECTS_QUERY = """
query FetchExistingProjects($teamId: String!, $after: String) {
  team(id: $teamId) {
    projects(first: 250, after: $after) {
      nodes {
        id
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""

# Maps lowercase project name -> project ID
EXISTING_PROJECT_IDS_TYPE = dict  # For type hinting clarity

FETCH_EXISTING_ISSUES_QUERY = """
query FetchExistingIssues($teamId: String!, $after: String) {
  team(id: $teamId) {
    issues(first: 250, after: $after) {
      nodes {
        id
        title
        project {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"""


class WorkspaceConfig:
    """Holds discovered workspace configuration."""
    
    def __init__(self):
        self.teams = {}  # key -> {id, name, key}
        self.teams_by_name = {}  # lowercase name -> id
        self.project_statuses = {}  # name -> id
        self.issue_states = {}  # name -> id
        self.cycles = {}  # name/number -> id
        self.users = {}  # name/email -> id
        self.project_labels = {}  # name -> {id, isGroup, children}
        self.issue_labels = {}  # name -> {id, isGroup, children}
        self.project_templates = []  # list of {id, name, type}
        self.issue_templates = []  # list of {id, name, type}
        
        # Team IDs
        self.parent_team_id = None
        self.target_team_id = None
        
        # Template IDs (resolved)
        self.project_template_id = None
        self.issue_template_id = None
        
        # Deduplication data
        self.existing_projects = {}  # lowercase project name -> project id
        self.existing_issues = {}  # project_id -> {lowercase_title: issue_id}
        
        # Initiatives (lowercase name -> {id, project_ids})
        self.initiatives = {}
        
        # Per-team state cache (for hierarchical mode with multiple teams)
        self._team_states = {}  # team_id -> {state_name: state_id}

    def print_summary(self):
        """Print discovered workspace configuration."""
        print("\n" + "=" * 60)
        print("WORKSPACE DISCOVERY RESULTS")
        print("=" * 60)

        # Teams
        print(f"\n📁 TEAMS ({len(self.teams)}):")
        for key, info in sorted(self.teams.items(), key=lambda x: x[1]['name']):
            marker = ""
            if info['id'] == self.parent_team_id:
                marker = " ← Parent team"
            elif info['id'] == self.target_team_id:
                marker = " ← Target team"
            print(f"  • {info['name']} ({key}){marker}")

        # Project Statuses
        print(f"\n📊 PROJECT STATUSES ({len(self.project_statuses)}):")
        for name in sorted(self.project_statuses.keys()):
            print(f"  • {name}")

        # Issue States
        if self.issue_states:
            print(f"\n📋 ISSUE STATES ({len(self.issue_states)}):")
            for name in sorted(self.issue_states.keys()):
                print(f"  • {name}")

        # Cycles
        if self.cycles:
            print(f"\n🔄 CYCLES ({len(self.cycles)}):")
            for name in sorted(self.cycles.keys()):
                print(f"  • {name}")

        # Users
        if self.users:
            print(f"\n👥 USERS ({len(self.users)}):")
            for name in list(sorted(self.users.keys()))[:10]:
                print(f"  • {name}")
            if len(self.users) > 10:
                print(f"  ... and {len(self.users) - 10} more")

        # Project Labels
        if self.project_labels:
            print(f"\n🏷️  PROJECT LABELS ({len(self.project_labels)}):")
            for name, info in sorted(self.project_labels.items()):
                if info["isGroup"]:
                    print(f"  • {name} (group)")
                    for child_name in info.get("children", {}).keys():
                        print(f"    └─ {child_name}")
                else:
                    print(f"  • {name}")

        # Issue Labels
        if self.issue_labels:
            print(f"\n🏷️  ISSUE LABELS ({len(self.issue_labels)}):")
            for name, info in sorted(self.issue_labels.items()):
                if info["isGroup"]:
                    print(f"  • {name} (group)")
                    for child_name in info.get("children", {}).keys():
                        print(f"    └─ {child_name}")
                else:
                    print(f"  • {name}")

        # Templates
        if self.project_templates:
            print(f"\n📋 PROJECT TEMPLATES ({len(self.project_templates)}):")
            for tmpl in self.project_templates:
                marker = " ✓" if tmpl['id'] == self.project_template_id else ""
                print(f"  • {tmpl['name']}{marker}")

        if self.issue_templates:
            print(f"\n📝 ISSUE TEMPLATES ({len(self.issue_templates)}):")
            for tmpl in self.issue_templates:
                marker = " ✓" if tmpl['id'] == self.issue_template_id else ""
                print(f"  • {tmpl['name']}{marker}")

        # Existing data
        if self.existing_projects:
            print(f"\n📦 EXISTING PROJECTS: {len(self.existing_projects)}")
        
        total_issues = sum(len(issues) for issues in self.existing_issues.values())
        if total_issues:
            print(f"📝 EXISTING ISSUES: {total_issues}")

        print("\n" + "=" * 60)


def discover_workspace(client: LinearClient, config: dict) -> WorkspaceConfig:
    """Discover and parse workspace configuration."""
    workspace = WorkspaceConfig()
    
    team_config = config.get("team", {})
    parent_key = team_config.get("parent_key")
    target_key = team_config.get("target_key")
    
    print("\n🔍 Discovering workspace configuration...")
    
    # Step 1: Fetch all teams (paginated)
    print("  Fetching teams...")
    after_cursor = None
    while True:
        variables = {"after": after_cursor} if after_cursor else {}
        teams_data = client.execute(DISCOVER_TEAMS_QUERY, variables)
        teams_page = teams_data.get("teams", {})
        for team in teams_page.get("nodes", []):
            workspace.teams[team["key"]] = {
                "id": team["id"],
                "name": team["name"],
                "key": team["key"],
            }
            workspace.teams_by_name[team["name"].lower()] = team["id"]
            if team["key"] == parent_key:
                workspace.parent_team_id = team["id"]
            if team["key"] == target_key:
                workspace.target_team_id = team["id"]
        page_info = teams_page.get("pageInfo", {})
        if page_info.get("hasNextPage") and page_info.get("endCursor"):
            after_cursor = page_info["endCursor"]
        else:
            break

    # Step 2: Fetch templates from target team
    if workspace.target_team_id:
        print("  Fetching templates...")
        templates_data = client.execute(DISCOVER_TEAM_TEMPLATES_QUERY, {"teamId": workspace.target_team_id})
        team_templates = templates_data.get("team", {}).get("templates", {}).get("nodes", [])
        for tmpl in team_templates:
            if tmpl["type"] == "project":
                workspace.project_templates.append({
                    "id": tmpl["id"],
                    "name": tmpl["name"],
                    "type": tmpl["type"],
                })
            elif tmpl["type"] == "issue":
                workspace.issue_templates.append({
                    "id": tmpl["id"],
                    "name": tmpl["name"],
                    "type": tmpl["type"],
                })
        
        # Resolve project template
        project_template_name = config.get("projects", {}).get("template")
        if project_template_name:
            for tmpl in workspace.project_templates:
                if project_template_name.lower() in tmpl["name"].lower():
                    workspace.project_template_id = tmpl["id"]
                    break
        
        # Resolve issue template
        issue_template_name = config.get("issues", {}).get("template")
        if issue_template_name:
            for tmpl in workspace.issue_templates:
                if issue_template_name.lower() in tmpl["name"].lower():
                    workspace.issue_template_id = tmpl["id"]
                    break

    # Step 3: Fetch issue states from target team
    if workspace.target_team_id:
        print("  Fetching issue states...")
        states_data = client.execute(DISCOVER_TEAM_STATES_QUERY, {"teamId": workspace.target_team_id})
        for state in states_data.get("team", {}).get("states", {}).get("nodes", []):
            workspace.issue_states[state["name"]] = state["id"]

    # Step 4: Fetch cycles from target team
    if workspace.target_team_id:
        print("  Fetching cycles...")
        cycles_data = client.execute(DISCOVER_TEAM_CYCLES_QUERY, {"teamId": workspace.target_team_id})
        for cycle in cycles_data.get("team", {}).get("cycles", {}).get("nodes", []):
            # Map by both name and number
            if cycle.get("name"):
                workspace.cycles[cycle["name"]] = cycle["id"]
            if cycle.get("number"):
                workspace.cycles[str(cycle["number"])] = cycle["id"]

    # Step 5: Fetch users (with pagination)
    print("  Fetching users...")
    all_users = []
    after_cursor = None
    while True:
        variables = {}
        if after_cursor:
            variables["after"] = after_cursor
        users_data = client.execute(DISCOVER_TEAM_USERS_QUERY, variables)
        users_page = users_data.get("users", {})
        all_users.extend(users_page.get("nodes", []))
        page_info = users_page.get("pageInfo", {})
        if page_info.get("hasNextPage") and page_info.get("endCursor"):
            after_cursor = page_info["endCursor"]
        else:
            break
    print(f"    Found {len(all_users)} users")
    for user in all_users:
        if user.get("active"):
            user_id = user["id"]
            name = user.get("name", "")
            display_name = user.get("displayName", "")
            email = user.get("email", "")
            
            # Map by exact name, displayName, and email
            if name:
                workspace.users[name] = user_id
                workspace.users[name.lower()] = user_id
            if display_name:
                workspace.users[display_name] = user_id
                workspace.users[display_name.lower()] = user_id
            if email:
                workspace.users[email] = user_id
                workspace.users[email.lower()] = user_id
                # Also map by email prefix (before @)
                email_prefix = email.split("@")[0].lower()
                workspace.users[email_prefix] = user_id
            
            # Create additional mappings for common name patterns
            if email:
                email_prefix = email.split("@")[0].lower()
                
                # Handle "firstname.lastname@domain.com" format
                if "." in email_prefix:
                    parts = email_prefix.split(".")
                    if len(parts) >= 2:
                        # Map "Firstname Lastname" -> user_id
                        full_name_variant = " ".join(p.capitalize() for p in parts)
                        workspace.users[full_name_variant] = user_id
                        workspace.users[full_name_variant.lower()] = user_id
                        # Also map just first name + last name (handles middle initials)
                        first_last = f"{parts[0].capitalize()} {parts[-1].capitalize()}"
                        workspace.users[first_last] = user_id
                        workspace.users[first_last.lower()] = user_id
                
                # Handle "firstnamelastname@domain.com" format (no period)
                # Try to match against common name patterns
                elif len(email_prefix) > 4:
                    # Store the raw prefix for partial matching
                    # e.g., match "Jane Doe" to "janedoe@domain.com"
                    workspace.users[email_prefix] = user_id

    # Step 6: Fetch project statuses and labels
    print("  Fetching project statuses and labels...")
    workspace_data = client.execute(DISCOVER_WORKSPACE_QUERY)
    
    for status in workspace_data.get("projectStatuses", {}).get("nodes", []):
        workspace.project_statuses[status["name"]] = status["id"]

    after_cursor = None
    label_count = 0
    while True:
        variables = {"after": after_cursor} if after_cursor else {}
        pl_data = client.execute(DISCOVER_PROJECT_LABELS_QUERY, variables)
        pl_root = pl_data.get("projectLabels", {})
        for label in pl_root.get("nodes", []):
            children = {}
            for child in label.get("children", {}).get("nodes", []):
                children[child["name"]] = child["id"]
            workspace.project_labels[label["name"]] = {
                "id": label["id"],
                "isGroup": label["isGroup"],
                "children": children,
            }
            label_count += 1
        page_info = pl_root.get("pageInfo", {})
        if page_info.get("hasNextPage") and page_info.get("endCursor"):
            after_cursor = page_info["endCursor"]
        else:
            break
    if label_count > 100:
        print(f"    Found {label_count} project labels (paginated)")

    # Step 6b: Fetch issue labels (paginated, separate query for complexity)
    print("  Fetching issue labels...")
    after_cursor = None
    while True:
        variables = {"after": after_cursor} if after_cursor else {}
        issue_label_data = client.execute(DISCOVER_ISSUE_LABELS_QUERY, variables)
        il_root = issue_label_data.get("issueLabels", {})
        for label in il_root.get("nodes", []):
            children = {}
            for child in label.get("children", {}).get("nodes", []):
                children[child["name"]] = child["id"]
            workspace.issue_labels[label["name"]] = {
                "id": label["id"],
                "isGroup": label["isGroup"],
                "children": children,
            }
        page_info = il_root.get("pageInfo", {})
        if page_info.get("hasNextPage"):
            after_cursor = page_info["endCursor"]
        else:
            break

    # Step 7: Fetch initiatives (paginated) for parent-initiative matching.
    # Gracefully skip if the API key lacks the initiative:read scope.
    print("  Fetching initiatives...")
    try:
        after_cursor = None
        while True:
            variables = {"after": after_cursor} if after_cursor else {}
            init_data = client.execute(DISCOVER_INITIATIVES_QUERY, variables)
            init_page = init_data.get("initiatives", {})
            for init in init_page.get("nodes", []):
                project_ids = {p["id"] for p in init.get("projects", {}).get("nodes", [])}
                workspace.initiatives[init["name"].strip().lower()] = {
                    "id": init["id"],
                    "name": init["name"],
                    "project_ids": project_ids,
                }
            page_info = init_page.get("pageInfo", {})
            if page_info.get("hasNextPage") and page_info.get("endCursor"):
                after_cursor = page_info["endCursor"]
            else:
                break
        if workspace.initiatives:
            print(f"    Found {len(workspace.initiatives)} initiatives")
    except Exception as e:
        if "forbidden" in str(e).lower() or "scope" in str(e).lower():
            print("    ⚠️  Skipped (API key lacks initiative:read scope)")
        else:
            print(f"    ⚠️  Skipped ({str(e)[:80]})")

    # Step 8: Fetch existing projects for deduplication (workspace-wide,
    # because projects may not yet be associated with the target team)
    print("  Fetching existing projects for deduplication...")
    workspace.existing_projects = fetch_all_projects(client)
    print(f"    Found {len(workspace.existing_projects)} existing projects")

    # Step 8: Fetch existing issues for deduplication
    if workspace.target_team_id:
        print("  Fetching existing issues for deduplication...")
        workspace.existing_issues = fetch_existing_issues(client, workspace.target_team_id)
        total_issues = sum(len(issues) for issues in workspace.existing_issues.values())
        print(f"    Found {total_issues} existing issues")

    return workspace


def fetch_existing_projects(client: LinearClient, team_id: str) -> dict:
    """Fetch all existing project names and IDs for a team."""
    existing_projects = {}  # lowercase name -> project id
    after = None
    
    while True:
        variables = {"teamId": team_id}
        if after:
            variables["after"] = after
        
        result = client.execute(FETCH_EXISTING_PROJECTS_QUERY, variables)
        team_data = result.get("team", {})
        projects_data = team_data.get("projects", {})
        
        for project in projects_data.get("nodes", []):
            existing_projects[project["name"].strip().lower()] = project["id"]
        
        page_info = projects_data.get("pageInfo", {})
        if page_info.get("hasNextPage"):
            after = page_info.get("endCursor")
        else:
            break
    
    return existing_projects


FETCH_ALL_PROJECTS_QUERY = """
query FetchAllProjects($after: String) {
  projects(first: 250, after: $after) {
    nodes {
      id
      name
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
"""


def fetch_all_projects(client: LinearClient) -> dict:
    """Fetch all existing project names and IDs across the entire workspace."""
    existing_projects = {}  # lowercase name -> project id
    after = None

    while True:
        variables = {}
        if after:
            variables["after"] = after

        result = client.execute(FETCH_ALL_PROJECTS_QUERY, variables)
        projects_data = result.get("projects", {})

        for project in projects_data.get("nodes", []):
            existing_projects[project["name"].strip().lower()] = project["id"]

        page_info = projects_data.get("pageInfo", {})
        if page_info.get("hasNextPage"):
            after = page_info.get("endCursor")
        else:
            break

    return existing_projects


def get_team_state_id(client: LinearClient, workspace: WorkspaceConfig, team_id: str, state_name: str) -> str:
    """Get state ID for a specific team, fetching and caching if needed."""
    if not team_id or not state_name:
        return None

    if team_id not in workspace._team_states:
        # Fetch states for this team
        states_data = client.execute(DISCOVER_TEAM_STATES_QUERY, {"teamId": team_id})
        team_states = {}
        for state in states_data.get("team", {}).get("states", {}).get("nodes", []):
            team_states[state["name"]] = state["id"]
        workspace._team_states[team_id] = team_states

    return workspace._team_states.get(team_id, {}).get(state_name)


def fetch_existing_issues(client: LinearClient, team_id: str) -> dict:
    """Fetch all existing issue titles and IDs for a team, grouped by project."""
    existing_issues = {}  # project_id -> {lowercase_title: issue_id}
    after = None
    
    while True:
        variables = {"teamId": team_id}
        if after:
            variables["after"] = after
        
        result = client.execute(FETCH_EXISTING_ISSUES_QUERY, variables)
        team_data = result.get("team", {})
        issues_data = team_data.get("issues", {})
        
        for issue in issues_data.get("nodes", []):
            project = issue.get("project")
            project_id = project["id"] if project else "none"
            
            if project_id not in existing_issues:
                existing_issues[project_id] = {}
            existing_issues[project_id][issue["title"].strip().lower()] = issue["id"]
        
        page_info = issues_data.get("pageInfo", {})
        if page_info.get("hasNextPage"):
            after = page_info.get("endCursor")
        else:
            break
    
    return existing_issues
