#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || ( $# -eq 1 && "${1}" != --publish ) ]]; then
  echo 'Usage: npm run release:bootstrap [-- --publish]' >&2
  exit 2
fi
if [[ $# -eq 1 && ( "$(git branch --show-current)" != main || -n "$(git status --porcelain)" ) ]]; then
  echo 'Check out the release commit on main with a clean working tree before publishing.' >&2
  exit 1
fi

npm ci
npm run typecheck
npm test

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive=$(npm pack --json --pack-destination "$work" |
  node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].filename')
tarball="$work/$archive"
tar -xOzf "$tarball" package/package.json | node -e '
  const assert = require("node:assert/strict");
  const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert.ok(!Object.hasOwn(manifest, "repository"),
    "Remove the repository field from the first release manifest.");
'
node scripts/check-package.js "$tarball"
git rev-parse HEAD
shasum -a 256 "$tarball" > "$tarball.sha256"
cat "$tarball.sha256"

if [[ $# -eq 1 ]]; then
  cd "$work"
  touch global.npmrc
  registry=https://npm.pkg.github.com
  npm_auth=(--registry="$registry" --userconfig="$work/publish.npmrc" --globalconfig="$work/global.npmrc")
  env -i PATH="$PATH" npm login --scope=@jccrosby --auth-type=legacy "${npm_auth[@]}"
  shasum -a 256 --check "$tarball.sha256"
  env -i PATH="$PATH" npm publish "$tarball" --ignore-scripts "${npm_auth[@]}"
else
  echo 'Package checks passed. Use --publish to check and publish the first version.'
fi
