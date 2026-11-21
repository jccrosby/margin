# Margin

Margin lets Codex search and read your local project files. It works with Git checkouts and optional folders of notes. It can also save private project notes when you enable saves.

- [Install and use Margin on Windows](docs/windows.md)
- [Install and use Margin on Ubuntu](docs/ubuntu.md)
- [Search, refresh, and add sources](docs/usage.md)
- [Update or remove Margin](docs/manage-margin.md)

## Get access to Margin

The following macOS examples need macOS 26 on Apple silicon and local APFS. They use Node.js 26, Git, Codex CLI, and `npx` from npm.

The **package** is the downloadable copy of the Margin program. GitHub Packages hosts it at `https://npm.pkg.github.com`. Its name is `@jccrosby/margin`.

1. Ask the package owner for **Read** access to `@jccrosby/margin`.
2. In GitHub, create a personal access token (classic) with the `read:packages` scope. [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)
3. Run this command to create `~/.npmrc` if needed and restrict access to your account.

   ```sh
   (umask 077 && touch "$HOME/.npmrc" && chmod 600 "$HOME/.npmrc")
   ```

4. Open `~/.npmrc` in a text editor. Add these lines or update the existing entries. Replace `REPLACE_WITH_YOUR_READ_TOKEN` with your token. Keep the token in this file and out of your project and Codex settings.

   ```ini
   @jccrosby:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=REPLACE_WITH_YOUR_READ_TOKEN
   ```

5. To pick a specific version, list the versions you can download. Run this from your home directory.

   ```sh
   cd "$HOME"
   npm view @jccrosby/margin versions --json
   ```

If the lookup fails, check your Read access, token, and whether the owner has published a version. If you have the source code, you can [run Margin from a checkout](#run-margin-from-a-checkout).

## Register and index your first project

Run the commands below in Terminal. Replace `0.1.0` with a published version, or use `@jccrosby/margin@latest`. The `latest` tag points to the release the publisher has marked as the default. [npm package tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

Margin calls its local projects file a **registry**. The `--registry` option takes that file's full path. The `registry` setting in `~/.npmrc` tells npm where to download Margin.

Pick a short ID for your project, such as `demo`. Replace `/absolute/path/to/checkout` with the full path to your Git checkout.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" \
  register demo "/absolute/path/to/checkout"
```

`npx` downloads the requested version if needed and runs it. Margin creates `projects.json` on the first registration. Keep it in a private directory outside every registered folder.

To include notes, append the full path to an existing notes folder after the checkout path. Use your chosen project ID in every command that shows `demo`.

Run a refresh to make the files searchable.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" refresh demo
```

Look for `"status":"complete"` for each folder in the output. If a folder has gaps, see [Refresh after files change](docs/usage.md#refresh-after-files-change).

If you prefer pnpm, replace `npx --yes` with `pnpm dlx --` in the examples. Keep the package name, version, and remaining arguments.

## Connect Codex and try a search

Use the same projects path you used to register the project. Choose an exact version to keep Codex on that release. With `@latest`, Codex can pick up a new release when it next starts Margin.

```sh
codex mcp add margin -- npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" serve
codex mcp get margin
```

Codex saves the values from your terminal when you run `mcp add`. Check that `mcp get` shows your version or tag and the full path to `projects.json`.

Start a new Codex session. Replace `PlayerControls` with a name you know appears in your checkout and try this prompt.

> Use Margin to search project `demo` for `PlayerControls`. Show the file paths and line numbers for the best matches.

If Margin fails to start, check that Codex can find Node.js, Git, and `npx`. It also needs access to your npm settings, projects file, and source folders. If Codex cannot find `npx`, run `command -v npx` and use the printed path in `codex mcp add`.

For another local MCP client, use the command and arguments after `codex mcp add margin --`. Select the stdio transport.

## Run Margin from a checkout

If you have access to the Margin repository, clone it and enter the checkout.

```sh
git clone https://github.com/jccrosby/margin.git
cd margin
```

If you already have a Margin checkout, open it in your terminal. Install the Xcode Command Line Tools for the native build. Then use pnpm 12.18.0 to install and build Margin.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

Run these commands from the Margin checkout. Replace the example checkout path with the full path to the project you want to search. You can append a notes folder path after it.

```sh
node "$PWD/src/margin.ts" \
  --registry "$HOME/Library/Application Support/Margin/projects.json" \
  register demo "/absolute/path/to/checkout"
node "$PWD/src/margin.ts" \
  --registry "$HOME/Library/Application Support/Margin/projects.json" refresh demo
codex mcp add margin -- node "$PWD/src/margin.ts" \
  --registry "$HOME/Library/Application Support/Margin/projects.json" serve
```

Open a new session and [try a search](#connect-codex-and-try-a-search).

For other examples, run from the Margin checkout. Replace `npx --yes @jccrosby/margin@0.1.0` with `node "$PWD/src/margin.ts"`.

## Verify a development checkout

Use pnpm 12.18.0 to work on Margin. Run these commands from the checkout.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
```

The tests launch the stdio server in a separate directory with synthetic Git and notes fixtures.
After the tests compile the native addon, you can run `node src/margin.ts` with the same arguments.

The Step 1 check used a fresh Codex CLI 0.167.0 session. Codex read bounded passages from both roots and rejected path escapes and foreign source IDs.

The checkout paths, file hashes, and Git status matched the baseline.

See the [release instructions](RELEASING.md) for package checks and publishing.

## Evaluate retrieval

Freeze ten questions per project before tuning. Use two projects and include identifiers, paraphrases, code and notes together, and source conflicts.

Record the search query and mode for each question. Record the required source ranges and which source governs any conflict.

Keep the manifest outside the repository. This example uses synthetic data.

```json
{
  "cases": [
    {
      "id": "sample-01",
      "projectId": "sample",
      "question": "When does the preview end?",
      "query": "preview timeout",
      "mode": "ranked",
      "requires": [
        { "rootId": "code", "relativePath": "player.ts", "startLine": 2, "endLine": 4 },
        { "rootId": "notes", "relativePath": "policy.md", "startLine": 5, "endLine": 6 }
      ],
      "governs": "The policy governs."
    }
  ]
}
```

Refresh both projects against the frozen source versions. Run the scorer from the Margin checkout.

```sh
node scripts/score-retrieval.ts --registry /absolute/path/to/projects.json \
  --manifest /absolute/path/to/private/cases.json
```

The scorer sends one fixed query per case to `search_project`. Each required range must fit within one live text citation in the first five results.

The scorer stops if Margin takes over 30 seconds to reply. The default JSON reports the score, case count, and p95 MCP round-trip latency in milliseconds. Add `--details` for a private report with case IDs, times, and missing ranges.

Use a fresh Codex session for each project. Check that it connects the implementation to its requirement and explains conflicting evidence.

Edit a cited file and switch a checkout to a different Git revision. Check that search drops stale citations before refresh.

For a hybrid comparison, use the same cases, snapshots, and hardware. Require at least three recovered misses and preserve every baseline exact match. Cap p95 at 125% of baseline and require zero added per-query provider cost.

Count refresh interruptions only when manual refresh restores the expected evidence. Consider automatic refresh after three distinct interruptions across at least two sessions. Test whether the proposed trigger would have prevented them.

Publish aggregate results or synthetic examples. Keep real questions, paths, excerpts, and case details private.
