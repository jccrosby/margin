# Update or remove Margin

Run `codex mcp get margin` to see how Codex launches Margin. The output shows the path after `--registry`. Use that projects file if you chose a different path during setup.

## Update a downloaded version

1. From your home directory, run `npm view @jccrosby/margin versions --json` to see the published versions you can access.
2. Replace `0.1.0` below with the version you want. Use the projects path from `codex mcp get margin`.
3. Run these commands to update the Codex entry and check the saved version.

   ```sh
   codex mcp add margin -- npx --yes @jccrosby/margin@0.1.0 \
     --registry "$HOME/Library/Application Support/Margin/projects.json" serve
   codex mcp get margin
   ```

4. Start a new Codex session. Ask Margin to list projects and search a project you know.

Use the same version in your terminal commands. To go back, repeat these steps with the previous version.

If you use pnpm, replace `npx --yes` with `pnpm dlx --` in the Codex command.

## Update a source checkout

Update your checkout to the Git revision you want to run. See the [checkout setup](../README.md#run-margin-from-a-checkout) for the Xcode Command Line Tools. From the checkout, run `pnpm install --frozen-lockfile`, then run `pnpm run build`.

Start a new Codex session and repeat the search check. If the checkout moved, [connect Codex again](../README.md#run-margin-from-a-checkout) from the new path.

## Rebuild a project's search index

Stop Margin sessions and refresh commands that use the projects file before deleting index files. To print the index path, replace `demo` with your project ID. Use your projects file path if it differs from the example.

```sh
printf '%s.%s.sqlite\n' "$HOME/Library/Application Support/Margin/projects.json" \
  "$(printf '%s' 'demo' | shasum -a 256 | cut -d ' ' -f 1)"
```

Delete that SQLite file and any matching `-wal`, `-shm`, or `-journal` files. Keep `.margin-saved-notes`. Run [refresh](usage.md#refresh-after-files-change) to rebuild search from project files and saved notes. Refresh fetches approved links again, so saved copies of earlier responses may be lost.

## Disconnect Margin from Codex

Close Codex sessions that use Margin. Remove the saved MCP entry and check the list.

```sh
codex mcp remove margin
codex mcp list
```

The projects file and search indexes remain on disk so you can connect again later. The `npx` and `pnpm dlx` setup uses a download cache. It does not require a global uninstall.

## Remove one project

Stop any Margin sessions and refresh commands that use the projects file. Open `projects.json` and remove the entry for that ID from the `projects` object. Keep the other entries and fix any trailing comma.

To delete the saved search data too, [find the project's index](#rebuild-a-projects-search-index) and move it and its matching journal files to Trash. The project's Git checkouts and notes stay in their original folders.

## Delete local Margin data

Stop any Margin sessions and refresh commands that use your projects file. To clear all projects that use the default path, open `~/Library/Application Support/Margin` in Finder. Move `projects.json` and its matching `projects.json.*.sqlite*` files to Trash. If you chose a custom path, use that file and the indexes named after it.

Deleting this data removes the registrations, link approvals, and saved index content. Keep `.margin-saved-notes` if you want to retain saved notes. Use the original projects path and project IDs to recover them. Keep your source folders and notes. If you ran from source, you can also delete the Margin checkout once you have saved any work you need.

If you created a token only for Margin, revoke it in GitHub and remove its line from `~/.npmrc`. Keep settings or tokens you still use for other GitHub packages.
