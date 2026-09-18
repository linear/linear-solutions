---
name: linear-triage-setup
description: One-time setup for the Linear triage automation workflow. Verifies prerequisites, creates the "Claude Code" label in Linear, and registers the RemoteTrigger that polls every 15 minutes. Run this once before using /linear-triage-poller.
---

You are setting up the Linear Triage Automation system. Execute each step in order and report the result of each.

## Step 1 — Verify prerequisites

Run these checks in parallel:

```bash
# 1a. gh CLI authenticated?
gh auth status

# 1b. Config file exists?
cat ~/.claude/linear-triage-config.json 2>/dev/null || echo "CONFIG_MISSING"
```

If `gh auth status` fails: stop and tell the user to run `gh auth login` first.

If `CONFIG_MISSING`: stop and tell the user to copy the example config:

```bash
cp <plugin-dir>/config.example.json ~/.claude/linear-triage-config.json
$EDITOR ~/.claude/linear-triage-config.json
```

They must set `repo`, `repoUrl`, and `team` before continuing. Re-run `/linear-triage-setup` once the config is in place.

## Step 2 — Validate config

Read `~/.claude/linear-triage-config.json` and confirm these fields are set (not the placeholder values from the example):

- `repo` — exists OR `repoUrl` is set so it can be cloned
- `team` — set to a real Linear team key (not `"YOUR_TEAM_KEY"`)
- `label` — defaults to `"Claude Code"` if absent

If `repo` does not exist locally and `repoUrl` is unset, stop and ask the user to set `repoUrl`.

If `repo` exists locally, verify it has a git remote:

```bash
cd <repo from config> && git remote -v
```

If no remote: stop and tell the user to configure one.

## Step 3 — Create the trigger label in Linear

Use `mcp__claude_ai_Linear__create_issue_label` to create a label named the value of `label` (default `"Claude Code"`) with color `#7C3AED` (purple). If the tool errors with "already exists", that's fine — skip and continue.

## Step 4 — Register the RemoteTrigger

Use the `schedule` skill or `RemoteTrigger` tool to create a scheduled remote agent with:
- **Cron**: `*/15 * * * *`
- **Prompt**: `/linear-triage-poller`
- **Description**: "Poll Linear triage queue and delegate eligible issues to Claude Code"

## Step 5 — Confirm setup

Print a summary:
```
✅ Linear Triage Automation — Setup Complete

Prerequisites:   ✅ gh CLI authenticated / ✅ git remote configured
Config:          ~/.claude/linear-triage-config.json
Label created:   "<label>" (apply this label to any triage issue you want Claude Code to handle)
RemoteTrigger:   */15 * * * * → /linear-triage-poller

Next steps:
1. Tag a triage issue with "<label>" in Linear
2. The poller will pick it up within 15 minutes
3. Or run /linear-triage-poller manually to trigger immediately
```
