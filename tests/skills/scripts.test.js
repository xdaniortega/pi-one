const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const execFileAsync = promisify(execFile);
const sdk = require(path.join(__dirname, "../../kms/node_modules/@open-wallet-standard/core"));
const { start } = require(path.join(__dirname, "../../kms/src/server"));

const WALLET_JS = path.join(__dirname, "../../skills/wallet/scripts/wallet.js");

// ── Setup ──
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ows-skill-test-"));
const passphrase = crypto.randomBytes(16).toString("hex");
fs.writeFileSync(path.join(vaultPath, "passphrase"), passphrase, { mode: 0o600 });

const mnemonic = sdk.generateMnemonic(12);
sdk.importWalletMnemonic("test-wallet", mnemonic, passphrase, undefined, vaultPath);
const wallet = sdk.getWallet("test-wallet", vaultPath);
const apiKey = sdk.createApiKey("test-agent", [wallet.id], [], passphrase, undefined, vaultPath);

const tokenFile = path.join(vaultPath, "token");
fs.writeFileSync(tokenFile, apiKey.token, { mode: 0o400 });
const approvedTokensFile = path.join(vaultPath, "approved-tokens.json");

process.env.OWS_VAULT_PATH = vaultPath;
process.env.OWS_WALLET_NAME = "test-wallet";
process.env.OWS_PASSPHRASE_FILE = path.join(vaultPath, "passphrase");

const port = 30000 + Math.floor(Math.random() * 10000);
const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  KMS_URL: `http://127.0.0.1:${port}`,
  OWS_TOKEN_FILE: tokenFile,
  OWS_APPROVED_TOKENS_FILE: approvedTokensFile,
};

async function run(cmd, args, envOverrides = {}) {
  const { stdout } = await execFileAsync("node", [WALLET_JS, cmd, ...args], {
    env: { ...baseEnv, ...envOverrides },
    encoding: "utf-8",
    timeout: 10000,
  });
  return JSON.parse(stdout);
}

async function runRaw(cmd, args, envOverrides = {}) {
  try {
    return { exitCode: 0, data: await run(cmd, args, envOverrides) };
  } catch (err) {
    return { exitCode: err.code || 1, data: err.stdout ? JSON.parse(err.stdout) : { error: err.message } };
  }
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", path: urlPath, headers: { "Content-Type": "application/json" } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (err) { failed++; console.log(`  ✖ ${name}: ${err.message}`); }
}

async function main() {
  const server = start({ port });
  await new Promise((r) => setTimeout(r, 300));

  console.log("\n▶ Wallet Skill Scripts (wallet.js)\n");

  // ── sign ──
  console.log("  sign");
  await test("signs on evm", async () => {
    const r = await run("sign", ["--chain", "evm", "--message", "hello world"]);
    assert.ok(r.signature);
    assert.equal(r.chain, "evm");
  });
  await test("signs on solana", async () => { assert.ok((await run("sign", ["--chain", "solana", "--message", "test"])).signature); });
  await test("signs on bitcoin", async () => { assert.ok((await run("sign", ["--chain", "bitcoin", "--message", "test"])).signature); });
  await test("fails without --chain", async () => { assert.ok((await runRaw("sign", ["--message", "hi"])).exitCode !== 0); });
  await test("fails without --message", async () => { assert.ok((await runRaw("sign", ["--chain", "evm"])).exitCode !== 0); });
  await test("fails with no token", async () => {
    assert.equal((await runRaw("sign", ["--chain", "evm", "--message", "hi"], { OWS_TOKEN_FILE: "/x" })).data.code, "NO_TOKEN");
  });

  // ── address ──
  console.log("\n  address");
  await test("returns evm address", async () => { assert.ok((await run("address", ["--chain", "evm"])).address.startsWith("0x")); });
  await test("returns solana address", async () => { assert.ok((await run("address", ["--chain", "solana"])).address); });
  await test("fails without --chain", async () => { assert.ok((await runRaw("address", [])).exitCode !== 0); });
  await test("fails with invalid chain", async () => { assert.ok((await runRaw("address", ["--chain", "invalid"])).exitCode !== 0); });

  // ── capabilities ──
  console.log("\n  capabilities");
  await test("returns active with token", async () => { assert.equal((await run("capabilities", [])).status, "active"); });
  await test("returns no_token without token", async () => {
    assert.equal((await run("capabilities", [], { OWS_TOKEN_FILE: "/x" })).status, "no_token");
  });

  // ── request ──
  console.log("\n  request");
  await test("creates pending request", async () => {
    const r = await run("request", ["--reason", "Need tx signing", "--operations", "sign_transaction", "--chains", "evm", "--ttl", "4h"]);
    assert.ok(r.request_id);
    assert.equal(r.status, "pending");
  });
  await test("fails without --reason", async () => { assert.ok((await runRaw("request", [])).exitCode !== 0); });

  // ── check ──
  console.log("\n  check");
  await test("returns pending", async () => {
    const req = await run("request", ["--reason", "check test"]);
    assert.equal((await run("check", ["--id", req.request_id])).status, "pending");
  });
  await test("fails with nonexistent id", async () => { assert.equal((await runRaw("check", ["--id", "nope"])).data.code, "NOT_FOUND"); });
  await test("fails without --id", async () => { assert.ok((await runRaw("check", [])).exitCode !== 0); });

  // ── full lifecycle ──
  console.log("\n  full lifecycle");
  await test("sign -> request -> approve -> sign with new token", async () => {
    assert.ok((await run("sign", ["--chain", "evm", "--message", "initial"])).signature);
    const req = await run("request", ["--reason", "Lifecycle test", "--ttl", "2h"]);
    assert.equal(req.status, "pending");
    assert.equal((await run("check", ["--id", req.request_id])).status, "pending");
    await httpPost(`/keys/approve/${req.request_id}`, { ttl: "1h" });
    assert.equal((await run("check", ["--id", req.request_id])).status, "approved");
    assert.ok(JSON.parse(fs.readFileSync(approvedTokensFile, "utf-8")).length >= 1);
    assert.ok((await run("sign", ["--chain", "evm", "--message", "new key"])).signature);
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  server.close();
  fs.rmSync(vaultPath, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main();
