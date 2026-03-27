---
name: wallet
description: Sign messages and transactions on any blockchain (EVM, Solana, Bitcoin, Cosmos, Tron, TON, Sui, Spark, Filecoin), check wallet addresses, and manage wallet capabilities via the KMS. Use when the user asks about signing, wallets, blockchain operations, or crypto transactions.
---

# Wallet

Secure wallet operations via an isolated KMS container. All output is JSON.

## Sign a message

```bash
node {baseDir}/scripts/wallet.js sign --chain evm --message "hello world"
```

Supported chains: `evm`, `solana`, `bitcoin`, `cosmos`, `tron`, `ton`, `sui`, `spark`, `filecoin`.

If you receive `POLICY_DENIED`, use "Request a new capability" below.

## Get wallet address

```bash
node {baseDir}/scripts/wallet.js address --chain evm
```

## Check current capabilities

```bash
node {baseDir}/scripts/wallet.js capabilities
```

## Request a new capability

When an operation is denied by policy, request the needed permission:

```bash
node {baseDir}/scripts/wallet.js request \
  --reason "Need to sign transactions on Base for contract deployment" \
  --operations "sign_transaction,sign_and_send" \
  --chains "evm" \
  --ttl "4h"
```

This submits a request to the KMS approval queue. Tell the user to approve:

```
docker-compose exec ows-vault node src/manage.js requests
docker-compose exec ows-vault node src/manage.js approve <request_id>
```

## Check request status

```bash
node {baseDir}/scripts/wallet.js check --id <request_id>
```

If approved, the new token is automatically loaded. Retry the previously denied operation.
