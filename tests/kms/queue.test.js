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

describe("KMS Approval Queue", () => {
  let server;
  let port;
  let vaultPath;
  let walletName = "test-wallet";
  let passphrase;
  let agentToken;

  before(async () => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ows-queue-test-"));
    passphrase = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(vaultPath, "passphrase"), passphrase, { mode: 0o600 });

    const mnemonic = sdk.generateMnemonic(12);
    sdk.importWalletMnemonic(walletName, mnemonic, passphrase, undefined, vaultPath);

    const wallet = sdk.getWallet(walletName, vaultPath);
    const apiKey = sdk.createApiKey("test-agent", [wallet.id], [], passphrase, undefined, vaultPath);
    agentToken = apiKey.token;

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

  // ── Request creation ──

  it("POST /keys/request creates a pending request", async () => {
    const res = await request(
      port,
      "POST",
      "/keys/request",
      {
        reason: "Need to sign transactions on Base",
        requested_scope: { operations: ["sign_transaction"], chains: ["evm:8453"] },
        requested_ttl: "24h",
      },
      agentToken,
    );
    assert.equal(res.status, 202);
    assert.ok(res.data.request_id, "Should return a request_id");
    assert.equal(res.data.status, "pending");
  });

  it("POST /keys/request without token succeeds (bootstrap)", async () => {
    const res = await request(port, "POST", "/keys/request", {
      reason: "bootstrap test",
      agent_id: "test-bootstrap",
    });
    assert.equal(res.status, 202);
    assert.ok(res.data.request_id);
  });

  it("POST /keys/request without reason returns 400", async () => {
    const res = await request(port, "POST", "/keys/request", {}, agentToken);
    assert.equal(res.status, 400);
  });

  // ── Request listing ──

  it("GET /keys/requests lists all requests", async () => {
    // Create a request first
    await request(
      port,
      "POST",
      "/keys/request",
      { reason: "listing test" },
      agentToken,
    );

    const res = await request(port, "GET", "/keys/requests");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length >= 1);
    assert.ok(res.data.some((r) => r.reason === "listing test"));
  });

  // ── Request polling ──

  it("GET /keys/request/:id returns request status", async () => {
    const createRes = await request(
      port,
      "POST",
      "/keys/request",
      { reason: "polling test" },
      agentToken,
    );
    const id = createRes.data.request_id;

    const res = await request(port, "GET", `/keys/request/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.id, id);
    assert.equal(res.data.status, "pending");
    assert.equal(res.data.reason, "polling test");
  });

  it("GET /keys/request/nonexistent returns 404", async () => {
    const res = await request(port, "GET", "/keys/request/nonexistent");
    assert.equal(res.status, 404);
  });

  // ── Approve flow ──

  it("POST /keys/approve/:id creates key and returns token", async () => {
    const createRes = await request(
      port,
      "POST",
      "/keys/request",
      { reason: "approve test", requested_ttl: "1h" },
      agentToken,
    );
    const id = createRes.data.request_id;

    // Approve
    const approveRes = await request(port, "POST", `/keys/approve/${id}`);
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.data.status, "approved");
    assert.ok(approveRes.data.token, "Should return the new token");
    assert.ok(
      approveRes.data.token.startsWith("ows_key_"),
      "Token should have ows_key_ prefix",
    );
    assert.ok(approveRes.data.key_id, "Should return key_id");

    // Verify the new token works for signing
    const signRes = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "evm", message: "signed with new key" },
      approveRes.data.token,
    );
    assert.equal(signRes.status, 200);
    assert.ok(signRes.data.signature, "New token should be able to sign");
  });

  it("POST /keys/approve/:id with TTL override sets expiry", async () => {
    const createRes = await request(
      port,
      "POST",
      "/keys/request",
      { reason: "ttl override test" },
      agentToken,
    );
    const id = createRes.data.request_id;

    const approveRes = await request(port, "POST", `/keys/approve/${id}`, {
      ttl: "2h",
    });
    assert.equal(approveRes.status, 200);
    assert.ok(approveRes.data.expires_at, "Should have an expiry");
  });

  it("POST /keys/approve/nonexistent returns 404", async () => {
    const res = await request(port, "POST", "/keys/approve/nonexistent");
    assert.equal(res.status, 404);
  });

  // ── Deny flow ──

  it("POST /keys/deny/:id marks request as denied", async () => {
    const createRes = await request(
      port,
      "POST",
      "/keys/request",
      { reason: "deny test" },
      agentToken,
    );
    const id = createRes.data.request_id;

    const denyRes = await request(port, "POST", `/keys/deny/${id}`, {
      reason: "Not authorized for this operation",
    });
    assert.equal(denyRes.status, 200);
    assert.equal(denyRes.data.status, "denied");
    assert.equal(denyRes.data.reason, "Not authorized for this operation");

    // Verify polling shows denied
    const pollRes = await request(port, "GET", `/keys/request/${id}`);
    assert.equal(pollRes.data.status, "denied");
    assert.equal(pollRes.data.deny_reason, "Not authorized for this operation");
  });

  // ── Full flow: request -> poll -> approve -> poll -> use ──

  it("full lifecycle: request, poll, approve, poll, sign with new token", async () => {
    // 1. Agent requests capability
    const reqRes = await request(
      port,
      "POST",
      "/keys/request",
      {
        reason: "Full lifecycle test",
        requested_scope: { operations: ["sign_message"], chains: ["evm"] },
        requested_ttl: "4h",
      },
      agentToken,
    );
    assert.equal(reqRes.status, 202);
    const requestId = reqRes.data.request_id;

    // 2. Agent polls - should be pending
    const poll1 = await request(port, "GET", `/keys/request/${requestId}`);
    assert.equal(poll1.data.status, "pending");

    // 3. Admin approves
    const approve = await request(port, "POST", `/keys/approve/${requestId}`, {
      ttl: "2h",
    });
    assert.equal(approve.data.status, "approved");
    const newToken = approve.data.token;

    // 4. Agent polls - should be approved with token
    const poll2 = await request(port, "GET", `/keys/request/${requestId}`);
    assert.equal(poll2.data.status, "approved");
    assert.ok(poll2.data.token);

    // 5. Agent signs with the new token
    const signRes = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "evm", message: "lifecycle test message" },
      newToken,
    );
    assert.equal(signRes.status, 200);
    assert.ok(signRes.data.signature);
  });
});
