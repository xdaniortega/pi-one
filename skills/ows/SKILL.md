---
name: ows
description: Background on the Open Wallet Standard. All signing goes through the wallet skill, not this CLI directly.
---

# OWS — Open Wallet Standard

The KMS container runs OWS internally. The agent does **not** have the `ows` CLI installed.

All signing and wallet operations go through the **wallet skill** (`wallet.js`), which talks to the KMS over the Unix socket. See the `wallet` skill for commands.

## Supported chains

`evm`, `solana`, `bitcoin`, `cosmos`, `tron`, `ton`, `sui`, `spark`, `filecoin`.
