# Linear OAuth Token Demo

An interactive reference app for Linear customers building OAuth integrations. It demonstrates three authentication patterns and how to **programmatically renew tokens** when they expire — without requiring user interaction (after initial setup, where applicable).

Run it locally to compare:

- **Developer token** — static, manual regeneration only
- **OAuth authorization code flow** — refresh token renewal after a one-time user install
- **Client credentials** — server-to-server token renewal using `client_id` + `client_secret`

## Which approach should I use?

| Approach | Best for | User install? | Access token TTL | How to renew |
|----------|----------|---------------|------------------|--------------|
| Developer token | Local development & prototyping | No | 30 days | Regenerate manually in app settings |
| OAuth (auth code + refresh) | Multi-workspace apps, user-authorized integrations | Yes, once per workspace | 24 hours | `grant_type=refresh_token` |
| Client credentials | CI, cron jobs, internal services, single-workspace automation | No | 30 days | `grant_type=client_credentials` (fetch new token) |

> **Important:** Client credentials tokens do **not** include a refresh token. Linear expects your server to request a new access token when the current one expires or when an API call returns **401**.

Token renewal for both OAuth refresh and client credentials happens via REST at `https://api.linear.app/oauth/token` — not via GraphQL. GraphQL is only used for API calls after you have a valid bearer token.

## Quick start

### 1. Create an OAuth app

In your Linear workspace: **Settings → API → OAuth Applications → Create app**

For the **OAuth (auth code)** column:

- **Redirect URI:** `http://localhost:3000/callback/oauth`
- **Enable refresh tokens**
- **Actor:** `app`

For the **Client Credentials** column:

- **Enable client credentials tokens** (toggle in OAuth app settings)
- No redirect URI needed for client credentials alone

### 2. Configure credentials

Copy the example env file and add your OAuth app credentials:

```bash
cp env.example .env
```

Edit `.env`:

```bash
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
```

The server loads `.env` automatically on startup. You can still use `export` in your shell instead if you prefer.

### 3. Run the demo

```bash
npm install
npm start
```

Open http://localhost:3000

## How to demo each column

### Column 1 — Developer Token (optional, no `.env` required)

1. In Linear: **Settings → API → OAuth Applications → [your app] → Developer token**
2. Copy the token and paste it into the left column
3. Click **Store dev token** → **Simulate API call**
4. Point out: no renewal path — when it expires, you regenerate manually

### Column 2 — OAuth refresh token flow

Requires `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in `.env`.

1. Click **Install OAuth app** — complete the browser consent flow as a workspace admin
2. After redirect, you'll see access token (24hr) and refresh token (30-day)
3. Click **Simulate API call** — makes a real `{ viewer { name email } }` GraphQL query
4. Click **Force expire access token** — simulates the 24hr expiry instantly
5. Click **Simulate API call** again — watch the event log:
   - Access token expired
   - POST `/oauth/token` with `grant_type=refresh_token`
   - New access + refresh tokens stored
   - GraphQL call succeeds

### Column 3 — Client credentials renewal

Requires `.env` credentials **and** "Client credentials tokens" enabled on your OAuth app.

1. Click **Fetch client credentials token** — server POSTs `grant_type=client_credentials`
2. You'll see a 30-day app actor access token (no refresh token)
3. Click **Simulate API call** — GraphQL call with the bearer token
4. Click **Force expire access token** — simulates expiry
5. Click **Simulate API call** again — watch the event log:
   - Access token expired
   - POST `/oauth/token` with `grant_type=client_credentials`
   - New access token stored
   - GraphQL call succeeds

You can also click **Fetch new token** anytime to manually renew without waiting for expiry.

### Reset between demos

Delete `.tokens.json` in the project root to clear stored tokens, then restart the server (or click **Disconnect** in each column).

## What each column demonstrates

### Developer Token

Paste a dev token from your OAuth app settings page. Calls the Linear GraphQL API directly. No renewal mechanism — when it expires, generate a new one manually.

### OAuth App (authorization code flow)

1. **Install** — a workspace admin authorizes your app once via the browser
2. **Store tokens** — access token (24hr) + refresh token (30-day)
3. **Make API calls** — check access token expiry before each call
4. **Refresh automatically** — POST to `/oauth/token` with `grant_type=refresh_token`
5. **Persist rotated tokens** — save both the new access token and new refresh token

Use **Force expire access token** to trigger the refresh cycle instantly.

### Client Credentials (server-to-server)

1. **Fetch token** — POST to `/oauth/token` with `grant_type=client_credentials`, your `client_id`, `client_secret`, and `scope`
2. **Store access token** — 30-day app actor token, no refresh token returned
3. **Make API calls** — use the token as a Bearer header on GraphQL requests
4. **Renew on expiry or 401** — POST the same client credentials request again to get a new access token

Use **Force expire access token** then **Simulate API call** to watch automatic renewal in the event log.

## How client credentials renewal works

This is the pattern for server-to-server integrations:

```
Before every Linear API call (or on 401):
  1. Check if access token is expired (or expiring soon)
  2. If yes → POST https://api.linear.app/oauth/token
       grant_type=client_credentials
       scope=read,write
       client_id=<your client id>
       client_secret=<your client secret>
  3. Save the new access_token from the response
  4. Proceed with the GraphQL API call using the new token
```

Key details:

- **No refresh token.** Renewal means requesting a brand-new access token with the same client credentials.
- **App actor token.** The token acts as your OAuth app within the workspace where the app was created.
- **30-day TTL.** Plan to renew proactively or reactively on 401.
- **Server-side only.** Never expose `client_secret` in a browser or mobile app.
- **Enable in app settings.** Your OAuth app must have client credentials tokens toggled on, or Linear returns an error.

### Example: wrap API calls with auto-renewal

```javascript
async function getClientCredentialsToken() {
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "read,write",
      client_id: process.env.LINEAR_CLIENT_ID,
      client_secret: process.env.LINEAR_CLIENT_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`Token request failed: ${await res.text()}`);

  const data = await res.json();
  await saveToken({
    accessToken: data.access_token,
    accessExpiry: new Date(Date.now() + data.expires_in * 1000),
  });

  return data.access_token;
}

async function getValidAccessToken(stored) {
  const bufferMs = 24 * 60 * 60 * 1000; // renew 1 day before expiry
  if (stored.accessToken && Date.now() < new Date(stored.accessExpiry) - bufferMs) {
    return stored.accessToken;
  }
  return getClientCredentialsToken();
}

async function linearQuery(stored, query) {
  let token = await getValidAccessToken(stored);

  let res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });

  if (res.status === 401) {
    token = await getClientCredentialsToken();
    res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
  }

  return res.json();
}
```

See `server.js` for the full working implementation used by this demo.

## How OAuth refresh-token renewal works

For integrations that use the authorization code flow:

```
Before every Linear API call:
  1. Check if access token is expired (or expiring soon)
  2. If yes → POST https://api.linear.app/oauth/token
       grant_type=refresh_token
       refresh_token=<stored refresh token>
       client_id=<your client id>
       client_secret=<your client secret>
  3. Save the new access_token AND refresh_token from the response
  4. Proceed with the API call
```

- **Refresh tokens rotate.** Each refresh invalidates the previous refresh token.
- **On refresh failure**, redirect the workspace admin through the install flow again.

## Token storage

Tokens are persisted to `.tokens.json` in the project root so a server restart does not require re-fetching. Delete this file to start fresh.

> **Demo only:** `.tokens.json` stores full tokens in plain text for visibility. In production, use a secrets manager or encrypted database — never commit tokens to git.

## Edge cases & production notes

Customers implementing token renewal should be aware of these behaviors:

### OAuth refresh token flow

- **Refresh tokens rotate.** Every successful refresh invalidates the previous refresh token. If you save the new access token but not the new refresh token, the next renewal will fail.
- **30-minute replay grace period.** If a refresh request succeeds but your server doesn't receive the response (network error), you can replay the same refresh request with the old refresh token for up to 30 minutes. After that, the old token is invalidated and you need a re-install.
- **Refresh token expiry (~30 days).** If the refresh token itself expires or the app is uninstalled, refresh fails — redirect the workspace admin through the install flow again.
- **Concurrent refreshes.** If multiple workers detect expiry at once, they may race to refresh. In production, use a lock (DB row lock, Redis mutex) so only one refresh runs and all workers read the persisted result.
- **Proactive refresh.** Don't wait until exact expiry — refresh a few minutes before (OAuth) or a day before (client credentials) to avoid failed API calls mid-request.

### Client credentials flow

- **No refresh token.** Renewal always means a new `grant_type=client_credentials` request — there is nothing to "refresh" in the OAuth sense.
- **401 handling.** Linear expects you to fetch a new token when an API call returns 401, even if your local expiry timestamp says the token is still valid (clock skew, early revocation, etc.).
- **Toggle required.** Client credentials must be enabled on the OAuth app in Linear settings, or the token endpoint returns `"Client does not support the client_credentials grant type"`.
- **Workspace-scoped.** The token is an app actor token for the workspace where the OAuth app was created. It does not grant access to other workspaces.
- **Scope changes revoke tokens.** Requesting a client credentials token with different scopes revokes all existing app actor tokens for that app and replaces them with the new one.
- **Secret rotation.** Rotating the OAuth app's client secret invalidates all existing client credentials tokens.
- **Token limit.** An app can hold up to 1000 active client credentials tokens in parallel (same scopes). This demo stores one; high-churn systems should reuse or revoke stale tokens.

### All flows

- **Token renewal is REST, not GraphQL.** All grant types use `POST https://api.linear.app/oauth/token`. GraphQL is only for API calls after you have a bearer token.
- **Server-side only.** `client_secret` must never ship to a browser, mobile app, or client-side JavaScript.
- **Don't mix patterns.** Client credentials (no user install) and authorization code + refresh (user install per workspace) solve different problems. Pick the one that matches your integration model.

## Further reading

- [Linear OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Client credentials tokens](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens)
- [Create an OAuth app](https://linear.app/settings/api/applications/new)
