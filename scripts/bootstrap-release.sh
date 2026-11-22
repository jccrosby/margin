#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 && "$1" == --publish ]]; then
  echo 'Publication blocked. Qualify one tarball on all three native targets before publishing.' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then
  echo 'Usage: pnpm run release:bootstrap' >&2
  exit 2
fi

pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball="$work/margin.tgz"
pnpm pack --out "$tarball" >/dev/null
tar -xOzf "$tarball" package/package.json | node -e '
  const assert = require("node:assert/strict");
  const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.ok(!Object.hasOwn(manifest, "repository"),
    "Remove the repository field from the first release manifest.");
'
node scripts/check-package.js "$tarball" --candidate
echo 'Package smoke checks passed. Publication requires native qualification.'
