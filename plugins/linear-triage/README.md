# Linear Triage Plugin for Claude Code

Polls a Linear team's triage queue for issues labeled **"Claude Code"** and implements each one end-to-end: reads the issue, plans, creates a worktree on Linear's `gitBranchName`, implements, opens a draft PR, runs tests, and marks the PR ready for review. Every stage transition is posted as a comment on the Linear issue, so the issue stays the single source of truth.

Built on the [Symphony](https://github.com/openai/symphony) pattern: tracker-as-queue + isolated worktree per issue + agent-per-issue.

See [`docs/architecture.md`](docs/architecture.md) for a diagram of how the three skills coordinate with the Linear MCP server.

## Install

```bash
# 1. Clone the linear-solutions monorepo
git clone https://github.com/linear/linear-solutions ~/Claude/linear-solutions

# 2. Copy the example config
cp ~/Claude/linear-solutions/plugins/linear-triage/config.example.json ~/.claude/linear-triage-config.json
$EDITOR ~/.claude/linear-triage-config.json   # set repo, repoUrl, team

# 3. Launch Claude Code with the plugin loaded
claude --plugin-dir ~/Claude/linear-solutions/plugins/linear-triage
```

> The `--plugin-dir` flag loads a local plugin for the session. To load it every time, add an alias (e.g. `alias claude-triage='claude --plugin-dir ~/Claude/linear-solutions/plugins/linear-triage'`) or pass multiple `--plugin-dir` flags to combine plugins.

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

## Permissions (required for background runs)

The poller fires via `RemoteTrigger` with no human in the loop, so every tool the workers call must be pre-approved — otherwise the background agent stalls on permission prompts that nobody answers.

The plugin ships a recommended allowlist at `plugins/linear-triage/settings.json` covering the Linear MCP tools, broad `Bash` access, and file tools. Bash is allowed broadly because the worker has to run arbitrary shell commands to explore the repo, implement fixes, and run tests — narrow patterns can't cover an autonomous coding agent. This is the same trust posture as running Claude Code interactively; only enable this for repos you'd be comfortable letting Claude Code modify on its own.

Merge it into your settings before kicking off background runs:

```bash
# Option A — copy into project settings (scoped to one repo)
cp ~/Claude/linear-solutions/plugins/linear-triage/settings.json <your-repo>/.claude/settings.local.json

# Option B — merge into user settings (applies everywhere)
$EDITOR ~/.claude/settings.json   # add the entries from the plugin's settings.json under permissions.allow
```

If your `testCommand` isn't one of the common runners listed (npm/pnpm/yarn/pytest/cargo/go), add it to the allowlist. After editing, restart your Claude Code session.

## Troubleshooting

**Poller isn't firing every 15 minutes**
Check that the `RemoteTrigger` was registered: ask Claude Code to "list my remote triggers" or re-run `/linear-triage-setup`. Triggers only fire while you have a Claude Code session that can receive them — confirm your session is running.

**"Claude Code" label not found / can't claim issues**
Re-run `/linear-triage-setup` to recreate the label. Verify your Linear MCP connection has write scope (`save_issue`, `create_issue_label`).

**`mcp__claude_ai_Linear__*` tools unavailable**
Connect the Linear MCP server at [claude.ai/settings/connectors](https://claude.ai/settings/connectors) and restart Claude Code. The plugin cannot read or update issues without it.

**Worker fails on `gh pr create`**
Run `gh auth status` and `gh auth refresh -s repo` to ensure the CLI has repo scope. The plugin opens PRs as the authenticated `gh` user.

**Tests fail and the issue is labeled `needs-human`**
Expected behavior — inspect the draft PR, push a fix manually, then remove the label. The poller will not retry an issue that's no longer in triage.

## Safety

- Workers only operate inside `repo/.worktrees/<issue-id>/`
- Each issue gets a fresh worktree on Linear's `gitBranchName` so the PR auto-links
- PRs always open as **draft**; tests must pass before they're marked ready
- Failing tests label the issue `needs-human` and stop — no merge attempt

## License

MIT
