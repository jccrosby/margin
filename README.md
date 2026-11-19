# Margin

Margin lets Codex list and read live project files through MCP. It reads existing Git checkouts and separate notes directories. It needs no files in those directories.

## Install and register a project

Use Node.js 26 LTS and Git on macOS. Run `npm ci` in the Margin checkout.

From that checkout, run this command with your own absolute paths.

```sh
node src/margin.ts --registry "$HOME/Library/Application Support/Margin/projects.json" \
  register demo /absolute/path/to/checkout /absolute/path/to/notes
```

The notes directory is optional. Margin creates a private registry outside your source roots. Use a distinct project ID for each worktree. Projects can share a notes directory.

To move a registered directory, repeat the command with the same project ID and the new paths. Supply both paths if the project still uses both. Source IDs stay the same for files at the same relative path.

## Connect Codex

Run this command from the Margin checkout. Use the absolute path to Node if your client runs with a different PATH.

```sh
codex mcp add margin -- "$(command -v node)" "$PWD/src/margin.ts" \
  --registry "$HOME/Library/Application Support/Margin/projects.json" serve
```

Start a fresh session and name the project ID. For example, ask Codex to list sources for `demo` and read lines 1–10 from one file.

Use approved clients and providers for private sources. The model can receive the passages returned by Margin. Treat source text as data.

## Tools

- `list_projects` lists project IDs and names.
- `list_sources` lists eligible paths and source IDs for one project. It reports missing roots and continues with the others.
- `read_source` reads a file by project ID and source ID. It returns at most 32 KiB of whole UTF-8 lines.

Listings default to 100 items. Pass a `limit` of 1–500 and use `nextCursor` to resume a listing. Reads start at line 1 by default and return up to 100 lines. Pass a `lineCount` of 1–500. Use `nextStartLine` if the result has more lines.

Margin includes tracked files and untracked files that Git does not ignore. It lists supported text files such as TypeScript, Markdown, and JSON. It skips symlinks, dependency and build directories, and common credential filenames. These filename rules do not scan file contents for secrets.

## Verify

Run `npm test` and `npm run typecheck` in the Margin checkout. The tests launch the stdio server in a separate directory and use synthetic Git and notes fixtures.

The Step 1 check used a fresh Codex CLI 0.167.0 session. Codex read bounded passages from both roots and rejected path escapes and foreign source IDs. The checkout paths, file hashes, and Git status matched the baseline.
