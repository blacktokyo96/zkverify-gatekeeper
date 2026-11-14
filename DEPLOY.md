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
