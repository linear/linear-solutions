---
name: linear-triage-poller
description: Poll the Linear triage queue every 15 minutes for issues labeled "Claude Code" and delegate each one to /linear-issue-worker. Intended to be triggered by the RemoteTrigger registered via /linear-triage-setup. Can also be run manually to trigger immediately.
---

You are the Linear triage poller. Your job is to find eligible issues and hand them off to worker agents. Be fast and methodical — this runs on a 15-minute heartbeat.

## Step 1 — Load config

Read `~/.claude/linear-triage-config.json`. Extract:
- `label` (default: "Claude Code")
- `maxConcurrentIssues` (default: 3)
- `statusMap.inProgress` (default: "In Progress")

## Step 2 — Query the triage queue

Call `mcp__claude_ai_Linear__list_issues` with:
- `state`: `"Triage"`
- `label`: value of `label` from config
- `limit`: value of `maxConcurrentIssues`
- `orderBy`: `"createdAt"`

If zero issues returned: log "No eligible triage issues found." and stop cleanly.

## Step 3 — Process each issue

For each issue returned, in order of priority (1=Urgent first, then 2=High, 3=Normal, 4=Low):

### 3a. Claim the issue (prevent double-pickup)
Call `mcp__claude_ai_Linear__save_issue` with:
- `id`: the issue identifier (e.g., "LIN-123")
- `state`: value of `statusMap.inProgress` from config

### 3b. Post intake comment
Call `mcp__claude_ai_Linear__save_comment` with:
- `issueId`: the issue identifier
- `body`:
```
🤖 **Claude Code** — Picked Up

This issue has been pulled from the triage queue and delegated to Claude Code for implementation. Work is starting now.

_Priority: [issue priority] · Team: [issue team]_
```

### 3c. Spawn the worker
Use the Agent tool to spawn a new agent with:
- `subagent_type`: `"general-purpose"`
- `description`: `"Linear issue worker: [issue id] — [issue title]"`
- `prompt`: `"Run the /linear-issue-worker skill for Linear issue [issue identifier]. The issue is: [title]. Full context: [description first 500 chars]. Repo: /Users/shannon/Claude/linear-solutions"`

Spawn all workers in a single parallel message if there are multiple issues.

## Step 4 — Log summary

After spawning all workers, output:
```
Linear Triage Poller — [timestamp]
Issues picked up: [N]
[list each: ISSUE-ID — title — priority]
```

## Error handling

- If `save_issue` fails for an issue (e.g., state not found): skip it, log the error, continue to next issue. Do NOT spawn a worker for an issue that wasn't successfully claimed.
- If a worker spawn fails: post a comment on the issue: "⚠️ **Claude Code** — Worker spawn failed. Issue returned to triage queue." Then call `save_issue` to set state back to "Triage".
