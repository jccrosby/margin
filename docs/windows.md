# Install Margin on Windows

Use these steps with a Windows-enabled release of Margin. You need Windows 11 25H2 x64, local NTFS, native Node.js 26, Git, and the Codex CLI.

Run these commands in PowerShell. Use local drive paths like `C:\Users\you\Documents\my-project`.

## Set up package access

Ask the package owner for **Read** access. Create a GitHub personal access token (classic) with the `read:packages` scope.

Create a private directory for npm settings. The ACL grants access to your account and applies to new files in the directory.

```powershell
$npmSettings = Join-Path $env:LOCALAPPDATA 'Margin npm settings'
New-Item -ItemType Directory -Path $npmSettings -ErrorAction Stop | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ((Get-Item -LiteralPath $npmSettings).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Use a local directory without a link or junction for npm settings.'
}
$acl = Get-Acl -LiteralPath $npmSettings
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) {
    throw 'Use an npm settings directory that you own.'
}
$acl.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;$($sid.Value))", [System.Security.AccessControl.AccessControlSections]::Access)
Set-Acl -LiteralPath $npmSettings -AclObject $acl -ErrorAction Stop
$npmrc = Join-Path $npmSettings 'reader.npmrc'
```

Sign in with your GitHub username. At the password prompt, enter the token. npm stores it in `reader.npmrc`. Keep credentials in that file.

```powershell
npm.cmd login --scope=@jccrosby --registry=https://npm.pkg.github.com --auth-type=legacy --userconfig $npmrc
```

## Install and register a project

List the versions you can access. Enter the exact version of a release that supports Windows.

```powershell
npm.cmd view '@jccrosby/margin' versions --json --userconfig $npmrc
$version = Read-Host 'Enter the exact Windows-enabled Margin version'
$install = Join-Path $env:LOCALAPPDATA 'Margin apps\Café'
New-Item -ItemType Directory -Path $install -Force | Out-Null
npm.cmd install --prefix $install --userconfig $npmrc --save-exact "@jccrosby/margin@$version"
if ($LASTEXITCODE -ne 0) { throw 'Margin install failed.' }
```

Use the installed entry point for both the CLI and Codex. Replace the checkout path with your project.

```powershell
$node = (Get-Command node.exe -CommandType Application).Source
$entry = Join-Path $install 'node_modules\@jccrosby\margin\dist\margin.js'
$registry = Join-Path $env:LOCALAPPDATA 'Margin data\Café\projects.json'
$checkout = 'C:\Users\you\Projects\Café checkout'

& $node $entry --registry $registry register demo $checkout
& $node $entry --registry $registry refresh demo
```

Keep the registry outside all registered folders. Margin creates its storage directory with access limited to your account. If Margin rejects the location, use a private folder on a local NTFS drive.

## Connect Codex

```powershell
codex mcp add margin -- $node $entry --registry $registry serve
codex mcp get margin
```

Check that the command ends in `node.exe` and points to your installed `margin.js` and registry. Start a fresh Codex session. Ask it to list projects and sources for `demo`.

## Upgrade

Close sessions that use Margin. Set `$version` to the new version and repeat the install command with the same `$install` and `$npmrc`. Start a fresh Codex session and check your project again.

To run from a source checkout, install Python and Visual Studio with the Desktop development with C++ workload. Run `pnpm install --frozen-lockfile` and `pnpm run build`.
