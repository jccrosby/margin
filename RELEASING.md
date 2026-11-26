# Release Margin

Publish only for macOS 26 on Apple silicon. [Issue #62](https://github.com/jccrosby/margin/issues/62) tracks cross-platform qualification.

## Publish an update

1. Run `pnpm version <version> --no-git-tag-version` and merge the version bump through a PR.
2. Run the following command with an authenticated GitHub CLI.

   ```sh
   gh workflow run release.yml --repo jccrosby/margin --ref main
   ```

3. Use the run ID from the printed URL to watch the run and read its log.

   ```sh
   gh run watch <run-id> --repo jccrosby/margin --exit-status
   gh run view <run-id> --repo jccrosby/margin --log
   ```

   Save the source commit and tarball SHA-256 from the log. Wait for the run to finish before dispatching another release.
4. Verify the published version before sharing it.

## Publish the first version

Use macOS 26 on Apple silicon with local APFS, Node.js 26, pnpm, npm, Git, and the Xcode Command Line Tools. Check out the release commit on a clean `main`.

```sh
pnpm run release:bootstrap --publish
```

The command runs the tests, checks the archive with both package launchers, and prints its source commit and SHA-256. It then prompts for npm login and publishes that archive. Sign in as `jccrosby` and use a short-lived classic token with `write:packages` as the password.

Run `pnpm run release:bootstrap` to check the package without signing in or publishing.

In GitHub package settings, confirm **Private** visibility and grant readers direct **Read** access. Leave repository permission inheritance off. Under **Manage Actions access**, give `jccrosby/margin` **Write** access. [GitHub Packages access controls](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## Verify before sharing

1. Confirm the exact version, **Private** visibility, and grants on GitHub.
2. On macOS with Node.js 26, Git, pnpm, and npm, use an account with direct **Read** access. Follow the [reader setup](README.md#get-access-to-margin), then run the command below with the published version.

   ```sh
   pnpm run release:verify 0.1.0
   ```

   The command checks both launchers with fresh caches and prints the path to a synthetic project registry. Add the pinned package to a local Codex MCP profile with that registry path. In a fresh session, confirm Codex lists the tools and finds the `smoke` project.

3. Check that both fetches fail with a registry denial. When prompted for the ungranted check, use a valid classic `read:packages` token from an account without a grant.

   ```sh
   pnpm run release:verify 0.1.0 anonymous
   pnpm run release:verify 0.1.0 ungranted
   ```

4. Record the version, source commit, tarball SHA-256, and check results. Keep tokens, local paths, and project data out of the record.

## Check a macOS candidate

Use macOS 26 on Apple silicon, local APFS, Node.js 26, Git, pnpm 12.18.0, and the Xcode Command Line Tools. Run these commands from the Margin checkout.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
tarball="$(mktemp -d)/margin.tgz"
pnpm pack --out "$tarball"
node scripts/check-package.js "$tarball" --candidate
node scripts/check-codex.js "$tarball"
```

The package check launches the archive through pnpm and npm with fresh caches. The Codex check uses a separate registry and synthetic Git checkouts.

For a manual onboarding check, install the archive in a test environment. Run `margin setup` from a synthetic Git checkout. Accept the suggested ID, skip notes, and check that setup reports a complete refresh. Run `margin refresh` with that ID and verify a search in a fresh Codex session.

## Check a Windows candidate

Run these commands on Windows with native Node.js 26 x64, Git, Python, and Visual Studio C++ build tools.

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
$tarball = Join-Path $env:TEMP 'margin.tgz'
pnpm --config.pnpmfile=scripts/candidate-pnpmfile.cjs pack --out $tarball
node scripts/check-package.js $tarball --candidate
```

The pack command marks the archive private and restricts installation to the build platform. The check installs it outside the checkout and starts the CLI and MCP server through Node.

## Check an Ubuntu candidate

Run these commands on Ubuntu 24.04 LTS x64. Use local ext4, native Node.js 26, Git, and the Codex CLI. Install `build-essential` and `acl`.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
tarball="$(mktemp -d)/margin.tgz"
pnpm --config.pnpmfile=scripts/candidate-pnpmfile.cjs pack --out "$tarball"
node scripts/check-package.js "$tarball" --candidate
node scripts/check-codex.js "$tarball"
```

Set `MARGIN_TEST_BIND_MOUNTS=1` to include the bind mount test if your account can run `sudo -n mount` and `sudo -n umount`.

The pack command marks the archive private and restricts installation to the build platform. The package check uses `npx` outside the checkout.
