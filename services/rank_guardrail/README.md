# Test the rank guardrail locally

This experimental service remembers an approved issue order and checks whether it has changed. In dry run it only logs the repair it would make. With writes explicitly enabled, it tries to restore the approved **relative order**. Use disposable issues in one dedicated TEST team only. This is not a native ordering lock or a production integration.

## 1. Understand the four separate controls

You do **not** edit `state.json` or change issue status to operate the guardrail. Use the commands below.

| Control | Where it lives | What it means |
| --- | --- | --- |
| Dry run | `DRY_RUN` in `.env`, read when each process starts | `true`: never write ranks. Exactly `false`: rank writes are permitted, subject to the other controls. Editing this file does not change an already-running server. |
| Paused | `.state/state.json`, changed with `pause` / `resume` | `paused: true`: no checks or repairs. `paused: false`: the running server may check the approved order. This is independent of dry run. |
| Baseline | `.state/state.json`, set with `publish` | The saved ordered IDs of the issues to protect. Publishing accepts the current labeled subset and its current order. It does not reorder issues in Linear. |
| Server running | The terminal running `npm start` | Only this long-running process checks/repairs ranks. CLI commands such as `resume` do not start a server. |

**Real repairs require all of these:** a running server, a published baseline, `paused: false`, the server started with `DRY_RUN=false`, and `tripped: false` (the safety breaker has not stopped it).

A new state directory starts paused, without a baseline. Restarting preserves the saved baseline, pause flag, and breaker. Restarting does **not** automatically resume. Turning off dry run does **not** resume either.

## 2. Install and prepare disposable issues

Use Node.js 22+ and npm (tested on Node 24). From the repository root, run:

```sh
cd services/rank_guardrail
npm ci --ignore-scripts
npm run build
npm test
cp .env.example .env
chmod 600 .env
```

Only copy `.env.example` for a new setup; do not overwrite an existing `.env`. The package has no dependencies. The build checks JavaScript syntax. Tests use mocks and loopback HTTP: no Linear API calls, ngrok, or real issue changes.

In Linear, prepare:

1. One dedicated team with the separate word `TEST` in its name, for example `Rank Guardrail TEST`.
2. Three disposable issues; call them A, B, C for this guide. Apply the same dedicated label to all three, and no other issues for now.
3. A team issue list set to **Manual order, ungrouped**, showing all three issues. Arrange A, B, C. Do not use a board, priority sort, sub-issue list, or grouped view for this first test.
4. An API key with access to read/update this test team only, where permission controls permit. Do not use production credentials.

## 3. Fill in `.env`

Open `.env` in your editor. Replace all five `REPLACE_WITH_...` values:

```dotenv
TEST_TEAM_ID=REPLACE_WITH_TEST_TEAM_UUID
TEST_TEAM_ALLOWLIST=REPLACE_WITH_SAME_TEST_TEAM_UUID
PROTECTED_LABEL_ID=REPLACE_WITH_LABEL_UUID
LINEAR_API_KEY=REPLACE_WITH_RESTRICTED_TEST_API_KEY
WEBHOOK_SECRET=REPLACE_WITH_LOCAL_RANDOM_SECRET_OR_REAL_WEBHOOK_SECRET
DRY_RUN=true
STATE_DIR=.state
PORT=8787
```

- The team value must be the team's UUID, not its name or key. Repeat that exact UUID in `TEST_TEAM_ALLOWLIST`.
- The label value must be the label's UUID, not its name. Keep the same team and label for this state directory.
- `WEBHOOK_SECRET` is required even when testing without a webhook. For the polling-only test, use a local random value, for example generate one with `openssl rand -hex 32` and paste it into `.env`. When adding a real webhook later, replace it with that webhook's actual signing secret and restart.
- Keep `.env` private. Do not paste your key or signing secret into chat. `.env` and `.state/` are gitignored.
- Leave `DRY_RUN=true` for now. Missing, misspelled, or upper-case values do not opt into writes; only the exact value `false` does.
- These instructions assume `STATE_DIR=.state` and `PORT=8787`. If you change either, adapt the file paths/port everywhere below.

If needed, these read-only queries in a GraphQL API client help locate IDs:

```graphql
query { teams { nodes { id name key } } }
query { issueLabels { nodes { id name team { id } } } }
```

These are paginated connections; follow further pages if the team/label is not on the first one. The program itself does not create teams, issues, labels, keys, or webhooks.

## 4. Open two terminals in the SAME directory

In **both** terminals, change into the full path to `services/rank_guardrail`. For example, if the repository is at `/Users/you/linear-solutions`, run:

```sh
cd /Users/you/linear-solutions/services/rank_guardrail
pwd
```

Replace the example path with your actual checkout. Both terminals must use the same `.env` and state directory. Do not run multiple copies of the server. Existing exported shell variables override values in Node's `--env-file`; use terminals without previously exported values for these configuration names.

- **Terminal 1:** runs the server and stays open.
- **Terminal 2:** runs short CLI commands and inspects results.

There is no HTTP dashboard or HTTP management endpoint. The CLI commands are `status`, `pause`, `publish`, `resume`, and `serve` (`npm start` runs `serve`). There is no `audit` command: read the audit file as shown below.

## 5. Publish your first baseline, then start in dry run

Leave the server stopped. In **Terminal 2**, run each command separately and check it succeeds:

```sh
node --env-file=.env src/cli.js pause
node --env-file=.env src/cli.js publish
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

What to expect:

- `pause` returns JSON containing `"paused": true`.
- `publish` reads Linear and saves the current labeled issues in ascending `sortOrder`. With only A, B, C labeled, its output includes `"paused": true`, `"protectedCount": 3`, `"dropped": []`, `"dryRun": true`. It **stays paused**.
- `status` shows a `baseline` array of three IDs/rank snapshots in A, B, C order. Confirm they are the intended issues. The first publish must contain 1–100 eligible issues; this guide uses exactly three.
- `resume` returns `"paused": false`. It does not start the server and does not perform a repair by itself.

If a command fails, stop here and use troubleshooting below. Do not continue on the assumption it worked.

Now in **Terminal 1**:

```sh
npm start
```

Wait for:

```text
Listening on localhost:8787; dryRun=true
```

Leave Terminal 1 running. The server checks immediately and about every five seconds after that. **A webhook and ngrok are not needed for this first test**: polling reads current order directly from Linear.

## 6. Test dry run: detect a change without repairing it

1. In Linear's ungrouped Manual list, drag C above A. The visible order should now be C, A, B.
2. Wait roughly 5–15 seconds (longer if API requests are slow).
3. In **Terminal 2**, inspect:

   ```sh
   node --env-file=.env src/cli.js status
   tail -n 10 .state/audit.jsonl
   ```

Expected: `paused` is `false`, `tripped` is `false`, the saved `baseline` is still A, B, C, and the audit contains `"event":"would-repair"`. **The visible order stays C, A, B.** That is the successful dry-run result. Repeated `would-repair` entries are normal until you restore the order.

Important: `status.baseline` is the saved approved order, not a fresh read of the visible order. `status.dryRun` describes the newly invoked CLI process, not the running server. The startup line in Terminal 1 tells you the server's mode.

## 7. Opt into real repairs safely (TEST issues only)

First put the issues back in the approved order while enforcement is paused:

**Terminal 2:**

```sh
node --env-file=.env src/cli.js pause
```

Wait for successful `"paused": true`. Then manually restore **A, B, C** in Linear. Do not publish C, A, B unless you actually want that to become the approved order.

**Terminal 1:** press **Ctrl+C** and wait for the server process to exit and the shell prompt to return. Do not force-kill it. Edit `.env` in your editor and change exactly:

```dotenv
DRY_RUN=false
```

Still in **Terminal 1**, restart:

```sh
npm start
```

Confirm the startup line now ends in **`dryRun=false`**. It is still paused because pause state survives restarts.

**Terminal 2:**

```sh
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

Expect `status` to show the A, B, C baseline and `paused: true`, then `resume` to return `paused: false`. Normal `resume` refuses if the current order does not match the baseline; restore A, B, C manually while paused before retrying.

Now drag C above A again. Wait roughly 5–15 seconds. **This time expect A, B, C to return.** Check:

```sh
node --env-file=.env src/cli.js status
tail -n 20 .state/audit.jsonl
```

Expect `repair-intent` entries and no `tripped: true`. Some successful repairs are followed by `in-order`; a repair completed at the final sweep step may not emit that event. Verify the visible relative order, not the presence of one particular success log line. Other protected issues can move during re-spacing; numeric ranks need not equal their original values.

To disable real repairs afterwards: run `pause` successfully in Terminal 2, stop Terminal 1 with Ctrl+C and wait for exit, edit `.env` back to `DRY_RUN=true`, and restart with `npm start`. Leave paused, or run `resume` only when the current approved order matches and you want dry-run checks again.

## 8. Intentionally accept a different order

Keep Terminal 1 running. In **Terminal 2**:

```sh
node --env-file=.env src/cli.js pause
```

**Wait for `paused: true` before dragging anything.** Then arrange C, B, A in Linear. Back in Terminal 2:

```sh
node --env-file=.env src/cli.js publish
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js resume
```

Expect the baseline to be C, B, A and the visible order to stay C, B, A after resuming. `publish` accepts the current order; it does not restore an older one. It also replaces the protected membership with the currently labeled subset and lists removed IDs in `dropped`. Review that list before resuming.

`pause` waits for any active sweep to finish under a shared filesystem lock. A failed or timed-out pause is **not** a pause acknowledgement. Publishing requires pause and clears the safety breaker/write budget, so do it only after reviewing the desired order and membership.

**Advanced option—not needed for this guide:** `resume --restore` bypasses the normal changed-order refusal and allows the server to restore the *old* baseline on its next check (if writes are enabled). Do not use it to accept an intentional reorder or as a generic fix for failed commands.

## 9. Optional: test webhook delivery with ngrok

Polling and webhook handling are separate checks. Seeing repairs happen does not by itself prove the webhook is configured correctly.

1. Keep the two terminals above. In a **third terminal**, start:

   ```sh
   ngrok http 8787
   ```

2. In Linear's webhook settings, create a webhook with URL `https://YOUR-NGROK-HOST/webhook`. Select only the dedicated test team and Issue events (updates required; include creation/removal where selectable). Do not select all teams.
3. Copy that webhook's actual signing secret into `WEBHOOK_SECRET` in `.env`. Pause from Terminal 2, stop Terminal 1 with Ctrl+C and wait for exit, restart `npm start`, then resume only after confirming the baseline/current order still match. The server cannot pick up a new secret without restarting.
4. Change a disposable issue and inspect Linear's delivery result or ngrok's private inspector. A valid delivery should receive HTTP 200 with `accepted`. Only this delivery evidence confirms the webhook path, signature, and timestamp checks passed; repairs alone could have come from polling. Keep the inspector private because it can retain issue payloads.

An unsigned local request should be rejected without stopping the server:

```sh
curl -i -X POST http://127.0.0.1:8787/webhook \
  -H 'Content-Type: application/json' --data '{"type":"Issue"}'
# Expected: HTTP 401
```

There is no browser home page or health endpoint; other routes return 404. If the ngrok hostname changes, update the webhook URL.

## 10. Additional acceptance checks

Use only disposable test issues. Avoid repeated live drags: they can exhaust the write budget. The mock tests cover retries, contention, and duplicate callbacks without spending that budget.

- **Other fields stay changed:** change B's status, cycle, and assignee, then disturb the approved order. After repair, those field changes should remain. The service sends only `{sortOrder}` in its update input.
- **Label removal stays protected:** remove the label from an issue already in the baseline and disturb its rank. It remains protected by saved ID. New labeled issues are not automatically added either. Only a later explicit paused `publish` updates membership.
- **Restart persists settings:** pause, stop/restart Terminal 1, and inspect `status`. Baseline and `paused: true` survive. Resume explicitly for further checks. Pending/missed events are recovered by periodic reads.
- **Duplicates/own callbacks:** run `npm test` for signed HTTP, retry deduplication, fresh reads instead of stale webhook ranks, and no additional writes once approved order is restored.
- **Missing/moved/archived issues:** tested with mocks. In live testing, pause before deliberately moving a protected issue out of the team; do not rely on a team-move race being atomic. A missing baseline issue on a fresh read fails closed, and three consecutive failed sweeps trip the breaker.

## Troubleshooting: inspect first, do not edit state by hand

Always run these in Terminal 2 from `services/rank_guardrail`:

```sh
node --env-file=.env src/cli.js status
tail -n 20 .state/audit.jsonl
```

The audit file may not exist until the first successful state-changing command. A CLI failure deliberately prints a generic message and exits nonzero; it does not expose API response details or credentials.

| Symptom | Check / next step |
| --- | --- |
| No repair, `would-repair` appears | Server is in dry run. Use section 7 only if you want real writes. |
| No checks, `paused: true` | Check the approved/current order, then run `resume`. Changing `.env` alone will not resume. |
| `paused: false`, but nothing happens | Is Terminal 1 still running? Is there a nonempty baseline? Is `tripped` false? Check the Manual ungrouped view, startup line, and audit. |
| `status` says `dryRun: false` but server logs plans | The CLI read the edited file, but the old server did not. Pause, stop and wait for exit, restart, verify its startup line, then resume as appropriate. Check for inherited exported variables overriding `.env`. |
| Initial `publish` fails | Verify all five required env values, actual team/label UUIDs, allowlist match, TEST in the team name, API permissions/connectivity, 1–100 labeled non-archived issues, and distinct finite ranks. |
| `publish` fails after previous testing | It requires `paused: true`. Run `pause` successfully first. |
| `resume` fails | It requires a baseline, an untripped breaker, and the current protected relative order matching the baseline. While paused, restore the approved order manually, or intentionally `publish` the new desired order. Do not automatically use `--restore`. |
| `tripped: true` | Stop experimenting. Inspect audit and issue eligibility. Repair budget is 3 writes per sweep / 10 attempted writes in 10 minutes; 3 consecutive failed sweeps also trip it. After understanding the cause, pause, arrange the desired eligible subset, publish deliberately, inspect, then resume. Waiting/restarting alone does not clear a tripped breaker. |
| Webhook returns 401 | Check the actual webhook signing secret, restart after editing it, synchronize your clock, and use a fresh delivery. The API key is not the webhook secret. Polling can still work while webhook verification fails. |
| Wrong team/label or different baseline in status | Stop; check working directory and `STATE_DIR`. Never run two different state directories against the same protected set. Changing team or label with existing state fails scope validation. |
| Lock error / command hangs then fails | A sweep may hold the lock; wait and retry (lock wait is about 30 seconds). After an unclean kill, stop **every** process using that state directory before removing only a confirmed stale `.state/lock` directory. Never remove an active lock or delete `.state` to fix a test. |

There are no `enable`, `disable`, `audit`, or `reset` CLI commands. Do not delete/edit `.state/state.json` to toggle modes. For corrupt state, preserve it for review and stop all processes before deciding on recovery.

## Technical scope and limitations

- The baseline selects all non-archived labeled issues in the configured team, including completed issues. No project/status/cycle/assignee filtering. Maximum 100 baseline issues and 10,000 team issues including archived ones.
- Relative protected order only: unprotected issues are not mutated but can appear in different positions among protected issues. Board columns, other filters/groupings, priority order, and sub-issue order are not equivalent to this baseline. Numeric baseline ranks are historical evidence, not an immutable lock.
- The deterministic repair re-spaces protected issues from the current minimum with at least 1,024 rank units. It can move neighbours and is not a minimum-movement algorithm. Ties trigger repair; unrepresentable ranks fail closed. Large reorders can exceed the small budget and require review.
- The server polls about every five seconds, with ten-second API timeouts. Repairs are eventual, not instantaneous or guaranteed within a fixed delay. There is **no atomic rank/team compare-and-set**: a concurrent edit or team move between a fresh team-scoped read and its update can still race. Pause before team moves. Publishing should happen during a quiet period while paused; paginated reads are not an atomic snapshot.
- A shared local lock serializes CLI commands and sweeps. Use one server/local filesystem, not NFS or multiple machines. `.state/state.json` is replaced by atomic rename; `.state/audit.jsonl` contains IDs/ranks, not credentials. This supports process restart, not power-loss/fsync or distributed-transaction guarantees. Custom state directories need separate gitignore rules; audit retention/backups are operator responsibilities.
- Webhooks verify raw-body hex HMAC-SHA256, with a signed integer millisecond `webhookTimestamp` within ±60 seconds; an optional `Linear-Timestamp` header must match. Body limit 1 MiB. Invalid authentication returns 401, oversized bodies 413, persistence failures 503. Relevant accepted events are persisted before acknowledgement. Best-effort delivery/header and byte deduplication keeps at most 4,000 keys. Periodic fresh reads maintain correctness independently of delivery headers, stale payload ranks, or actor identity.
- The API uses public GraphQL `sortOrder` reads and `issueUpdate(id,input:{sortOrder})` writes only. Signature/schema conventions came from the supplied previous-session source excerpts: [WebhookUtils](https://github.com/linear/linear-app/blob/master/api/src/utils/WebhookUtils.ts), [IssueWebhookPresenter](https://github.com/linear/linear-app/blob/master/api/src/entity/presenters/IssueWebhookPresenter.ts), [public schema](https://github.com/linear/linear-app/blob/master/api/src/graphql/schema-public.gql). No Linear application code is imported.

No live Linear workspace mutations, ngrok delivery, or settings UI interaction was used to validate this implementation or documentation. Offline tests verify the mock paths; the optional live acceptance tests above remain for the operator.
