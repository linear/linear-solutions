# ADO Repos Integration for Linear

A lightweight TypeScript service that connects Azure DevOps pull requests to Linear issues — mirroring the behavior of Linear's built-in GitHub integration.

[!NOTE]
This is not a formal integration built by the Linear engineering/product team. This should be considered more a working prototype meant to be adapted, configured, and hosted by you or your organization to use and maintain.

[Video Walkthrough](https://www.loom.com/share/325850603ae44ac8b70dd4cd8601f2ae)

## What It Does

- **Links PRs to issues**: Parses PR title, description, and branch name for Linear issue identifiers (e.g. `ENG-123`) using the same magic-word matching as the GitHub integration
- **Syncs workflow state**: Automatically transitions Linear issues as PRs move through review and merge
- **Bidirectional comment sync**: PR comments appear on linked Linear issues; Linear issue comments appear on the PR
- **Linkback comments**: Posts a comment on the ADO PR listing the linked Linear issues

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **ngrok** (or similar tunnel for local development)
- **Linear authentication** — OAuth app (preferred) or personal API key
- **Azure DevOps authentication** — Service principal / Entra ID token (preferred) or PAT

## Setup

### 1. Install

```bash
cd services/ado_repos
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

#### Authentication

For both Linear and ADO, the integration supports two authentication modes. **OAuth is recommended** so that actions (comments, state changes) appear as the integration application rather than a personal user account.

##### Linear Authentication

| Mode | Variables | Description |
|---|---|---|
| **OAuth app** (preferred) | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET` | Actions appear as the application. Create an OAuth app at **Settings > API > OAuth applications** in Linear. The integration uses the `client_credentials` grant to obtain a 30-day access token and auto-refreshes on expiry. |
| Personal API key | `LINEAR_API_KEY` | Actions appear as the user who created the key. Generate at https://linear.app/settings/api. |

If both OAuth and API key are configured, OAuth takes precedence.

##### Azure DevOps Authentication

| Mode | Variables | Description |
|---|---|---|
| **Service principal** (preferred) | `ADO_OAUTH_TOKEN` | Actions appear as the service account. Provide a bearer token from a Microsoft Entra ID app registration or managed identity. See [Microsoft docs on service principals for ADO](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity). |
| Personal Access Token | `ADO_PAT` | Actions appear as the user who created the token. Create at `https://dev.azure.com/{org}/_usersSettings/tokens` with **Code (Read & Write)** scope. |

If both OAuth token and PAT are configured, the OAuth token takes precedence.

#### Other Configuration

| Variable | Description |
|---|---|
| `LINEAR_WEBHOOK_SECRET` | Signing secret from your Linear webhook configuration |
| `ADO_ORG` | Your Azure DevOps organization name |
| `ADO_PROJECT` | Your Azure DevOps project name |
| `WEBHOOK_SECRET` | A secret you generate (e.g. `openssl rand -hex 32`) and include in your ADO Service Hook webhook URLs as `?secret=<value>`. Prevents unauthorized requests. |
| `PORT` | Server port (default: 3000) |
| `LINEAR_STATE_STARTED` | Linear workflow state name for "In Progress" (default: `In Progress`) |
| `LINEAR_STATE_IN_REVIEW` | Linear workflow state name for "In Review" (default: `In Review`) |
| `LINEAR_STATE_DONE` | Linear workflow state name for "Done" (default: `Done`) |
| `LINEAR_STATE_CANCELLED` | Linear workflow state name for "Cancelled" (default: `Cancelled`) |

### 3. Start the Server

**Development** (with auto-reload):
```bash
npm run dev
```

**Production**:
```bash
npm run build
npm start
```

### 4. Expose via ngrok

```bash
ngrok http 3000
```

Note the `https://xxxx.ngrok.io` URL — you'll use this when configuring webhooks.

### 5. Configure Azure DevOps Service Hooks

In your ADO project, go to **Project Settings > Service Hooks** and create a subscription for each event:

#### Event 1: Pull request created
- Service: **Web Hooks**
- Trigger: **Pull request created**
- Repository: (select your repo or leave as "Any")
- URL: `https://xxxx.ngrok.io/ado-webhook?secret=YOUR_WEBHOOK_SECRET`
- Resource details to send: **All**

#### Event 2: Pull request updated
- Trigger: **Pull request updated**
- Change: **Any** (captures status changes, reviewer votes, reviewer list changes, pushes)
- URL: `https://xxxx.ngrok.io/ado-webhook?secret=YOUR_WEBHOOK_SECRET`

#### Event 3: Pull request merge attempted
- Trigger: **Pull request merge attempted**
- Merge result: **Any**
- URL: `https://xxxx.ngrok.io/ado-webhook?secret=YOUR_WEBHOOK_SECRET`

#### Event 4: Pull request commented on
- Trigger: **Pull request commented on**
- URL: `https://xxxx.ngrok.io/ado-webhook?secret=YOUR_WEBHOOK_SECRET`

### 6. Configure Linear Outbound Webhook

In your Linear workspace, go to **Settings > API > Webhooks** and create a webhook:

- **URL**: `https://xxxx.ngrok.io/linear-webhook`
- **Resource types**: Check **Comment**
- Copy the **Signing secret** and set it as `LINEAR_WEBHOOK_SECRET` in your `.env`

## Issue Matching

The integration uses the same matching logic as Linear's GitHub integration.

### By Branch Name

Name your branches with a Linear issue identifier:

```
feature/ENG-123-add-login
bugfix/ENG-456
eng-789-refactor
```

### By PR Title

Include the identifier in the PR title:

```
ENG-123: Add login page
```

### By PR Description (Magic Words)

Use magic words in the PR description to control link behavior:

**Closing** — issue moves to Done when PR merges:
```
Closes ENG-123
Fixes ENG-123, ENG-456
Resolves ENG-123 and ENG-456
```

**Contributing** — links without closing on merge:
```
Refs ENG-123
Part of ENG-123
Contributes to ENG-123
```

**Ignoring** — prevents automatic linking:
```
Skip ENG-123
Ignore ENG-123
```

### Linear URLs

You can also paste Linear issue URLs directly in the PR description:
```
Closes https://linear.app/myteam/issue/ENG-123/issue-title
```

### Priority Rules

- Magic words in the description take precedence over branch/title matching
- If an issue is mentioned with `contributes to` in the body, it won't be treated as `closes` even if found in the branch name
- `closes` takes precedence over `contributes` for the same issue
- `ignore`/`skip` removes an issue from all categories

## State Mapping

The integration maps ADO PR lifecycle events to Linear workflow states:

| PR Event | Linear State |
|---|---|
| PR created | In Progress |
| Reviewers added | In Review |
| Reviewer(s) approved | In Review |
| All reviewers approved | In Review |
| PR completed (merged) | Done |
| PR abandoned | Cancelled |
| PR reactivated | In Progress |

**Notes:**
- Only issues linked with closing magic words (or default branch/title matches) transition to Done on merge
- Issues linked with `contributes to` / `refs` never auto-transition to Done
- State transitions only move forward — a push notification won't regress an issue from "In Review" back to "In Progress"

Customize state names in `.env` to match your team's workflow.

## Comment Syncing

### ADO → Linear
When someone comments on an ADO PR that's linked to a Linear issue, the comment appears on the Linear issue with attribution:

> **Jamal Hartnett** commented on ADO PR #42:
>
> Looks good, just one nit on line 15.

### Linear → ADO
When someone comments on a Linear issue that has a linked ADO PR, the comment appears as a new thread on the PR:

> **Alice** commented on Linear issue ENG-123:
>
> Updated the implementation per review feedback.

### Loop Prevention
Comments created by the integration include a hidden marker (`<!-- linear-ado-sync -->`) to prevent infinite sync loops.

## Architecture

```
┌─────────────────┐          ┌──────────────────┐          ┌────────────┐
│  Azure DevOps   │──webhook──▶                  │──SDK──────▶  Linear   │
│  (Service Hooks)│          │   Integration    │           │   API     │
│                 │◀──REST────│   Server         │◀──webhook──│          │
└─────────────────┘          │   (Node.js)      │           └────────────┘
                             └──────────────────┘
```

### Files

| File | Purpose |
|---|---|
| `src/index.ts` | HTTP server, routing, request parsing |
| `src/config.ts` | Environment configuration with validation |
| `src/types.ts` | TypeScript type definitions for ADO and Linear payloads |
| `src/logger.ts` | Structured JSON logging |
| `src/matchIssues.ts` | Issue identifier matching (ported from Linear's GitHub integration) |
| `src/linear.ts` | Linear SDK wrapper (issues, attachments, states, comments) |
| `src/ado.ts` | Azure DevOps REST API client (PR comments/threads) |
| `src/automation.ts` | State machine mapping PR events to workflow transitions |
| `src/webhookAdo.ts` | ADO webhook handler (PR lifecycle + comments) |
| `src/webhookLinear.ts` | Linear webhook handler (comment sync to ADO) |
| `src/comments.ts` | Bidirectional comment sync logic with loop prevention |
| `src/linkback.ts` | Linkback comment creation/update on ADO PRs |
| `src/store.ts` | In-memory store for PR↔issue links and comment mappings |

### Dependencies

Only two runtime dependencies:
- `@linear/sdk` — Linear GraphQL API client
- `dotenv` — environment variable loading

No Express, no Azure DevOps SDK. Uses Node.js built-in `http` and `fetch`.

## Adapting for Production

This is a prototype intended as a starting point. For production deployment, consider:

1. **Persistent storage**: Replace `src/store.ts` with a database (Redis, SQLite, Postgres) so PR↔issue links survive server restarts
2. **Queue processing**: Add a job queue (Bull, BullMQ) for reliable webhook processing with retries
3. **ADO token refresh**: The current `ADO_OAUTH_TOKEN` is static; implement a Microsoft Entra ID refresh flow to rotate it automatically
4. **Multi-project support**: Extend configuration to support multiple ADO projects/repositories
5. **Hosting**: Deploy to a cloud service (Azure Functions, AWS Lambda, Cloud Run) behind a load balancer
6. **Monitoring**: Add health check monitoring, error alerting, and metric collection
