# Margin

Margin lets Codex search and read your local project files. It works with Git checkouts and optional folders of notes. It can also save private project notes when you enable saves.

- [Search, refresh, and add sources](docs/usage.md)
- [Update or remove Margin](docs/manage-margin.md)

## Get access to Margin

The published package supports macOS 26 on Apple silicon.

Ask the package owner for **Read** access to `@jccrosby/margin`. Create a GitHub personal access token (classic) with the `read:packages` scope.

Run these commands from your home directory. Enter your GitHub username and use your token as the password. [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)

```sh
cd "$HOME"
(umask 077 && touch .npmrc && chmod 600 .npmrc)
npm login --scope=@jccrosby --registry=https://npm.pkg.github.com --auth-type=legacy
```

## Install on macOS

Use macOS 26 on Apple silicon, local APFS, Node.js 26, and Git. Install the Codex CLI to search from Codex.

```sh
npm install --global @jccrosby/margin
```

Use a release that includes `margin setup`. Run `margin --help` to check. If the package lacks this command, [build from source](#run-margin-from-a-checkout).

## Register and index your first project

Open a terminal in the Git checkout you want to search and run:

```sh
margin setup
```

Margin finds the checkout root and asks for a project ID and an optional notes folder. Press Enter to accept the suggested ID. Press Enter again to skip notes, or type a folder path.

Margin registers and indexes the project. It stores the registry and search indexes in `~/Library/Application Support/Margin`. Use a new project ID for each setup.

If setup reports indexing gaps, fix the reported errors and [refresh the project](docs/usage.md#refresh-after-files-change).

## Connect Codex and try a search

Run this once for your macOS install:

```sh
codex mcp add margin -- "$(command -v margin)" serve
codex mcp get margin
```

Start a fresh Codex session. Replace `demo` with your project ID, and use a word you know appears in your checkout.

> Use Margin to search project `demo` for `PlayerControls`. Show the file paths and line numbers for the best matches.

For another MCP client, use the same command and arguments after `--` with the stdio transport.

## Run Margin from a checkout

Clone the Margin repository if you need a local copy. Install the Xcode Command Line Tools and use pnpm 12.18.0.

```sh
git clone https://github.com/jccrosby/margin.git
cd margin
pnpm install --frozen-lockfile
pnpm run build
margin_entry="$PWD/dist/margin.js"
```

In the same terminal, switch to the Git checkout you want to search. Replace the example path with your own.

```sh
cd "/absolute/path/to/your/checkout"
node "$margin_entry" setup
codex mcp add margin -- "$(command -v node)" "$margin_entry" serve
```

Start a new Codex session and [try a search](#connect-codex-and-try-a-search). Use `node "$margin_entry"` in place of `margin` for other commands.

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

See the [release instructions](RELEASING.md#check-a-windows-candidate) to test Windows and Ubuntu builds.

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
