---
name: wallet
description: Sign messages, check wallet addresses, and manage wallet capabilities via the KMS.
---

# Wallet

Secure wallet operations via an isolated KMS container. All commands output JSON.

Your token is already loaded from bootstrap. You do not need to configure or pass it — `wallet.js` reads it automatically.

## Commands

### Sign a message

```bash
node {baseDir}/scripts/wallet.js sign --chain evm --message "hello world"
```

### Get wallet address

```bash
node {baseDir}/scripts/wallet.js address --chain evm
```

### Check current capabilities

```bash
node {baseDir}/scripts/wallet.js capabilities
```

Supported chains: `evm`, `solana`, `bitcoin`, `cosmos`, `tron`, `ton`, `sui`, `spark`, `filecoin`.

## Handling POLICY_DENIED errors

If any command returns `"code": "POLICY_DENIED"`, your current token does not have permission for that operation. Follow these steps **in order**:

### Step 1 — Request the capability you need

```bash
node {baseDir}/scripts/wallet.js request \
  --reason "<explain why you need this>" \
  --operations "<comma-separated: sign_message,sign_transaction,sign_and_send>" \
  --chains "<comma-separated: evm,solana,...>" \
  --ttl "4h"
```

This returns a `request_id`. Save it.

### Step 2 — Tell the user to approve

Tell the user to run these commands on their host machine:

```
docker-compose exec ows-vault node src/manage.js requests
docker-compose exec ows-vault node src/manage.js approve <request_id>
```

### Step 3 — Poll until approved

```bash
node {baseDir}/scripts/wallet.js check --id <request_id>
```

If the output shows `"status": "approved"`, the new token is automatically saved and loaded.

### Step 4 — Retry the original command

Re-run the exact command that returned `POLICY_DENIED`. It will now use the new token.
