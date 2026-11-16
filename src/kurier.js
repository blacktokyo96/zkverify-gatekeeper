// Kurier submission of our own Groth16 proof (zkVerify mainnet).
// Flow per docs.zkverify.io (Verifying proofs with Kurier):
//   1. register-vk ONCE per API key with the vk JSON -> returns vkHash.
//   2. submit-proof with vkRegistered:true + that vkHash -> {jobId, optimisticVerify}.
//   3. poll job-status until a txHash appears -> that 0x hash is proof_tx.
// Without step 1 the vk is unknown to Kurier under our key and submit-proof
// fails (seen live: "kurier http 422" on Round 4 task 1, 16 Nov 2026).
// Without step 3 there is no tx hash yet — the submit response carries only
// a jobId, and the platform needs a network transaction to confirm.
// Only active when KURIER_API_KEY is set. Without it, the response carries
// proof + public_signals only and the platform scores the decision without
// a verified proof (+10 instead of +12, no reliability bonus).
const fs = require("fs");
const path = require("path");

const API_URL = "https://api.kurier.xyz/api/v1";
const GATEKEEPER_VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab4970c90c5316d4168bfbad77b0";
const VK_PATH = path.join(__dirname, "..", "circuits", "vk.json");

function loadVk() {
  try { return JSON.parse(fs.readFileSync(VK_PATH, "utf8")); } catch { return null; }
}

async function postJson(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, data, text: text.slice(0, 500) };
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, data, text: text.slice(0, 500) };
}

// Register the gatekeeper vk under our API key. Cached per process.
let vkRegPromise = null;
function registerVk() {
  if (!vkRegPromise) vkRegPromise = doRegisterVk();
  return vkRegPromise;
}

async function doRegisterVk() {
  const apiKey = process.env.KURIER_API_KEY;
  if (!apiKey) return { registered: false, reason: "no KURIER_API_KEY" };
  const vk = loadVk();
  if (!vk) return { registered: false, reason: "vk.json not found" };
  const t0 = Date.now();
  try {
    const r = await postJson(`${API_URL}/register-vk/${apiKey}`, {
      proofType: "groth16",
      proofOptions: { library: "snarkjs", curve: "bn128" },
      vk,
    }, 20000);
    if (!r.ok) return { registered: false, reason: `kurier register-vk http ${r.status}`, detail: r.text, ms: Date.now() - t0 };
    const vkHash = (r.data && (r.data.vkHash || (r.data.meta && r.data.meta.vkHash))) || null;
    return { registered: true, vkHash, matchesHardcoded: vkHash === GATEKEEPER_VK_HASH, ms: Date.now() - t0 };
  } catch (e) {
    return { registered: false, reason: `kurier register-vk error: ${String(e.message || e)}`, ms: Date.now() - t0 };
  }
}

// Poll job-status until a txHash appears (or budget runs out).
async function waitForTxHash(apiKey, jobId, budgetMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    try {
      const r = await getJson(`${API_URL}/job-status/${apiKey}/${jobId}`, 5000);
      if (r.ok && r.data && r.data.txHash) return { txHash: r.data.txHash, status: r.data.status || null, ms: Date.now() - t0 };
      if (r.ok && r.data && r.data.status === "Failed") return { txHash: null, status: "Failed", ms: Date.now() - t0 };
    } catch { /* transient — keep polling until budget ends */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { txHash: null, status: "timeout", ms: Date.now() - t0 };
}

async function submitToKurier(proof, publicSignals, { timeoutMs = 20000 } = {}) {
  const apiKey = process.env.KURIER_API_KEY;
  if (!apiKey) return { submitted: false, reason: "no KURIER_API_KEY" };
  const t0 = Date.now();
  // Step 1: make sure the vk is registered under this key.
  const reg = await registerVk();
  const vkHash = (reg.registered && reg.vkHash) || GATEKEEPER_VK_HASH;
  try {
    // Step 2: submit the proof.
    const r = await postJson(`${API_URL}/submit-proof/${apiKey}`, {
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: vkHash },
    }, timeoutMs);
    if (!r.ok) return { submitted: false, reason: `kurier http ${r.status}`, detail: r.text, vkRegistered: !!reg.registered, ms: Date.now() - t0 };
    const jobId = (r.data && (r.data.jobId || r.data.id || r.data.job_id)) || null;
    const optimisticVerify = (r.data && r.data.optimisticVerify) || null;
    if (!jobId) return { submitted: false, reason: "kurier submit: no jobId in response", detail: r.text, ms: Date.now() - t0 };
    // Step 3: wait briefly for the on-chain tx hash (the value the platform
    // needs to confirm the network transaction). Fall back to the jobId.
    const wait = await waitForTxHash(apiKey, jobId);
    const proofTx = wait.txHash || jobId;
    return { submitted: true, jobId, proofTx, txHash: wait.txHash || null, optimisticVerify, jobStatus: wait.status, vkRegistered: !!reg.registered, ms: Date.now() - t0, raw: r.data };
  } catch (e) {
    return { submitted: false, reason: `kurier error: ${String(e.message || e)}`, vkRegistered: !!reg.registered, ms: Date.now() - t0 };
  }
}

module.exports = { submitToKurier, registerVk, GATEKEEPER_VK_HASH };
