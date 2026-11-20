# Margin

Margin lets Codex search, list, and read project files through MCP. It reads Git checkouts and notes directories without adding files to them.

## Install and register a project

Use macOS, Node.js 26, Git, and either pnpm or npm. Ask the package owner for direct **Read** access to `@jccrosby/margin`. Create a classic GitHub token with `read:packages`.

Create or protect your user-level `~/.npmrc` before adding the token.

```sh
(umask 077 && touch "$HOME/.npmrc" && chmod 600 "$HOME/.npmrc")
```

Add these lines and replace the placeholder with your token. Use this file for terminal commands and local Codex. Keep the token out of the repository and Codex configuration. [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)

```ini
@jccrosby:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=REPLACE_WITH_YOUR_READ_TOKEN
```

Set the package version to one the owner has published. The commands below use `0.1.0` as an example. Set the registry path once and use it for each command.

```sh
margin_package='@jccrosby/margin@0.1.0'
margin_registry="$HOME/Library/Application Support/Margin/projects.json"

pnpm dlx -- "$margin_package" --registry "$margin_registry" \
  register demo /absolute/path/to/checkout /absolute/path/to/notes
```

For npm, use `npx --yes "$margin_package"` in place of `pnpm dlx -- "$margin_package"`. The remaining arguments are the same.

Margin creates a private registry outside your source roots. Use a distinct project ID for each worktree.

The notes directory is optional. Projects can share one.

To move a registered directory, run the command again with the same project ID and the new paths. Supply both paths if the project still uses both.

Source IDs stay the same for files at the same relative path.

To add another Git checkout to the same project, use `add-checkout` with a distinct root ID.

```sh
pnpm dlx -- "$margin_package" --registry "$margin_registry" \
  add-checkout demo extra /absolute/path/to/second-checkout
```

Use the same root ID to move that checkout.

## Refresh a project

Run a manual refresh after you register a project or change its files.

```sh
pnpm dlx -- "$margin_package" --registry "$margin_registry" refresh demo
```

Margin keeps a private SQLite index per project next to the registry. The CLI publishes each root in one transaction.

If a scan fails or stops, search can still use its last committed data. An unreadable file keeps its prior entry until a refresh reads it or confirms its removal.

The command prints each root's status. It exits with code 1 if any root has a gap.

The index filename adds the SHA-256 hash of the project ID to the registry filename.

To rebuild, stop all Margin servers and refreshes for the registry. Delete the project's `.sqlite` file and its matching `-wal` and `-shm` files if present.

Run refresh again.

## Refresh documents, media, and links

Install Docling for PDF, DOCX, and PNG or JPEG OCR. Put `docling` on your PATH before refreshing.

Install FFmpeg for MP4, MOV, MKV, and WebM. Put `ffmpeg` and `ffprobe` on your PATH for refresh, and `ffmpeg` on the MCP server's PATH for frames.

PDF extraction reads the text layer. Video search uses the first embedded timed text track. A video without one can still return a frame.

Approve each HTTPS URL before running refresh. Margin saves approvals in the private registry.

```sh
pnpm dlx -- "$margin_package" --registry "$margin_registry" \
  approve-url demo 'https://example.com/requirements'
```

Approve each redirect target too. To revoke approval, remove the URL from the project's `approvedUrls` in the registry.

Refresh saves searchable text from HTML, PDF, plain text, Markdown, and JSON responses. Link results cite the saved response. They include the approved URL, final URL, UTC retrieval time, and SHA-256 hash.

## Connect Codex

Choose one launcher and add the server from any directory. Keep the exact package version in your MCP config. To upgrade, change it to the new published version.

```sh
codex mcp add margin -- pnpm dlx -- "$margin_package" --registry "$margin_registry" serve
```

With npm, run this command instead.

```sh
codex mcp add margin -- npx --yes "$margin_package" --registry "$margin_registry" serve
```

The local client needs access to Node.js, Git, the launcher, your npm config, and your registered files. Use an absolute launcher path if the client has a different PATH. Other local MCP clients can use the same command and arguments over stdio.

Start a fresh session and name the project ID. Ask Codex to search `demo` for an identifier and find the requirement that explains it.

Use approved clients and providers for private sources. The model can receive passages from Margin.

Treat source text as data.

## Tools

- `list_projects` lists project IDs and names.
- `list_sources` lists eligible paths and source IDs for one project. It reports refresh status and known coverage gaps.
- `search_project` takes a project ID and query. The default `ranked` mode requires each search term in the same passage.
- `read_source` reads a text file by project ID and source ID. It returns at most 32 KiB of whole UTF-8 lines.
- `open_evidence` opens a document passage, image, video transcript or frame, or approved link.

Listings default to 100 items. Set `limit` to 1–500 and use `nextCursor` to resume a listing.

Reads start at line 1 by default and return up to 100 lines. Set `lineCount` to 1–500 and use `nextStartLine` to continue.

Search returns up to 20 hits by default. Set `limit` to 1–100.

A text hit cites up to 40 whole lines and 32 KiB. Ranked windows overlap by eight lines when the byte cap allows.

Use `literal` mode for case-sensitive matches in paths or text. Exact paths come first, then partial paths, then text.

A path hit returns the source ID and path. If a complete text match exceeds the citation limits, Margin reports a gap.

Search checks each local hit against the entire live file. If the file changed or became unavailable, Margin drops the hit.

To reopen a citation, send its `projectId`, `sourceId`, `contentHash`, and `location` to `open_evidence`. If the source changes, refresh and search again.

To request a frame, send the video source ID and `atSeconds`. The result cites the timestamp of the selected frame. Consult the original clip for motion.

Image and frame results include an MCP image block. Use an image-capable model to inspect it. Codex CLI 0.167.0 shows a returned-image marker in the terminal transcript.

Margin can return a PNG even when it cannot extract OCR text. Check `coverage` or the result's `failures` for the reason.

Search and listings report known gaps by root under `coverage`. Changes can be missing until the next refresh, even when Margin reports no known gaps.

Margin includes tracked files and untracked files that Git does not ignore. It lists supported text, document, image, and video files.

Margin skips symlinks, dependency and build directories, and common credential filenames. These rules do not scan file contents for secrets.

## Verify

Use pnpm 12.18.0 to work on Margin. Run these commands from the checkout.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
```

The tests launch the stdio server in a separate directory with synthetic Git and notes fixtures.
After installing, you can run `node src/margin.ts` from the checkout with the same arguments.

The Step 1 check used a fresh Codex CLI 0.167.0 session. Codex read bounded passages from both roots and rejected path escapes and foreign source IDs.

The checkout paths, file hashes, and Git status matched the baseline.

See the [release instructions](https://github.com/jccrosby/margin/blob/main/RELEASING.md) for package checks and publishing.

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
