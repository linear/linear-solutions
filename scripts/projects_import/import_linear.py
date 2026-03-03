#!/usr/bin/env python3
"""
Generic Linear Import CLI

Imports projects and issues from CSV files into Linear using a config-driven approach.

Usage:
  python import_linear.py --api-key <KEY> --config <FILE> [OPTIONS]

Options:
  --api-key KEY     Linear API key (required)
  --config FILE     Path to JSON/YAML config file (required)
  --csv PATTERN     CSV file(s) to import (glob pattern supported)
  --discover        Only discover workspace resources
  --dry-run         Validate and show what would be created
  --batch N         Import only first N items
  --projects-only   Only import projects, skip issues
  --issues-only     Only import issues (projects must exist)
  --verbose         Show detailed progress
"""

import argparse
import csv
import glob
import json
import os
import sys

# Try to import yaml, fall back to json-only if not available
try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

from lib.client import LinearClient
from lib.discovery import discover_workspace, fetch_all_projects
from lib.importers.projects import (
    import_projects, prepare_project_from_filename, prepare_projects_from_csv,
    prepare_projects_from_hierarchical, prepare_projects_from_parent_task,
    prepare_milestones_from_parent_task, import_milestones,
    reconcile_project_teams,
)
from lib.importers.issues import (
    import_issues, prepare_issues_from_csv, prepare_issues_from_hierarchical,
    prepare_issues_from_parent_task, prepare_subissues_from_parent_task,
    prepare_milestone_issues_from_parent_task,
    create_issue_relations, create_name_based_relations,
)
from lib.labels import ensure_label_groups, ensure_issue_label_groups
from lib.teams import ensure_teams
from lib.utils import extract_project_name_from_filename, convert_numbers_to_csv


def load_config(config_path: str) -> dict:
    """Load configuration file (YAML or JSON)."""
    with open(config_path, "r") as f:
        if config_path.endswith(".json"):
            return json.load(f)
        elif config_path.endswith(".yaml") or config_path.endswith(".yml"):
            if HAS_YAML:
                return yaml.safe_load(f)
            else:
                raise Exception("YAML support requires PyYAML. Install with: pip install pyyaml\nOr use a .json config file instead.")
        else:
            # Try JSON first, then YAML
            content = f.read()
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                if HAS_YAML:
                    return yaml.safe_load(content)
                raise Exception("Could not parse config file. Use .json format or install PyYAML for .yaml support.")


def load_csv(csv_path: str) -> list:
    """Load CSV file and return list of dicts."""
    rows = []
    
    # Detect delimiter
    delimiter = ","
    if csv_path.endswith(".tsv"):
        delimiter = "\t"
    
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        for row in reader:
            rows.append(row)
    
    return rows


def find_csv_files(pattern: str) -> list:
    """Find CSV files matching the pattern.
    
    Apple Numbers (.numbers) files are automatically converted to CSV.
    """
    if "*" in pattern or "?" in pattern:
        files = glob.glob(pattern)
    elif os.path.isdir(pattern):
        files = glob.glob(os.path.join(pattern, "*.csv"))
        files.extend(glob.glob(os.path.join(pattern, "*.tsv")))
    else:
        files = [pattern]

    # Auto-convert .numbers files to CSV
    converted = []
    for f in files:
        if f.lower().endswith(".numbers"):
            csv_path = convert_numbers_to_csv(f)
            converted.append(csv_path)
        else:
            converted.append(f)

    return sorted(converted)


def run_hierarchical_import(client, workspace, config, all_csv_data, csv_files, args):
    """Run import in hierarchical mode (Feature→Project, Subfeature→Issue).
    
    Two-pass import:
    1. Features become Projects (with UUID tracking)
    2. Subfeatures become Issues (linked to Projects via parent UUID)
    3. Optional: Create blocking relations between Issues
    """
    hierarchy = config.get("hierarchy", {})
    team_config = config.get("team", {})
    project_config = config.get("projects", {})
    issues_config = config.get("issues", {})

    entity_type_col = hierarchy.get("entity_type_column", "entity_type")
    entity_uuid_col = hierarchy.get("entity_uuid_column", "entity_uuid")
    parent_uuid_col = hierarchy.get("parent_uuid_column", "parent_entity_uuid")
    feature_type = hierarchy.get("feature_type", "Feature")
    subfeature_type = hierarchy.get("subfeature_type", "Subfeature")

    # Split rows by entity type
    feature_rows = [r for r in all_csv_data if r.get(entity_type_col) == feature_type]
    subfeature_rows = [r for r in all_csv_data if r.get(entity_type_col) == subfeature_type]

    print(f"\n📊 Hierarchical Data:")
    print(f"   Features (→ Projects): {len(feature_rows)}")
    print(f"   Subfeatures (→ Issues): {len(subfeature_rows)}")

    # Step 1: Auto-create teams
    team_results = {"created": 0, "skipped": 0, "errors": []}
    if team_config.get("auto_create"):
        team_col = team_config.get("team_column", "Owning Eng Team")
        fallback = team_config.get("fallback_team_name")
        unique_teams = set()
        for row in all_csv_data:
            t = row.get(team_col, "").strip()
            if t:
                unique_teams.add(t)
        if fallback:
            unique_teams.add(fallback)

        team_results = ensure_teams(client, workspace, unique_teams, dry_run=args.dry_run)

    # Step 2: Fetch existing projects for dedup (workspace-wide)
    if not workspace.existing_projects:
        print("  Fetching existing projects for deduplication...")
        workspace.existing_projects = fetch_all_projects(client)
        print(f"    Found {len(workspace.existing_projects)} existing projects")

    # Confirmation prompt
    if not args.dry_run and not args.yes:
        total = len(feature_rows) + len(subfeature_rows)
        mode = "BATCH" if args.batch else "FULL"
        print(f"\n⚠️  This will CREATE up to {total} items in Linear ({mode} import)")
        try:
            response = input("   Continue? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                print("\n❌ Import cancelled")
                sys.exit(0)
        except (KeyboardInterrupt, EOFError):
            print("\n\n❌ Import cancelled")
            sys.exit(0)

    # Step 3: Pre-scan subfeature teams for each Feature (parent project).
    # A project must include all teams its issues belong to, otherwise
    # Linear rejects the issue with "project not in same team as issue".
    parent_uuid_col = hierarchy.get("parent_uuid_column", "parent_entity_uuid")
    team_col = team_config.get("team_column", "Owning Eng Team")
    fallback_team = team_config.get("fallback_team_name")

    subfeature_teams_by_parent = {}  # parent_uuid -> set of team_ids
    for row in subfeature_rows:
        parent_uuid = row.get(parent_uuid_col, "").strip()
        if not parent_uuid:
            continue
        sub_team_name = row.get(team_col, "").strip()
        sub_team_id = workspace.teams_by_name.get(sub_team_name.lower()) if sub_team_name else None
        if not sub_team_id and fallback_team:
            sub_team_id = workspace.teams_by_name.get(fallback_team.lower())
        if sub_team_id:
            if parent_uuid not in subfeature_teams_by_parent:
                subfeature_teams_by_parent[parent_uuid] = set()
            subfeature_teams_by_parent[parent_uuid].add(sub_team_id)

    # Step 4: Ensure labels exist
    label_results = ensure_label_groups(client, workspace, config, all_csv_data, dry_run=args.dry_run)
    ensure_issue_label_groups(client, workspace, config, all_csv_data, dry_run=args.dry_run)

    # Step 5: Prepare and import projects (Features)
    project_results = {"success": 0, "failed": 0, "skipped": 0, "errors": [], "created_projects": {}}
    if not args.issues_only and feature_rows:
        print("\n" + "=" * 60)
        print("IMPORTING PROJECTS (from Features)")
        print("=" * 60)

        csv_basename = os.path.basename(csv_files[0]) if len(csv_files) == 1 else "multiple files"
        projects = prepare_projects_from_hierarchical(feature_rows, config, workspace)

        # Inject subfeature teams into each project's team_ids
        for project in projects:
            # Find the feature's UUID for this project name
            for row in feature_rows:
                feat_name = row.get(project_config.get("columns", {}).get("name", "entity_name"), "").strip()
                if feat_name == project["name"]:
                    feat_uuid = row.get(entity_uuid_col, "").strip()
                    extra_teams = subfeature_teams_by_parent.get(feat_uuid, set())
                    for tid in extra_teams:
                        if tid not in project["team_ids"]:
                            project["team_ids"].append(tid)
                    break
        for p in projects:
            p["source_file"] = csv_basename
        project_results = import_projects(
            client, projects, workspace, config,
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

    # Step 6: Build UUID→project_id map
    uuid_to_project = {}
    name_col = project_config.get("columns", {}).get("name", "entity_name")
    for row in feature_rows:
        uuid = row.get(entity_uuid_col, "").strip()
        name = row.get(name_col, "").strip()
        project_id = project_results["created_projects"].get(name)
        if uuid and project_id:
            uuid_to_project[uuid] = project_id

    print(f"\n  📎 Mapped {len(uuid_to_project)} Feature UUIDs to Project IDs")

    # Step 6b: Reconcile project teams - ensure each project includes all
    # teams that its subfeature issues will need (handles both new and existing projects)
    if subfeature_teams_by_parent and not args.issues_only:
        reconcile_project_teams(
            client,
            project_results,
            subfeature_teams_by_parent,
            feature_rows,
            entity_uuid_col,
            name_col,
            dry_run=args.dry_run,
        )

    # Step 7: Prepare and import issues (Subfeatures)
    issue_results = {"success": 0, "failed": 0, "skipped": 0, "errors": [], "created_issues": {}}
    if issues_config.get("enabled", True) and not args.projects_only and subfeature_rows:
        print("\n" + "=" * 60)
        print("IMPORTING ISSUES (from Subfeatures)")
        print("=" * 60)

        issues = prepare_issues_from_hierarchical(subfeature_rows, config, workspace, uuid_to_project)
        for iss in issues:
            iss["source_file"] = csv_basename
        issue_results = import_issues(
            client, issues, workspace, config, {},
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

    # Step 8: Create blocking relations
    relation_results = {"created": 0, "skipped": 0, "errors": []}
    relations_config = config.get("relations", {})
    if relations_config.get("enabled") and not args.projects_only and not args.issues_only:
        # Build uuid→linear map for both projects and issues
        uuid_to_linear = {}
        for uuid, pid in uuid_to_project.items():
            if pid and pid != "dry-run":
                uuid_to_linear[uuid] = ("project", pid)
        for uuid, iid in issue_results.get("created_issues", {}).items():
            if iid and iid != "dry-run":
                uuid_to_linear[uuid] = ("issue", iid)

        blocking_col = relations_config.get("blocking_column", "Is blocking ids")
        separator = relations_config.get("uuid_separator", ", ")

        relation_results = create_issue_relations(
            client, all_csv_data, entity_uuid_col, blocking_col, separator,
            uuid_to_linear, dry_run=args.dry_run,
        )

    return label_results, project_results, issue_results, team_results, relation_results


def run_parent_task_import(client, workspace, config, all_csv_data, csv_files, args):
    """Run import in parent_task mode (Asana-style hierarchy).
    
    Hierarchy is inferred from the Parent task column:
      depth 0 (no parent)  → Projects
      depth 1              → Milestones (within parent project)
      depth 2+             → Issues (linked to milestone via projectMilestoneId)
    """
    hierarchy = config.get("hierarchy", {})
    issues_config = config.get("issues", {})
    project_config = config.get("projects", {})
    name_col = hierarchy.get("name_column", "Name")
    parent_col = hierarchy.get("parent_column", "Parent task")

    # ------------------------------------------------------------------
    # Step 1: Build hierarchy by computing depth for every row
    # ------------------------------------------------------------------
    parent_of = {}  # task name -> parent name
    rows_by_name = {}  # task name -> row (last wins for dupes)
    for row in all_csv_data:
        name = row.get(name_col, "").strip()
        parent = row.get(parent_col, "").strip()
        if name:
            parent_of[name] = parent
            rows_by_name[name] = row

    # Names that are themselves parents of other tasks
    is_parent_name = set(parent_of.values()) - {""}

    # Iterative depth calculation
    depth_cache = {}

    def get_depth(name):
        if name in depth_cache:
            return depth_cache[name]
        depth = 0
        current = name
        seen = set()
        while current in parent_of and parent_of[current] and current not in seen:
            seen.add(current)
            current = parent_of[current]
            depth += 1
        depth_cache[name] = depth
        return depth

    depth_0_rows = []  # projects
    depth_1_rows = []  # issues
    depth_2_rows = []  # sub-issues

    for row in all_csv_data:
        name = row.get(name_col, "").strip()
        if not name:
            continue
        d = get_depth(name)
        if d == 0:
            depth_0_rows.append(row)
        elif d == 1:
            depth_1_rows.append(row)
        else:
            depth_2_rows.append(row)

    print(f"\n📊 Parent-Task Hierarchy:")
    print(f"   Depth 0 (→ Projects):    {len(depth_0_rows)}")
    print(f"   Depth 1 (→ Milestones):  {len(depth_1_rows)}")
    print(f"   Depth 2+ (→ Issues):     {len(depth_2_rows)}")

    # Build a mapping: child_name → top-level ancestor name (project name)
    # Used so sub-issues inherit the correct project.
    parent_name_to_project = {}
    for name in parent_of:
        current = name
        seen = set()
        while parent_of.get(current) and current not in seen:
            seen.add(current)
            current = parent_of[current]
        # current is now the top-level ancestor
        if current != name:
            parent_name_to_project[name] = current

    # ------------------------------------------------------------------
    # Step 2: Fetch existing projects for dedup
    # ------------------------------------------------------------------
    if not workspace.existing_projects:
        print("  Fetching existing projects for deduplication...")
        workspace.existing_projects = fetch_all_projects(client)
        print(f"    Found {len(workspace.existing_projects)} existing projects")

    # ------------------------------------------------------------------
    # Step 3: Confirmation prompt
    # ------------------------------------------------------------------
    if not args.dry_run and not args.yes:
        total = len(depth_0_rows) + len(depth_1_rows) + len(depth_2_rows)
        mode = "BATCH" if args.batch else "FULL"
        print(f"\n⚠️  This will CREATE up to {total} items in Linear ({mode} import)")
        try:
            response = input("   Continue? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                print("\n❌ Import cancelled")
                sys.exit(0)
        except (KeyboardInterrupt, EOFError):
            print("\n\n❌ Import cancelled")
            sys.exit(0)

    # ------------------------------------------------------------------
    # Step 4: Ensure target team exists
    # ------------------------------------------------------------------
    team_config = config.get("team", {})
    target_key = team_config.get("target_key")
    target_name = team_config.get("target_name")

    if not workspace.target_team_id and target_key and target_name:
        print(f"\n🏢 Target team '{target_name}' ({target_key}) not found – creating...")
        if args.dry_run:
            print(f"  → Would create team: {target_name} (key: {target_key})")
            workspace.target_team_id = "dry-run"
        else:
            from lib.teams import CREATE_TEAM_MUTATION
            try:
                result = client.execute(CREATE_TEAM_MUTATION, {"name": target_name, "key": target_key})
                team_data = result.get("teamCreate", {})
                if team_data.get("success"):
                    team = team_data["team"]
                    workspace.target_team_id = team["id"]
                    workspace.teams[team["key"]] = {"id": team["id"], "name": team["name"], "key": team["key"]}
                    workspace.teams_by_name[team["name"].lower()] = team["id"]
                    print(f"  ✓ Created team: {team['name']} (key: {team['key']}, id: {team['id']})")
                else:
                    print(f"  ✗ Failed to create team")
            except Exception as e:
                print(f"  ✗ Error creating team: {e}")

    if not workspace.target_team_id:
        print(f"\n❌ Error: No target team available. Set team.target_key and team.target_name in config.")
        sys.exit(1)

    # ------------------------------------------------------------------
    # Step 5: Ensure labels exist
    # ------------------------------------------------------------------
    label_results = ensure_label_groups(client, workspace, config, all_csv_data, dry_run=args.dry_run)
    ensure_issue_label_groups(client, workspace, config, all_csv_data, dry_run=args.dry_run)

    # ------------------------------------------------------------------
    # Step 6: Import projects (depth 0)
    # ------------------------------------------------------------------
    project_results = {"success": 0, "failed": 0, "skipped": 0, "errors": [], "created_projects": {}}
    if not args.issues_only and depth_0_rows:
        print("\n" + "=" * 60)
        print("IMPORTING PROJECTS (depth 0 - top-level tasks)")
        print("=" * 60)

        csv_basename = os.path.basename(csv_files[0]) if len(csv_files) == 1 else "multiple files"
        projects = prepare_projects_from_parent_task(depth_0_rows, config, workspace)
        for p in projects:
            p["source_file"] = csv_basename

        project_results = import_projects(
            client, projects, workspace, config,
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

    # Build name → project_id map
    name_to_project_id = {}
    for name, pid in project_results.get("created_projects", {}).items():
        if pid:
            name_to_project_id[name] = pid
    print(f"\n  📎 Mapped {len(name_to_project_id)} task names to Project IDs")

    # ------------------------------------------------------------------
    # Step 7: Import milestones (depth 1)
    # ------------------------------------------------------------------
    milestone_results = {"created": 0, "skipped": 0, "errors": [], "name_to_id": {}}
    name_to_milestone_id = {}

    if issues_config.get("enabled", True) and not args.projects_only and depth_1_rows:
        print("\n" + "=" * 60)
        print("IMPORTING MILESTONES (depth 1 - direct children)")
        print("=" * 60)

        milestones = prepare_milestones_from_parent_task(
            depth_1_rows, config, workspace, name_to_project_id,
        )

        milestone_results = import_milestones(
            client, milestones,
            dry_run=args.dry_run,
        )
        name_to_milestone_id = milestone_results.get("name_to_id", {})

    print(f"\n  📎 Mapped {len(name_to_milestone_id)} task names to Milestone IDs")

    # ------------------------------------------------------------------
    # Step 8: Import issues under milestones (depth 2+)
    # ------------------------------------------------------------------
    issue_results = {"success": 0, "failed": 0, "skipped": 0, "errors": [], "created_issues": {}}
    name_to_issue_id = {}

    if issues_config.get("enabled", True) and not args.projects_only and depth_2_rows:
        print("\n" + "=" * 60)
        print("IMPORTING ISSUES (depth 2+ - under milestones)")
        print("=" * 60)

        csv_basename = os.path.basename(csv_files[0]) if len(csv_files) == 1 else "multiple files"
        issues = prepare_milestone_issues_from_parent_task(
            depth_2_rows, config, workspace,
            name_to_milestone_id, name_to_project_id, parent_name_to_project,
        )
        for iss in issues:
            iss["source_file"] = csv_basename
            iss["entity_uuid"] = iss.get("task_name", iss["title"])

        issue_results = import_issues(
            client, issues, workspace, config, {},
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

        for task_name, linear_id in issue_results.get("created_issues", {}).items():
            if linear_id and linear_id != "dry-run":
                name_to_issue_id[task_name] = linear_id

    print(f"  📎 Mapped {len(name_to_issue_id)} task names to Issue IDs")

    # ------------------------------------------------------------------
    # Step 9: Create blocking relations
    # ------------------------------------------------------------------
    relation_results = {"created": 0, "skipped": 0, "errors": []}
    relations_config = config.get("relations", {})
    if relations_config.get("enabled") and not args.projects_only and not args.issues_only:
        blocking_col = relations_config.get("blocking_column", "Blocked By (Dependencies)")
        separator = relations_config.get("separator", ",")

        relation_results = create_name_based_relations(
            client, all_csv_data, name_col, blocking_col, separator,
            name_to_issue_id, dry_run=args.dry_run,
        )

    # No team auto-creation in parent_task mode
    team_results = {"created": 0, "skipped": 0, "errors": []}

    return label_results, project_results, milestone_results, issue_results, team_results, relation_results


def main():
    parser = argparse.ArgumentParser(
        description="Import projects and issues from CSV into Linear",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Discover workspace resources
  python import_linear.py --api-key KEY --config configs/team.yaml --discover

  # Dry run with single CSV
  python import_linear.py --api-key KEY --config configs/team.yaml --csv data.csv --dry-run

  # Import multiple CSVs
  python import_linear.py --api-key KEY --config configs/team.yaml --csv "*.csv"

  # Import with batch limit
  python import_linear.py --api-key KEY --config configs/team.yaml --csv "*.csv" --batch 5

  # Projects only
  python import_linear.py --api-key KEY --config configs/team.yaml --csv "*.csv" --projects-only
        """
    )

    parser.add_argument("--api-key", required=True, help="Linear API key")
    parser.add_argument("--config", required=True, help="Path to JSON/YAML config file")
    parser.add_argument("--csv", help="CSV file(s) to import (glob pattern supported)")
    parser.add_argument("--discover", action="store_true", help="Only discover workspace resources")
    parser.add_argument("--dry-run", action="store_true", help="Validate and show what would be created")
    parser.add_argument("--batch", type=int, metavar="N", help="Import only first N items per category")
    parser.add_argument("--projects-only", action="store_true", help="Only import projects")
    parser.add_argument("--issues-only", action="store_true", help="Only import issues")
    parser.add_argument("--verbose", action="store_true", help="Show detailed progress")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompt")

    args = parser.parse_args()

    # Load config
    print(f"📄 Loading config: {args.config}")
    try:
        config = load_config(args.config)
    except Exception as e:
        print(f"\n❌ Failed to load config: {e}")
        sys.exit(1)

    print(f"   Config: {config.get('name', 'Unnamed')}")

    # Initialize client
    client = LinearClient(args.api_key, verbose=args.verbose)

    # Discover workspace
    try:
        workspace = discover_workspace(client, config)
    except Exception as e:
        print(f"\n❌ Failed to discover workspace: {e}")
        sys.exit(1)

    # Discovery mode - just print and exit
    if args.discover:
        workspace.print_summary()
        sys.exit(0)

    # Validate required teams (only for standard mode)
    team_config = config.get("team", {})
    import_mode = config.get("import_mode", "standard")
    if import_mode not in ("hierarchical", "parent_task"):
        if team_config.get("target_key") and not workspace.target_team_id:
            print(f"\n❌ Error: Target team '{team_config['target_key']}' not found in workspace")
            sys.exit(1)

    # Check for CSV files
    if not args.csv:
        print("\n❌ Error: --csv argument required for import")
        sys.exit(1)

    # Find CSV files
    csv_files = find_csv_files(args.csv)
    if not csv_files:
        print(f"\n❌ Error: No CSV files found matching '{args.csv}'")
        sys.exit(1)

    print(f"\n📁 Found {len(csv_files)} CSV file(s)")

    # Load all CSV data
    all_csv_data = []
    csv_data_by_file = {}
    for csv_file in csv_files:
        print(f"  Loading: {os.path.basename(csv_file)}")
        csv_data = load_csv(csv_file)
        all_csv_data.extend(csv_data)
        csv_data_by_file[csv_file] = csv_data

    # ========================
    # PARENT_TASK MODE
    # ========================
    if import_mode == "parent_task":
        results = run_parent_task_import(client, workspace, config, all_csv_data, csv_files, args)
        if results is None:
            sys.exit(0)
        label_results, project_results, milestone_results, issue_results, team_results, relation_results = results

        print("\n" + "=" * 60)
        print("IMPORT SUMMARY")
        print("=" * 60)

        if not args.issues_only:
            print(f"\n  📦 PROJECTS:")
            print(f"     ✓ Successful: {project_results.get('success', 0)}")
            print(f"     ✗ Failed: {project_results.get('failed', 0)}")
            print(f"     ⏭ Skipped: {project_results.get('skipped', 0)}")

        if not args.projects_only:
            print(f"\n  🏁 MILESTONES:")
            print(f"     ✓ Created: {milestone_results.get('created', 0)}")
            print(f"     ⏭ Skipped: {milestone_results.get('skipped', 0)}")

            print(f"\n  📝 ISSUES (under milestones):")
            print(f"     ✓ Successful: {issue_results.get('success', 0)}")
            print(f"     ✗ Failed: {issue_results.get('failed', 0)}")
            print(f"     ⏭ Skipped: {issue_results.get('skipped', 0)}")

        if label_results.get("groups_created") or label_results.get("labels_created"):
            print(f"\n  🏷️  LABELS:")
            print(f"     ✓ Groups created: {label_results.get('groups_created', 0)}")
            print(f"     ✓ Labels created: {label_results.get('labels_created', 0)}")

        if relation_results.get("created"):
            print(f"\n  🔗 RELATIONS:")
            print(f"     ✓ Created: {relation_results.get('created', 0)}")
            print(f"     ⏭ Skipped: {relation_results.get('skipped', 0)}")

        rl = client.get_rate_limit_stats()
        print(f"\n  📊 API STATS:")
        print(f"     Requests: {rl['total_requests']}")
        if rl["rate_limited"]:
            print(f"     Rate limited: {rl['rate_limited']} (retried successfully)")
        if rl["retries"]:
            print(f"     Total retries: {rl['retries']}")
        if rl["remaining_quota"] is not None:
            print(f"     Remaining quota: {rl['remaining_quota']}")

        unmatched = getattr(workspace, '_unmatched_assignees', set())
        if unmatched:
            print(f"\n  ⚠️  UNMATCHED ASSIGNEES ({len(unmatched)}):")
            for name in sorted(unmatched):
                print(f"     • {name}")

        all_errors = (
            label_results.get("errors", []) +
            project_results.get("errors", []) +
            milestone_results.get("errors", []) +
            issue_results.get("errors", []) +
            relation_results.get("errors", [])
        )
        if all_errors:
            print(f"\n  ❌ Errors ({len(all_errors)}):")
            for err in all_errors[:10]:
                name = err.get("project") or err.get("issue") or err.get("name") or err.get("label")
                print(f"\n    {name}:")
                print(f"    {err.get('error', 'Unknown')}")
            if len(all_errors) > 10:
                print(f"\n    ... and {len(all_errors) - 10} more errors")

        print("\n" + "=" * 60)

        total_failed = project_results.get("failed", 0) + issue_results.get("failed", 0)
        sys.exit(0 if total_failed == 0 else 1)

    # ========================
    # HIERARCHICAL MODE
    # ========================
    if import_mode == "hierarchical":
        results = run_hierarchical_import(client, workspace, config, all_csv_data, csv_files, args)
        if results is None:
            sys.exit(0)
        label_results, project_results, issue_results, team_results, relation_results = results

        # Print summary
        print("\n" + "=" * 60)
        print("IMPORT SUMMARY")
        print("=" * 60)

        if team_results.get("created"):
            print(f"\n  🏢 TEAMS:")
            print(f"     ✓ Created: {team_results.get('created', 0)}")
            print(f"     ⏭ Existing: {team_results.get('skipped', 0)}")

        if label_results.get("groups_created") or label_results.get("labels_created"):
            print(f"\n  🏷️  LABELS:")
            print(f"     ✓ Groups created: {label_results.get('groups_created', 0)}")
            print(f"     ✓ Labels created: {label_results.get('labels_created', 0)}")

        if not args.issues_only:
            print(f"\n  📦 PROJECTS:")
            print(f"     ✓ Successful: {project_results.get('success', 0)}")
            print(f"     ✗ Failed: {project_results.get('failed', 0)}")
            print(f"     ⏭ Skipped: {project_results.get('skipped', 0)}")

        if not args.projects_only:
            print(f"\n  📝 ISSUES:")
            print(f"     ✓ Successful: {issue_results.get('success', 0)}")
            print(f"     ✗ Failed: {issue_results.get('failed', 0)}")
            print(f"     ⏭ Skipped: {issue_results.get('skipped', 0)}")

        if relation_results.get("created"):
            print(f"\n  🔗 RELATIONS:")
            print(f"     ✓ Created: {relation_results.get('created', 0)}")
            print(f"     ⏭ Skipped: {relation_results.get('skipped', 0)}")

        # Rate limit stats
        rl = client.get_rate_limit_stats()
        print(f"\n  📊 API STATS:")
        print(f"     Requests: {rl['total_requests']}")
        if rl["rate_limited"]:
            print(f"     Rate limited: {rl['rate_limited']} (retried successfully)")
        if rl["retries"]:
            print(f"     Total retries: {rl['retries']}")
        if rl["remaining_quota"] is not None:
            print(f"     Remaining quota: {rl['remaining_quota']}")

        # Report unmatched assignees
        unmatched = getattr(workspace, '_unmatched_assignees', set())
        if unmatched:
            print(f"\n  ⚠️  UNMATCHED ASSIGNEES ({len(unmatched)}):")
            for name in sorted(unmatched):
                print(f"     • {name}")

        # Print errors
        all_errors = (
            team_results.get("errors", []) +
            label_results.get("errors", []) +
            project_results.get("errors", []) +
            issue_results.get("errors", []) +
            relation_results.get("errors", [])
        )
        if all_errors:
            print(f"\n  ❌ Errors ({len(all_errors)}):")
            for err in all_errors[:10]:
                name = err.get("project") or err.get("issue") or err.get("team") or err.get("label")
                print(f"\n    {name}:")
                print(f"    {err.get('error', 'Unknown')}")
            if len(all_errors) > 10:
                print(f"\n    ... and {len(all_errors) - 10} more errors")

        print("\n" + "=" * 60)

        total_failed = project_results.get("failed", 0) + issue_results.get("failed", 0)
        sys.exit(0 if total_failed == 0 else 1)

    # ========================
    # STANDARD MODE (existing behavior)
    # ========================

    # Determine project source
    project_config = config.get("projects", {})
    project_source = project_config.get("source", "filename")
    issues_enabled = config.get("issues", {}).get("enabled", True)

    # Count projects and issues for summary (without full preparation yet)
    project_count = 0
    issue_count = 0
    if project_source == "filename":
        project_count = len(csv_files)
        if issues_enabled and not args.projects_only:
            issue_count = len(all_csv_data)
    else:
        # Count unique project names
        name_col = project_config.get("columns", {}).get("name", "Projects")
        unique_names = set()
        for row in all_csv_data:
            name = row.get(name_col, "").strip()
            if name:
                unique_names.add(name)
        project_count = len(unique_names)
        if issues_enabled and not args.projects_only:
            issue_count = len([r for r in all_csv_data if r.get(name_col, "").strip()])

    print(f"\n📊 Data Summary:")
    print(f"   Projects: {project_count}")
    print(f"   Issues: {issue_count}")

    # Confirmation prompt for actual imports
    if not args.dry_run and not args.yes:
        mode = "BATCH" if args.batch else "FULL"
        print(f"\n⚠️  This will CREATE real projects and issues in Linear ({mode} import)")
        try:
            response = input("   Continue? [y/N]: ").strip().lower()
            if response not in ("y", "yes"):
                print("\n❌ Import cancelled")
                sys.exit(0)
        except (KeyboardInterrupt, EOFError):
            print("\n\n❌ Import cancelled")
            sys.exit(0)

    # Initialize results tracking
    project_results = {"success": 0, "failed": 0, "skipped": 0, "created_projects": {}}
    issue_results = {"success": 0, "failed": 0, "skipped": 0}
    label_results = {"groups_created": 0, "labels_created": 0}

    # STEP 1: Ensure label groups exist BEFORE preparing projects/issues
    # This updates the workspace cache so projects can resolve label IDs
    if not args.issues_only and project_count > 0:
        label_results = ensure_label_groups(
            client,
            workspace,
            config,
            all_csv_data,
            dry_run=args.dry_run,
        )

    # STEP 1b: Ensure issue label groups exist (for issue-level labels)
    issue_label_results = ensure_issue_label_groups(
        client, workspace, config, all_csv_data, dry_run=args.dry_run,
    )

    # STEP 2: NOW prepare projects (after labels exist in workspace cache)
    all_projects = []
    all_issues = []
    file_to_project = {}

    for csv_file in csv_files:
        csv_data = csv_data_by_file[csv_file]
        
        if project_source == "filename":
            # Create project from filename
            project = prepare_project_from_filename(csv_file, config, workspace)
            if project["name"] not in [p["name"] for p in all_projects]:
                project["source_file"] = os.path.basename(csv_file)
                all_projects.append(project)
            file_to_project[csv_file] = project["name"]
            
            # Prepare issues with project reference and source file (if enabled)
            if issues_enabled and not args.projects_only:
                issues = prepare_issues_from_csv(csv_data, config, workspace)
                for issue in issues:
                    issue["project"] = project["name"]
                    issue["source_file"] = os.path.basename(csv_file)
                all_issues.extend(issues)
        else:
            # Projects from column
            projects = prepare_projects_from_csv(csv_data, config, workspace)
            for project in projects:
                if project["name"] not in [p["name"] for p in all_projects]:
                    project["source_file"] = os.path.basename(csv_file)
                    all_projects.append(project)
            
            # Issues already have project from column (if enabled)
            if issues_enabled and not args.projects_only:
                issues = prepare_issues_from_csv(csv_data, config, workspace)
                for issue in issues:
                    issue["source_file"] = os.path.basename(csv_file)
                all_issues.extend(issues)

    # Import projects
    if not args.issues_only and all_projects:
        print("\n" + "=" * 60)
        print("IMPORTING PROJECTS")
        print("=" * 60)
        project_results = import_projects(
            client,
            all_projects,
            workspace,
            config,
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

    # Build project map for issue linking
    # For existing projects, we need to query their IDs
    project_map = project_results.get("created_projects", {})
    
    # Import issues
    if not args.projects_only and all_issues:
        print("\n" + "=" * 60)
        print("IMPORTING ISSUES")
        print("=" * 60)
        issue_results = import_issues(
            client,
            all_issues,
            workspace,
            config,
            project_map,
            dry_run=args.dry_run,
            batch_size=args.batch,
        )

    # Print summary
    print("\n" + "=" * 60)
    print("IMPORT SUMMARY")
    print("=" * 60)
    
    if not args.issues_only and (label_results.get("groups_created") or label_results.get("labels_created")):
        print(f"\n  🏷️  LABELS:")
        print(f"     ✓ Groups created: {label_results.get('groups_created', 0)}")
        print(f"     ✓ Labels created: {label_results.get('labels_created', 0)}")
    
    if not args.issues_only:
        print(f"\n  📦 PROJECTS:")
        print(f"     ✓ Successful: {project_results['success']}")
        print(f"     ✗ Failed: {project_results['failed']}")
        print(f"     ⏭ Skipped: {project_results['skipped']}")
    
    if not args.projects_only:
        print(f"\n  📝 ISSUES:")
        print(f"     ✓ Successful: {issue_results['success']}")
        print(f"     ✗ Failed: {issue_results['failed']}")
        print(f"     ⏭ Skipped: {issue_results['skipped']}")
    
    # Rate limit stats
    rl = client.get_rate_limit_stats()
    print(f"\n  📊 API STATS:")
    print(f"     Requests: {rl['total_requests']}")
    if rl["rate_limited"]:
        print(f"     Rate limited: {rl['rate_limited']} (retried successfully)")
    if rl["retries"]:
        print(f"     Total retries: {rl['retries']}")
    if rl["remaining_quota"] is not None:
        print(f"     Remaining quota: {rl['remaining_quota']}")

    # Report unmatched assignees
    unmatched = getattr(workspace, '_unmatched_assignees', set())
    if unmatched:
        print(f"\n  ⚠️  UNMATCHED ASSIGNEES ({len(unmatched)}):")
        for name in sorted(unmatched):
            print(f"     • {name}")
        print(f"\n     To fix: Add an assignee_map to your config, or request a")
        print(f"     name-to-email mapping file from the customer.")

    # Print errors
    all_errors = label_results.get("errors", []) + project_results.get("errors", []) + issue_results.get("errors", [])
    if all_errors:
        print(f"\n  ❌ Errors ({len(all_errors)}):")
        for err in all_errors[:10]:
            name = err.get("project") or err.get("issue")
            print(f"\n    {name}:")
            print(f"    {err['error']}")
        if len(all_errors) > 10:
            print(f"\n    ... and {len(all_errors) - 10} more errors")

    print("\n" + "=" * 60)

    # Exit with error code if failures
    total_failed = project_results.get("failed", 0) + issue_results.get("failed", 0)
    sys.exit(0 if total_failed == 0 else 1)


if __name__ == "__main__":
    main()
