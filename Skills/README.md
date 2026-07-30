# Skills

Claude Code skills and plugins for Linear workflows.

## triage-plugin

A Claude Code plugin that turns a Linear team's triage queue into an autonomous
implementation pipeline. It polls triage every 15 minutes for issues labeled
**"Claude Code"** and handles each one end-to-end — reads the issue, plans,
creates an isolated git worktree on Linear's `gitBranchName`, implements the
change, opens a **draft** PR, runs tests, and marks the PR ready for review.
Every stage transition is posted as a comment on the issue, so the Linear issue
stays the single source of truth.

Auth is delegated to the `gh` CLI (GitHub) and the Linear MCP — no secrets are
stored in the plugin. See [`triage-plugin/README.md`](./triage-plugin/README.md)
for install and configuration.
