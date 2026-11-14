// Optional Kurier submission of our own Groth16 proof.
// Only active when KURIER_API_KEY is set. Without it, the response carries
// proof + public_signals only (proof_tx is optional per /build) and the
// platform re-verifies the proof itself against its own registered VK.
// Kurier flow (from /build §03): POST /submit-proof/<key> with
// { proofType:"groth16", vkRegistered:true, proofOptions:{library:"snarkjs",curve:"bn128"},
//   proofData:{ proof, publicSignals, vk: registeredVkHash } }
// then poll the job until Finalized. Returns the proof tx / job id or null.
const API_URL = "https://api.kurier.xyz/api/v1";
const GATEKEEPER_VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab4970c90c5316d4168bfbad77b0";

async function submitToKurier(proof, publicSignals, { timeoutMs = 20000 } = {}) {
  const apiKey = process.env.KURIER_API_KEY;
  if (!apiKey) return { submitted: false, reason: "no KURIER_API_KEY" };
  const t0 = Date.now();
  const res = await fetch(`${API_URL}/submit-proof/${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: GATEKEEPER_VK_HASH },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { submitted: false, reason: `kurier http ${res.status}`, ms: Date.now() - t0 };
  const job = await res.json();
  const jobId = job.jobId || job.id || job.job_id || null;
  const txHash = job.proofTx || job.txHash || job.transactionHash || jobId;
  return { submitted: true, jobId, proofTx: txHash || null, ms: Date.now() - t0, raw: job };
}

module.exports = { submitToKurier, GATEKEEPER_VK_HASH };
