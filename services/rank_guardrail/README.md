# Rank guardrail

Rank guardrail protects the manual order of a chosen set of issues in one or more Linear teams. In each protected team you label the issues you care about, arrange them in a **Manual order** list, and publish that order as the approved baseline. A small Node.js service then watches each team:

- In **dry run** (the default), it records the repair it would make whenever the protected issues fall out of the approved relative order.
- With writes enabled, it puts the protected issues back in the approved relative order by updating their rank (`sortOrder`).
- With optional **role-aware approvals**, a reorder made in Linear by a workspace owner, workspace admin, or owner of the protected team becomes the new approved order instead of being repaired.

The guardrail only ever writes `sortOrder`. It never changes status, cycle, assignee, labels, or any other field, and it does not treat status or cycle changes as violations.

> **Note:** This is a small automation developed by the Linear Solutions Engineering team. It is not a Linear feature or a supported integration, and it is not a native ordering lock. Use it as an experimental starting point that your team adapts, hosts, and maintains. Its behavior is covered by offline tests; try it on disposable issues before you rely on it.

## Before you start: current constraints

These are enforced by the current code. Read them before you plan a rollout.

- **One label per team.** You can protect several teams from one installation, each with its own label. A team's baseline is every non-archived issue in that team with its label: 1–100 issues, in a team with at most 10,000 issues including archived ones.
- **Relative order only.** It protects the order of the labeled issues relative to each other, as seen in an ungrouped Manual order list. Unlabeled issues can sit anywhere between them. Boards, grouped views, priority sorting, and sub-issue order are not protected.
- **Eventual repair, not a lock.** People can still drag issues; the service checks about every five seconds and repairs afterwards.
- **One local process.** The service runs on one machine, keeps its state on the local filesystem, and listens only on `127.0.0.1`. Receiving webhooks needs a tunnel or reverse proxy in front of it.

## How it works

You operate the guardrail with CLI commands. Never edit files under `.state/` by hand or change issue statuses to control it.

Each protected team is independent: it has its own baseline, pause flag, safety breaker, and audit log in `.state/<team-uuid>/`. Pausing, publishing, a repair, or a tripped breaker in one team never affects another.

| Control | Where it lives | What it means |
| --- | --- | --- |
| Dry run | `DRY_RUN` in `.env`, read when each process starts | Any value other than exactly `false` means never write ranks. `false` permits rank writes, subject to the other controls. Editing `.env` does not change a server that is already running. |
| Paused | `.state/<team-uuid>/state.json`, changed with `pause` / `resume` | `paused: true`: no checks or repairs. `paused: false`: the running server checks the approved order. Independent of dry run. |
| Baseline | `.state/<team-uuid>/state.json`, set with `publish` | The ordered IDs of the protected issues. Publishing accepts the issues that currently have the label, in their current order. It does not reorder anything in Linear. |
| Server | The terminal running `npm start` | Only this long-running process checks and repairs. CLI commands such as `resume` do not start it. |
| Role approvals | `ROLE_APPROVALS` in `.env`, read when each process starts | Off unless exactly `true`. When on, a provable reorder by an allowed role becomes the new approved order (step 11). When off, every reorder of protected issues is repaired, whoever made it. |

**Real repairs require all of these:** a running server, a published baseline, `paused: false`, the server started with `DRY_RUN=false`, and `tripped: false` (the safety breaker has not stopped it).

A newly protected team starts paused, without a baseline. Restarting the server keeps the baseline, pause flag, and breaker. Restarting does **not** resume, and turning off dry run does **not** resume either.

## What you need

- Node.js 22 or later and npm (tested on Node 24).
- A checkout of this repository on the machine that will run the service.
- A Linear workspace where you can create an OAuth application.
- A workspace admin, if you want webhooks (needed for role-aware approvals) or need to give the app access to a private team.

## 1. Install

```sh
git clone https://github.com/linear/linear-solutions.git
cd linear-solutions/services/rank_guardrail
npm ci --ignore-scripts
npm run build
npm test
cp .env.example .env
chmod 600 .env
```

Run every command in this guide from `services/rank_guardrail`. Only copy `.env.example` for a new setup; do not overwrite an existing `.env`. The package has no runtime dependencies. `npm run build` checks JavaScript syntax, and `npm test` uses mocks and local HTTP only: no Linear API calls and no changes to real issues.

## 2. Prepare the team, label, and view

In Linear:

1. **Choose a team.** Any team works. For a first trial, consider a dedicated team or a few disposable issues; you can protect more teams later (see [Protect more teams](#protect-more-teams)).
2. **Create a label** to mark protected issues, for example `Ranked`, and apply it only to the issues whose order you want to protect. This guide uses three disposable issues called A, B, and C.
3. **Open a team issue list set to Manual order, ungrouped**, that shows all labeled issues, and arrange them A, B, C. Use this kind of view whenever you check or change the protected order.

## 3. Create a Linear OAuth app and copy its API key

The guardrail authenticates as a Linear **OAuth application** that acts as itself (`actor=app`). Use this rather than a personal API key:

- **Not tied to a person.** The service acts as the app's own user, so it keeps working if the person who set it up leaves, and its repairs show up as the app in issue history.
- **Your own reorders can be approved.** With a personal key, your drags in Linear look identical to the guardrail's writes, so role-aware approvals always deny them. The app user is never an allowed approver, so repairs still can't approve themselves.
- **Least privilege and easy revocation.** Grant only `read,write`, manage the app's team access from its details page, and revoke or delete the app in Linear settings without touching anyone's account.

1. Open [Settings → API → OAuth applications → New](https://linear.app/settings/api/applications/new) and create an application, for example `Rank guardrail`, with the `app` actor and the `read,write` scopes. Do not grant `admin`. The service reads teams, issues, labels, and users, and updates issue ranks, which needs `write`.
   - The guardrail does not use the redirect/callback URL. If the form requires one, enter a URL you control, such as `http://localhost/callback`.
   - Leave the application's own webhook settings off. This guide uses a workspace webhook instead (step 10).
2. **Copy the app's API key.** You paste it into `.env` in the next step. Never commit it, share it, or ship it to a browser.
3. **Authorize the app for your teams.** The app can access all public teams in the workspace where you created it. If a protected team is private, a workspace admin must give the app access to that team from the app's details page under [Settings → Applications](https://linear.app/settings/applications/).

## 4. Fill in `.env`

Open `.env` and set the team, label, and webhook values:

```dotenv
PROTECTED_TEAMS=REPLACE_WITH_TEAM_UUID:REPLACE_WITH_LABEL_UUID
LINEAR_API_KEY=REPLACE_WITH_OAUTH_APP_API_KEY
WEBHOOK_SECRET=REPLACE_WITH_WEBHOOK_SIGNING_SECRET
DRY_RUN=true
ROLE_APPROVALS=false
APPROVAL_GRACE_MS=10000
STATE_DIR=.state
PORT=8787
```

- `PROTECTED_TEAMS` is `<team-uuid>:<label-uuid>`: the team's UUID (not its name or key), a colon, and the protected label's UUID (not its name). To protect several teams, separate pairs with commas, for example `TEAM_A_UUID:LABEL_A_UUID,TEAM_B_UUID:LABEL_B_UUID`. Each team appears once and has one label; teams may share a workspace label. Keep a team's label unchanged for the life of its state.
- `LINEAR_API_KEY` is the OAuth app's API key from step 3. Paste it as is; the service sends it as `Bearer <key>`. (A value that already starts with `Bearer ` is sent unchanged.)
- `WEBHOOK_SECRET` is required even without a webhook. Until you set one up, use a random value, for example from `openssl rand -hex 32`. When you add the webhook (step 10), replace it with that webhook's signing secret and restart.
- Leave `DRY_RUN=true` for now. Missing, misspelled, or upper-case values never enable writes; only the exact value `false` does.
- Leave `ROLE_APPROVALS=false` until step 11. It accepts only `true` or `false`. `APPROVAL_GRACE_MS` (0–60000, default 10000) only matters when approvals are on.
- This guide assumes `STATE_DIR=.state` and `PORT=8787` (allowed range 1024–65535). If you change either, adapt the paths and port below. A custom state directory outside `.state/` is not covered by `.gitignore`.

Keep `.env` private: it holds the app's API key. `.env` and `.state/` are gitignored.

To look up the UUIDs, paste the app's API key into `.env` first, then run these read-only queries:

```sh
LINEAR_KEY="$(sed -n 's/^LINEAR_API_KEY=//p' .env)"
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $LINEAR_KEY" -H 'Content-Type: application/json' \
  --data '{"query":"{ teams(first: 100) { nodes { id name key } } }"}'
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $LINEAR_KEY" -H 'Content-Type: application/json' \
  --data '{"query":"{ issueLabels(first: 100) { nodes { id name team { id } } } }"}'
```

For role-aware approvals (step 11) you will also want a few user UUIDs to test with:

```sh
curl -s https://api.linear.app/graphql -H "Authorization: Bearer $LINEAR_KEY" -H 'Content-Type: application/json' \
  --data '{"query":"{ users(first: 100) { nodes { id name admin } } }"}'
```

These lists are [paginated](https://linear.app/developers/pagination); request further pages if what you need is not on the first one. The app only sees teams it has access to. The service itself never creates teams, issues, labels, OAuth apps, or webhooks.

## 5. Open two terminals

You use two terminals, both in `services/rank_guardrail`:

- **Terminal 1** runs the server and stays open.
- **Terminal 2** runs short CLI commands.

Both must use the same `.env` and state directory. Never run more than one server against the same protected issues. Values already exported in a terminal take precedence over `.env`, so make sure no `LINEAR_API_KEY`, `PROTECTED_TEAMS`, `DRY_RUN`, or similar guardrail variables are exported in these terminals.

Every command, including `status` and `pause`, validates the whole configuration before it runs. Check your configuration at any time with the read-only status command (it does not call Linear):

```sh
node --env-file=.env src/cli.js status
```

It prints the `team` and `label`, `paused`, `tripped`, `dryRun`, `roleApprovals`, `approvalGraceMs`, the saved `baseline`, and counts of pending approval events, own-write intents, and recent repair writes. `dryRun` and `roleApprovals` describe the `.env` this CLI process read; the running server's modes are on its startup line. With several protected teams, `status` and `pause` cover every team and return `{ "teams": [...] }`; see [Protect more teams](#protect-more-teams).

**Operator trust.** Anyone who can run these commands with this `.env` and state directory is a trusted operator: `pause`, `publish`, and `resume --restore` are not role-checked. Role checks apply only to reorders made in Linear and reported by webhook. Protect the checkout, `.env` and `.state/` with filesystem permissions.

## 6. Publish the first baseline and start in dry run

With the server stopped, in **Terminal 2** run each command separately and check it succeeds:

```sh
node --env-file=.env src/cli.js pause
node --env-file=.env src/cli.js publish
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

What to expect:

- `pause` returns JSON containing `"paused": true`.
- `publish` reads Linear and saves the labeled issues in their current order. With A, B, C labeled, the output includes `"paused": true`, `"protectedCount": 3`, `"dropped": []`, and `"dryRun": true`. It **stays paused**.
- `status` shows a `baseline` of three IDs and ranks in A, B, C order. Confirm they are the intended issues.
- `resume` returns `"paused": false`. It neither starts the server nor repairs anything by itself.

If a command fails, stop and use the troubleshooting section. Do not continue on the assumption that it worked.

Then in **Terminal 1**:

```sh
npm start
```

Wait for:

```text
Listening on localhost:8787; teams=1; dryRun=true; roleApprovals=false; approvalGraceMs=10000
```

Leave it running. The server checks immediately and then about every five seconds. **No webhook is needed for detection and repair**: polling reads the current order directly from Linear.

## 7. Check detection in dry run

1. In the Manual order list, drag C above A, so the order is C, A, B.
2. Wait about 5–15 seconds.
3. In **Terminal 2**:

   ```sh
   node --env-file=.env src/cli.js status
   tail -n 10 .state/*/audit.jsonl
   ```

Expected: `paused` and `tripped` are `false`, the baseline is still A, B, C, and the audit log contains `"event":"would-repair"`. **The order in Linear stays C, A, B.** Repeated `would-repair` entries are normal until you restore the order.

`status.baseline` is the saved approved order, not a fresh read of Linear.

## 8. Turn on repairs

First restore the approved order while paused. In **Terminal 2**:

```sh
node --env-file=.env src/cli.js pause
```

Wait for `"paused": true`, then put the issues back to A, B, C in Linear. (Do not `publish` C, A, B unless you want it to become the approved order.)

In **Terminal 1**, press **Ctrl+C** and wait for the prompt to return; do not force-kill it. Change `.env` to:

```dotenv
DRY_RUN=false
```

Restart in Terminal 1:

```sh
npm start
```

Confirm the startup line shows **`dryRun=false`**. It is still paused, because the pause flag survives restarts. In **Terminal 2**:

```sh
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

`resume` refuses if the current order does not match the baseline; restore it while paused and retry.

Now drag C above A again and wait 5–15 seconds. **A, B, C should return.** Check:

```sh
node --env-file=.env src/cli.js status
tail -n 20 .state/*/audit.jsonl
```

Expect `repair-intent` entries and `tripped: false`. Some repairs are followed by an `in-order` event and some are not, so check the order in Linear rather than one specific log line. Re-spacing can move other protected issues, and their numeric ranks need not match the old values.

To turn repairs off again: `pause`, stop the server with Ctrl+C, set `DRY_RUN=true`, and restart. Resume only when the current order matches the baseline and you want dry-run checks again.

## 9. Change the approved order

Keep the server running. In **Terminal 2**:

```sh
node --env-file=.env src/cli.js pause
```

**Wait for `"paused": true` before dragging anything.** Arrange the new order in Linear (for example C, B, A), add or remove the label on any issues whose protection should change, then:

```sh
node --env-file=.env src/cli.js publish
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

The baseline is now the new order, and it stays that way after resuming. `publish` accepts the current order rather than restoring an older one. It also replaces the protected set with the currently labeled issues and lists removed IDs in `dropped`; review that list before resuming. Publishing also resets the safety breaker and write budget, so only publish once the order and membership are what you want.

`pause` waits for any running check to finish. A failed or timed-out `pause` has **not** paused the service.

**Advanced:** `resume --restore` skips the changed-order check so that the server restores the *old* baseline on its next check (if writes are enabled). Do not use it to accept an intentional reorder or as a generic fix for failed commands.

## 10. Optional: add a webhook

Polling is enough for detection and repair. A webhook is required only for role-aware approvals (step 11), because polling cannot tell who moved an issue.

Linear only delivers webhooks to a publicly reachable HTTPS URL, and expects a `200` response within five seconds. The service listens on `127.0.0.1:8787` only, so put a tunnel (for example `ngrok http 8787`) or a TLS reverse proxy on the same machine in front of it, forwarding `POST /webhook`.

1. A workspace admin opens [Settings → API](https://linear.app/settings/api), creates a **new webhook** with the URL `https://YOUR-PUBLIC-HOST/webhook`, selects **only the protected teams** (not all public teams), and enables **Issue** data change events.
2. Copy the webhook's signing secret from its detail page into `WEBHOOK_SECRET` in `.env`. Then `pause`, stop the server with Ctrl+C, restart with `npm start`, and `resume` once the baseline and current order match. The server reads the secret only at startup.
3. Change one protected issue's rank, then check the delivery in Linear or in your tunnel's request inspector. A valid delivery receives HTTP 200 with the body `accepted`. Only this confirms that signature and timestamp verification passed; repairs alone could have come from polling. Keep request inspectors private, because they retain issue payloads.

An unsigned request is rejected without affecting the server:

```sh
curl -i -X POST http://127.0.0.1:8787/webhook \
  -H 'Content-Type: application/json' --data '{"type":"Issue"}'
# Expected: HTTP 401
```

There is no web page or health endpoint; other routes return 404. If your tunnel's hostname changes, update the webhook URL. This guide has not validated delivery through an OAuth application's own webhook settings.

## 11. Optional: role-aware approvals

With `ROLE_APPROVALS=true`, a reorder of protected issues is **accepted** (it becomes the new baseline and is not repaired) only when the guardrail can prove who made it. Everyone else's reorders are repaired as before. This needs the working webhook from step 10; without it, every move is repaired after the grace period.

**Who may reorder.** An active, non-app user in the same workspace as the guardrail's OAuth app who is a workspace **owner**, workspace **admin**, or an **owner of exactly the protected team** through an active membership. Owners of other teams (including parent teams), regular members, inactive or suspended users, app users, users from other workspaces, unknown users, and non-user actors (`integration`, `oauthClient`, `externalUser`, or none) are denied. The token's own user, the OAuth app, is always denied, so the guardrail's repairs can never approve themselves. Because the guardrail authenticates as an app rather than as a person, people's own drags in Linear are attributed to them and can be approved.

> **Free plan caveat:** on the Free plan Linear reports every member as an admin, so every active member would be allowed to reorder. Use approvals only on a paid plan, or leave them off.

**What counts as proof.** All of these must hold, checked on a fresh read while the state is locked:

- A signed Issue `update` webhook whose `updatedFrom.sortOrder` and `data.sortOrder` are both numbers and differ, for a baseline issue in the protected team. Status-, cycle-, or assignee-only events carry no rank change and never approve anything, including someone else's simultaneous drift.
- Its previous rank equals the guardrail's trusted anchor for that issue (its last rank in approved order), following webhook steps from that anchor reaches the issue's current rank, and the last step's `updatedAt` equals the issue's current `updatedAt` (no later unseen update).
- Every protected issue whose rank differs from its anchor is explained this way, and every step's actor is allowed. Mixed changes (an allowed move plus any unexplained or denied move) are rejected as a whole and repaired.
- The new order has distinct ranks. Webhooks for the guardrail's own repair writes (recorded as intents before each write) are ignored.

An approval changes only the order and anchors of the existing baseline in local state. It never adds or removes protected issues and never writes to Linear. In dry run, approvals still update the local baseline, so you can test roles without enabling repairs.

**Grace period.** Polling can see a move before its webhook arrives. While some drift is unexplained, the server waits up to `APPROVAL_GRACE_MS` from first detection (audited as `approval-wait`) before repairing. A webhook that arrives after that is too late: the move has already been repaired and the event cannot approve anything.

**Turn it on.** `pause`, set `ROLE_APPROVALS=true` in `.env`, restart the server, confirm the startup line shows `roleApprovals=true`, then `resume`. Check people's roles first (read-only; prints `allowed` and a `reason` such as `workspace-admin`, `team-owner`, or `not-owner-admin-or-team-owner`):

```sh
node --env-file=.env src/cli.js check-actor ADMIN_USER_UUID
node --env-file=.env src/cli.js check-actor MEMBER_USER_UUID
```

Then have an allowed user drag C above A, and a regular member drag B to the top. Inspect:

```sh
node --env-file=.env src/cli.js status
grep -E 'approved-move|approval-rejected|approval-wait|own-callback' .state/*/audit.jsonl | tail -n 20
```

Expect an `approved-move` for the allowed user's drag (baseline C, A, B, no repair), and an `approval-rejected` with reason `unauthorized-actor` (or `unexplained-rank-change` if the webhook was missing) for the member's drag, followed by a repair back to C, A, B (or `would-repair` in dry run). Audit entries contain issue and user UUIDs and role reasons, never names, emails, or secrets.

If an allowed move is repaired anyway, check that the webhook arrived within the grace period, that its payload includes `updatedFrom.sortOrder` (approvals fail closed without it), that nobody else changed protected issues at the same time, and that nothing else updated the moved issue afterwards. You can always use the manual path instead: `pause`, arrange, `publish`, `resume`.

## 12. Run it for longer

- **Key changes.** The key is read once at startup. To replace it: `pause`, stop the server, update `LINEAR_API_KEY` in `.env`, `npm start`, `resume`. If the key is revoked while the server is running, API calls return 401, and after three consecutive failed checks the safety breaker trips. To recover, `pause`, restart with a working key, review the order, `publish`, and `resume`.
- **Hosting.** Keep exactly one server process per state directory, on one machine with a local disk (no NFS or multiple replicas), started from this directory with the same `.env` and `.state/`. A process manager (systemd, launchd, or a container with a persistent volume for `STATE_DIR`) can restart it after a crash; saved state is picked up and polling recovers missed events.
- **Revoking access.** To stop the guardrail from changing Linear, `pause` it. To cut off its API access entirely, revoke the app's API key or delete the app.
- **Records.** Each `.state/<team-uuid>/audit.jsonl` contains issue IDs, ranks, and user UUIDs, not credentials. Retention and backups are up to you.

## Protect more teams

Once one team works as expected, add more `<team-uuid>:<label-uuid>` pairs to `PROTECTED_TEAMS`, separated by commas. One server protects every listed team, and one workspace webhook can cover all of them.

1. Prepare each new team as in step 2: a label, the labeled issues, and a Manual order list. Give the app access if the team is private (step 3).
2. `pause` (this pauses every already protected team), stop the server with Ctrl+C, add the new pair to `PROTECTED_TEAMS`, and restart with `npm start`. The startup line shows the new `teams=` count.
3. Publish and resume the new team by its UUID. New teams start paused without a baseline, so nothing happens in them until you do:

   ```sh
   node --env-file=.env src/cli.js status --team NEW_TEAM_UUID
   node --env-file=.env src/cli.js publish --team NEW_TEAM_UUID
   node --env-file=.env src/cli.js resume --team NEW_TEAM_UUID
   ```

4. Resume each existing team with `resume --team TEAM_UUID` once its order still matches its baseline.
5. If you use a webhook, add the new team to it (step 10).

With more than one protected team:

- `status`, `pause`, and `check-actor` apply to every team unless you add `--team <team-uuid>`, and return one result per team in `{ "teams": [...] }`.
- `publish` and `resume` change one team at a time and require `--team <team-uuid>`.
- Every result includes its `team`, and each team's audit log is `.state/<team-uuid>/audit.jsonl`.
- Role approvals use each team's own owners: an owner of team A can approve reorders in team A, not in team B. Workspace owners and admins can approve in every team.
- The server checks the teams one after another about every five seconds, so each team adds Linear API requests to every check.

To stop protecting a team, `pause --team TEAM_UUID`, stop the server, remove its pair from `PROTECTED_TEAMS`, and restart. Its directory under `.state/` is kept; if you add the team back with the same label, it resumes from that state, still paused.

## Command reference

Run from `services/rank_guardrail` as `node --env-file=.env src/cli.js <command> [--team <team-uuid>]`. Without `--team`, a command applies to every protected team; `publish` and `resume` need `--team` when more than one team is protected.

| Command | Calls Linear | What it does |
| --- | --- | --- |
| `status` | No | Prints mode, pause and breaker state, and the saved baseline. |
| `pause` | No | Stops checks and repairs; waits for a running check to finish. |
| `publish` | Yes | While paused, saves the currently labeled issues and their order as the baseline, and resets the breaker. |
| `resume` | Yes | Restarts checks if the current order matches the baseline. |
| `resume --restore` | Yes | Restarts checks even if the order changed, so the old baseline is restored. |
| `check-actor <user-uuid>` | Yes | Read-only: shows whether that user could approve a reorder in each protected team. |
| `serve` | Yes | Runs the server. `npm start` runs `serve` with `.env`. |

There is no `audit`, `enable`, `disable`, or `reset` command, and no HTTP dashboard or management endpoint.

## Troubleshooting

Inspect first; do not edit state by hand. In Terminal 2:

```sh
node --env-file=.env src/cli.js status
tail -n 20 .state/*/audit.jsonl
```

The audit file may not exist until the first successful state-changing command. A failed command prints `Command failed (<code>: <reason>)` and exits nonzero. Reasons name configuration variables and HTTP status codes, never their values, API response text, or credentials; anything unexpected prints `unexpected-error`.

| Code | Meaning / next step |
| --- | --- |
| `config` | A named `.env` value is missing, still a `REPLACE_WITH_` placeholder, or invalid (`PROTECTED_TEAMS` pairs or a repeated team, `ROLE_APPROVALS`, `APPROVAL_GRACE_MS`, `PORT`). `LINEAR_API_KEY ... placeholder` means the app's API key is not in `.env` yet (step 4). |
| `team-mismatch` | Each `PROTECTED_TEAMS` entry must start with the team's UUID, not its key or name. |
| `api-http` | Linear returned an HTTP error: 401 (the API key is wrong or revoked; check `LINEAR_API_KEY`), 403 (the app lacks access to this team or operation; check team access and `write` scope), 429 (rate limited; wait), 5xx (retry later). |
| `api-network` / `api-response` | No connection or timeout / unreadable response. Retry. |
| `api-graphql` | Linear rejected the request: check UUIDs, the app's team access, and scopes. Details are intentionally hidden. |
| `pause-required` | Run `pause`, wait for `"paused": true`, then `publish`. |
| `label-count` | Publish needs 1–100 non-archived issues with the team's label in that team; the message shows the team and how many were found. |
| `rank-collision` | Protected issues share a rank: while paused, drag them into a distinct order, then publish. |
| `order-changed` | `resume` found a different order. Restore the approved order while paused, or `publish` the new order on purpose. |
| `no-baseline` | Run `pause`, then `publish` first. |
| `breaker-tripped` | See the `tripped: true` row below. |
| `state-scope` | The team's saved state was published with a different label. Restore the previous `PROTECTED_TEAMS` entry, or use a separate `STATE_DIR`. |
| `state-lock` / `state-unreadable` | See the lock row below / preserve `state.json` and stop all processes. |
| `usage` | Unknown command or argument, `--team` not listed in `PROTECTED_TEAMS`, or `publish`/`resume` without `--team` while several teams are protected. |

| Symptom | Check / next step |
| --- | --- |
| No repair, `would-repair` appears | The server is in dry run. Use step 8 if you want real writes. |
| No checks, `paused: true` | Check the approved and current order, then run `resume`. Editing `.env` alone does not resume. |
| `paused: false`, but nothing happens | Is the server still running? Is there a baseline? Is `tripped` false? Check the Manual order ungrouped view, the startup line, and the audit log. |
| `status` says `dryRun: false` but the server logs plans | The CLI read the edited file but the old server did not. Pause, stop and wait for exit, restart, check the startup line, then resume. Check for exported variables overriding `.env`. |
| Initial `publish` fails | Read the error code. Check `PROTECTED_TEAMS`, the team and label UUIDs, the API key and team access, 1–100 labeled non-archived issues, and distinct ranks. |
| Allowed user's drag is repaired | Approvals are off (`roleApprovals=false` on the startup line), the webhook is missing or late, `check-actor` denies the user, or the change was mixed or stale. See step 11 and the `approval-rejected` reason. |
| `resume` fails | It needs a baseline, an untripped breaker, and the current order matching the baseline. While paused, restore the approved order or intentionally `publish` a new one. Do not reach for `--restore` by default. |
| `tripped: true` | Stop and inspect the audit log. The repair budget is 3 writes per check and 10 writes per 10 minutes, and 3 consecutive failed checks (for example, a revoked API key) also trip it. Once you understand the cause, pause, fix it, arrange the desired order, publish, and resume. Waiting or restarting alone does not clear it. |
| Webhook returns 401 | Check the webhook's signing secret (it is not the OAuth app's API key or client secret), restart after changing it, make sure the machine's clock is correct, and test with a fresh delivery. Polling keeps working meanwhile. |
| Wrong team, label, or baseline in `status` | Check the working directory, `STATE_DIR`, and `PROTECTED_TEAMS`. Never run two state directories against the same protected issues. |
| Lock error, or a command hangs then fails | A check may hold the lock; wait and retry (the wait is about 30 seconds). After an unclean kill, stop **every** process using that state directory before removing a confirmed stale `.state/lock` directory. Never remove an active lock or delete `.state` to fix a problem. |

For corrupt state, preserve `.state/` for review and stop all processes before deciding how to recover.

## Technical details and limitations

- **Selection.** A team's baseline is every non-archived issue in that team with its label, including completed issues, with no project, status, cycle, or assignee filtering. Removing the label from a baselined issue does not unprotect it, and newly labeled issues are not added, until the next `publish`.
- **Repair.** Repairs re-space the protected issues from the current lowest rank, at least 1,024 rank units apart. This can move neighbors and is not a minimum-movement algorithm. Each write is preceded by a fresh read, and an unexpected rank (a concurrent edit) triggers a new plan. Ties trigger repair; unrepresentable ranks fail closed. Large reorders can exceed the write budget and trip the breaker for review.
- **Concurrency.** There is no atomic compare-and-set in Linear for rank or team, so an edit or team move between a fresh read and an update can still race. Pause before moving protected issues to another team. A protected issue that is missing, archived, or moved out of the team counts as a failed check. Publish during a quiet period while paused; paginated reads are not an atomic snapshot.
- **Timing.** The server checks about every five seconds with ten-second API timeouts. Repairs are eventual, not guaranteed within a fixed delay.
- **Role approvals** are conservative: missed, late, stale, mixed, or anchor-mismatched events are repaired rather than approved, and an allowed user's move that builds on someone else's unapproved drift is repaired too. A change that re-ranks several issues is approved only if every change arrives as an allowed user's webhook. There is no CLI command to approve a single move; use pause and publish. Role lookups read `user(id)` fields (`active`, `app`, `admin`, `owner`, `organization`, and `teamMemberships`); only the exact protected team counts, not parent teams, and more than 1,000 memberships fail closed for non-admins. Lookups are not cached between checks, so revoked roles apply immediately. Approval evidence is kept per team for at most 10 minutes or 200 events, and is discarded on pause/resume and publish.
- **State.** Each team has its own directory and local lock under `STATE_DIR`, which serializes that team's CLI commands and checks; use one machine and a local filesystem, not NFS. `state.json` is replaced atomically, which survives process restarts but is not a power-loss or distributed guarantee.
- **Webhooks.** The server verifies the hex HMAC-SHA256 `Linear-Signature` over the raw body and requires the signed `webhookTimestamp` to be within 60 seconds; a `Linear-Timestamp` header, if present, must match it. Bodies over 1 MiB get 413, failed verification 401, and persistence failures 503 (so Linear retries). Each event is offered to every protected team; a team saves only events for its own issues (or its baseline issues that moved away), before acknowledgment, deduplicated per team (up to 4,000 keys). Correctness comes from periodic fresh reads, not webhook payload ranks.
- **API usage.** Reads issues (`sortOrder`, `updatedAt`, labels), the team, `viewer`, and `user` for role checks; writes only `issueUpdate(id, input: { sortOrder })`. The Authorization header is `Bearer <LINEAR_API_KEY>`, or the value unchanged if it already names a scheme or is a personal `lin_api_` key.

## References

- [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)
- [Webhooks, payloads, and signature verification](https://linear.app/developers/webhooks)
- [GraphQL API](https://linear.app/developers/graphql) and [pagination](https://linear.app/developers/pagination)
