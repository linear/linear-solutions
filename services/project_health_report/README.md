# Graphing Project Health Report

A standalone, read-only dashboard for active Linear projects associated with the **Graphing** team or any descendant team. The application resolves that hierarchy at runtime, computes issue-based completion metrics, persists daily project snapshots in a relational database, and uses snapshots plus project-update history for trends and comparisons.

## Stack

- TypeScript, React, and Vinext/Next-compatible route handlers
- Cloudflare Worker runtime with a lightweight JSON API
- Cloudflare D1 (SQLite) with explicit Drizzle migrations
- Linear GraphQL API at `https://api.linear.app/graphql`
- Canvas-based, clickable trend charts

The integration only performs GraphQL queries. It contains no Linear mutations.

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` for local development. Never expose these values through `NEXT_PUBLIC_*` variables.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LINEAR_API_KEY` | Production | — | Personal Linear API key used only by the server |
| `LINEAR_ROOT_TEAM` | No | `Graphing` | Runtime-resolved root team name |
| `DASHBOARD_TIMEZONE` | No | `America/Los_Angeles` | Snapshot date and daily job timezone |
| `UPDATE_FRESHNESS_DAYS` | No | `7` | Age after which health displays as “No current update” |
| `CRON_SECRET` | Production | — | Bearer token for the refresh endpoint |

If `LINEAR_API_KEY` is absent, `/api/dashboard` deliberately returns clearly labeled preview data. This keeps the UI reviewable without leaking or requiring credentials. Once a key is configured, D1 and Linear become the only sources used by the report.

## Linear API setup

1. In Linear, open **Settings → Security & access → Personal API keys** and create a read-only-use key for this service.
2. Set it as `LINEAR_API_KEY` in the server/Worker environment.
3. Ensure the key can see the Graphing team, its private descendants if applicable, and their projects.
4. Trigger the initial snapshot:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $CRON_SECRET" \
     "http://localhost:3000/api/refresh?snapshot=true"
   ```

The service first paginates all visible teams, finds exactly one case-insensitive `Graphing` match, follows `parent.id` relationships recursively, then paginates projects associated with each resolved team. Project IDs and team IDs are never hardcoded.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open `http://localhost:3000`. Local D1 state is stored under `.wrangler/` and ignored by git.

Useful commands:

```bash
npm run test       # metric tests, production build, artifact smoke test
npm run test:unit  # metric and snapshot-comparison tests only
npm run lint
npm run db:generate
npm run build
```

## Database and migrations

The logical D1 binding is `DB` in `.openai/hosting.json`. The schema lives in `db/schema.ts`; generated SQL migrations live in `drizzle/`.

Core tables:

- `teams` — resolved hierarchy metadata
- `projects_current` — latest hourly project metrics
- `project_teams` and `project_initiatives` — relational associations
- `project_updates` — full project-update history used for health history
- `project_snapshots` — one row per project per local calendar day
- `refresh_runs` — refresh audit/status records

After changing `db/schema.ts`, run `npm run db:generate`, inspect the SQL, and commit both the schema and migration. Runtime initialization is idempotent, and the checked-in migration remains the authoritative deployment history.

## Refresh jobs

`POST /api/refresh` is authenticated with `Authorization: Bearer <CRON_SECRET>`.

- Hourly current refresh: `POST /api/refresh`
- Daily snapshot refresh: `POST /api/refresh?snapshot=true`

The Worker also exposes a `scheduled` handler intended to run every hour. Every invocation refreshes current data; during the `02:00` hour in `DASHBOARD_TIMEZONE`, it upserts that day’s snapshot. The `(project_id, snapshot_date)` primary key prevents duplicate daily rows.

If the hosting control plane does not attach scheduled triggers automatically, configure any trusted scheduler to call the authenticated endpoint at those cadences. An example Cloudflare cron configuration is included in `wrangler.jsonc`.

## Metric definitions

- **Completion %**: completed, non-canceled issues divided by all non-canceled issues. A project with no eligible issues reports `0%`.
- **Weighted completion %**: completed estimate points divided by all estimate points across estimated, non-canceled issues. It is omitted when no positive estimates exist.
- **Current health**: health from the latest project update (`onTrack`, `atRisk`, or `offTrack`). If the project has no update or its latest update exceeds the freshness threshold, the displayed value is **No current update**.
- **Health downgrade**: On track → At risk/Off track, or At risk → Off track. Missing/stale update display state is not itself a downgrade.
- **7-day delta**: current completion minus the latest daily snapshot at or before the instant seven days ago.
- **Stalled**: at least two snapshots in the last 14 days and no completion change across that window.
- **Target-date change**: current target date compared with the prior daily snapshot. A positive signed day count is a slip.
- **Overdue milestone**: target date is before today and milestone progress is below 100%.
- **Blocked issue**: an open issue with an inverse `blocks` relation, meaning another issue blocks it.
- **High priority**: open Linear priority `1` (Urgent) or `2` (High).
- **Fresh green update**: latest update is `onTrack` and is within the configured freshness threshold.
- **Completed projects by week**: projects first observed at 100% issue completion compared with the preceding daily snapshot, aggregated by week.

All week-over-week, trend, regression, and movement calculations use stored daily snapshots or stored project-update history rather than Linear’s current project progress field.

## API behavior

- `GET /api/dashboard` returns current project rows, filter facets, and historical series. It performs an initial refresh when the database is empty and credentials are configured.
- `POST /api/refresh` refreshes current data; add `?snapshot=true` for the daily snapshot.
- GraphQL pagination checks both HTTP failures and Linear’s `errors` array.
- API credentials remain server-side. Browser code only calls the local dashboard API.

The UI includes loading, empty, and actionable API-error states. Every KPI, chart, and attention signal opens the corresponding filtered drill-down list; project names open Linear in a new tab.

## Deployment

Build with `npm run build`, apply the migration to the bound D1 database, configure the environment variables as protected server values, and deploy the generated Worker bundle. Keep site access private unless your organization explicitly approves a broader audience because project names, health, staffing, and delivery dates may be sensitive.
