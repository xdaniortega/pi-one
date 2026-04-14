#!/bin/sh
# Wrapper around `ows sign tx`. Prints only the signature to stdout.
# Usage: sign.sh <wallet-name> <chain> <tx-hex>

set -e

if [ $# -ne 3 ]; then
  printf 'Usage: sign.sh <wallet-name> <chain> <tx-hex>\n' >&2
  exit 1
fi

ows sign tx --wallet "$1" --chain "$2" --tx-hex "$3"
