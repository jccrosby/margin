#!/usr/bin/env bash
set -euo pipefail

version=${1:-}
mode=${2:-reader}
if [[ $# -gt 2 || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ||
      ( "$mode" != reader && "$mode" != anonymous && "$mode" != ungranted ) ]]; then
  echo 'Usage: pnpm run release:verify <version> [reader|anonymous|ungranted]' >&2
  exit 2
fi

package="@jccrosby/margin@$version"
umask 077
work=$(mktemp -d)
cd "$work"

if [[ "$mode" == reader ]]; then
  trap 'if [[ $? -ne 0 ]]; then rm -rf "$work"; fi' EXIT
  registry="$PWD/projects.json"
  git init --quiet demo
  printf 'Synthetic release check\n' > demo/README.md
  XDG_CACHE_HOME="$PWD/pnpm-cache" pnpm dlx --store-dir="$PWD/pnpm-store" -- "$package" \
    --registry "$registry" register smoke "$PWD/demo"
  npm_config_cache="$PWD/npm-cache" npx --yes "$package" --registry "$registry" refresh smoke
  printf 'Use this registry for the fresh Codex check: %s\n' "$registry"
  exit 0
fi

trap 'rm -rf "$work"' EXIT
touch user.npmrc global.npmrc
npm_auth=(--registry=https://npm.pkg.github.com --userconfig="$PWD/user.npmrc" --globalconfig="$PWD/global.npmrc")
if [[ "$mode" == ungranted ]]; then
  echo 'Sign in with a reader token for an account without a package grant.'
  env -i PATH="$PATH" npm login --scope=@jccrosby --auth-type=legacy "${npm_auth[@]}"
fi
if env -i PATH="$PATH" npm pack "$package" --ignore-scripts --cache="$PWD/npm-cache" \
    "${npm_auth[@]}" > fetch.log 2>&1; then
  echo "The $mode fetch downloaded $package. Check the package grants." >&2
  exit 1
fi
cat fetch.log >&2
if ! grep -Eq '^npm (error|ERR!) code E(401|403|404)[[:space:]]*$' fetch.log; then
  echo 'The fetch failed without a registry response that confirms denial.' >&2
  exit 1
fi
printf 'The registry denied the %s fetch of %s.\n' "$mode" "$package"
