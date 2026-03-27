const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// OWS SDK
const sdk = require(path.join(__dirname, "../../kms/node_modules/@open-wallet-standard/core"));

// KMS server
const { start } = require(path.join(__dirname, "../../kms/src/server"));

// ── Test helpers ──────────────────────────────────────────────

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

// ── Test suite ────────────────────────────────────────────────

describe("KMS Signing API", () => {
  let server;
  let port;
  let vaultPath;
  let walletName = "test-wallet";
  let passphrase;
  let agentToken;

  before(async () => {
    // Create temp vault
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ows-test-"));

    // Generate passphrase
    passphrase = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(vaultPath, "passphrase"), passphrase, { mode: 0o600 });

    // Create wallet
    const mnemonic = sdk.generateMnemonic(12);
    sdk.importWalletMnemonic(walletName, mnemonic, passphrase, undefined, vaultPath);

    // Create API key for agent
    const wallet = sdk.getWallet(walletName, vaultPath);
    const apiKey = sdk.createApiKey("test-agent", [wallet.id], [], passphrase, undefined, vaultPath);
    agentToken = apiKey.token;

    // Set env vars for KMS
    process.env.OWS_VAULT_PATH = vaultPath;
    process.env.OWS_WALLET_NAME = walletName;
    process.env.OWS_PASSPHRASE_FILE = path.join(vaultPath, "passphrase");

    // Start KMS on random port
    port = 30000 + Math.floor(Math.random() * 10000);
    server = start({ port });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (server) server.close();
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  // ── Health ──

  it("GET /health returns 200", async () => {
    const res = await request(port, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
  });

  // ── Sign message ──

  it("POST /sign-message with valid token returns signature", async () => {
    const res = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "evm", message: "hello world" },
      agentToken,
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.signature, "Should return a signature");
    assert.equal(res.data.chain, "evm");
    assert.equal(res.data.message, "hello world");
    // Signature should be a hex string
    assert.ok(res.data.signature.length > 10, "Signature should be non-trivial");
  });

  it("POST /sign-message without token returns 401", async () => {
    const res = await request(port, "POST", "/sign-message", {
      chain: "evm",
      message: "hello",
    });
    assert.equal(res.status, 401);
    assert.ok(res.data.error.includes("Authorization"));
  });

  it("POST /sign-message with invalid token returns error", async () => {
    const res = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "evm", message: "hello" },
      "ows_key_invalidtokenhere1234567890abcdef1234567890abcdef1234567890abcdef",
    );
    assert.ok(res.status >= 400, `Expected error status, got ${res.status}`);
  });

  it("POST /sign-message with missing fields returns 400", async () => {
    const res = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "evm" }, // missing message
      agentToken,
    );
    assert.equal(res.status, 400);
  });

  it("POST /sign-message works on different chains", async () => {
    // Solana
    const sol = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "solana", message: "test solana" },
      agentToken,
    );
    assert.equal(sol.status, 200);
    assert.ok(sol.data.signature);

    // Bitcoin
    const btc = await request(
      port,
      "POST",
      "/sign-message",
      { chain: "bitcoin", message: "test bitcoin" },
      agentToken,
    );
    assert.equal(btc.status, 200);
    assert.ok(btc.data.signature);
  });

  // ── Address ──

  it("GET /address/evm returns address", async () => {
    const res = await request(port, "GET", "/address/evm");
    assert.equal(res.status, 200);
    assert.ok(res.data.address, "Should return an address");
    assert.ok(res.data.address.startsWith("0x"), "EVM address should start with 0x");
    assert.equal(res.data.chain, "evm");
  });

  it("GET /address/solana returns address", async () => {
    const res = await request(port, "GET", "/address/solana");
    assert.equal(res.status, 200);
    assert.ok(res.data.address);
  });

  it("GET /address/invalid returns error", async () => {
    const res = await request(port, "GET", "/address/invalid");
    assert.ok(res.status >= 400);
  });

  // ── Capabilities ──

  it("GET /capabilities with token returns status", async () => {
    const res = await request(port, "GET", "/capabilities", undefined, agentToken);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "active");
  });

  it("GET /capabilities without token returns 401", async () => {
    const res = await request(port, "GET", "/capabilities");
    assert.equal(res.status, 401);
  });

  // ── 404 ──

  it("Unknown route returns 404", async () => {
    const res = await request(port, "GET", "/nonexistent");
    assert.equal(res.status, 404);
  });
});
