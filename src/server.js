// Proof Gatekeeper agent endpoint — blacktokyo.
// POST /agent : signed task envelope (or signed preflight) -> signed JSON response.
// GET  /health: liveness probe for the platform health check.
// Secrets: AGENT_GAMES_HMAC_SECRET (from dashboard "Rotate Secret"), KURIER_API_KEY (optional).
// Fail-closed: bad/missing HMAC -> 401; unknown type -> 400; any internal error
// after parsing -> REJECT with the computed reason_code (proof omitted on failure).
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { decide } = require("./decision");
const { circuitInput } = require("./field");
const { generateProof } = require("./prove");
const { submitToKurier } = require("./kurier");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const DATA_DIR = path.join(__dirname, "..", "data");
const SEEN_PATH = path.join(DATA_DIR, "seen.json");
const CACHE_PATH = path.join(DATA_DIR, "responses.json");
const PROOF_BUDGET_MS = parseInt(process.env.PROOF_BUDGET_MS || "45000", 10);

fs.mkdirSync(DATA_DIR, { recursive: true });
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p + ".tmp", JSON.stringify(obj, null, 2));
  fs.renameSync(p + ".tmp", p);
}
let seen = loadJson(SEEN_PATH, {});       // proof_tx -> { task_id, at }
let cache = loadJson(CACHE_PATH, {});     // task_id -> response body (idempotent retries)

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
}
function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}
function verifyHmac(secret, rawBody, sigHeader) {
  if (!secret) return false;
  if (!sigHeader) return false;
  const expected = Buffer.from(hmacHex(secret, rawBody), "utf8");
  const got = Buffer.from(String(sigHeader).trim(), "utf8");
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}
function signBody(rawBody) {
  return HMAC_SECRET ? hmacHex(HMAC_SECRET, rawBody) : "";
}
function sendJson(res, status, obj, sign = true) {
  const raw = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (sign && HMAC_SECRET) headers["x-agent-games-signature"] = signBody(raw);
  res.writeHead(status, headers);
  res.end(raw);
}

async function handleTask(env) {
  const input = env.input || {};
  const taskId = env.task_id || env.taskId || "unknown";
  const proofTx = input.proof_tx || input.proofTx || null;

  // Idempotent retry of an already-processed task: return the cached response.
  if (cache[taskId]) return { response: cache[taskId], cached: true };

  const isReused = !!(proofTx && seen[proofTx]);
  const { decision, reason_code, trap } = decide(input, isReused);

  // Record the proof reference as seen (every submitted reference, any outcome).
  if (proofTx && !seen[proofTx]) {
    seen[proofTx] = { task_id: taskId, at: new Date().toISOString() };
    saveJson(SEEN_PATH, seen);
  }

  const response = { decision, reason_code };
  const decisionBit = decision === "APPROVE" ? 1 : 0;

  // PROOF_REUSED tasks carry no proof (per /build scoring notes: excluded).
  if (trap !== "PROOF_REUSED") {
    try {
      // task_id lives on the envelope, not inside input — pass it through.
      const proofPromise = generateProof(circuitInput({ ...input, task_id: taskId }, decisionBit));
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("proof budget exceeded")), PROOF_BUDGET_MS));
      const { proof, publicSignals, ms } = await Promise.race([proofPromise, timeout]);
      response.proof = proof;
      response.public_signals = publicSignals;
      log({ task_id: taskId, trap, proof_ms: ms });
      // Optional on-chain pointer (needs KURIER_API_KEY; skipped silently without it).
      try {
        const sub = await submitToKurier(proof, publicSignals);
        if (sub.submitted && sub.proofTx) response.proof_tx = sub.proofTx;
        if (sub.submitted) log({ task_id: taskId, kurier: "submitted", jobId: sub.jobId, proofTx: sub.proofTx, rawKeys: sub.raw ? Object.keys(sub.raw) : [] });
        if (!sub.submitted) log({ task_id: taskId, kurier: sub.reason });
      } catch (e) {
        log({ task_id: taskId, kurier_error: String(e.message || e) });
      }
    } catch (e) {
      // Correct decision without a valid proof still scores (+12, -2) — far better
      // than flipping the decision. Fail closed on the decision, open on the proof.
      log({ task_id: taskId, trap, proof_error: String(e.message || e) });
    }
  } else {
    log({ task_id: taskId, trap, proof: "omitted (PROOF_REUSED)" });
  }

  cache[taskId] = response;
  saveJson(CACHE_PATH, cache);
  return { response, cached: false };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return sendJson(res, 200, { ok: true, agent: "blacktokyo-gatekeeper", protocolVersion: "v1" }, false);
  }
  if (req.method !== "POST" || (req.url !== "/agent" && req.url !== "/")) {
    return sendJson(res, 404, { ok: false, error: "not found" }, false);
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    if (!HMAC_SECRET) {
      log({ error: "AGENT_GAMES_HMAC_SECRET not set — refusing (fail closed)" });
      return sendJson(res, 500, { ok: false, error: "server misconfigured" }, false);
    }
    if (!verifyHmac(HMAC_SECRET, raw, req.headers["x-agent-games-signature"])) {
      log({ error: "HMAC mismatch", url: req.url });
      return sendJson(res, 401, { ok: false, error: "bad signature" }, false);
    }
    let env;
    try {
      env = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    if (env.type === "agent-games.preflight.v1") {
      log({ preflight: env.agent_id || "?" });
      return sendJson(res, 200, { ok: true, protocolVersion: "v1" });
    }
    if (env.type !== "agent-games.proof-gatekeeper.v1") {
      return sendJson(res, 400, { ok: false, error: "unknown type" });
    }
    try {
      const { response } = await handleTask(env);
      return sendJson(res, 200, response);
    } catch (e) {
      log({ error: String(e.message || e), task_id: env.task_id });
      // Last-resort fail-closed: reject without proof.
      return sendJson(res, 200, { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log({ listening: PORT, hmac_configured: !!HMAC_SECRET, kurier_configured: !!process.env.KURIER_API_KEY });
});
