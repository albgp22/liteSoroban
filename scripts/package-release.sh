#!/usr/bin/env bash
#
# Assemble the release assets from a built pkg/ (run `npm run build:wasm` first).
#
#   ./scripts/package-release.sh v0.1.0 [outdir]
#
# Writes <outdir> (default: dist/):
#   litesoroban-host-<tag>.tar.gz   the wasm-pack output: .wasm, JS glue, .d.ts, package.json
#   soroban_host_bg.wasm            the bare WASM, for anyone bringing their own glue
#   SHA256SUMS
#
# Refuses to package a build that carries the builder's own directories. rustc
# writes source paths into the WASM (panic locations), so a build made on a
# laptop embeds /Users/<name>/.cargo/registry/... The release workflow remaps
# those prefixes at build time; this check is what fails the release if the
# remap ever stops working.
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag> [outdir]" >&2
  exit 1
fi
OUT="${2:-dist}"
# A branch name from a manual workflow run can contain slashes.
NAME="litesoroban-host-${TAG//\//-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/pkg"
FILES=(soroban_host_bg.wasm soroban_host.js soroban_host.d.ts soroban_host_bg.wasm.d.ts package.json)

for f in "${FILES[@]}"; do
  if [ ! -f "$PKG/$f" ]; then
    echo "missing $PKG/$f - run 'npm run build:wasm' first" >&2
    exit 1
  fi
done

# Any home-directory-shaped path, plus the literal checkout and $HOME.
leaks="$(cd "$PKG" && LC_ALL=C grep -a -o -E '(/Users|/home|/root)/[A-Za-z0-9._-]+' "${FILES[@]}" | sort -u || true)"
fixed=(-e "$ROOT")
[ "${#HOME}" -gt 1 ] && fixed+=(-e "$HOME")
literal="$(cd "$PKG" && LC_ALL=C grep -a -l -F "${fixed[@]}" "${FILES[@]}" || true)"
if [ -n "$leaks$literal" ]; then
  echo "refusing to package: the build embeds local paths" >&2
  [ -n "$leaks" ] && printf '%s\n' "$leaks" | sed 's/^/  /' >&2
  [ -n "$literal" ] && printf '  the checkout or home directory appears in: %s\n' "$literal" >&2
  echo "build with RUSTFLAGS=--remap-path-prefix=... (see .github/workflows/release.yml)" >&2
  exit 1
fi

mkdir -p "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$NAME"
for f in "${FILES[@]}"; do cp "$PKG/$f" "$STAGE/$NAME/$f"; done

# wasm-pack copies the crate's version (0.0.1) into package.json. A release tag
# (v1.2.3, v1.2.3-rc.1) carries the real one; anything else, such as a branch
# from a manual run, keeps the crate's.
if [[ "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$STAGE/$NAME/package.json" "${BASH_REMATCH[1]}"
fi

# Same inputs, same bytes: fixed order, owner and mtime, no gzip timestamp.
# (--sort and friends are GNU tar; bsdtar on macOS still produces a valid
# archive, just not a reproducible one.)
tar_opts=()
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar_opts=(--sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner)
fi
tar ${tar_opts[@]+"${tar_opts[@]}"} -cf - -C "$STAGE" "$NAME" | gzip -n >"$OUT/$NAME.tar.gz"
cp "$PKG/soroban_host_bg.wasm" "$OUT/soroban_host_bg.wasm"

if command -v sha256sum >/dev/null 2>&1; then sum=(sha256sum); else sum=(shasum -a 256); fi
(cd "$OUT" && "${sum[@]}" "$NAME.tar.gz" soroban_host_bg.wasm >SHA256SUMS)

echo "packaged $OUT/:"
(cd "$OUT" && ls -l "$NAME.tar.gz" soroban_host_bg.wasm SHA256SUMS && cat SHA256SUMS)
