const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sdk = require("@open-wallet-standard/core");

function requestsDir(vaultPath) {
  const dir = path.join(vaultPath, "requests");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function requestPath(id, vaultPath) {
  return path.join(requestsDir(vaultPath), `${id}.json`);
}

function createRequest(requesterToken, body, vaultPath) {
  const id = `req_${crypto.randomBytes(8).toString("hex")}`;
  const request = {
    id,
    status: "pending",
    requester: requesterToken ? requesterToken.slice(0, 12) + "..." : body.agent_id || "bootstrap",
    reason: body.reason,
    requested_scope: body.requested_scope || {},
    requested_ttl: body.requested_ttl || null,
    created_at: new Date().toISOString(),
  };

  fs.writeFileSync(requestPath(id, vaultPath), JSON.stringify(request, null, 2), {
    mode: 0o600,
  });

  return { request_id: id, status: "pending" };
}

function getRequest(id, vaultPath) {
  const filePath = requestPath(id, vaultPath);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function listRequests(vaultPath, statusFilter) {
  const dir = requestsDir(vaultPath);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const requests = files.map((f) =>
    JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")),
  );

  if (statusFilter) return requests.filter((r) => r.status === statusFilter);
  return requests;
}

function approveRequest(id, passphrase, walletName, vaultPath, overrides = {}) {
  const request = getRequest(id, vaultPath);
  if (!request) return null;
  if (request.status !== "pending") {
    throw new Error(`Request ${id} is already ${request.status}`);
  }

  // Get wallet info for the wallet ID
  const wallet = sdk.getWallet(walletName, vaultPath);
  if (!wallet) throw new Error(`Wallet '${walletName}' not found`);

  // Determine expiry
  const ttl = overrides.ttl || request.requested_ttl;
  let expiresAt;
  if (ttl) {
    const match = ttl.match(/^(\d+)(h|m|d)$/);
    if (match) {
      const [, num, unit] = match;
      const ms = { h: 3600000, m: 60000, d: 86400000 }[unit];
      expiresAt = new Date(Date.now() + parseInt(num, 10) * ms).toISOString();
    } else {
      expiresAt = ttl; // Assume ISO string
    }
  }

  // Create the API key via OWS SDK
  const keyName = `${id}-approved`;
  const policyIds = overrides.policyIds || [];
  const apiKey = sdk.createApiKey(
    keyName,
    [wallet.id],
    policyIds,
    passphrase,
    expiresAt,
    vaultPath,
  );

  // Update request record
  request.status = "approved";
  request.token = apiKey.token;
  request.key_id = apiKey.id;
  request.key_name = apiKey.name;
  request.approved_at = new Date().toISOString();
  request.expires_at = expiresAt || null;
  if (overrides.ttl) request.approved_ttl = overrides.ttl;

  fs.writeFileSync(requestPath(id, vaultPath), JSON.stringify(request, null, 2), {
    mode: 0o600,
  });

  return {
    request_id: id,
    status: "approved",
    token: apiKey.token,
    key_id: apiKey.id,
    expires_at: expiresAt || null,
  };
}

function denyRequest(id, reason, vaultPath) {
  const request = getRequest(id, vaultPath);
  if (!request) return null;
  if (request.status !== "pending") {
    throw new Error(`Request ${id} is already ${request.status}`);
  }

  request.status = "denied";
  request.deny_reason = reason;
  request.denied_at = new Date().toISOString();

  fs.writeFileSync(requestPath(id, vaultPath), JSON.stringify(request, null, 2), {
    mode: 0o600,
  });

  return { request_id: id, status: "denied", reason };
}

module.exports = {
  createRequest,
  getRequest,
  listRequests,
  approveRequest,
  denyRequest,
};
