const sdk = require("@open-wallet-standard/core");

function signMessage(walletName, chain, message, token, vaultPath) {
  try {
    const result = sdk.signMessage(
      walletName,
      chain,
      message,
      token, // OWS detects ows_key_ prefix -> agent mode
      undefined, // encoding
      undefined, // index
      vaultPath,
    );
    return {
      signature: result.signature,
      recoveryId: result.recoveryId,
      chain,
      message,
    };
  } catch (err) {
    const error = new Error(err.message || String(err));
    if (
      String(err).includes("POLICY_DENIED") ||
      String(err).includes("policy")
    ) {
      error.code = "POLICY_DENIED";
    } else if (
      String(err).includes("API_KEY_NOT_FOUND") ||
      String(err).includes("Invalid passphrase") ||
      String(err).includes("invalid")
    ) {
      error.code = "INVALID_TOKEN";
    }
    throw error;
  }
}

function signTransaction(walletName, chain, txHex, token, vaultPath) {
  try {
    const result = sdk.signTransaction(
      walletName,
      chain,
      txHex,
      token,
      undefined, // index
      vaultPath,
    );
    return {
      signature: result.signature,
      recoveryId: result.recoveryId,
      chain,
    };
  } catch (err) {
    const error = new Error(err.message || String(err));
    if (String(err).includes("POLICY_DENIED") || String(err).includes("policy")) {
      error.code = "POLICY_DENIED";
    }
    throw error;
  }
}

function getAddress(walletName, chain, vaultPath) {
  const wallet = sdk.getWallet(walletName, vaultPath);
  if (!wallet) throw new Error(`Wallet '${walletName}' not found`);

  const account = wallet.accounts.find((a) => {
    const ns = a.chainId.split(":")[0];
    // Map chain param to CAIP namespace
    const chainToNs = {
      evm: "eip155",
      solana: "solana",
      bitcoin: "bip122",
      cosmos: "cosmos",
      tron: "tron",
      ton: "ton",
      sui: "sui",
      spark: "spark",
      filecoin: "fil",
    };
    return ns === (chainToNs[chain] || chain);
  });

  if (!account)
    throw new Error(`No account for chain '${chain}' in wallet '${walletName}'`);

  return {
    address: account.address,
    chain,
    chainId: account.chainId,
    derivationPath: account.derivationPath,
  };
}

function getCapabilities(token, vaultPath) {
  // OWS doesn't expose a direct "what can this token do" API.
  // We return the key metadata from our queue records if available,
  // or a basic status indicating the token is valid.
  const keys = sdk.listApiKeys(vaultPath);
  // We can't match token to key (only hash stored), so return basic info
  return {
    status: "active",
    note: "Token capabilities are enforced by OWS policies at signing time. Use wallet operations to test what is allowed.",
    registeredKeys: keys.length,
  };
}

module.exports = {
  signMessage,
  signTransaction,
  getAddress,
  getCapabilities,
};
