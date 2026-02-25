"""Team management for Linear import - auto-creation and key generation."""

import re
from .client import LinearClient
from .discovery import WorkspaceConfig

CREATE_TEAM_MUTATION = """
mutation CreateTeam($name: String!, $key: String!) {
  teamCreate(input: {
    name: $name,
    key: $key
  }) {
    success
    team {
      id
      name
      key
    }
  }
}
"""


MAX_TEAM_KEY_LENGTH = 7


def generate_team_key(name: str, existing_keys: set) -> str:
    """Generate a unique team key from a team name (max 7 chars).
    
    Strategy:
    1. If name contains an acronym in parentheses (e.g., "(IAM)"), use it
    2. Take first 2 chars of each word (up to 3 words)
    3. Take first 3 chars of first word + first char of remaining words
    4. Progressively longer prefix of cleaned name
    5. Numeric suffix fallback
    """
    # Check for acronym in parentheses
    paren_match = re.search(r'\(([A-Z][A-Z0-9]+)\)', name)
    if paren_match:
        key = paren_match.group(1)[:MAX_TEAM_KEY_LENGTH]
        if key not in existing_keys:
            return key

    words = re.findall(r'[A-Za-z0-9]+', name)

    if len(words) >= 2:
        # Strategy: first 3 chars of word 1 + first 2 chars of words 2-3
        parts = [words[0][:3].upper()]
        for w in words[1:3]:
            parts.append(w[:2].upper())
        candidate = ''.join(parts)[:MAX_TEAM_KEY_LENGTH]
        if candidate not in existing_keys:
            return candidate

        # Strategy: first 2 chars of each word (up to 3 words)
        candidate = ''.join(w[:2].upper() for w in words[:3])[:MAX_TEAM_KEY_LENGTH]
        if candidate not in existing_keys:
            return candidate

        # Strategy: first char of each word + more from first word
        initials = ''.join(w[0].upper() for w in words)[:MAX_TEAM_KEY_LENGTH]
        if len(initials) >= 2 and initials not in existing_keys:
            return initials

    # Progressively longer prefix of cleaned name
    clean = ''.join(words).upper()
    for length in range(3, min(len(clean) + 1, MAX_TEAM_KEY_LENGTH + 1)):
        candidate = clean[:length]
        if candidate not in existing_keys:
            return candidate

    # Numeric suffix fallback
    base = clean[:MAX_TEAM_KEY_LENGTH - 1]
    counter = 2
    while f"{base}{counter}" in existing_keys:
        counter += 1
    return f"{base}{counter}"


def ensure_teams(
    client: LinearClient,
    workspace: WorkspaceConfig,
    team_names: set,
    dry_run: bool = False,
) -> dict:
    """Ensure all required teams exist in the workspace, creating missing ones.
    
    Updates workspace.teams and workspace.teams_by_name with new teams.
    Returns results dict with counts.
    """
    results = {
        "created": 0,
        "skipped": 0,
        "errors": [],
    }

    if not team_names:
        return results

    print("\n🏢 Ensuring teams exist...")

    # Build set of existing team names (case-insensitive)
    existing_names = {info["name"].lower(): info for info in workspace.teams.values()}
    existing_keys = {key for key in workspace.teams.keys()}

    missing_teams = []
    for name in sorted(team_names):
        if name.lower() in existing_names:
            results["skipped"] += 1
        else:
            missing_teams.append(name)

    if not missing_teams:
        print(f"  ✓ All {len(team_names)} teams already exist")
        return results

    print(f"  Found {results['skipped']} existing, {len(missing_teams)} to create")

    for name in missing_teams:
        key = generate_team_key(name, existing_keys)

        if dry_run:
            print(f"  → Would create team: {name} (key: {key})")
            results["created"] += 1
            # Add to workspace for downstream resolution in dry-run
            workspace.teams[key] = {"id": f"dry-run-{key}", "name": name, "key": key}
            workspace.teams_by_name[name.lower()] = f"dry-run-{key}"
            existing_keys.add(key)
            continue

        try:
            result = client.execute(CREATE_TEAM_MUTATION, {
                "name": name,
                "key": key,
            })
            team_result = result.get("teamCreate", {})
            if team_result.get("success"):
                team = team_result["team"]
                team_id = team["id"]
                team_key = team["key"]
                print(f"  ✓ Created: {name} (key: {team_key})")
                results["created"] += 1
                existing_keys.add(team_key)

                # Update workspace
                workspace.teams[team_key] = {
                    "id": team_id,
                    "name": name,
                    "key": team_key,
                }
                workspace.teams_by_name[name.lower()] = team_id
            else:
                print(f"  ✗ Failed to create team: {name}")
                results["errors"].append({"team": name, "error": "Unknown error"})

            client.rate_limit_delay()

        except Exception as e:
            print(f"  ✗ Error creating team {name}: {e}")
            results["errors"].append({"team": name, "error": str(e)})

    print(f"\n  Created {results['created']} teams, {results['skipped']} already existed")
    if results["errors"]:
        print(f"  ⚠️  {len(results['errors'])} errors")

    return results
