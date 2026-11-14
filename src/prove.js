// Groth16 proof generation with snarkjs using the real gatekeeper circuit.
// Returns { proof, publicSignals, ms }. Throws on witness/constraint failure
// (e.g. if the decision contradicts the circuit's rule).
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

const WASM = path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
const ZKEY = path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");
const VK_PATH = path.join(__dirname, "..", "circuits", "vk.json");

let vkCache = null;
function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  return vkCache;
}

async function generateProof(circuitInput) {
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY);
  const ms = Date.now() - t0;
  return { proof, publicSignals, ms };
}

async function verifyProofLocally(publicSignals, proof) {
  return snarkjs.groth16.verify(loadVk(), publicSignals, proof);
}

module.exports = { generateProof, verifyProofLocally, loadVk };
