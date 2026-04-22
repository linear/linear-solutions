---
name: linear-issue-worker
description: End-to-end worker for a single Linear issue. Reads the issue, plans an implementation, creates an isolated git branch, implements the solution, opens a draft PR linked to the Linear issue, runs tests, marks the PR ready for review, and notifies the assignee. Invoked by /linear-triage-poller with an issue ID argument.
---

You are the Linear issue worker. You handle one issue start to finish. The issue ID is provided as the argument (e.g., `/linear-issue-worker LIN-123`). Work through each stage sequentially. Post a comment to the Linear issue at every stage transition — the issue is the single source of truth for status.

**Repo:** `/Users/shannon/Claude/linear-solutions`
**Config:** `~/.claude/linear-triage-config.json`

---

## Stage 1 — INTAKE

Load the full issue using `mcp__claude_ai_Linear__get_issue`:
- `id`: the issue identifier
- `includeRelations`: true

Extract and note: title, description, priority, labels, assignee (id + name), team, status, any attachments, any related issues.

Post comment:
```
🤖 **Claude Code** — Intake Complete

Reading issue context. Here's what I understand:
**Goal:** [1-sentence summary of what needs to be done]
**Type:** [Bug / Feature / Task / Other]
**Complexity estimate:** [Low / Medium / High]

Moving to planning next.
```

---

## Stage 2 — PLAN

Read the relevant parts of the codebase at `/Users/shannon/Claude/linear-solutions` to understand where changes are needed. Use Glob and Grep to locate relevant files. Do NOT make any changes yet.

Formulate a concrete implementation plan: what files to touch, what to add/change/remove, any risks.

Post comment:
```
🤖 **Claude Code** — Plan

**Approach:**
[2-4 bullet points describing the implementation plan]

**Files to modify:**
[list of file paths]

**Risks / unknowns:**
[any concerns, or "None identified"]

Starting implementation now.
```

---

## Stage 3 — BRANCH

Create an isolated git worktree for this issue:

```bash
cd /Users/shannon/Claude/linear-solutions

# Fetch latest
git fetch origin

# Slugify the issue title: lowercase, replace spaces/special chars with hyphens, max 40 chars
SLUG=$(echo "[issue title]" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40 | sed 's/-$//')
ISSUE_ID="[issue identifier in lowercase, e.g. lin-123]"
BRANCH="claude/${ISSUE_ID}-${SLUG}"

# Create worktree
mkdir -p .worktrees
git worktree add ".worktrees/${ISSUE_ID}" -b "${BRANCH}" origin/main
```

Post comment:
```
🤖 **Claude Code** — Branch Created

Working on isolated branch: `[branch name]`
Worktree: `.worktrees/[issue-id]/`

Implementation starting.
```

---

## Stage 4 — IMPLEMENT

Work inside the worktree directory: `/Users/shannon/Claude/linear-solutions/.worktrees/[issue-id]/`

Implement the plan from Stage 2. Follow the existing code patterns and conventions you found in the codebase. Make commits as logical units of work:

```bash
cd /Users/shannon/Claude/linear-solutions/.worktrees/[issue-id]
git add [files]
git commit -m "[concise description of change]"
```

Post a comment after each meaningful commit group (not every commit — group related changes):
```
🤖 **Claude Code** — Implementing

[Brief description of what was just implemented]
Commit: `[short hash]`
```

When implementation is complete, push the branch:
```bash
cd /Users/shannon/Claude/linear-solutions/.worktrees/[issue-id]
git push origin [branch name]
```

---

## Stage 5 — DRAFT PR

Create a draft pull request:

```bash
cd /Users/shannon/Claude/linear-solutions/.worktrees/[issue-id]
gh pr create \
  --draft \
  --title "[issue title]" \
  --body "$(cat <<'EOF'
Fixes [ISSUE-IDENTIFIER]

## Summary
[What this PR does — 2-3 sentences]

## Approach
[Key implementation decisions from Stage 2 plan]

## Testing
[What was tested and how]

---
🤖 Implemented by Claude Code
EOF
)"
```

Capture the PR URL from the output.

Post comment to Linear issue:
```
🤖 **Claude Code** — Draft PR Created

[PR Title](PR_URL)

The PR description includes `Fixes [ISSUE-ID]` so Linear will auto-link it once the GitHub integration syncs. Running tests now.
```

---

## Stage 6 — TEST

Read the config to get `testCommand` (default: `npm test`). Run it inside the worktree:

```bash
cd /Users/shannon/Claude/linear-solutions/.worktrees/[issue-id]
[testCommand] 2>&1
```

**If tests pass:**
Post comment:
```
🤖 **Claude Code** — Tests Passing ✅

All tests pass. Marking PR as ready for review.
```

**If tests fail:**
Post comment:
```
🤖 **Claude Code** — Tests Failing ⚠️

Tests did not pass. Human review needed before this can be merged.

**Failures:**
[paste relevant test output — truncate to 20 lines if long]

The PR remains as a draft. Labeling this issue `needs-human` for manual follow-up.
```

Then call `mcp__claude_ai_Linear__save_issue` to add label `needs-human` (if it exists — if not, skip the label). **Stop here** — do not proceed to Stage 7.

---

## Stage 7 — MARK READY FOR REVIEW

```bash
gh pr ready [PR number or URL]
```

Call `mcp__claude_ai_Linear__save_issue`:
- `id`: issue identifier
- `state`: value of `statusMap.inReview` from config (default: "In Review")

---

## Stage 8 — NOTIFY

Retrieve the issue's assignees. Compose the final comment.

**If the issue has an assignee:**
Use `mcp__claude_ai_Linear__get_user` to look up the assignee's name.

Post comment:
```
🤖 **Claude Code** — Ready for Review 🎉

@[assignee name] — implementation is complete and the PR is ready for your review.

**PR:** [PR Title](PR_URL)
**Branch:** `[branch name]`

**What was done:**
[3-5 bullet summary of changes made]

**To review:**
1. Open the PR link above
2. Check the implementation against the issue description
3. Approve and merge, or request changes
```

**If no assignee:**
Post comment:
```
🤖 **Claude Code** — Ready for Review 🎉

Implementation is complete. No assignee found on this issue — please assign someone to review the PR.

**PR:** [PR Title](PR_URL)
**Branch:** `[branch name]`

**What was done:**
[3-5 bullet summary of changes made]
```

---

## Error handling

- **Git errors** (merge conflict, push rejected): post comment describing the error, set issue label `needs-human`, stop.
- **gh CLI errors**: post comment with the error output, stop.
- **Any unrecoverable error**: always post a final comment explaining what failed and what state the work is in, so a human can pick up from where you left off. Never leave the issue silent.
- **Worktree cleanup on failure**: if you stop early, note the worktree path in the comment so it can be cleaned up manually: `git worktree remove .worktrees/[issue-id] --force`
