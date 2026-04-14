#!/usr/bin/env node
/**
 * Wallet CLI -- single entry point for all wallet operations.
 * Communicates with KMS over Unix socket or TCP. Tokens loaded from file.
 *
 * Usage:
 *   node wallet.js sign --chain evm --message "hello"
 *   node wallet.js address --chain evm
 *   node wallet.js capabilities
 *   node wallet.js request --reason "need tx signing" [--operations X] [--chains Y] [--ttl Z]
 *   node wallet.js check --id <request_id>
 */
const http = require("node:http");
const fs = require("node:fs");

const SOCKET_PATH = process.env.KMS_SOCKET_PATH || "/var/run/ows/ows.sock";
const KMS_URL = process.env.KMS_URL;
const TOKEN_FILE = process.env.OWS_TOKEN_FILE || "/run/secrets/token";
const APPROVED_TOKENS_FILE = process.env.OWS_APPROVED_TOKENS_FILE || "/tmp/ows-approved-tokens.json";

// ── Helpers ──

function loadToken() {
  try {
    const approved = JSON.parse(fs.readFileSync(APPROVED_TOKENS_FILE, "utf-8"));
    if (approved.length > 0) return approved[approved.length - 1];
  } catch {}
  try { return fs.readFileSync(TOKEN_FILE, "utf-8").trim(); } catch {}
  return null;
}

function saveApprovedToken(token) {
  let tokens = [];
  try { tokens = JSON.parse(fs.readFileSync(APPROVED_TOKENS_FILE, "utf-8")); } catch {}
  tokens.push(token);
  fs.writeFileSync(APPROVED_TOKENS_FILE, JSON.stringify(tokens), { mode: 0o600 });
}

function kms(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      method, path,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    if (!KMS_URL) { opts.socketPath = SOCKET_PATH; }
    else { const u = new URL(KMS_URL); opts.hostname = u.hostname; opts.port = u.port; }

    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: { raw: d } }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(3); // skip node, script, subcommand
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return args;
}

function out(data) { console.log(JSON.stringify(data, null, 2)); }
function die(msg, code) { out({ error: msg, code: code || "ERROR" }); process.exit(1); }
function needToken() { const t = loadToken(); if (!t) die("No wallet token available. Token must be provisioned by KMS administrator.", "NO_TOKEN"); return t; }

// ── Commands ──

async function cmdSign() {
  // agent calls scripts/sign.sh via bash tool
  die("Signing removed from wallet.js — use scripts/sign.sh or ows CLI (see skills/ows/SKILL.md)");
}

async function cmdAddress(args) {
  if (!args.chain) die("--chain required (evm, solana, bitcoin, cosmos, tron, ton, sui, spark, filecoin)");
  const res = await kms("GET", `/address/${args.chain}`);
  if (res.status !== 200) die(res.data.error || `KMS returned ${res.status}`, res.data.code);
  out(res.data);
}

async function cmdCapabilities() {
  const token = loadToken();
  if (!token) { out({ status: "no_token", message: "No wallet token loaded." }); return; }
  const res = await kms("GET", "/capabilities", undefined, token);
  if (res.status !== 200) die(res.data.error || `KMS returned ${res.status}`, res.data.code);
  out({ ...res.data, tokens_loaded: 1 });
}

async function cmdRequest(args) {
  if (!args.reason) die("--reason required");
  const token = loadToken(); // May be null for bootstrap -- that's OK
  const body = {
    reason: args.reason,
    agent_id: args["agent-id"] || "pi-agent",
    requested_scope: {},
    requested_ttl: args.ttl || null,
  };
  if (args.operations) body.requested_scope.operations = args.operations.split(",").map((s) => s.trim());
  if (args.chains) body.requested_scope.chains = args.chains.split(",").map((s) => s.trim());
  const res = await kms("POST", "/keys/request", body, token);
  if (res.status !== 202) die(res.data.error || `KMS returned ${res.status}`, res.data.code);
  out({
    ...res.data,
    next_steps: [
      "Ask the user to approve:",
      "  docker-compose exec ows-vault node src/manage.js requests",
      `  docker-compose exec ows-vault node src/manage.js approve ${res.data.request_id}`,
      `Then run: node wallet.js check --id ${res.data.request_id}`,
    ],
  });
}

async function cmdCheck(args) {
  if (!args.id) die("--id required (the request_id from 'wallet.js request')");
  const token = loadToken(); // May be null for bootstrap polling
  const res = await kms("GET", `/keys/request/${args.id}`, undefined, token);
  if (res.status === 404) die(`Request ${args.id} not found`, "NOT_FOUND");
  if (res.status !== 200) die(res.data.error || `KMS returned ${res.status}`, res.data.code);

  if (res.data.status === "approved" && res.data.token) {
    saveApprovedToken(res.data.token);
    out({ status: "approved", message: "New capability loaded. Retry the previously denied operation.", expires_at: res.data.expires_at || "never" });
  } else if (res.data.status === "denied") {
    out({ status: "denied", reason: res.data.deny_reason || "No reason given" });
  } else {
    out({ status: res.data.status, message: "Waiting for user approval." });
  }
}

// ── Main ──

const cmd = process.argv[2];
const args = parseArgs();
const commands = { sign: cmdSign, address: cmdAddress, capabilities: cmdCapabilities, request: cmdRequest, check: cmdCheck };

if (!cmd || !commands[cmd]) {
  die(`Usage: wallet.js <sign|address|capabilities|request|check> [--flags]`);
}
commands[cmd](args).catch((err) => die(err.message));
