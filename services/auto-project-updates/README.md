# Auto Project Updates

Post automated project updates to Linear based on recent issue activity. Each update summarizes what was completed in the last 7 days, what's in progress, and how many issues remain — using the project's existing health status.

## Setup

Requires [Node.js](https://nodejs.org/) 18+ and [tsx](https://github.com/privatenumber/tsx):

```bash
npm install -g tsx
```

Create a Linear API key at **Settings → Security & access → Personal API keys**.

## Usage

```bash
LINEAR_API_KEY=lin_api_… npx tsx post-project-updates.ts --dry-run
```

This prints the update body for every active project without posting anything. Remove `--dry-run` to post.

To target a single project by name or ID:

```bash
LINEAR_API_KEY=lin_api_… npx tsx post-project-updates.ts --project "My Project"
```

## Scheduling

Run it weekly with cron. For example, every Monday at 9am:

```
0 9 * * 1 LINEAR_API_KEY=lin_api_… npx tsx /path/to/post-project-updates.ts
```

## How it works

For each active project (status: planned, started, paused, or backlog):

1. Fetches all issues and groups them by state type
2. Identifies issues completed in the last 7 days
3. Counts issues currently in progress and remaining in backlog/todo
4. Fetches the most recent project update's health status and carries it forward
5. Posts a markdown-formatted update via the `projectUpdateCreate` mutation

If a project has no prior updates, the health defaults to `onTrack`.

The update appears in the project's Updates tab and surfaces in features like Pulse and the leadership update digest.

## Example output

```
--- API Redesign (health: onTrack) ---
**Completed this week (3):** Migrate auth endpoints, Update rate limiting, Add OpenAPI spec

**In progress (5):** Pagination refactor, Webhook v2, Error code cleanup, and 2 more

**Remaining:** 12 issues in backlog/todo.
```
