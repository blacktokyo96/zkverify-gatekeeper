// End-to-end test: boots the real server with a test HMAC secret and posts
// signed envelopes for the sample payload + one payload per trap type.
// Checks decision, reason_code, proof presence, and local Groth16 verification.
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";

const SECRET = "test-secret-do-not-use-in-production";
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const vk = JSON.parse(fs.readFileSync("circuits/vk.json", "utf8"));
const snarkjs = await import("snarkjs");

const FULL = {
  registeredVk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
  proofVk: "0x7d3a00000000000000000000000000000000000000000000000000000000f291",
  proofVkOther: "0xa4c100000000000000000000000000000000000000000000000000000000b8ff",
  recipient: "0xDe42000000000000000000000000000000009f01",
  recipientOther: "0xBeef00000000000000000000000000000000000001",
};
function task(taskId, overrides = {}, proofTx) {
  // Unique proof reference per task (sha256 of the task id) — the old
  // char-mapping helper collided between task ids and faked a reuse.
  const tx = proofTx || "0x" + crypto.createHash("sha256").update(taskId).digest("hex");
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input: {
      registered_vk: FULL.registeredVk,
      proof_vk: FULL.proofVk,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: FULL.recipient,
      condition_recipient: FULL.recipient,
      amount: "500",
      max_transfer: "1000",
      proof_tx: tx,
      ...overrides,
    },
  };
}
const CASES = [
  { name: "VALID_CONDITION", env: task("gk_test_valid"), want: ["APPROVE", "VALID_CONDITION"], proof: true },
  { name: "VK_SUBSTITUTION", env: task("gk_test_vk", { proof_vk: FULL.proofVkOther }), want: ["REJECT", "VK_SUBSTITUTION"], proof: true },
  { name: "THRESHOLD_MISMATCH", env: task("gk_test_thr", { public_balance: "999" }), want: ["REJECT", "THRESHOLD_MISMATCH"], proof: true },
  { name: "EXPIRED_CONDITION", env: task("gk_test_exp", { current_block: 19842202 }), want: ["REJECT", "EXPIRED_CONDITION"], proof: true },
  { name: "RECIPIENT_MISMATCH", env: task("gk_test_rec", { recipient: FULL.recipientOther }), want: ["REJECT", "RECIPIENT_MISMATCH"], proof: true },
  { name: "AMOUNT_OVERFLOW", env: task("gk_test_amt", { amount: "1001" }), want: ["REJECT", "AMOUNT_OVERFLOW"], proof: true },
  // PROOF_REUSED: re-send the VALID task's proof_tx under a new task_id.
  { name: "PROOF_REUSED", env: task("gk_test_reuse", {}, task("gk_test_valid").input.proof_tx), want: ["REJECT", "PROOF_REUSED"], proof: false },
];

function sign(raw) {
  return crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
}
async function post(path, bodyObj, sig) {
  const raw = JSON.stringify(bodyObj);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sig ?? sign(raw) },
    body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => null), sigHeader: res.headers.get("x-agent-games-signature"), raw: await res.text().catch(() => "") };
}

const server = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

if (!(await waitHealth())) {
  console.log("FAIL  server did not come up\n" + serverLog);
  server.kill();
  process.exit(1);
}

for (const c of CASES) {
  const t0 = Date.now();
  const { status, body, sigHeader } = await post("/agent", c.env);
  const ms = Date.now() - t0;
  const [wantDec, wantReason] = c.want;
  check(`${c.name}: http ${status}`, status === 200, `${ms}ms`);
  check(`${c.name}: decision=${body?.decision} reason=${body?.reason_code}`, body?.decision === wantDec && body?.reason_code === wantReason, `want ${wantDec}/${wantReason}`);
  check(`${c.name}: response signed`, typeof sigHeader === "string" && sigHeader.length === 64 && sigHeader === sign(JSON.stringify(body)), "x-agent-games-signature present + valid");
  if (c.proof) {
    const hasProof = body?.proof && Array.isArray(body?.public_signals) && body.public_signals.length === 13;
    check(`${c.name}: proof + 13 public signals`, !!hasProof, `publicSignals=${body?.public_signals?.length}`);
    if (hasProof) {
      const ok = await snarkjs.groth16.verify(vk, body.public_signals, body.proof);
      check(`${c.name}: local Groth16 verify`, ok === true);
    }
  } else {
    check(`${c.name}: proof omitted (PROOF_REUSED)`, !body?.proof && !body?.public_signals);
  }
}

// Preflight
{
  const env = { type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "abc123" };
  const { status, body, sigHeader } = await post("/agent", env);
  check("preflight: { ok:true, protocolVersion:v1 }", status === 200 && body?.ok === true && body?.protocolVersion === "v1", JSON.stringify(body));
  check("preflight: signed", typeof sigHeader === "string" && sigHeader === sign(JSON.stringify(body)));
}
// Bad HMAC -> 401
{
  const { status } = await post("/agent", CASES[0].env, "00".repeat(32));
  check("bad HMAC -> 401", status === 401, `got ${status}`);
}
// Idempotent retry: same task_id returns the same response
{
  const { body } = await post("/agent", CASES[0].env);
  check("retry same task_id -> identical response", body?.decision === "APPROVE" && body?.reason_code === "VALID_CONDITION");
}

console.log(`\n${pass} passed, ${fail} failed`);
server.kill();
process.exit(fail ? 1 : 0);
