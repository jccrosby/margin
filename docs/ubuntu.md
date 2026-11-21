# Install Margin on Ubuntu

Use a Linux-enabled release on Ubuntu 24.04 LTS x64. You need local ext4 storage, Node.js 26 with npm, Git, and the Codex CLI.

## Set up package access

Follow the [package access steps](../README.md#get-access-to-margin). Keep your token in your user npm settings file, `~/.npmrc`, with mode `0600`. Run npm commands outside project folders.

## Register and refresh a project

Run these commands in Bash. Replace `0.1.0` with the exact version of a release that supports Ubuntu. Set `checkout` and `extra` to your Git checkout paths.

```bash
cd "$HOME"
version='0.1.0'
registry="$HOME/.local/share/Margin data/projects.json"
checkout="$HOME/Projects/Café checkout"
extra="$HOME/Projects/Other checkout"

margin=(npx --yes "@jccrosby/margin@$version" --registry "$registry")
"${margin[@]}" register demo "$checkout"
"${margin[@]}" add-checkout demo extra "$extra"
"${margin[@]}" refresh demo
```

Keep the registry outside all registered folders. Use absolute paths on local ext4. Margin rejects bind mounts and network filesystems.

Margin creates directories with mode `0700` and files with mode `0600`. If Margin rejects an existing location, check its ownership, modes, and ACLs. You can also choose a new private directory.

## Connect Codex

Use the same launcher and registry. Start npm in your home directory so it reads your user settings.

```bash
codex mcp add margin -- /usr/bin/env -C "$HOME" "${margin[@]}" serve
codex mcp get margin
```

Check the exact package version and registry path. Start a fresh Codex session. Ask it to list sources in `demo`, search for a phrase, and open a citation.

See [Search, refresh, and add sources](usage.md) for the tools and examples.

## Build from a checkout

Install the C build tools with `sudo apt install build-essential`. Use Node.js 26 with its headers and pnpm 12.18.0.

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Install the `acl` package to run the ACL tests. Run `pnpm test` with `TMPDIR` on local ext4.
