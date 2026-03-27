#!/usr/bin/env node
/**
 * Agent bootstrap: requests a token from the KMS and waits for approval.
 * Runs before the agent starts. Exits once a token is available.
 */
const http = require("node:http");
const fs = require("node:fs");

const SOCKET_PATH = process.env.KMS_SOCKET_PATH || "/var/run/ows/ows.sock";
const KMS_URL = process.env.KMS_URL;
const TOKEN_FILE = process.env.OWS_TOKEN_FILE || "/tmp/agent/token";
const APPROVED_FILE = process.env.OWS_APPROVED_TOKENS_FILE || "/tmp/agent/approved-tokens.json";
const POLL_INTERVAL = parseInt(process.env.BOOTSTRAP_POLL_INTERVAL || "5000", 10);
const AGENT_ID = process.env.AGENT_ID || "pi-agent";

function kms(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { method, path, headers: { "Content-Type": "application/json" } };
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

async function main() {
  // Ensure data directory exists and is writable
  const dataDir = require("node:path").dirname(APPROVED_FILE);
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

  // Check if token already exists
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
    if (existing) { console.log("[bootstrap] Token already exists. Skipping."); return; }
  } catch {}
  try {
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE, "utf-8"));
    if (approved.length > 0) { console.log("[bootstrap] Approved token exists. Skipping."); return; }
  } catch {}

  console.log("[bootstrap] No token found. Requesting from KMS...");

  const res = await kms("POST", "/keys/request", {
    reason: "Initial agent token (bootstrap)",
    agent_id: AGENT_ID,
  });

  if (res.status !== 202) {
    console.error(`[bootstrap] Request failed: ${JSON.stringify(res.data)}`);
    process.exit(1);
  }

  const requestId = res.data.request_id;
  console.log(`[bootstrap] Request submitted: ${requestId}`);
  console.log("[bootstrap] Waiting for approval...");
  console.log(`[bootstrap] Approve via: docker-compose exec ows-vault node src/manage.js requests`);

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    try {
      const poll = await kms("GET", `/keys/request/${requestId}`);

      if (poll.data.status === "approved" && poll.data.token) {
        // Save token
        const dir = require("node:path").dirname(APPROVED_FILE);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(APPROVED_FILE, JSON.stringify([poll.data.token]), { mode: 0o600 });
        console.log("[bootstrap] Token approved and saved.");
        return;
      }

      if (poll.data.status === "denied") {
        console.error(`[bootstrap] Token denied: ${poll.data.deny_reason}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`[bootstrap] Poll error: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`[bootstrap] Error: ${err.message}`);
  process.exit(1);
});
