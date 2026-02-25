#!/usr/bin/env python3
"""
Update existing projects with labels, updates, and members.

This script is for retroactively updating projects that were created
before labels were properly assigned.

Usage:
  python update_existing_projects.py --api-key <KEY> --config <FILE> --csv <FILE> [--dry-run]
"""

import argparse
import csv
import json
import sys

from lib.client import LinearClient
from lib.discovery import discover_workspace
from lib.importers.projects import prepare_projects_from_csv, resolve_user_id

UPDATE_PROJECT_MUTATION = """
mutation UpdateProject($id: String!, $labelIds: [String!], $memberIds: [String!]) {
  projectUpdate(id: $id, input: {
    labelIds: $labelIds,
    memberIds: $memberIds
  }) {
    success
    project {
      id
      name
    }
  }
}
"""

CREATE_PROJECT_UPDATE_MUTATION = """
mutation CreateProjectUpdate($projectId: String!, $body: String!, $health: ProjectUpdateHealthType) {
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


def load_config(config_path: str) -> dict:
    with open(config_path, "r") as f:
        return json.load(f)


def load_csv(csv_path: str) -> list:
    rows = []
    delimiter = "\t" if csv_path.endswith(".tsv") else ","
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        for row in reader:
            rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Update existing projects with labels and updates")
    parser.add_argument("--api-key", required=True, help="Linear API key")
    parser.add_argument("--config", required=True, help="Path to config file")
    parser.add_argument("--csv", required=True, help="CSV file with project data")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be updated")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation")

    args = parser.parse_args()

    # Load config and CSV
    print(f"📄 Loading config: {args.config}")
    config = load_config(args.config)
    
    print(f"📄 Loading CSV: {args.csv}")
    csv_data = load_csv(args.csv)

    # Initialize client and discover workspace
    client = LinearClient(args.api_key)
    workspace = discover_workspace(client, config)

    # Prepare projects to get label IDs and other data
    print("\n📊 Preparing project data...")
    projects = prepare_projects_from_csv(csv_data, config, workspace)
    
    print(f"\n   Found {len(projects)} projects in CSV")
    
    # Match projects to existing ones
    updates_needed = []
    for project in projects:
        name = project["name"]
        existing_id = workspace.existing_projects.get(name.strip().lower())
        
        if existing_id:
            label_ids = project.get("label_ids", []) + project.get("conditional_label_ids", [])
            member_ids = project.get("member_ids", [])
            health = project.get("health")
            update_text = project.get("update_text")
            
            if label_ids or member_ids or health or update_text:
                updates_needed.append({
                    "id": existing_id,
                    "name": name,
                    "label_ids": label_ids,
                    "member_ids": member_ids,
                    "health": health,
                    "update_text": update_text,
                })

    print(f"   {len(updates_needed)} projects need updates")

    if not updates_needed:
        print("\n✅ No updates needed")
        return

    # Confirmation
    if not args.dry_run and not args.yes:
        print(f"\n⚠️  This will UPDATE {len(updates_needed)} projects in Linear")
        response = input("   Continue? [y/N]: ").strip().lower()
        if response not in ("y", "yes"):
            print("\n❌ Cancelled")
            sys.exit(0)

    # Process updates
    print("\n" + "=" * 60)
    print("UPDATING PROJECTS")
    print("=" * 60 + "\n")

    project_config = config.get("projects", {})
    health_map = project_config.get("health_map", {
        "On Track": "onTrack",
        "At Risk": "atRisk",
        "Off Track": "offTrack"
    })

    success_count = 0
    for i, update in enumerate(updates_needed, 1):
        print(f"[{i}/{len(updates_needed)}] {update['name']}")
        
        if args.dry_run:
            print(f"  → Labels: {len(update['label_ids'])}")
            print(f"  → Members: {len(update['member_ids'])}")
            print(f"  → Health: {update['health'] or 'None'}")
            if update['update_text']:
                preview = update['update_text'][:40] + "..." if len(update['update_text']) > 40 else update['update_text']
                print(f"  → Update: {preview}")
            success_count += 1
            continue

        project_id = update["id"]
        
        # Update labels and members in one call
        if update["label_ids"] or update["member_ids"]:
            try:
                update_vars = {"id": project_id}
                if update["label_ids"]:
                    update_vars["labelIds"] = update["label_ids"]
                if update["member_ids"]:
                    update_vars["memberIds"] = update["member_ids"]
                
                result = client.execute(UPDATE_PROJECT_MUTATION, update_vars)
                if result.get("projectUpdate", {}).get("success"):
                    parts = []
                    if update["label_ids"]:
                        parts.append(f"{len(update['label_ids'])} labels")
                    if update["member_ids"]:
                        parts.append(f"{len(update['member_ids'])} members")
                    print(f"  ✓ Added {', '.join(parts)}")
                else:
                    print(f"  ⚠️ Update failed")
            except Exception as e:
                print(f"  ⚠️ Update error: {str(e)[:60]}")
            client.rate_limit_delay()
        
        # Create update
        if update["health"] or update["update_text"]:
            try:
                body = update["update_text"] if update["update_text"] else f"Project status: {update['health']}"
                update_vars = {
                    "projectId": project_id,
                    "body": body
                }
                if update["health"] and update["health"] in health_map:
                    update_vars["health"] = health_map[update["health"]]
                
                result = client.execute(CREATE_PROJECT_UPDATE_MUTATION, update_vars)
                if result.get("projectUpdateCreate", {}).get("success"):
                    print(f"  ✓ Added project update (health: {update['health'] or 'N/A'})")
            except Exception as e:
                print(f"  ⚠️ Update error: {str(e)[:50]}")
            client.rate_limit_delay()
        
        success_count += 1

    print("\n" + "=" * 60)
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Updated {success_count}/{len(updates_needed)} projects")
    print("=" * 60)


if __name__ == "__main__":
    main()
