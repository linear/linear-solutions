# Linear Agent Skills

Claude Code skills for automating Linear issue workflows — from triage intake to PR-ready handoff.

## What it does

Polls your Linear triage queue every 15 minutes. Any issue tagged **`Claude Code`** gets automatically:

1. Moved to **In Progress** (preventing double-pickup on the next poll)
2. Picked up by a Claude Code agent that reads the full issue context
3. Implemented on an isolated git branch (`claude/<issue-id>-<slug>`)
4. Submitted as a **draft PR** with `Fixes <ISSUE-ID>` to auto-link in Linear
5. Tested — if tests pass, PR is marked ready for review; if not, it stops and flags for human
6. Assignee **notified** via a Linear comment with the PR link

Progress is posted as comments on the Linear issue at every stage.

---

## Setup

### Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- This repo has a GitHub remote (`git remote -v`)
- Linear's GitHub integration enabled in your workspace
- `LINEAR_API_KEY` available in your Claude Code environment

### Install the skills

Copy the `skills/` folder to `~/.claude/skills/`:

```bash
cp -r agent-skills/skills/* ~/.claude/skills/
cp agent-skills/linear-triage-config.json ~/.claude/linear-triage-config.json
```

### One-time setup

Open Claude Code and run:

```
/linear-triage-setup
```

This creates the `Claude Code` label in Linear and registers the 15-minute RemoteTrigger.

---

## Day-to-day usage

1. Find a triage issue you want Claude Code to handle
2. Add the **`Claude Code`** label to it in Linear
3. Within 15 minutes the poller picks it up automatically

**Trigger immediately:**
```
/linear-triage-poller
```

**Run a single issue manually:**
```
/linear-issue-worker LIN-123
```

**Answer a how-to question (onboarding):**
```
/linear-onboarding how do I set up SAML SSO?
```

---

## Configuration

Edit `~/.claude/linear-triage-config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `label` | `"Claude Code"` | Label that marks issues as eligible |
| `branchPrefix` | `"claude"` | Git branch prefix |
| `repo` | `linear-solutions path` | Repo Claude Code works in |
| `testCommand` | `"npm test"` | Test command before marking PR ready |
| `maxConcurrentIssues` | `3` | Max issues picked up per poll cycle |
| `statusMap.inProgress` | `"In Progress"` | Linear status on pickup |
| `statusMap.inReview` | `"In Review"` | Linear status when PR is ready |

---

## Skills

| Skill | File | Description |
|-------|------|-------------|
| `/linear-triage-setup` | `skills/linear-triage-setup/SKILL.md` | One-time setup: label creation + RemoteTrigger registration |
| `/linear-triage-poller` | `skills/linear-triage-poller/SKILL.md` | 15-min scheduler — queries triage, claims issues, spawns workers |
| `/linear-issue-worker` | `skills/linear-issue-worker/SKILL.md` | Per-issue executor — all 8 stages from intake to assignee notification |
| `/linear-onboarding` | `skills/linear-onboarding/SKILL.md` | Surfaces how-to guides from the Start Here team for onboarding Q&A |

---

## Issue lifecycle

```
[Triage] + "Claude Code" label
      ↓  (poller picks up)
[In Progress]  ← Claude Code working
      ↓  (tests pass, PR ready)
[In Review]    ← human reviews PR
```

## Branch naming

```
claude/<issue-id>-<title-slug>
# e.g. claude/lin-123-fix-tab-crash
```
