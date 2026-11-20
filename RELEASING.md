# Release Margin

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

On macOS with Node.js 26, pnpm, npm, and Git, check out the release commit on a clean `main`.

```sh
pnpm run release:bootstrap --publish
```

The command runs the tests, checks the archive, and prints its source commit and SHA-256. It then prompts for npm login and publishes that archive. Sign in as `jccrosby` and use a short-lived classic token with `write:packages` as the password.

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
