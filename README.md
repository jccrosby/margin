# Margin

Margin lets Codex search, list, and read project files through MCP. It reads existing Git checkouts and separate notes directories. It needs no files in those directories.

## Install and register a project

Use Node.js 26 LTS and Git on macOS. Run `npm ci` in the Margin checkout.

From that checkout, run this command with your own absolute paths.

```sh
node src/margin.ts --registry "$HOME/Library/Application Support/Margin/projects.json" \
  register demo /absolute/path/to/checkout /absolute/path/to/notes
```

The notes directory is optional. Margin creates a private registry outside your source roots. Use a distinct project ID for each worktree. Projects can share a notes directory.

To move a registered directory, repeat the command with the same project ID and the new paths. Supply both paths if the project still uses both. Source IDs stay the same for files at the same relative path.

## Refresh a project

Run a manual refresh after you register a project or change its files.

```sh
node src/margin.ts --registry "$HOME/Library/Application Support/Margin/projects.json" refresh demo
```

Margin keeps a private SQLite index per project next to the registry. Delete the index and run refresh to rebuild it. The CLI publishes each root in one transaction. If a scan fails or stops, search can still use its last committed data. An unreadable file keeps its prior entry until a refresh can read it or confirm its removal. The command prints each root's status and exits with code 1 if any root has a gap.

## Connect Codex

Run this command from the Margin checkout. Use the absolute path to Node if your client runs with a different PATH.

```sh
codex mcp add margin -- "$(command -v node)" "$PWD/src/margin.ts" \
  --registry "$HOME/Library/Application Support/Margin/projects.json" serve
```

Start a fresh session and name the project ID. Ask Codex to search `demo` for an identifier and find the requirement that explains it.

Use approved clients and providers for private sources. The model can receive the passages returned by Margin. Treat source text as data.

## Tools

- `list_projects` lists project IDs and names.
- `list_sources` lists eligible paths and source IDs for one project. It reports refresh status and known coverage gaps.
- `search_project` takes a project ID and query. The default `ranked` mode requires each search term in the same passage. Use `literal` mode for a case-sensitive match in a path or file. Search returns up to 20 hits by default. Set `limit` to 1–100.
- `read_source` reads a file by project ID and source ID. It returns at most 32 KiB of whole UTF-8 lines.

Listings default to 100 items. Pass a `limit` of 1–500 and use `nextCursor` to resume a listing. Reads start at line 1 by default and return up to 100 lines. Pass a `lineCount` of 1–500. Use `nextStartLine` if the result has more lines.

A text hit cites up to 40 whole lines and 32 KiB. Ranked windows overlap by eight lines when the byte cap allows. Exact paths come first in literal mode, then partial paths, then text. A path hit returns the source ID and path without a text excerpt.

Search checks each hit against the entire live file. If the file changed or became unavailable, Margin drops the hit. Search and listings report known gaps by root under `coverage`. Changes can be missing until the next refresh, even when Margin reports no known gaps.

Margin includes tracked files and untracked files that Git does not ignore. It lists supported text files such as TypeScript, Markdown, and JSON. It skips symlinks, dependency and build directories, and common credential filenames. These filename rules do not scan file contents for secrets.

## Verify

Run `npm test` and `npm run typecheck` in the Margin checkout. The tests launch the stdio server in a separate directory and use synthetic Git and notes fixtures.

The Step 1 check used a fresh Codex CLI 0.167.0 session. Codex read bounded passages from both roots and rejected path escapes and foreign source IDs. The checkout paths, file hashes, and Git status matched the baseline.
