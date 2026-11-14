// Pure decision logic for Proof Gatekeeper — no I/O, no network.
// Input: the `input` object of a task envelope (agent-games.proof-gatekeeper.v1).
// Output: { decision: "APPROVE"|"REJECT", reason_code, trap }.
// Trap precedence (only matters if a task carried two faults at once; the
// published trap frequencies sum to 100%, i.e. tasks are single-fault by design):
//   VK_SUBSTITUTION > PROOF_REUSED > THRESHOLD_MISMATCH > EXPIRED_CONDITION
//   > RECIPIENT_MISMATCH > AMOUNT_OVERFLOW
// Expiry rule: expired iff current_block > expiry_block (a task is still valid
// in its expiry block itself). Balance rule: approve iff public_balance >= minimum.

const REASON = {
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  REUSED: "PROOF_REUSED",
  EXPIRED: "EXPIRED_CONDITION",
  RECIPIENT: "RECIPIENT_MISMATCH",
  AMOUNT: "AMOUNT_OVERFLOW",
};

function normHex(h) {
  return String(h || "").trim().toLowerCase();
}

function decide(input, isReused) {
  const proofVk = normHex(input.proof_vk);
  const registeredVk = normHex(input.registered_vk);
  if (proofVk !== registeredVk) {
    return { decision: "REJECT", reason_code: REASON.VK, trap: "VK_SUBSTITUTION" };
  }
  if (isReused) {
    return { decision: "REJECT", reason_code: REASON.REUSED, trap: "PROOF_REUSED" };
  }
  if (BigInt(input.public_balance) < BigInt(input.minimum)) {
    return { decision: "REJECT", reason_code: REASON.THRESHOLD, trap: "THRESHOLD_MISMATCH" };
  }
  if (BigInt(input.current_block) > BigInt(input.expiry_block)) {
    return { decision: "REJECT", reason_code: REASON.EXPIRED, trap: "EXPIRED_CONDITION" };
  }
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) {
    return { decision: "REJECT", reason_code: REASON.RECIPIENT, trap: "RECIPIENT_MISMATCH" };
  }
  if (BigInt(input.amount) > BigInt(input.max_transfer)) {
    return { decision: "REJECT", reason_code: REASON.AMOUNT, trap: "AMOUNT_OVERFLOW" };
  }
  return { decision: "APPROVE", reason_code: REASON.VALID, trap: "VALID_CONDITION" };
}

module.exports = { decide, REASON };
