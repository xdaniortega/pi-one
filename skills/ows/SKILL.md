---
name: ows
description: Sign messages and transactions via the OWS CLI. Read before any signing or wallet operation.
---

# OWS — Open Wallet Standard CLI

All signing uses the `ows` CLI or `scripts/sign.sh`. Never import a signing library or make HTTP calls to sign.

## Wallet management

```sh
ows wallet create --name <wallet-name>
ows wallet list
```

`create` outputs the wallet name and address. `list` prints one wallet per line.

## Sign a message

```sh
ows sign message --wallet <name> --chain <chain> --message <hex>
```

Chains: `evm`, `solana`, `bitcoin`, `cosmos`, `tron`, `ton`, `sui`, `spark`, `filecoin`.
`<hex>` is the message encoded as hex (no `0x` prefix).

## Sign a transaction

Prefer the stable wrapper:

```sh
scripts/sign.sh <wallet-name> <chain> <tx-hex>
```

Direct call:

```sh
ows sign tx --wallet <name> --chain <chain> --tx-hex <hex>
```

`<tx-hex>` is the raw unsigned transaction in hex (no `0x` prefix).

## Output

On success both commands print one line to stdout: the signature hex. Nothing else.

## Errors

Non-zero exit code means failure. Read stderr for the reason.
Common: wallet not found, unsupported chain, invalid hex, locked vault.

## Rules

1. **Never construct a transaction.** Always pass raw hex received from the caller.
2. Prefer `scripts/sign.sh` for tx signing — it insulates you from CLI flag changes.
