# Release Margin

Run the native qualification checks for [issue #62](https://github.com/jccrosby/margin/issues/62) before publishing a cross-platform release. The release workflow and bootstrap command run package checks only. [Issue #63](https://github.com/jccrosby/margin/issues/63) tracks private publication and reader access.

## Build one candidate

Select one version and source commit. Use a clean checkout of that commit on each target.

| Target | Filesystem | Build tools |
| --- | --- | --- |
| macOS 26 ARM64 | APFS | Xcode Command Line Tools |
| Windows 11 25H2 x64 | NTFS | Python and Visual Studio C++ build tools |
| Ubuntu 24.04 LTS x64 | ext4 | `build-essential` and `acl` |

Use native Node.js 26, Git, npm, and the pnpm version in `package.json`. Run these commands on each target.

```sh
git rev-parse HEAD
git status --porcelain
pnpm install --frozen-lockfile
pnpm run build
```

Confirm all three checkouts report the same commit and an empty status. The build writes one native addon in `dist`. Copy `windows.node` and `linux.node` to the macOS build's `dist` through an owner-approved private channel. Keep the local copies and transfer away from the public GitHub repository, Actions artifacts, and logs.

On macOS, leave `macos.node` and the compiled JavaScript in place. Pack once with scripts disabled to keep all three addons.

```sh
umask 077
candidate_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$candidate_dir"
git rev-parse HEAD
shasum -a 256 "$candidate_dir/"*.tgz
```

Record the package version, full commit, and SHA-256. Transfer that archive privately to the other targets. Give each operator the same candidate record. Use the original archive for every check.

## Run the automated checks

On each target, install the Codex CLI, OpenSSL, Docling, FFmpeg, and `ffprobe`. Install the Docling models needed for PDF, DOCX, and OCR. Use a temporary directory on the target filesystem. Unset `NODE_OPTIONS` before running qualification. On Ubuntu, the bind mount test also needs `sudo -n mount` and `sudo -n umount`.

From the clean source checkout, pass the archive path and the recorded commit and SHA-256.

```sh
node scripts/qualify-candidate.js "<tarball>" "<commit>" "<sha256>"
```

If needed, pass the Codex executable as the last argument. On Windows, you can pass the path to the installed Codex `bin/codex.js` if your setup uses a command shim.

Save stdout as the target's JSON record. Save stderr as the run log. Keep both outside the checkout. The command checks the target, runs type checking and tests, and starts fresh Codex sessions using the installed archive.

The test suite checks path and link rejection, missing-extractor gaps, and concurrent note reads. The installed checks verify Git-backed retrieval, project isolation, approved HTTPS, real extraction, note recovery, and search after refresh.

## Complete the manual checks

Use only synthetic data. Record the result and supporting evidence for each check in the target record.

### Second ordinary account on every target

1. Start a fresh candidate session. Register a synthetic Git project with a copy of the media fixtures in `test/fixtures/evidence`. Enable note saves and save a note with a citation.
2. From the owner account, start a refresh of uncached media. While it runs, list the actual private paths. Include the registry, note, index, active SQLite WAL and shared-memory files, and an evidence scratch file. The refresh holds its index transaction open while Docling extracts a document.
3. Sign in as another ordinary account. Apply the probes below to its own control file first. Confirm read, write-open, and rename succeed.
4. Try to read each listed file. Open each existing file for writing and close it without writing. Rename each file with a `.probe` suffix. Try listing and renaming the private storage directory too.
5. Require an access denial for each probe. Missing files and sharing violations leave a gap. Confirm transient files exist during the probes. Repeat an uncached refresh if needed.
6. Restore any renamed synthetic paths under the owner account and mark that check failed. Confirm the owner can still read the data and open the citation. Record the file roles and outcomes. Mark `manual.secondAccount` as `pass` after every denial.

On Unix, use `cat`, `ls`, and `mv` for reads, listings, and renames. Use this write probe. It opens the existing file without creating, truncating, or writing it.

```sh
node -e 'const fs = require("node:fs"); fs.closeSync(fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_APPEND))' "$file"
```

In PowerShell, use `Get-Content`, `Get-ChildItem`, and `Rename-Item` with `-LiteralPath` and `-ErrorAction Stop`. Use this write probe.

```powershell
[IO.File]::Open($file, 'Open', 'Write', 'ReadWrite, Delete').Dispose()
```

### PowerShell launcher on Windows

Use the paths and registration commands in the [Windows setup guide](docs/windows.md). Skip the registry login and version lookup. Set `$tarball` to the local archive. Use an unused install directory and a synthetic registry. Keep spaces in both paths.

```powershell
npm.cmd install --prefix $install --save-exact $tarball
if ($LASTEXITCODE -ne 0) { throw 'Margin install failed.' }
$server = 'margin-qualification-' + [guid]::NewGuid().ToString('N')
codex mcp add $server -- $node $entry --registry $registry serve
codex mcp get $server
```

Confirm Codex uses `node.exe` with the installed `margin.js` and registry paths. In a fresh session, use the temporary server to list, search, and read sources. Reopen a citation. Remove the temporary entry with `codex mcp remove $server`. Record the result under `manual.powerShellLauncher`.

### Upgrade on macOS

Install the previous macOS release in an isolated setup. If no release exists, use a package from the last macOS baseline and record its commit. Set up a synthetic registry at the path the previous launcher uses. Register a project, save a note with a versioned citation, and record the project ID, note ID, and citation.

Switch the launcher to the candidate and keep the registry and source paths. Start a fresh Codex session. Confirm the same project and note IDs, search for the saved note, and reopen its original citation. Record that result under `manual.upgrade`.

## Record the release decision

Keep the tarball, three target records, and their logs private. Compare the version, commit, and SHA-256 on all three records. Release qualification requires every automated and manual check to pass. A failure or missing result blocks publication.

After qualification, use [issue #63](https://github.com/jccrosby/margin/issues/63) to verify publication and reader access. Check registry denials with fresh caches for both anonymous requests and a valid account without a package grant. Keep tokens, package contents, local paths, and project data out of public records.
