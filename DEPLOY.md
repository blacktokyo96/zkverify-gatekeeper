# Deploy — zkVerify Gatekeeper (blacktokyo)

Service: plain long-running Node.js HTTP server (`npm start` -> `node src/server.js`).
Needs env vars: `AGENT_GAMES_HMAC_SECRET` (from dashboard Manage Agents -> Rotate Secret),
optional `KURIER_API_KEY`. Port from `PORT` (default 3000).

## Good targets (take this repo as-is)
- Railway / Render / Fly.io — connect the repo, set start command `node src/server.js`,
  set the env vars, deploy. You get a public `https://<host>` URL.
- A VPS the user already has — `git clone`, `npm ci`, `npm start` behind any reverse proxy with TLS.

## NOT as-is: Vercel
Vercel does not host long-running Node servers; this code would need to be wrapped as
Serverless Functions first. Prefer Railway/Render/Fly for tonight.

## After deploy
1. Endpoint URL is `https://<host>/agent` (health check: `GET https://<host>/health`).
2. Register the agent in the Agent Games dashboard (name, repo URL, endpoint URL).
3. Dashboard issues the HMAC secret -> set `AGENT_GAMES_HMAC_SECRET` on the host, restart.
4. Run the signed preflight from the dashboard, then practice mode before any scored round.

## Fly.io lessons (deployed 14 Nov 2026, app blacktokyo-gatekeeper, region sin)
- `fly deploy` fails with "app not found" if the app does not exist yet: create it
  first with `fly apps create <name> --org personal`.
- Fly does NOT inject `PORT` automatically. The server reads `PORT` (default 3000)
  while `http_service.internal_port` is 8080, so the first deploy warned "app is not
  listening on the expected address" and was unreachable. Fix: `[env] PORT = "8080"`
  in fly.toml (committed ff23ac4).
- `fly deploy` creates 2 machines by default (high availability). This service keeps
  its proof-reuse seen-set on local disk, so 2 machines would split it and could
  miss PROOF_REUSED traps. Scaled to 1 machine: `fly scale count 1 --yes`.
  Keep exactly 1 machine unless the seen-set moves to shared storage.
- Without `AGENT_GAMES_HMAC_SECRET` set, POST /agent fail-closes with
  `{"ok":false,"error":"server misconfigured"}` HTTP 500 — expected until the real
  secret is set via `fly secrets set AGENT_GAMES_HMAC_SECRET=...` + restart.
- Live URL: https://blacktokyo-gatekeeper.fly.dev (health 200, /agent 500 until secret).
  Fly account is a 7-day free trial (from 14 Nov 2026) — a credit card is needed
  after the trial to keep it running.
