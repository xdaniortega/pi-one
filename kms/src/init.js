const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sdk = require("@open-wallet-standard/core");

function run(vaultPath, walletName) {
  console.log("════════════════════════════════════════════════");
  console.log("  Pi-One KMS Initialization");
  console.log("════════════════════════════════════════════════");
  console.log(`  Vault: ${vaultPath}`);

  fs.mkdirSync(vaultPath, { recursive: true, mode: 0o700 });

  const existingWallets = sdk.listWallets(vaultPath);
  const existing = existingWallets.find((w) => w.name === walletName);

  if (existing) {
    console.log(`  Wallet '${walletName}' already exists. Skipping.`);
    console.log("════════════════════════════════════════════════\n");
    return;
  }

  // Generate passphrase
  const passphrase = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(vaultPath, "passphrase"), passphrase, { mode: 0o600 });

  // Generate mnemonic
  const mnemonic = sdk.generateMnemonic(12);
  console.log("\n  ╔══════════════════════════════════════════════╗");
  console.log("  ║  BACKUP YOUR MNEMONIC (shown once only):    ║");
  console.log("  ╠══════════════════════════════════════════════╣");
  console.log(`  ║  ${mnemonic}`);
  console.log("  ╚══════════════════════════════════════════════╝\n");

  const wallet = sdk.importWalletMnemonic(walletName, mnemonic, passphrase, undefined, vaultPath);
  console.log(`  Wallet created: ${wallet.name} (${wallet.id})`);

  if (wallet.accounts && wallet.accounts.length > 0) {
    console.log("  Addresses:");
    for (const account of wallet.accounts) {
      console.log(`    ${account.chainId}: ${account.address}`);
    }
  }

  console.log("\n  No agent tokens created. Agents must request their own.");
  console.log("  Approve via: docker-compose exec ows-vault node src/manage.js requests");
  console.log("════════════════════════════════════════════════\n");
}

// If run directly (standalone init)
if (require.main === module) {
  const vaultPath = process.env.OWS_VAULT_PATH || `${process.env.HOME}/.ows`;
  const walletName = process.env.OWS_WALLET_NAME || "pi-treasury";
  run(vaultPath, walletName);
}

module.exports = { run };
