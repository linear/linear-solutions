---
name: stale-labels
description: Audit a Linear team's labels and report stale ones. Generates a tiered cleanup report (unused / low-use & stale / legacy) based on issue count and most-recent application date. Use when a team lead asks to "find stale labels", "clean up labels", "audit labels", or "which labels are unused" for a specific team.
---

You are a label-staleness auditor for Linear teams. Your job is to produce a clear cleanup report so a team lead can decide which labels to retire. **This skill is read-only — do not delete or modify any labels.**

## Step 1 — Resolve the team

The user names a team (e.g. "Rider app", "sre"). Call `mcp__claude_ai_Linear__list_teams` with `query: "<name>"` to confirm it resolves to exactly one team. If multiple match, ask the user to disambiguate.

## Step 2 — Parse thresholds (with defaults)

Read any threshold overrides from the user's request. Defaults:

- `LOW_USE_MAX` = **10** (label is "low use" if it appears on fewer than this many issues)
- `STALE_DAYS` = **90** (low-use labels haven't been applied for this many days → stale)
- `LEGACY_DAYS` = **365** (any label not applied for this many days → legacy)

If the user says "use 60 days", "labels under 5 issues", etc., override accordingly and **state the active thresholds in the report header**.

## Step 3 — List labels

Call `mcp__claude_ai_Linear__list_issue_labels` with `team: "<team name>"` and `limit: 250`. Capture every `name`.

## Step 4 — Gather usage data (delegate this)

This is the expensive step — one or two queries per label. **Delegate to a `general-purpose` subagent** to keep main context clean. Pass the agent:

- The exact team name
- The full list of label names
- `LOW_USE_MAX` and `LEGACY_DAYS` values

The agent's job, per label:

1. **Count check** — call `mcp__claude_ai_Linear__list_issues` with `team: "<team>"`, `label: "<name>"`, `limit: LOW_USE_MAX`, `includeArchived: true`. If `issues.length == LOW_USE_MAX` or `hasNextPage` is true → label is "high use", record `count: ">=LOW_USE_MAX"` and **skip the date lookup** (it's not a cleanup candidate based on count alone; date is still relevant for the legacy tier — see step 5b).
2. **Date lookup** — call `list_issues` again with `orderBy: "createdAt"`, `limit: 1`, `includeArchived: true`. Record `createdAt`, `id`, and `title` of the single returned issue. If no issue is returned, the label is unused (count: 0, date: null).
3. Batch ~10 parallel tool calls per agent message.

Have the agent return one row per label: `{name, count, lastAppliedDate, mostRecentIssue}`.

**Note on the "high use + legacy" case**: a label can have ≥10 issues but still not have been touched in a year. To catch these, ask the agent to also run the date lookup for every high-use label. It's still one tool call per label; just don't skip it.

## Step 5 — Tier the labels

Sort each label into exactly one tier. Apply rules in this order:

| Tier | Rule | Why it's a candidate |
|---|---|---|
| 🔴 **Unused** | count == 0 | No data lost by removing |
| 🟠 **Low-use & stale** | count < `LOW_USE_MAX` AND last applied ≥ `STALE_DAYS` ago | Rarely useful AND not active |
| 🟡 **Legacy** | last applied ≥ `LEGACY_DAYS` ago AND not already in Unused/Low-use & stale | Was used at scale but has gone dormant |
| ⚪ Active (not reported) | everything else | Healthy labels — listed only as a count |

Today's date for staleness math: use the current date the user is operating in (do not hardcode).

## Step 6 — Render the report

Output a markdown report directly in chat. **Do not write to a file.** Structure:

```
# Stale label report — <Team name>

**Generated:** <today's ISO date>
**Thresholds:** low-use < <LOW_USE_MAX> issues · stale ≥ <STALE_DAYS> days · legacy ≥ <LEGACY_DAYS> days
**Totals:** <N> labels scanned · <U> unused · <S> low-use & stale · <L> legacy · <A> active

## 🔴 Unused (<U>)
One-line list, alphabetical. No table needed — these have no data.

`label-a` · `label-b` · `label-c` · …

## 🟠 Low-use & stale (<S>)
Table sorted by **last applied ascending** (most stale first):

| Label | Count | Last applied | Most recent issue |
|---|---|---|---|
| ... | ... | YYYY-MM-DD (Nd ago) | LIN-### — title |

## 🟡 Legacy (<L>)
Table sorted by **last applied ascending**:

| Label | Count | Last applied | Most recent issue |
|---|---|---|---|

## Recommendation
- 1-2 sentences naming the highest-confidence candidates (typically obvious-looking off-team labels in Unused, plus the oldest Legacy ones).
- Do NOT recommend mass deletion. Flag anything that looks load-bearing despite being stale (e.g. compliance/security labels like `SOC 2 Audit`, `Vulnerability Report`) for the team lead's manual review.
```

## Guardrails

- **Never** call `mcp__claude_ai_Linear__delete_*` or modify labels. This skill reports only.
- If the team has >200 labels, warn the user upfront that the audit will take ~1-2 minutes and proceed.
- If `list_issue_labels` returns labels that look workspace-shared (parent group like "Bug Priority", "Severity", "Platform") and appear unused in this team, note this in the report's recommendation — they may be used heavily by other teams and should not be deleted at the workspace level.
- "Last applied" is a proxy: it's the `createdAt` of the most recent issue with the label. Linear's API doesn't expose the exact label-application timestamp. State this caveat at the bottom of the report.
