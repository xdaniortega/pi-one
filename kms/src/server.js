const http = require("node:http");
const fs = require("node:fs");
const { URL } = require("node:url");
const ows = require("./ows");
const queue = require("./queue");

// Config is read lazily so env vars set after require() are picked up
function cfg() {
  const vaultPath = process.env.OWS_VAULT_PATH || `${process.env.HOME}/.ows`;
  return {
    socketPath: process.env.KMS_SOCKET_PATH,
    port: parseInt(process.env.KMS_PORT || "3100", 10),
    vaultPath,
    walletName: process.env.OWS_WALLET_NAME || "pi-treasury",
    passphraseFile:
      process.env.OWS_PASSPHRASE_FILE || `${vaultPath}/passphrase`,
  };
}

function getPassphrase() {
  return fs.readFileSync(cfg().passphraseFile, "utf-8").trim();
}

function extractToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function matchRoute(method, path, expectedMethod, pattern) {
  if (method !== expectedMethod) return null;
  if (typeof pattern === "string") return path === pattern ? {} : null;
  const match = path.match(pattern);
  if (!match) return null;
  return match.groups || {};
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;

  try {
    // Health
    if (matchRoute(method, path, "GET", "/health")) {
      return json(res, 200, { status: "ok", vault: cfg().vaultPath });
    }

    // Sign message
    if (matchRoute(method, path, "POST", "/sign-message")) {
      const token = extractToken(req);
      if (!token) return json(res, 401, { error: "Missing Authorization header" });
      const body = await parseBody(req);
      if (!body.chain || !body.message)
        return json(res, 400, { error: "chain and message required" });
      const result = ows.signMessage(
        cfg().walletName,
        body.chain,
        body.message,
        token,
        cfg().vaultPath,
      );
      return json(res, 200, result);
    }

    // Get address
    if (matchRoute(method, path, "GET", /^\/address\/(?<chain>[a-z0-9]+)$/)) {
      const { chain } = path.match(/^\/address\/(?<chain>[a-z0-9]+)$/).groups;
      const result = ows.getAddress(cfg().walletName, chain, cfg().vaultPath);
      return json(res, 200, result);
    }

    // Capabilities (what does this token allow)
    if (matchRoute(method, path, "GET", "/capabilities")) {
      const token = extractToken(req);
      if (!token) return json(res, 401, { error: "Missing Authorization header" });
      const result = ows.getCapabilities(token, cfg().vaultPath);
      return json(res, 200, result);
    }

    // Request a new key (agent-facing, auth optional for bootstrap)
    if (matchRoute(method, path, "POST", "/keys/request")) {
      const token = extractToken(req);
      const body = await parseBody(req);
      if (!body.reason)
        return json(res, 400, { error: "reason required" });
      const result = queue.createRequest(token, body, cfg().vaultPath);
      return json(res, 202, result);
    }

    // Check request status (agent-facing)
    const checkMatch = path.match(
      /^\/keys\/request\/(?<id>[a-zA-Z0-9_-]+)$/,
    );
    if (method === "GET" && checkMatch) {
      const { id } = checkMatch.groups;
      const result = queue.getRequest(id, cfg().vaultPath);
      if (!result) return json(res, 404, { error: "Request not found" });
      return json(res, 200, result);
    }

    // List pending requests (admin-facing)
    if (matchRoute(method, path, "GET", "/keys/requests")) {
      const result = queue.listRequests(cfg().vaultPath);
      return json(res, 200, result);
    }

    // Approve request (admin-facing)
    const approveMatch = path.match(
      /^\/keys\/approve\/(?<id>[a-zA-Z0-9_-]+)$/,
    );
    if (method === "POST" && approveMatch) {
      const { id } = approveMatch.groups;
      const body = await parseBody(req);
      const passphrase = getPassphrase();
      const result = queue.approveRequest(
        id,
        passphrase,
        cfg().walletName,
        cfg().vaultPath,
        body,
      );
      if (!result) return json(res, 404, { error: "Request not found" });
      return json(res, 200, result);
    }

    // Deny request (admin-facing)
    const denyMatch = path.match(/^\/keys\/deny\/(?<id>[a-zA-Z0-9_-]+)$/);
    if (method === "POST" && denyMatch) {
      const { id } = denyMatch.groups;
      const body = await parseBody(req);
      const result = queue.denyRequest(id, body.reason || "Denied", cfg().vaultPath);
      if (!result) return json(res, 404, { error: "Request not found" });
      return json(res, 200, result);
    }

    // 404
    json(res, 404, { error: "Not found" });
  } catch (err) {
    const status = err.code === "POLICY_DENIED" ? 403 : 500;
    json(res, status, { error: err.message, code: err.code });
  }
}

function start(opts = {}) {
  const server = http.createServer(handleRequest);
  const socketPath = opts.socketPath || cfg().socketPath;
  const port = opts.port || cfg().port;

  if (socketPath) {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o666); // Docker network is the auth boundary
      console.log(`KMS listening on ${socketPath}`);
    });
  } else {
    server.listen(port, "127.0.0.1", () => {
      console.log(`KMS listening on http://127.0.0.1:${port}`);
    });
  }

  return server;
}

// Start if run directly: init wallet on first boot, then start server
if (require.main === module) {
  const init = require("./init");
  init.run(cfg().vaultPath, cfg().walletName);
  start();
}

module.exports = { start };
