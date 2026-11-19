# Release Margin

Release on macOS with Node.js 26, npm, and Git. Use a clean checkout of the release commit on `main`.

## Prepare the first version

Run the checks and pack once. Keep the tarball on your machine.

```sh
npm ci
npm run typecheck
npm test
margin_release=$(mktemp -d)
margin_tarball="$margin_release/$(npm pack --silent --pack-destination "$margin_release")"
node scripts/check-package.js "$margin_tarball"
git rev-parse HEAD
shasum -a 256 "$margin_tarball"
```

The package check compares the archive contents with the expected JavaScript files, README, and package metadata. It installs the archive, registers a synthetic Git project, and checks the MCP handshake outside the checkout.

## Publish the first version

John Crosby (`jccrosby`) publishes the checked tarball with a short-lived classic token that has `write:packages`. Use the token as the password when npm prompts. Use a temporary config so the publish token stays separate from your reader token.

```sh
(
  set -e
  umask 077
  margin_auth=$(mktemp)
  trap 'rm -f "$margin_auth"' EXIT
  npm login --scope=@jccrosby --auth-type=legacy \
    --registry=https://npm.pkg.github.com --userconfig="$margin_auth"
  npm publish "$margin_tarball" --ignore-scripts \
    --registry=https://npm.pkg.github.com --userconfig="$margin_auth"
)
```

Open the package settings in GitHub. Confirm **Private** visibility and grant readers direct **Read** access. Leave repository permission inheritance off. Under **Manage Actions access**, add `jccrosby/margin` with **Write** access. [GitHub Packages access controls](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## Publish later versions

Update the version in the release PR with `npm version <version> --no-git-tag-version`. After merge, run **Release Margin** from `main`. The workflow checks and uploads the same tarball using its GitHub token.

## Verify access before sharing

Check the exact version, **Private** visibility, and grants on GitHub. Use a different account with a direct **Read** grant for the install checks. Follow the [reader setup](README.md#install-and-register-a-project) for its classic token with `read:packages`.

Use a new macOS temp directory outside the Margin checkout. Set `margin_package` to the version you published.

```sh
margin_package='@jccrosby/margin@0.1.0'
margin_check=$(mktemp -d)
cd "$margin_check"
margin_registry="$PWD/projects.json"
git init --quiet demo
printf 'Synthetic release check\n' > demo/README.md

XDG_CACHE_HOME="$PWD/pnpm-cache" pnpm dlx --store-dir="$PWD/pnpm-store" "$margin_package" \
  --registry "$margin_registry" register smoke "$PWD/demo"
npm_config_cache="$PWD/npm-cache" npx --yes "$margin_package" \
  --registry "$margin_registry" refresh smoke
```

Add the pinned command to a local Codex MCP profile using the same registry path. Open a fresh session and confirm the server lists its tools and finds the synthetic project.

From the same temp directory, check denial with empty configs and an empty cache. The fetch must fail with a registry response that indicates missing access.

```sh
touch "$PWD/no-auth.npmrc" "$PWD/empty-global.npmrc"
env -i PATH="$PATH" HOME="$PWD" npm pack "$margin_package" --ignore-scripts \
  --registry=https://npm.pkg.github.com --cache="$PWD/anonymous-cache" \
  --userconfig="$PWD/no-auth.npmrc" --globalconfig="$PWD/empty-global.npmrc"
```

Repeat with a valid classic `read:packages` token for an account without a grant. Sign in with that account when npm prompts.

```sh
(
  set -e
  umask 077
  margin_auth=$(mktemp)
  trap 'rm -f "$margin_auth"' EXIT
  env -i PATH="$PATH" HOME="$PWD" npm login --scope=@jccrosby --auth-type=legacy \
    --registry=https://npm.pkg.github.com --userconfig="$margin_auth" \
    --globalconfig="$PWD/empty-global.npmrc"
  env -i PATH="$PATH" HOME="$PWD" npm pack "$margin_package" --ignore-scripts \
    --registry=https://npm.pkg.github.com --cache="$PWD/ungranted-cache" \
    --userconfig="$margin_auth" --globalconfig="$PWD/empty-global.npmrc"
)
```

Confirm the registry also denies that fetch. A network error or a mistyped version does not show that the grant works.

Record the version, source commit, tarball SHA-256, and check results. Share the version after both launchers and Codex work for the reader and both denial checks pass. Keep tokens, local paths, and project data out of the record.
