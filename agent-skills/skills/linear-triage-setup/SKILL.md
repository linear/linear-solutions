---
name: linear-triage-setup
description: One-time setup for the Linear triage automation workflow. Creates the "Claude Code" label in Linear, verifies gh CLI and git are configured, and registers the RemoteTrigger that polls every 15 minutes. Run this once before using /linear-triage-poller.
---

You are setting up the Linear Triage Automation system. Execute each step in order and report the result of each.

## Step 1 — Verify prerequisites

Run these checks in parallel:

```bash
# 1a. gh CLI authenticated?
gh auth status

# 1b. linear-solutions has a remote?
cd /Users/shannon/Claude/linear-solutions && git remote -v

# 1c. Config file exists?
cat ~/.claude/linear-triage-config.json 2>/dev/null || echo "CONFIG_MISSING"
```

If `gh auth status` fails: stop and tell the user to run `gh auth login` first.
If no git remote: stop and tell the user to configure a GitHub remote for linear-solutions.
If CONFIG_MISSING: write the default config (Step 2) before continuing.

## Step 2 — Write default config (if missing)

Write `~/.claude/linear-triage-config.json`:
```json
{
  "label": "Claude Code",
  "branchPrefix": "claude",
  "repo": "/Users/shannon/Claude/linear-solutions",
  "testCommand": "npm test",
  "statusMap": {
    "inProgress": "In Progress",
    "inReview": "In Review"
  },
  "maxConcurrentIssues": 3
}
```

## Step 3 — Create "Claude Code" label in Linear

Use `mcp__claude_ai_Linear__create_issue_label` to create a label named **"Claude Code"** with color `#7C3AED` (purple). If the tool errors with "already exists", that's fine — skip and continue.

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
Label created:   "Claude Code" (apply this label to any triage issue you want Claude Code to handle)
RemoteTrigger:   */15 * * * * → /linear-triage-poller

Next steps:
1. Tag a triage issue with "Claude Code" in Linear
2. The poller will pick it up within 15 minutes
3. Or run /linear-triage-poller manually to trigger immediately
```
