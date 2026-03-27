/**
 * Integration test: simulates the full bootstrap flow.
 *
 * 1. KMS inits wallet (no token)
 * 2. Agent requests a token (bootstrap, no auth)
 * 3. Admin approves
 * 4. Agent signs with approved token
 * 5. Agent requests additional capability
 * 6. Admin approves
 * 7. Agent signs with new token
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const sdk = require(path.join(__dirname, "../../kms/node_modules/@open-wallet-standard/core"));
const { start } = require(path.join(__dirname, "../../kms/src/server"));

function request(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      method,
      path: urlPath,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("E2E: Bootstrap -> Approve -> Sign -> Request -> Approve -> Sign", () => {
  let server;
  let port;
  let vaultPath;
  let walletName = "pi-treasury";
  let passphrase;

  before(async () => {
    // ── Simulate KMS init (wallet only, no token) ──
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ows-e2e-"));
    passphrase = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(path.join(vaultPath, "passphrase"), passphrase, { mode: 0o600 });

    const mnemonic = sdk.generateMnemonic(12);
    sdk.importWalletMnemonic(walletName, mnemonic, passphrase, undefined, vaultPath);
    console.log(`  [init] Wallet created (no tokens)`);

    // ── Start KMS ──
    process.env.OWS_VAULT_PATH = vaultPath;
    process.env.OWS_WALLET_NAME = walletName;
    process.env.OWS_PASSPHRASE_FILE = path.join(vaultPath, "passphrase");

    port = 30000 + Math.floor(Math.random() * 10000);
    server = start({ port });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (server) server.close();
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  // ── Step 1: No tokens exist ──

  it("Step 1: No API keys exist in vault", () => {
    const keys = sdk.listApiKeys(vaultPath);
    assert.equal(keys.length, 0);
  });

  // ── Step 2: Agent requests token (no auth -- bootstrap) ──

  let bootstrapRequestId;

  it("Step 2: Agent requests initial token without auth", async () => {
    const res = await request(port, "POST", "/keys/request", {
      reason: "Initial agent token (bootstrap)",
      agent_id: "pi-agent",
    });
    assert.equal(res.status, 202);
    assert.equal(res.data.status, "pending");
    bootstrapRequestId = res.data.request_id;
    console.log(`  [agent] Bootstrap request: ${bootstrapRequestId}`);
  });

  // ── Step 3: Agent polls -- pending ──

  it("Step 3: Agent polls -- still pending", async () => {
    const res = await request(port, "GET", `/keys/request/${bootstrapRequestId}`);
    assert.equal(res.data.status, "pending");
    assert.equal(res.data.requester, "pi-agent");
  });

  // ── Step 4: Admin sees request ──

  it("Step 4: Admin lists pending requests", async () => {
    const res = await request(port, "GET", "/keys/requests");
    const pending = res.data.filter((r) => r.status === "pending");
    assert.ok(pending.length >= 1);
    console.log(`  [admin] Pending: "${pending[0].reason}"`);
  });

  // ── Step 5: Admin approves ──

  let agentToken;

  it("Step 5: Admin approves bootstrap request", async () => {
    const res = await request(port, "POST", `/keys/approve/${bootstrapRequestId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "approved");
    assert.ok(res.data.token.startsWith("ows_key_"));
    agentToken = res.data.token;
    console.log(`  [admin] Approved.`);
  });

  // ── Step 6: Agent picks up token ──

  it("Step 6: Agent polls -- approved, gets token", async () => {
    const res = await request(port, "GET", `/keys/request/${bootstrapRequestId}`);
    assert.equal(res.data.status, "approved");
    assert.equal(res.data.token, agentToken);
  });

  // ── Step 7: Agent signs with bootstrap token ──

  it("Step 7: Agent signs with approved token", async () => {
    const res = await request(
      port, "POST", "/sign-message",
      { chain: "evm", message: "first sign after bootstrap" },
      agentToken,
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.signature);
    console.log(`  [agent] Signed: ${res.data.signature.slice(0, 20)}...`);
  });

  // ── Step 8: Agent requests additional capability ──

  let secondRequestId;

  it("Step 8: Agent requests additional capability (with token this time)", async () => {
    const res = await request(port, "POST", "/keys/request", {
      reason: "Need transaction signing on Base",
      requested_scope: { operations: ["sign_transaction"], chains: ["evm:8453"] },
      requested_ttl: "4h",
    }, agentToken);
    assert.equal(res.status, 202);
    secondRequestId = res.data.request_id;
  });

  // ── Step 9: Admin approves with tighter TTL ──

  let secondToken;

  it("Step 9: Admin approves with 1h TTL", async () => {
    const res = await request(port, "POST", `/keys/approve/${secondRequestId}`, { ttl: "1h" });
    assert.equal(res.data.status, "approved");
    assert.ok(res.data.expires_at);
    secondToken = res.data.token;
  });

  // ── Step 10: Agent signs with new token ──

  it("Step 10: Agent signs with second token", async () => {
    const res = await request(
      port, "POST", "/sign-message",
      { chain: "evm", message: "signed with escalated capability" },
      secondToken,
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.signature);
    console.log(`  [agent] Signed with new key: ${res.data.signature.slice(0, 20)}...`);
  });

  // ── Step 11: Original token still works ──

  it("Step 11: Bootstrap token still works", async () => {
    const res = await request(
      port, "POST", "/sign-message",
      { chain: "evm", message: "still works" },
      agentToken,
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.signature);
  });
});
