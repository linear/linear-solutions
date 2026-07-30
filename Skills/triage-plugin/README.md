# Linear Triage Plugin for Claude Code

Polls a Linear team's triage queue for issues labeled **"Claude Code"** and implements each one end-to-end: reads the issue, plans, creates a worktree on Linear's `gitBranchName`, implements, opens a draft PR, runs tests, and marks the PR ready for review. Every stage transition is posted as a comment on the Linear issue, so the issue stays the single source of truth.

Built on the [Symphony](https://github.com/openai/symphony) pattern: tracker-as-queue + isolated worktree per issue + agent-per-issue.

## Install

```bash
# 1. Clone next to your repos
git clone https://github.com/shannonhu/linear-triage-plugin ~/Claude/linear-triage-plugin

# 2. Register the plugin with Claude Code
claude plugin install ~/Claude/linear-triage-plugin

# 3. Copy the example config
cp ~/Claude/linear-triage-plugin/config.example.json ~/.claude/linear-triage-config.json
$EDITOR ~/.claude/linear-triage-config.json   # set repo, repoUrl, team
```

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- `git` available on PATH
- Claude Linear MCP connected (the `mcp__claude_ai_Linear__*` tools must be available)
- A target git repo cloned locally (the plugin will clone for you if missing)

## Setup

In Claude Code, run:

```
/linear-triage-setup
```

This:

1. Verifies prerequisites
2. Creates the **"Claude Code"** label in Linear (if missing)
3. Registers a `RemoteTrigger` cron `*/15 * * * *` that runs `/linear-triage-poller`

## Daily use

Tag any Linear triage issue with the **"Claude Code"** label. Within 15 minutes the poller picks it up, claims it (moves to "In Progress"), and spawns a worker that delivers a draft PR.

To trigger immediately: `/linear-triage-poller`

## Configuration

`~/.claude/linear-triage-config.json`:

| Key | Purpose |
|---|---|
| `label` | Linear label that opts an issue into automation |
| `team` | Linear team key to scope the poller to (omit for all teams) |
| `repo` | Local path where worktrees are created |
| `repoUrl` | Remote URL — used if `repo` doesn't exist locally |
| `testCommand` | Run inside the worktree after implementation |
| `statusMap.inProgress` | Linear state name to claim issues into |
| `statusMap.inReview` | Linear state name to set when PR is ready |
| `maxConcurrentIssues` | Cap on workers spawned per poll |

## Safety

- Workers only operate inside `repo/.worktrees/<issue-id>/`
- Each issue gets a fresh worktree on Linear's `gitBranchName` so the PR auto-links
- PRs always open as **draft**; tests must pass before they're marked ready
- Failing tests label the issue `needs-human` and stop — no merge attempt

## License

MIT
