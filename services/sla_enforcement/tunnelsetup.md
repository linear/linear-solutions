# Tunnel Setup for SLA Enforcement Agent

The SLA agent listens locally (default `PORT=3010`) and needs a public HTTPS URL so Linear can deliver webhooks. This doc covers tunnel options.

**Webhook path:** `/webhooks/linear` (plural — easy to typo as `/webhook/linear`).
**Full webhook URL format:** `https://<tunnel-host>/webhooks/linear`

---

## Cloudflare Tunnel

### Quick tunnel (ephemeral, no account)

```bash
cloudflared tunnel --url http://localhost:3010
```

- URL rotates every restart → must update Linear webhook each time.
- Fine for short demos.

### Named tunnel (stable URL, recommended)

Prereq: a domain managed by Cloudflare (free plan works).

One-time setup:
```bash
cloudflared tunnel login                                  # browser auth, saves cert
cloudflared tunnel create sla-agent                       # creates tunnel + creds
cloudflared tunnel route dns sla-agent sla.yourdomain.com # DNS record
```

Run:
```bash
cloudflared tunnel --url http://localhost:3010 run sla-agent
```

Webhook URL becomes permanent: `https://sla.yourdomain.com/webhooks/linear`

Optional — run as a service so it starts on boot:
```bash
sudo cloudflared service install
```

---

## ngrok

### Multiple tunnels on one machine

**Option 1 — two accounts via separate configs:**
```bash
# Default config holds account A's token
# Add account B's token to a second config
ngrok config add-authtoken <TOKEN_B> --config ~/.config/ngrok/ngrok-b.yml

# Run in two terminals
ngrok http 3000                                       # account A → SRE app
ngrok http 3010 --config ~/.config/ngrok/ngrok-b.yml  # account B → SLA agent
```

**Option 2 — one account, multiple tunnels in one config:**
```yaml
# ~/.config/ngrok/ngrok.yml
version: "3"
agent:
  authtoken: <TOKEN>
endpoints:
  - name: sre
    url: http://localhost:3000
  - name: sla
    url: http://localhost:3010
```

Start all: `ngrok start --all`

### Stable URL (paid)

Reserved domain on a paid plan:
```bash
ngrok http --domain=sla-agent.ngrok.app 3010
```

### Free-tier caveats
- 1 simultaneous tunnel per account → need a separate account per concurrent tunnel.
- Random URL that rotates on restart unless you have a reserved domain.
- Inspector at `localhost:4040`; second agent auto-picks `4041`, etc.

---

## Other options

- **Tailscale Funnel** — free, stable URL `https://machine.tailnet.ts.net`, requires Tailscale installed.
- **localtunnel** — free, `lt --port 3010 --subdomain sla-agent`, less reliable.

---

## Updating the Linear webhook

After any tunnel URL change:
1. Linear → Settings → API → Webhooks → edit the webhook.
2. Set URL to `https://<new-host>/webhooks/linear`.
3. Confirm `LINEAR_WEBHOOK_SECRET` in `.env` matches the webhook's signing secret (otherwise signature middleware rejects events).
4. Trigger an issue change to verify; agent terminal should log the incoming webhook.

## Troubleshooting

- `connection refused` from cloudflared → app isn't running on the port the tunnel targets. Start with `PORT=3010 npm run dev` (or `npm run build && npm start`).
- `{"error":"Not found"}` at the tunnel URL → tunnel works; you're hitting a path the app doesn't serve. Try `/health` to confirm.
- Webhook events not arriving → check the path is `/webhooks/linear` (plural) and the signing secret matches.
- Port already in use → pick a free port, update `PORT` in `.env`, restart both the app and the tunnel.
