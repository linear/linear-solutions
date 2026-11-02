# Rank Guardrail

Keep a set of Linear issues in an approved manual order. Rank Guardrail remembers the order of every issue carrying a chosen label in one team, watches for reorders, and puts the issues back when someone moves them out of order. If you turn on role-aware approvals, reorders made by workspace owners, workspace admins, and owners of that team become the new approved order. Reorders by anyone else are repaired.

> **Status: experimental reference implementation.** It runs against **one dedicated team whose name contains the word `TEST`** and starts in dry run. Evaluate it with disposable issues before you rely on it. It is not a native Linear ordering lock.

The guardrail only ever writes an issue's `sortOrder` (its manual rank). It never changes status, cycle, assignee, labels, or any other field, and status or cycle changes don't count as violations.

## How it works

1. **Publish a baseline.** While paused, you run `publish`. The guardrail saves the IDs of all non-archived issues in the team with the protected label (1–100 issues), in their current manual order.
2. **Watch.** A small local server polls Linear about every five seconds and also accepts signed Linear webhooks.
3. **Repair or approve.** If the protected issues are out of the approved relative order, the guardrail re-spaces only those issues to restore it. With `ROLE_APPROVALS=true`, a reorder is accepted instead when signed webhooks prove that an allowed user made every move.

Safety defaults: the server starts paused and in dry run. Writes are capped at 3 per sweep and 10 per 10 minutes. A safety breaker stops the server after repeated failures or a large drift, and nothing restarts it automatically.

## Requirements

- Node.js 22 or newer and npm. The package has no runtime dependencies.
- A Linear workspace where you can create an OAuth application (workspace admin).
- For webhooks and role approvals: a public HTTPS URL that forwards to the server, for example [ngrok](https://ngrok.com/) or a reverse proxy on the same host. The server only listens on `127.0.0.1`.
- For role approvals: a paid plan. On the Free plan, Linear reports every member as an admin, so every member would be allowed to reorder.

## Setup

### 1. Install

```sh
git clone https://github.com/linear/linear-solutions.git
cd linear-solutions/services/rank_guardrail
npm ci --ignore-scripts
npm run build   # syntax check
npm test        # offline: mocks and loopback HTTP only, no Linear calls
cp .env.example .env
chmod 600 .env
```

Run every command below from `services/rank_guardrail`.

### 2. Prepare your Linear workspace

1. **Team.** Create or choose a team whose name contains `TEST` as a separate word, for example `Roadmap TEST`. The guardrail won't run against any other team. `Testing` and `MyTest` don't qualify.
2. **Label.** Create a label, for example `Rank protected`, and apply it only to the issues whose order you want to protect. To try the guardrail out, use three disposable issues: A, B, C.
3. **View.** Open the team's issue list with **Ordering: Manual** and **Grouping: No grouping**, then arrange the protected issues in the order you want. The guardrail protects this manual order. It doesn't protect board columns, grouped views, priority sorting, or sub-issue order.

### 3. Create an OAuth application for credentials

Use an OAuth application rather than a personal API key:

- **Not tied to a person.** The app acts as its own app user, so the guardrail keeps working if the person who set it up leaves, and its writes show up as the app in issue history.
- **Repairs can't approve themselves.** An app user is never an allowed approver. With a personal key, every drag you make in the UI looks identical to a write made with your key, so the guardrail always denies your own reorders.
- **Least privilege and easy revocation.** Request only `read` and `write`, give the app access to just the team it needs, and revoke or rotate it from Linear settings without touching anyone's account.
- **Built-in webhook.** The app can deliver Issue webhooks, with its own signing secret.

Steps (a workspace admin needs to do these):

1. In Linear, go to **Settings → API → OAuth applications** and create a new application, for example `Rank Guardrail`. You won't use the callback URL with client credentials, but it can't be empty, so enter something like `http://localhost/callback`.
2. In the app settings, turn on **Client credentials**. This lets the server request an app token with just the client ID and secret, without a browser install flow.
3. If you'll use webhooks (required for role approvals), turn on **Webhooks** in the same settings:
   - **URL:** `https://YOUR-PUBLIC-HOST/webhook`. The path must be exactly `/webhook`.
   - **Resource types:** select **Issues**.
   - Copy the app's **webhook signing secret**. It goes in `WEBHOOK_SECRET`.
4. Save, then copy the **Client ID** and **Client secret**. Store them in a password manager. Don't commit them.
5. Request an access token with the `read,write` scopes:

   ```sh
   curl -s https://api.linear.app/oauth/token \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d grant_type=client_credentials \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d scope=read,write
   ```

   The JSON response contains `access_token` and `expires_in` (about 30 days). The `access_token` goes in `LINEAR_API_KEY`.
6. If the TEST team is **private**, go to **Settings → Applications**, open the app, and give it access to that team. Without access, API calls fail with `api-http` 403 or `api-graphql`.

**Token renewal.** Client-credentials tokens don't come with a refresh token. Before the token expires (or as soon as the guardrail reports HTTP 401), request a new one with the same `curl` command. Then run `pause`, update `LINEAR_API_KEY`, restart the server, and run `resume`. [`services/linear-token-renew`](../linear-token-renew) shows how to automate renewal.

The guardrail sends OAuth tokens as `Authorization: Bearer <token>`. You can paste the token with or without the `Bearer ` prefix.

<details>
<summary>Alternatives (not recommended)</summary>

- **Developer token from the OAuth app.** In the app settings, use **Create & copy token**, choose **App** as the actor, and select the `read` and `write` scopes. It's fine for a quick evaluation, but you have to regenerate it by hand when it expires.
- **Personal API key** (`lin_api_...`, from **Settings → Security & access → Personal API keys**). It's tied to one person, carries that person's access, and stops working if they leave. That person's own reorders can never be approved. If you use one anyway, create it for a dedicated service user and restrict it to the TEST team. Personal keys are sent as-is, without `Bearer`.
- **Workspace webhook** (**Settings → API → Webhooks**) instead of the app webhook. Select only the TEST team and the **Issues** resource, and use that webhook's signing secret.

</details>

### 4. Find the team and label UUIDs

The configuration needs UUIDs, not names or team keys. Look them up with your token:

```sh
TOKEN=YOUR_ACCESS_TOKEN
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ teams(first: 250) { nodes { id name key } } }"}'
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ issueLabels(first: 250) { nodes { id name team { id } } } }"}'
```

The app only sees teams it has access to. For role approvals, you'll also want the UUIDs of a few users to test with:

```sh
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ users(first: 250) { nodes { id name admin } } }"}'
```

You can also copy UUIDs from Linear with **Cmd/Ctrl+K → Copy model UUID** while viewing the team, label, or user.

### 5. Configure `.env`

Open `.env` and replace every `REPLACE_WITH_...` value:

```dotenv
TEST_TEAM_ID=<team UUID>
TEST_TEAM_ALLOWLIST=<the same team UUID>
PROTECTED_LABEL_ID=<label UUID>
LINEAR_API_KEY=<OAuth app access token>
WEBHOOK_SECRET=<webhook signing secret>
DRY_RUN=true
ROLE_APPROVALS=false
APPROVAL_GRACE_MS=10000
STATE_DIR=.state
PORT=8787
```

| Variable | Notes |
| --- | --- |
| `TEST_TEAM_ID` / `TEST_TEAM_ALLOWLIST` | The team's UUID, repeated in both. The allowlist is a deliberate second confirmation. |
| `PROTECTED_LABEL_ID` | Label UUID. A state directory is bound to one team and one label. |
| `LINEAR_API_KEY` | The OAuth app access token from step 3. Despite the name, this is where any Linear credential goes. |
| `WEBHOOK_SECRET` | Always required. If you aren't using webhooks yet, use a random value (`openssl rand -hex 32`) and replace it with the real signing secret later. The token is not the signing secret. |
| `DRY_RUN` | Only the exact value `false` allows rank writes. Missing, misspelled, or upper-case values stay in dry run. |
| `ROLE_APPROVALS` | `true` or `false`. Anything else is a configuration error. See [Role-aware approvals](#role-aware-approvals). |
| `APPROVAL_GRACE_MS` | 0–60000, default 10000. How long the guardrail waits for a webhook to explain a reorder. Only used when approvals are on. |
| `STATE_DIR` / `PORT` | Local state directory (default `.state`) and port (1024–65535, default 8787). The examples below assume the defaults. |

`.env` and `.state/` are gitignored. Keep both private. Values exported in your shell override `.env`.

## Run it

You'll use two terminals in `services/rank_guardrail`. Terminal 1 runs the server (`npm start`). Terminal 2 runs short CLI commands.

```sh
node --env-file=.env src/cli.js <command>
```

| Command | What it does |
| --- | --- |
| `status` | Read-only. Prints `paused`, `tripped`, `dryRun`, `roleApprovals`, the saved `baseline`, and counters. |
| `pause` | Stops checks and repairs. Waits for any sweep in progress to finish. |
| `publish` | Paused only. Saves the current labeled issues and their order as the new baseline, and resets the safety breaker. It doesn't change anything in Linear. |
| `resume [--restore]` | Re-enables checks. Without `--restore`, it refuses if the current order differs from the baseline. |
| `check-actor <user-uuid>` | Read-only. Shows whether that user would be allowed to approve a reorder, and why. |
| `serve` | Starts the server. `npm start` runs this. |

There's no HTTP dashboard or management endpoint. Anyone who can run these commands with your `.env` and state directory is a trusted operator, because `pause`, `publish`, and `resume --restore` aren't role-checked.

**Real repairs need all of these:** the server is running, a baseline is published, `paused` is `false`, the server was started with `DRY_RUN=false`, and `tripped` is `false`. Pause state, baseline, and breaker survive restarts. Restarting never resumes on its own, and neither does changing `DRY_RUN`. The server reads `.env` only at startup, so restart it after any change. Its startup line shows the active modes.

### 1. Publish a baseline and start in dry run

In Terminal 2, with the server stopped:

```sh
node --env-file=.env src/cli.js pause
node --env-file=.env src/cli.js publish    # expect "protectedCount": 3, still paused
node --env-file=.env src/cli.js status     # confirm the baseline IDs are A, B, C
node --env-file=.env src/cli.js resume     # expect "paused": false
```

In Terminal 1:

```sh
npm start
# Listening on localhost:8787; dryRun=true; roleApprovals=false; approvalGraceMs=10000
```

Polling doesn't need a webhook. In Linear, drag C above A, wait 5–15 seconds, then check:

```sh
node --env-file=.env src/cli.js status
tail -n 10 .state/audit.jsonl
```

You should see `"event":"would-repair"`, and the order in Linear stays C, A, B. That's the expected dry-run result. `status.baseline` is the saved approved order, not a fresh read from Linear.

### 2. Turn on real repairs

1. Run `pause` in Terminal 2, then restore A, B, C in Linear.
2. Stop the server with Ctrl+C. Set `DRY_RUN=false` in `.env` and run `npm start` again. Confirm the startup line shows `dryRun=false`.
3. Run `resume` in Terminal 2.
4. Drag C above A. Within about 5–15 seconds, A, B, C comes back, and the audit log shows `repair-intent` entries. Other protected issues can get new numeric ranks. Only their relative order is guaranteed.

To go back to dry run: `pause`, stop the server, set `DRY_RUN=true`, restart, then `resume`.

### 3. Accept a new order on purpose

```sh
node --env-file=.env src/cli.js pause
# arrange the new order in Linear (and add/remove the label to change membership)
node --env-file=.env src/cli.js publish    # review "dropped" for issues that left the set
node --env-file=.env src/cli.js resume
```

Membership only changes when you publish. Removing the label doesn't release an issue that's already in the baseline, and adding the label doesn't protect a new issue until the next `publish`. `resume --restore` restores the old baseline instead of the current order. Use it only when that's what you want.

### 4. Connect the webhook

Webhooks are optional for repairs, because polling catches every change. They are required for role approvals.

1. Expose the local server, for example with `ngrok http 8787`, and set the OAuth app's webhook URL to `https://YOUR-NGROK-HOST/webhook`.
2. Put the app's webhook signing secret in `WEBHOOK_SECRET`. Then run `pause`, restart the server, and run `resume`.
3. Change a protected issue and check the delivery in the OAuth app's webhook settings or the ngrok inspector. A valid delivery gets HTTP `200 accepted`. A wrong secret gets `401`. Seeing repairs isn't proof that webhooks work, because polling repairs too.

```sh
curl -i -X POST http://127.0.0.1:8787/webhook -H 'Content-Type: application/json' --data '{"type":"Issue"}'
# Expected: HTTP 401 (unsigned)
```

The OAuth app webhook delivers events for every team the app can access. The guardrail ignores events from other teams. If the public hostname changes, update the webhook URL.

## Role-aware approvals

With `ROLE_APPROVALS=true`, a reorder of protected issues becomes the new approved order, with no repair, when the guardrail can prove who made it. Any other reorder is repaired as usual. Polling can't tell who moved an issue, so approvals need a working webhook. Without one, every move is repaired after the grace period.

**Allowed:** active, non-app users in the same workspace who are a workspace **owner**, workspace **admin**, or **owner of exactly the configured team**.

**Denied:** members, owners of other teams (including parent teams), inactive users, app users (including the guardrail's own OAuth app), users from other workspaces, unknown users, the guardrail token's own user, and non-user actors such as integrations, OAuth clients, and external users.

**What counts as proof**, checked against a fresh read from Linear:

- A signed Issue `update` webhook in which the issue's rank changed, for a protected issue in the configured team. Status-, cycle-, or assignee-only updates never approve anything.
- A chain of such webhooks leads from the last approved rank to the issue's current rank, and the last one matches the issue's current `updatedAt`, so no unseen update happened in between.
- Every protected issue that moved is explained this way, every actor in each chain is allowed, and the new ranks are distinct. If an allowed move is mixed with any unexplained or denied move, the guardrail rejects the whole reorder and repairs it.
- Webhooks for the guardrail's own repair writes are recognized and ignored.

Approval only updates the local baseline. It never writes to Linear and never adds or removes protected issues. It also works in dry run, so you can test roles before you enable repairs.

**Grace period.** Polling can see a move before its webhook arrives. Unexplained drift waits up to `APPROVAL_GRACE_MS` (logged as `approval-wait`) before repair. A webhook that arrives after that can't approve anything.

**Try it:**

1. Run `pause`, set `ROLE_APPROVALS=true`, restart the server (the startup line shows `roleApprovals=true`), and run `resume`.
2. Check roles:

   ```sh
   node --env-file=.env src/cli.js check-actor ADMIN_USER_UUID    # allowed: true, reason: workspace-admin
   node --env-file=.env src/cli.js check-actor MEMBER_USER_UUID   # allowed: false, reason: not-owner-admin-or-team-owner
   ```

3. As an admin, drag C above A. As a member, drag B to the top.
4. Inspect the results:

   ```sh
   grep -E 'approved-move|approval-rejected|approval-wait|own-callback' .state/audit.jsonl | tail -n 20
   ```

   The admin's move shows `approved-move`, and the baseline becomes C, A, B. The member's move shows `approval-rejected` with reason `unauthorized-actor`, or `unexplained-rank-change` if no webhook arrived, and is then repaired (or logged as `would-repair` in dry run).

If an allowed move gets repaired anyway, check four things: the webhook arrived within the grace period, the payload included `updatedFrom.sortOrder`, nobody else changed protected issues at the same time, and nothing updated the issue afterwards. If you're unsure, use `pause` → arrange → `publish` → `resume`.

## Running it continuously

- Run exactly **one** server per state directory, on one machine with a local filesystem. Don't use NFS or multiple replicas. A filesystem lock serializes the server and CLI commands.
- Run it under a process manager (systemd, launchd, a container with a persistent volume for `STATE_DIR`). After a crash, a restart picks up the saved state, and polling recovers any missed events.
- The server binds to `127.0.0.1`. Put a reverse proxy or tunnel on the same host in front of `/webhook`. Webhook bodies are limited to 1 MiB, and signatures must be within ±60 seconds, so keep the clock synchronized.
- Plan for token renewal (see [step 3](#3-create-an-oauth-application-for-credentials)). `.state/audit.jsonl` grows over time. Rotating and backing it up is up to you.

## Troubleshooting

Start with:

```sh
node --env-file=.env src/cli.js status
tail -n 20 .state/audit.jsonl
```

Don't edit or delete `.state/state.json` to change modes. There are no `enable`, `disable`, or `reset` commands. Errors print as `Command failed (<code>: <reason>)`. They name variables and HTTP status codes, but never secrets or API response text.

| Code | Meaning / next step |
| --- | --- |
| `config` | A `.env` value is missing, still a placeholder, not allowlisted, or invalid (`ROLE_APPROVALS`, `APPROVAL_GRACE_MS`, `PORT`). |
| `team-name` | The team name must contain `TEST` as a separate word. Rename the team. |
| `team-mismatch` | `TEST_TEAM_ID` must be the team UUID, not its key or name. |
| `api-http` | 401: the token is wrong or expired, so request a new one. 403: the app has no access to the team (see setup step 3.6). 429: wait. 5xx: retry later. |
| `api-network` / `api-response` | No connection, a timeout, or an unreadable response. Retry. |
| `api-graphql` | Linear rejected the query. Check the UUIDs, scopes (`read,write`), and team access. Details are hidden on purpose. |
| `pause-required` | Run `pause`, wait for `"paused": true`, then run `publish`. |
| `label-count` | Publish needs 1–100 non-archived labeled issues in the team. The message shows how many it found. |
| `rank-collision` | Protected issues share a rank. While paused, drag them into a distinct order, then publish. |
| `order-changed` | `resume` found a different order. Restore it while paused, or `publish` the new order on purpose. |
| `no-baseline` | Run `pause`, then `publish` first. |
| `breaker-tripped` | See `tripped: true` below. |
| `state-scope` | This `STATE_DIR` belongs to a different team or label. Use a separate directory. |
| `state-lock` | A sweep or command holds the lock. Wait and retry. After an unclean kill, stop every process using the directory before you remove a confirmed stale `.state/lock`. |
| `state-unreadable` | Stop all processes and keep `state.json` for review. |
| `usage` | Unknown command or argument. |

| Symptom | Check / next step |
| --- | --- |
| `would-repair` but nothing changes | The server is in dry run. See [Turn on real repairs](#2-turn-on-real-repairs). |
| `paused: false` but nothing happens | Is the server running? Is there a baseline? Is `tripped` false? Are you looking at the Manual, ungrouped list? |
| `status` says `dryRun: false` but the server only plans | The server hasn't restarted since you edited `.env`. `status` reflects the file. The startup line reflects the server. |
| An allowed user's drag is repaired | Approvals are off, the webhook is missing or late, `check-actor` denies the user, or the change was mixed with other moves. Check the `approval-rejected` reason. |
| `tripped: true` | The guardrail stopped itself because 3 writes in one sweep couldn't restore the order, it hit the limit of 10 writes in 10 minutes, or 3 sweeps failed in a row. Read the audit log, `pause`, arrange the order, `publish`, then `resume`. Waiting or restarting doesn't clear the breaker. |
| Webhook returns 401 | Wrong signing secret (it's not the token), the server hasn't restarted since the change, or the clock is off. Polling keeps working meanwhile. |

## Limitations

- **Scope.** One team, one label, at most 100 protected issues, and at most 10,000 issues in the team, counting archived ones. Completed issues with the label are included.
- **Relative order only.** Unprotected issues are never changed but can sit anywhere between protected ones. Repairs re-space the protected issues from the current lowest rank with at least 1,024 units between them, so neighbors can move. This isn't a minimum-movement algorithm.
- **Eventual, not atomic.** Polling runs about every five seconds, with 10-second API timeouts. Linear has no compare-and-set for rank, so a concurrent edit can race a repair. Pause before moving protected issues to another team, and publish during a quiet period.
- **Approvals are conservative.** Missed, late, stale, mixed, or out-of-sequence events are repaired, not approved. A user actor can't distinguish a UI drag from an API call made with that user's personal key. Roles are looked up fresh at each approval, so revoked roles apply right away. Approval evidence expires after 10 minutes, and `pause`/`resume` or `publish` discards it.
- **Local state.** State is saved by atomic rename, which survives process restarts but not power loss. The audit log contains issue and user UUIDs and ranks, never names, emails, or credentials.
- **API surface.** The guardrail uses public GraphQL reads of `sortOrder` and `updatedAt`, read-only `viewer` and `user` lookups, and `issueUpdate(input: { sortOrder })` writes. Nothing else.

The automated tests (`npm test`) use mocks only. Validate the behavior in your own TEST team before you depend on it.
