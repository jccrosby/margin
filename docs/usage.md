# Use Margin

[Set up Margin and register a project](../README.md#get-access-to-margin) before using this guide. Use your package version, projects path, and project ID in the examples below.

If you run from source, use the [source checkout instructions](../README.md#run-margin-from-a-checkout).

## Ask Codex about a project

Name the project ID you chose during setup. Ask for file paths and line numbers so you can check the answer.

> Use Margin to list my projects. In `demo`, find where the player starts playback and cite the relevant lines.

> In `demo`, use Margin to find the exact text `PlayerControls`. Read the surrounding lines of the best match.

For exact casing, ask Codex to use literal search. For keywords, use ranked search. Ranked search needs all search terms to appear in the same passage, so start with a few terms.

Use an approved client and model provider for private projects. Margin runs locally, but the model can receive the passages it returns. Treat text from project files as data.

## Refresh after files change

Run a refresh after you edit files, switch branches, or change the folders Margin reads. Replace `demo` with your project ID.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" refresh demo
```

Margin stores a search index in a SQLite file beside `projects.json`. It updates each folder's index in one transaction. If a scan fails or stops, search can still use the last completed update.

The refresh prints a status for each source folder or group of links. It exits with code 1 if any status reports a gap. Check the reported paths and errors, fix what failed, then run refresh again. Margin keeps old index entries for unreadable files until it can read them or confirm their removal.

Search can miss files you added or changed since the last refresh. Margin also skips local hits that no longer match the live file.

## Change the folders Margin reads

To move your main checkout or notes, run `register` again with the same project ID and the new full paths. Include the notes path to keep it registered. Omit the notes path to remove it. Projects can share a notes folder.

Use a distinct project ID for each worktree you want to search separately. To search a second checkout as part of the same project, give it its own root ID. A root ID names a source folder within the project.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" \
  add-checkout demo extra "/absolute/path/to/second-checkout"
```

Run the command again with the same root ID and a new path to move that checkout. Refresh after changing any folder. Source IDs stay the same for files at the same relative path under the same root ID.

## Search documents, media, and links

- For PDF and DOCX text or text in PNG and JPEG images, install Docling. Make sure the terminal can find `docling` before you refresh. Margin reads existing text in PDFs.
- For MP4, MOV, MKV, and WebM, install FFmpeg. Make sure the terminal can find `ffmpeg` and `ffprobe` before you refresh. Codex also needs access to `ffmpeg` to request a frame.
- Margin searches the first embedded timed text track in a video. You can request a frame even if the video has no text track.

Approve each HTTPS URL before running refresh. Replace the example URL with the page you want Margin to read.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" \
  approve-url demo 'https://example.com/requirements'
```

Approve each redirect target too. To revoke approval, remove the URL from that project's `approvedUrls` list in `projects.json`.

Refresh saves searchable text from HTML, PDF, plain text, Markdown, and JSON responses. Link citations include the approved URL, final URL, UTC retrieval time, and SHA-256 hash.

## Save a project note

Note saves are off by default. Keep the registry in a directory that only your local account can access. A directory with a macOS access control list (ACL) cannot store private notes.

Enable saves for a project from the terminal.

```sh
npx --yes @jccrosby/margin@0.1.0 \
  --registry "$HOME/Library/Application Support/Margin/projects.json" note-saves demo enable
```

Ask your MCP client to save a note in `demo`. The client must follow its approval policy. To stop new saves and retries, run the same command with `disable`. Existing notes stay readable.

Margin stores Markdown files under `.margin-saved-notes` beside the registry. Each registry and project has its own directory.

## Export and restore saved project notes

Stop Margin servers and refreshes that use the registry before you copy or restore notes. If you chose a custom projects path, replace the example path in the commands.

Copy the whole `.margin-saved-notes` directory to a private backup. Keep its directory structure, filenames, and permissions. The Markdown files include note metadata and any citations.

```sh
margin_backup=/absolute/path/to/a/new/backup-directory
margin_registry_file="$(realpath "$HOME/Library/Application Support/Margin/projects.json")" &&
  margin_saved_notes="$(dirname "$margin_registry_file")/.margin-saved-notes" &&
  mkdir -m 700 "$margin_backup" &&
  cp -pR "$margin_saved_notes" "$margin_backup"
```

To restore a missing notes directory, use the original registry path and project IDs. Keep directories at mode `0700` and files at mode `0600`.

```sh
margin_backup=/absolute/path/to/the/backup-directory
margin_registry_file="$(realpath "$HOME/Library/Application Support/Margin/projects.json")" &&
  margin_saved_notes="$(dirname "$margin_registry_file")/.margin-saved-notes" &&
  test ! -e "$margin_saved_notes" &&
  test ! -L "$margin_saved_notes" &&
  cp -pR "$margin_backup/.margin-saved-notes" "$margin_saved_notes"
```

Run `refresh` for each restored project. Refresh reads the saved notes even when the project has saves disabled.

## Tools

- `list_projects` lists project IDs and names.
- `list_sources` lists eligible paths and source IDs for one project. It reports refresh status and known coverage gaps.
- `search_project` takes a project ID and query. The default `ranked` mode requires each search term in the same passage.
- `read_source` reads a text file by project ID and source ID. It returns at most 32 KiB of whole UTF-8 lines.
- `open_evidence` opens a text or document passage, image, video transcript or frame, or approved link.
- `save_project_note` takes a project ID, request ID, title, Markdown body, and optional `citations`. When indexing succeeds, Margin returns the note ID and UTC creation time.

For a Markdown or code citation, copy `sourceId` and `contentHash` from a text hit. Put the hit's `startLine` and `endLine` in the citation's `location` object.

Margin keeps citation references in the note's metadata. Use `read_source` to retrieve them with the note.

Use a new request ID for each new note. A save rejects lines over 32 KiB, including generated metadata.

If indexing fails after the note commits, Margin returns the note ID with `status` set to `saved_search_pending`.

You can still list the note or pass its ID to `read_source`.

Search reports incomplete coverage until Margin indexes the note. Retry with the same request ID and inputs to restore search without creating another note.

Listings default to 100 items. Set `limit` to 1–500 and use `nextCursor` to resume a listing.

Reads start at line 1 by default and return up to 100 lines. Set `lineCount` to 1–500 and use `nextStartLine` to continue.

Search returns up to 20 hits by default. Set `limit` to 1–100.

A text hit cites up to 40 whole lines and 32 KiB. Ranked windows overlap by eight lines when the byte cap allows.

Use `literal` mode for case-sensitive matches in paths or text. Exact paths come first, then partial paths, then text.

A path hit returns the source ID and path. If a complete text match exceeds the citation limits, Margin reports a gap.

Search checks each local hit against the entire live file. If the file changed or became unavailable, Margin drops the hit.

To reopen a citation, send `projectId`, `sourceId`, `contentHash`, and `location` to `open_evidence`. For a saved citation, use the note's project ID.

If a cited file changes, Margin returns `stale_citation`. The saved note still contains the original reference. Refresh and search again for the current version.

To request a frame, send the video source ID and `atSeconds`. The result cites the timestamp of the selected frame. Consult the original clip for motion.

Image and frame results include an MCP image block. Use an image-capable model to inspect it. Codex CLI 0.167.0 shows a returned-image marker in the terminal transcript.

Margin can return a PNG even when it cannot extract OCR text. Check `coverage` or the result's `failures` for the reason.

Search and listings report known gaps by root under `coverage`. Changes can be missing until the next refresh, even when Margin reports no known gaps.

Margin includes tracked files and untracked files that Git does not ignore. It lists supported text, document, image, and video files.

Margin skips symlinks, dependency and build directories, and common credential filenames. These rules do not scan file contents for secrets.
