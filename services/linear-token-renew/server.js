import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.json());

// -------------------------------------------------------------------
// Config — set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET from your
// OAuth app (Settings > API > OAuth Applications).
// -------------------------------------------------------------------
const CLIENT_ID = process.env.LINEAR_CLIENT_ID || "";
const CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET || "";

const CONFIG = {
  devtoken: {
    label: "Developer Token",
  },
  oauth: {
    label: "OAuth App",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: "http://localhost:3000/callback/oauth",
  },
  clientcredentials: {
    label: "Client Credentials",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scope: "read,write",
  },
};

const WORKSPACES = ["devtoken", "oauth", "clientcredentials"];

function emptyStoreEntry() {
  return { accessToken: null, accessExpiry: null, refreshToken: null, refreshExpiry: null, log: [] };
}

// -------------------------------------------------------------------
// In-memory token store
// -------------------------------------------------------------------
const store = {
  devtoken: emptyStoreEntry(),
  oauth: emptyStoreEntry(),
  clientcredentials: emptyStoreEntry(),
};

// Persist to disk so a restart doesn't lose tokens
const STORE_PATH = path.join(__dirname, ".tokens.json");
if (existsSync(STORE_PATH)) {
  try {
    const saved = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    const devtoken = saved.devtoken || saved.sandbox || {};
    const oauth = saved.oauth || saved.prod || {};
    const clientcredentials = saved.clientcredentials || {};
    Object.assign(store.devtoken, devtoken);
    Object.assign(store.oauth, oauth);
    Object.assign(store.clientcredentials, clientcredentials);
  } catch {}
}

function persist() {
  writeFileSync(
    STORE_PATH,
    JSON.stringify(
      {
        devtoken: store.devtoken,
        oauth: store.oauth,
        clientcredentials: store.clientcredentials,
      },
      null,
      2
    )
  );
}

// -------------------------------------------------------------------
// SSE clients for live UI updates
// -------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

function addLog(workspace, message) {
  const entry = { time: new Date().toISOString(), message };
  store[workspace].log.unshift(entry);
  store[workspace].log = store[workspace].log.slice(0, 50);
  broadcast("log", { workspace, entry });
}

// -------------------------------------------------------------------
// Token helpers
// -------------------------------------------------------------------
async function exchangeCode(code) {
  const cfg = CONFIG.oauth;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken() {
  const cfg = CONFIG.oauth;
  const s = store.oauth;
  if (!s.refreshToken) throw new Error("No refresh token stored");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: s.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) throw new Error(`Refresh failed: ${await res.text()}`);
  return res.json();
}

async function fetchClientCredentialsToken() {
  const cfg = CONFIG.clientcredentials;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars first");
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: cfg.scope,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) throw new Error(`Client credentials request failed: ${await res.text()}`);
  return res.json();
}

function storeTokens(workspace, data) {
  const s = store[workspace];
  const now = Date.now();
  s.accessToken = data.access_token;
  s.accessExpiry = new Date(now + (data.expires_in || defaultTtlSeconds(workspace)) * 1000).toISOString();
  if (data.refresh_token) {
    s.refreshToken = data.refresh_token;
    s.refreshExpiry = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  } else if (workspace === "clientcredentials") {
    s.refreshToken = null;
    s.refreshExpiry = null;
  }
  persist();
  broadcast("tokens", { workspace, state: safeState(workspace) });
}

function defaultTtlSeconds(workspace) {
  if (workspace === "oauth") return 86400;
  return 30 * 24 * 60 * 60;
}

function safeState(workspace) {
  const s = store[workspace];
  return {
    connected: !!s.accessToken,
    accessToken: s.accessToken ? s.accessToken.slice(0, 12) + "..." : null,
    accessExpiry: s.accessExpiry,
    refreshToken: s.refreshToken ? s.refreshToken.slice(0, 12) + "..." : null,
    refreshExpiry: s.refreshExpiry,
    log: s.log,
  };
}

function isAccessTokenExpired(workspace) {
  const s = store[workspace];
  return !s.accessExpiry || new Date(s.accessExpiry) <= new Date();
}

async function renewOAuthAccessToken() {
  addLog("oauth", "Access token expired. POST /oauth/token with grant_type=refresh_token...");
  const data = await refreshAccessToken();
  storeTokens("oauth", data);
  addLog("oauth", "Refresh successful. New access token (24hr) + new refresh token issued. Old refresh token invalidated.");
}

async function renewClientCredentialsToken(reason) {
  addLog("clientcredentials", `${reason} POST /oauth/token with grant_type=client_credentials...`);
  const data = await fetchClientCredentialsToken();
  storeTokens("clientcredentials", data);
  addLog("clientcredentials", "New access token issued (30-day app actor token). No refresh token — store this access token.");
}

async function linearViewerQuery(accessToken) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: "{ viewer { name email } }" }),
  });

  return { status: res.status, json: await res.json() };
}

// -------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);

  WORKSPACES.forEach(ws => {
    res.write(`event: tokens\ndata: ${JSON.stringify({ workspace: ws, state: safeState(ws) })}\n\n`);
  });

  req.on("close", () => sseClients.delete(res));
});

app.get("/state", (req, res) => {
  const configured = !!(CLIENT_ID && CLIENT_SECRET);
  res.json({
    devtoken: safeState("devtoken"),
    oauth: safeState("oauth"),
    clientcredentials: safeState("clientcredentials"),
    config: {
      oauth: { configured },
      clientcredentials: { configured },
    },
  });
});

app.get("/install", (req, res) => {
  const cfg = CONFIG.oauth;
  if (!cfg.clientId || !cfg.clientSecret) {
    return res.status(400).send("Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars first.");
  }
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write");
  url.searchParams.set("actor", "app");
  res.redirect(url.toString());
});

app.get("/callback/oauth", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    addLog("oauth", `Install failed: ${error || "no code returned"}`);
    return res.redirect("/?error=install_failed");
  }

  try {
    const data = await exchangeCode(code);
    storeTokens("oauth", data);
    addLog("oauth", "App installed. Access token + refresh token stored.");
    res.redirect("/?installed=oauth");
  } catch (err) {
    addLog("oauth", `Code exchange failed: ${err.message}`);
    res.redirect("/?error=exchange_failed");
  }
});

app.post("/fetch-client-credentials", async (req, res) => {
  try {
    addLog("clientcredentials", "Requesting token via client_credentials grant...");
    const data = await fetchClientCredentialsToken();
    storeTokens("clientcredentials", data);
    addLog("clientcredentials", "Token received. App actor access token stored (30-day TTL, no refresh token).");
    res.json({ ok: true });
  } catch (err) {
    addLog("clientcredentials", `Token request failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.post("/force-expire/:workspace", (req, res) => {
  const workspace = req.params.workspace;
  if (workspace !== "oauth" && workspace !== "clientcredentials") {
    return res.status(400).json({ error: "Force expire is only supported for OAuth and client credentials flows" });
  }
  store[workspace].accessExpiry = new Date(Date.now() - 1000).toISOString();
  persist();
  const message =
    workspace === "oauth"
      ? "Access token manually expired. Next API call will trigger refresh."
      : "Access token manually expired. Next API call will fetch a new client credentials token.";
  addLog(workspace, message);
  broadcast("tokens", { workspace, state: safeState(workspace) });
  res.json({ ok: true });
});

app.post("/api-call/:workspace", async (req, res) => {
  const workspace = req.params.workspace;
  const s = store[workspace];

  if (!s.accessToken) return res.status(400).json({ error: "Not connected" });

  if (workspace === "oauth" && isAccessTokenExpired("oauth")) {
    try {
      await renewOAuthAccessToken();
    } catch (err) {
      addLog("oauth", `Refresh failed: ${err.message}`);
      return res.status(401).json({ error: err.message });
    }
  }

  if (workspace === "clientcredentials" && isAccessTokenExpired("clientcredentials")) {
    try {
      await renewClientCredentialsToken("Access token expired.");
    } catch (err) {
      addLog("clientcredentials", `Renewal failed: ${err.message}`);
      return res.status(401).json({ error: err.message });
    }
  }

  try {
    let { status, json } = await linearViewerQuery(store[workspace].accessToken);

    if (workspace === "clientcredentials" && status === 401) {
      addLog("clientcredentials", "GraphQL returned 401. Fetching new client credentials token and retrying...");
      await renewClientCredentialsToken("401 from GraphQL.");
      ({ status, json } = await linearViewerQuery(store[workspace].accessToken));
    }

    if (status === 401) throw new Error("Authentication failed (401)");
    if (json.errors) throw new Error(json.errors[0].message);

    addLog(workspace, `API call successful. Viewer: ${json.data.viewer.name} (${json.data.viewer.email})`);
    res.json({ ok: true, viewer: json.data.viewer });
  } catch (err) {
    addLog(workspace, `API call failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post("/store-dev-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });
  const s = store.devtoken;
  s.accessToken = token;
  s.accessExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  s.refreshToken = null;
  s.refreshExpiry = null;
  persist();
  addLog("devtoken", "Dev token stored. Valid for 30 days, no refresh mechanism.");
  broadcast("tokens", { workspace: "devtoken", state: safeState("devtoken") });
  res.json({ ok: true });
});

app.post("/disconnect/:workspace", (req, res) => {
  const workspace = req.params.workspace;
  if (!store[workspace]) return res.status(404).json({ error: "Unknown workspace" });
  Object.assign(store[workspace], emptyStoreEntry());
  persist();
  addLog(workspace, "Disconnected.");
  broadcast("tokens", { workspace, state: safeState(workspace) });
  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("\nLinear OAuth Demo running at http://localhost:3000\n");
  console.log("Set env vars before starting:");
  console.log("  LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET\n");
});
