// Field-element conversions for the gatekeeper circuit.
// Circuit inputs (reverse-engineered from the shipped wasm/zkey, 13 total):
//   decision, amount, minimum, publicBalance, expiryBlock, currentBlock,
//   maxTransfer, recipient, conditionRecipient, taskId, registeredVkHash,
//   proofVkHash, salt
// All 13 are public signals (nPublic = 13 in the verification key).
// Conversions used here (NOT documented on the site — see README "Open questions"):
//   - hex strings (addresses, vk hashes) -> BigInt(hex) mod BN128 prime
//   - taskId string ("gk_24_9d1") -> BigInt(sha256(taskId)) mod prime
//   - salt -> fresh random 128-bit value per proof
const { createHash, randomBytes } = require("crypto");
const BN128_PRIME = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

function toField(hex) {
  return (BigInt(hex) % BN128_PRIME).toString();
}
function taskIdToField(taskId) {
  return toField("0x" + createHash("sha256").update(String(taskId)).digest("hex"));
}
function randomSalt() {
  return BigInt("0x" + randomBytes(16).toString("hex")).toString();
}

// Build the 13 circuit inputs from a task envelope input + decision (1/0).
function circuitInput(input, decisionBit) {
  return {
    decision: decisionBit,
    amount: String(BigInt(input.amount)),
    minimum: String(BigInt(input.minimum)),
    publicBalance: String(BigInt(input.public_balance)),
    expiryBlock: String(BigInt(input.expiry_block)),
    currentBlock: String(BigInt(input.current_block)),
    maxTransfer: String(BigInt(input.max_transfer)),
    recipient: toField(input.recipient),
    conditionRecipient: toField(input.condition_recipient),
    taskId: taskIdToField(input.task_id ?? input.taskId ?? ""),
    registeredVkHash: toField(input.registered_vk),
    proofVkHash: toField(input.proof_vk),
    salt: randomSalt(),
  };
}
module.exports = { toField, taskIdToField, randomSalt, circuitInput, BN128_PRIME };
