# zkVerify Agent Games — Proof Gatekeeper agent (blacktokyo)

Public HTTPS endpoint that plays Proof Gatekeeper: it receives signed task
envelopes from the Agent Games platform, decides APPROVE/REJECT with
deterministic field checks, and returns its own Groth16 proof (snarkjs +
the real gatekeeper circuit) for the platform to re-verify.

- Track: Proof Gatekeeper — 100,000 VFY, split 50/30/20.
- Rounds: 13–20 Nov 2026, nightly 17:30–03:30 WIB, 8 tasks/agent/round.
- Round 1 result: 112 issued, 65 responded, **only 3 verified** — the
  Groth16 proof is the hard part. This agent generates a real proof for
  every provable task (see "Proof" below).

## Run

```bash
cd ~/workspace/zkverify-gatekeeper
npm install            # only dependency: snarkjs 0.7.5
cp .env.example .env   # then fill in the real secret (see below)
AGENT_GAMES_HMAC_SECRET=<secret from dashboard> PORT=3000 node src/server.js
```

Endpoints:

- `GET /health` → `{ ok: true, agent: "blacktokyo-gatekeeper", protocolVersion: "v1" }`
- `POST /agent` → task envelope or preflight, HMAC-signed both ways.

The server is currently running on this VM on port 3000 with a
**placeholder** secret (`PLACEHOLDER-rotate-from-dashboard`) — preflight
will fail until the real secret is set. Restart after changing the secret:
`pkill -f "node src/server.js"` then start again as above.
Note: this VM restarts roughly every 2 h; the server must be restarted
after each VM restart.

## HMAC secret

Dashboard → Manage Agents → **Rotate Secret** (revealed once). Set it as
`AGENT_GAMES_HMAC_SECRET` in the environment. Never paste it in chat,
never commit it. The user sends it via the Secure Vault flow.

- Inbound: header `x-agent-games-signature` = hex HMAC-SHA256 over the
  **raw request body**. Verified before parsing JSON; mismatch → 401.
- Outbound: every response carries the same header over the raw response
  body. Missing secret → server refuses all POSTs (fail closed).

## Response format — RESOLVED (with one documented ambiguity)

The event page's "Expected response shape" (`{decision, reason_code,
proof_tx}`) is a **simplified example**. The authoritative `/build` guide
says the signed response is:

```json
{ "decision": "APPROVE|REJECT", "reason_code": "VALID_CONDITION|…",
  "proof": { …Groth16… }, "public_signals": [ …13 values… ] }
```

plus optional `proof_tx`. `/build` states explicitly: *"an omitted or
invalid proof costs −2"* and *"proof_tx is an optional on-chain audit
pointer"*. So: `proof` + `public_signals` are required on every provable
task; `proof_tx` is included only when the proof was submitted to Kurier
and a tx/job id came back (needs `KURIER_API_KEY`, see below).

Preflight (`type: "agent-games.preflight.v1"`) → `{ ok: true,
protocolVersion: "v1" }`, signed. Preflight must pass before the
platform marks the agent active.

## Decision logic (deterministic, `src/decision.js`)

One mismatch = REJECT. Precedence if a task ever carried two faults
(published traps are single-fault; frequencies sum to 100%):

1. `proof_vk != registered_vk` → REJECT `VK_SUBSTITUTION`
2. `proof_tx` already in local seen-set → REJECT `PROOF_REUSED`
   (no proof attached — per `/build`, reused tasks are excluded from
   the proof requirement)
3. `public_balance < minimum` → REJECT `THRESHOLD_MISMATCH`
4. `current_block > expiry_block` → REJECT `EXPIRED_CONDITION`
   (a task is still valid inside its expiry block)
5. `recipient != condition_recipient` (case-insensitive) → REJECT
   `RECIPIENT_MISMATCH`
6. `amount > max_transfer` → REJECT `AMOUNT_OVERFLOW`
7. otherwise → APPROVE `VALID_CONDITION`

Seen-set and per-task response cache persist in `data/seen.json` and
`data/responses.json` (retries of the same `task_id` return the cached
response instead of re-deciding). If proof generation fails, the agent
still returns the correct decision without a proof — a correct decision
without a proof scores +12−2, far better than flipping to a wrong
decision (−3/−6).

## The circuit — reverse-engineered from the shipped artifacts

No input schema is published anywhere on the site, so the circuit was
probed directly (`circuits/gatekeeper.wasm` + `gatekeeper_final.zkey`,
downloaded from `/api/circuit-info`; vkHash
`0x6b79c6012a6d8651f3e13bc4d2a20370280ab4970c90c5316d4168bfbad77b0`).
Verified facts:

- Groth16/BN128, Circom 2.x, **13 public signals**, witness size 647.
- 13 inputs, all public: `decision, amount, minimum, publicBalance,
  expiryBlock, currentBlock, maxTransfer, recipient, conditionRecipient,
  taskId, registeredVkHash, proofVkHash, salt`.
- Public-signal order (measured): `[digest, proofVkHash,
  registeredVkHash, minimum, publicBalance, expiryBlock, currentBlock,
  recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`.
  Signal 0 is a digest that changes with `salt` but not with `amount` —
  `salt` is the private randomness, so the platform can only check the
  other 12 signals against the task.
- The circuit **enforces** `decision == (all checks pass)`: a wrong
  decision (APPROVE on a trap, REJECT on a valid task) fails witness
  generation with `Assert Failed` in `GatekeeperEvaluation` line 102.
  A correct decision always produces a proof that verifies locally.

Field conversions used (`src/field.js`) — **not documented on the site**,
see "Open questions" below:

- hex strings (addresses, vk hashes) → `BigInt(hex) mod BN128 prime`
- `taskId` string (`"gk_24_9d1"`) → `BigInt(sha256(taskId)) mod prime`
- `salt` → fresh random 128-bit value per proof

## zkVerify submission (Kurier) — optional

`/build` recommends submitting the proof via Kurier
(`POST https://api.kurier.xyz/api/v1/submit-proof/<KURIER_API_KEY>`,
`{proofType:"groth16", vkRegistered:true, proofOptions:{library:"snarkjs",
curve:"bn128"}, proofData:{proof, publicSignals, vk: <gatekeeper vkHash>}}`)
and waiting for Finalized. That needs a **Kurier mainnet API key**
(signup at kurier.xyz — not created here). Without it (`KURIER_API_KEY`
unset) the agent skips submission and answers with `proof` +
`public_signals` only; the platform re-verifies the proof itself against
its own registered VK, which is sufficient per the docs.

NOT implemented: on-chain verification of the *incoming* third-party
proof (`proof_tx`). Every trap description states the incoming proof is
already on-chain/genuine; verifying it would need the same Kurier key
(or a funded zkVerifyJS/Volta account). The decision logic does not
depend on it — the 7 field checks are the actual game.

## Tests — all passing

`npm test` (boots the real server with a test secret; `test/test-traps.mjs`):

```
38 passed, 0 failed
VALID_CONDITION:      APPROVE / VALID_CONDITION, proof verifies locally
VK_SUBSTITUTION:      REJECT  / VK_SUBSTITUTION, proof verifies locally
THRESHOLD_MISMATCH:   REJECT  / THRESHOLD_MISMATCH, proof verifies locally
EXPIRED_CONDITION:    REJECT  / EXPIRED_CONDITION, proof verifies locally
RECIPIENT_MISMATCH:   REJECT  / RECIPIENT_MISMATCH, proof verifies locally
AMOUNT_OVERFLOW:      REJECT  / AMOUNT_OVERFLOW, proof verifies locally
PROOF_REUSED:         REJECT  / PROOF_REUSED, proof correctly omitted
preflight:            { ok:true, protocolVersion:"v1" }, signed
bad HMAC -> 401; retry of same task_id -> identical cached response
```

Timings (this VM, 1.5 shared CPU): witness ~50 ms, Groth16 prove
~300–1,000 ms (first prove ~1 s, warm ~0.3 s), local verify ~40 ms,
full HTTP round-trip ~0.3–1.1 s — far inside the 60 s deadline.

## Deployment status — NO public URL yet (blocked, not skipped)

The server runs locally and is fully tested, but no no-login tunnel
works from this VM (verified 14 Nov 2026 ~17:30 WIB):

- `cloudflared` quick tunnel: provisioning fails with **403**
  (shared VM egress IP blocked for anonymous tunnels), tried twice.
- `localtunnel` (npm): `localtunnel.me` unreachable from this VM
  (connection timeout).
- `localhost.run` via SSH: connection reset by the egress proxy
  (198.19.0.1:3128 blocks outbound SSH).

To get a public HTTPS endpoint, one of these needs the user's login:

1. **Cloudflare Workers** (free) — needs `wrangler login`; snarkjs on
   Workers is risky (wasm + Node APIs), needs a test deploy.
2. **Vercel** (free hobby) — needs Vercel login; adapt to a serverless
   function (proof gen ~1 s fits; the seen-set would need Vercel KV or
   similar for persistence across instances).
3. **Railway / Render / Fly.io** free tier — needs account login.
4. Any VPS the user already has — copy this directory, `npm install`,
   run with the real secret, expose port 3000 via HTTPS.

## Open questions (to confirm in practice mode)

1. **Field mapping** — ✅ VALIDATED 14 Nov 2026 ~20:20 WIB by practice task
   `practice_7657e096-d869-4b5f-849c-afbefd1b9ec6` (EXPIRED_CONDITION):
   platform verdict CORRECT DECISION, proof VERIFIED. So `sha256(taskId)
   mod p` and `BigInt(hex) mod p` are the right mapping — do not vary
   them. (The site never documents the mapping; this practice result is
   the evidence.)
2. **HMAC format** — ✅ VALIDATED: raw hex works — preflight requests
   (id b6faae1f-bb74-4cae-9b6e-079ef4c83de1) pass HMAC verification and
   the practice task was accepted.
3. **Kurier key** — optional but recommended; user signs up at
   kurier.xyz and provides the key via Secure Vault.
4. **Expiry edge** — `current_block == expiry_block` is treated as
   still valid (expired iff `current > expiry`).

## Exact next steps for Yahya

1. **Deploy** — pick one of the options above (Vercel is the fastest
   known-good path for a Node service) and give the deploy its URL,
   e.g. `https://<name>.vercel.app/agent`. Or provide a VPS/host.
2. **Send the HMAC secret** via Secure Vault (dashboard → Manage Agents
   → Rotate Secret) — never in chat. Set it as `AGENT_GAMES_HMAC_SECRET`
   and restart the server.
3. **Register the agent** in the dashboard: name (e.g.
   `blacktokyo-gatekeeper`), repo URL, endpoint URL (full path, e.g.
   `https://<host>/agent`). The platform runs a health check, then a
   signed preflight — both are handled by this code.
4. **Practice mode** — run at least one practice task per trap type and
   confirm the platform accepts the proofs (this validates open
   question 1). If a proof is rejected, tell the agent the exact error
   and it will adjust the field mapping. NOTE (14 Nov, 7 tasks): practice
   mode sends traps only — EXPIRED ×4, AMOUNT ×2, THRESHOLD ×1, never a
   VALID_CONDITION. The approve path can only be validated live in a
   scored round; it was first exercised in Round 3 (15 Nov 18:20 WIB,
   VALID_CONDITION, proof 780 ms, answered cleanly).
5. **Competition** — rounds 3–8 run 15–20 Nov, 17:30–03:30 WIB.
   Round 2 (14 Nov) is already missed; nothing to do about that.
6. Optional: Kurier API key (kurier.xyz signup) for the on-chain
   `proof_tx` pointer.
