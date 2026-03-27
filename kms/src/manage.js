#!/usr/bin/env node
/**
 * KMS management CLI. Run via:
 *   docker-compose exec ows-vault node src/manage.js <command>
 *
 * Commands:
 *   requests                     List pending key requests
 *   approve <id> [--ttl 1h]     Approve a request
 *   deny <id> [--reason "..."]  Deny a request
 *   keys                        List all API keys (via OWS)
 *   wallets                     List all wallets (via OWS)
 */
const http = require("node:http");
const fs = require("node:fs");

const SOCKET = process.env.KMS_SOCKET_PATH || "/var/run/ows/ows.sock";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else if (!args._positional) {
      args._positional = argv[i];
    }
  }
  return args;
}

async function main() {
  const cmd = process.argv[2];
  const args = parseArgs();

  if (cmd === "requests") {
    const data = await request("GET", "/keys/requests");
    if (!Array.isArray(data) || data.length === 0) {
      console.log("  No pending requests.");
      return;
    }
    console.log();
    for (const r of data) {
      console.log(`  [${r.status}] ${r.id}`);
      console.log(`    From: ${r.requester}`);
      console.log(`    Reason: ${r.reason}`);
      if (r.requested_ttl) console.log(`    TTL: ${r.requested_ttl}`);
      console.log(`    Created: ${r.created_at}`);
      console.log();
    }
    const pending = data.filter((r) => r.status === "pending");
    if (pending.length > 0) {
      console.log(`  To approve: node src/manage.js approve ${pending[0].id}`);
      console.log(`  To deny:    node src/manage.js deny ${pending[0].id} --reason "..."\n`);
    }

  } else if (cmd === "approve") {
    const id = args._positional;
    if (!id) { console.error("  Usage: manage.js approve <request_id> [--ttl 1h]"); process.exit(1); }
    const data = await request("POST", `/keys/approve/${id}`, { ttl: args.ttl });
    if (data.error) { console.error(`  Error: ${data.error}`); process.exit(1); }
    console.log(`  Approved: ${id}`);
    console.log(`  Key: ${data.key_id}`);
    if (data.expires_at) console.log(`  Expires: ${data.expires_at}`);

  } else if (cmd === "deny") {
    const id = args._positional;
    if (!id) { console.error("  Usage: manage.js deny <request_id> [--reason '...']"); process.exit(1); }
    const data = await request("POST", `/keys/deny/${id}`, { reason: args.reason || "Denied" });
    if (data.error) { console.error(`  Error: ${data.error}`); process.exit(1); }
    console.log(`  Denied: ${id} (${data.reason})`);

  } else if (cmd === "keys") {
    const sdk = require("@open-wallet-standard/core");
    const vaultPath = process.env.OWS_VAULT_PATH || "/home/ows/.ows";
    const keys = sdk.listApiKeys(vaultPath);
    if (keys.length === 0) { console.log("  No API keys."); return; }
    for (const k of keys) console.log(`  ${k.name} (${k.id})`);

  } else if (cmd === "wallets") {
    const sdk = require("@open-wallet-standard/core");
    const vaultPath = process.env.OWS_VAULT_PATH || "/home/ows/.ows";
    const wallets = sdk.listWallets(vaultPath);
    if (wallets.length === 0) { console.log("  No wallets."); return; }
    for (const w of wallets) {
      console.log(`  ${w.name} (${w.id})`);
      for (const a of w.accounts || []) console.log(`    ${a.chainId}: ${a.address}`);
    }

  } else {
    console.log("  Usage: node src/manage.js <requests|approve|deny|keys|wallets>");
    console.log();
    console.log("  requests                     List pending key requests");
    console.log("  approve <id> [--ttl 1h]      Approve a request");
    console.log("  deny <id> [--reason '...']   Deny a request");
    console.log("  keys                         List all API keys");
    console.log("  wallets                      List all wallets");
    process.exit(1);
  }
}

main().catch((err) => { console.error(`  Error: ${err.message}`); process.exit(1); });
