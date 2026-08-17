#!/usr/bin/env bash
#
# Rebuild the contract fixtures from a checkout of the smart-account repo.
#
#   ./scripts/build-fixtures.sh ~/src/stellar-smart-account
#
# Contracts target wasm32v1-none, NOT wasm32-unknown-unknown: soroban-sdk 27
# refuses the latter on Rust 1.82+ ("has features enabled that are not yet
# supported and not easily disabled: reference-types, multi-value"). The
# `stellar` CLI selects the right target, which is why this shells out to it
# rather than calling cargo directly.
#
# Note the checked-in testdata/smart_account_v1.wasm in that repo is an OLDER
# build with a different signer shape (WebAuthn-style Secp256r1, key_id as the
# SignerKey). Always build from source rather than copying testdata.
set -euo pipefail

REPO="${1:-}"
if [ -z "$REPO" ] || [ ! -f "$REPO/Cargo.toml" ]; then
  echo "usage: $0 <path-to-stellar-smart-account-checkout>" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/test/fixtures"

for pkg in smart-account contract-factory; do
  echo "building $pkg ..."
  (cd "$REPO" && stellar contract build --package "$pkg")
done

cp "$REPO/target/wasm32v1-none/release/smart_account.wasm"    "$OUT/smart_account_current.wasm"
cp "$REPO/target/wasm32v1-none/release/contract_factory.wasm" "$OUT/contract_factory.wasm"

echo
echo "fixtures updated:"
ls -la "$OUT/smart_account_current.wasm" "$OUT/contract_factory.wasm"
