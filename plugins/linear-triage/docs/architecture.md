# Linear Triage Plugin — Architecture

How the three skills coordinate with the Linear MCP server and local `gh`/`git`.

```
                         ┌─────────────────────────┐
                         │   You (Linear user)     │
                         │  add "Claude Code" label│
                         │  to a triage issue      │
                         └────────────┬────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          LINEAR (cloud)                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐    │
│  │ Triage queue │───▶│ "Claude Code"│    │ Issue comments &     │    │
│  │              │    │ labeled issue│    │ state transitions    │    │
│  └──────────────┘    └──────────────┘    └──────────▲───────────┘    │
└─────────────────▲──────────────▲────────────────────│────────────────┘
                  │              │                    │
       list_issues│   save_issue │       save_comment │
       get_issue  │   get_user   │       create_label │
                  │              │                    │
            ┌─────┴──────────────┴────────────────────┴──────┐
            │             Linear MCP Server                  │
            │      (mcp__claude_ai_Linear__*)                │
            └─────▲──────────────▲────────────────────▲──────┘
                  │              │                    │
   ─ ─ ─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─ ─
                  │              │                    │
       ┌──────────┴────┐  ┌──────┴───────┐   ┌────────┴─────────┐
       │   SKILL 1     │  │   SKILL 2    │   │     SKILL 3      │
       │ triage-setup  │  │ triage-poller│   │  issue-worker    │
       │ (one-time)    │  │ (every 15m)  │   │  (per issue)     │
       ├───────────────┤  ├──────────────┤   ├──────────────────┤
       │• check gh/git │  │• list_issues │   │• get_issue       │
       │• create label │  │  (label=CC,  │   │• save_comment    │
       │• register     │  │   state=     │   │  (stage updates) │
       │  RemoteTrigger│  │   triage)    │   │• save_issue      │
       │  cron */15    │  │• save_issue  │   │  (state→InReview)│
       │               │  │  →InProgress │   │• get_user        │
       │               │  │• save_comment│   │  (assignee @)    │
       │               │  │  "picked up" │   │                  │
       │               │  │• spawn worker│──▶│ (one agent per   │
       │               │  │  per issue   │   │  issue, parallel)│
       └───────┬───────┘  └──────┬───────┘   └────────┬─────────┘
               │                 ▲                    │
               │                 │ cron fires         │ git + gh
               │                 │                    │ (local)
               ▼                 │                    ▼
       ┌──────────────────────────────┐    ┌──────────────────────┐
       │  Claude Code RemoteTrigger   │    │  Local repo worktree │
       │  */15 * * * *                │    │  .worktrees/<id>/    │
       │  → /linear-triage-poller     │    │  branch=gitBranchName│
       └──────────────────────────────┘    │  → gh pr create      │
                                           │    --draft           │
                                           │  → npm test          │
                                           │  → gh pr ready       │
                                           └──────────┬───────────┘
                                                      │
                                                      ▼
                                              ┌───────────────┐
                                              │  GitHub PR    │
                                              │  (auto-linked │
                                              │   to issue)   │
                                              └───────────────┘
```

## Reading it left-to-right

- **Skill 1 (`linear-triage-setup`)** — runs once. Talks to Linear MCP to create the label, talks to the Claude Code runtime to register the cron.
- **Skill 2 (`linear-triage-poller`)** — runs on the cron. Queries Linear for labeled triage issues, claims each one (state change + intake comment), then **spawns Skill 3 as a sub-agent per issue** (parallel).
- **Skill 3 (`linear-issue-worker`)** — runs once per issue. Reads the full issue from Linear, does all the local `git`/`gh`/test work in a worktree, and posts status comments back to Linear at every stage. Final step flips the issue to "In Review" and pings the assignee.

## Key invariants

- **Linear is the queue and the status board.** All three skills share the Linear MCP server: it's how the plugin reads work (labeled triage issues) and reports progress (comments, state transitions).
- **`gh` and `git` only appear in Skill 3.** Setup and the poller never touch code or GitHub — they only orchestrate.
- **One worker per issue, isolated in a worktree.** Concurrent issues never collide because each gets its own `.worktrees/<issue-id>/` directory on Linear's `gitBranchName`.
- **The cron is the only thing that makes it "autonomous".** Without `RemoteTrigger`, the plugin is still usable — you'd just invoke `/linear-triage-poller` manually.
