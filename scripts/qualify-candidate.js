import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { release as kernelRelease, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [archive, commit, sha256, codex, ...extra] = process.argv.slice(2);
assert.ok(archive && /^[a-f0-9]{40}$/i.test(commit ?? '') && /^[a-f0-9]{64}$/i.test(sha256 ?? '') && !extra.length,
  'Usage: node scripts/qualify-candidate.js <tarball> <source-commit> <sha256> [codex]');
assert.ok(!Object.entries(process.env).some(([key, value]) => key.toUpperCase() === 'NODE_OPTIONS' && value),
  'Unset NODE_OPTIONS before qualification so the full test suite runs.');
const tarball = realpathSync.native(resolve(archive));
const cwd = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const temp = realpathSync.native(tmpdir());
const env = { ...process.env, MARGIN_TEST_EXTRACTORS: '1' };
const text = (command, args) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
function verifyHash() {
  assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), sha256.toLowerCase(),
    'Candidate SHA-256 does not match the release record.');
}
verifyHash();
const entries = text('tar', ['-tzf', tarball]).split(/\r?\n/);
for (const addon of ['macos', 'windows', 'linux']) {
  const entry = `package/dist/${addon}.node`;
  assert.equal(entries.filter(name => name === entry).length, 1, `Candidate is missing ${entry} or contains duplicates.`);
}

assert.equal(text('git', ['rev-parse', 'HEAD']), commit.toLowerCase(), 'Check out the recorded source commit.');
assert.equal(text('git', ['status', '--porcelain']), '', 'Use a clean checkout of that commit.');
const manifest = JSON.parse(text('tar', ['-xOzf', tarball, 'package/package.json']));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, version, 'The archive version differs from the source version.');
assert.match(process.versions.node, /^26\./, 'Use native Node.js 26.');

let target;
let release;
const windows = process.platform === 'win32';
if (process.platform === 'darwin' && process.arch === 'arm64') {
  release = text('/usr/bin/sw_vers', ['-productVersion']);
  assert.match(release, /^26\./, 'Use macOS 26 on Apple silicon.');
  const mounts = text('/sbin/mount', []).split('\n');
  for (const path of [temp, cwd]) {
    const device = text('/bin/df', ['-P', path]).split('\n').at(-1).split(/\s+/)[0];
    assert.ok(mounts.some(mount => mount.startsWith(device + ' on ') && / \(apfs, .*\blocal\b/.test(mount)),
      'Use local APFS for the checkout and temporary files.');
  }
  target = 'macos-arm64-apfs';
} else if (windows && process.arch === 'x64') {
  const volumeCheck = `
    $ErrorActionPreference = 'Stop'
    $os = Get-CimInstance Win32_OperatingSystem
    $processors = Get-CimInstance Win32_Processor
    if (!$processors -or ($processors | Where-Object Architecture -ne 9)) {
      throw 'Use an x64 processor without ARM64 emulation.'
    }
    $version = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion
    if ($os.ProductType -ne 1 -or $version -ne '25H2' -or $os.BuildNumber -notmatch '^26200$') {
      throw 'Use Windows 11 25H2 x64.'
    }
    $tempProbe = Join-Path $env:MARGIN_QUALIFY_TEMP ([IO.Path]::GetRandomFileName())
    [IO.File]::Open($tempProbe, 'CreateNew').Dispose()
    try {
      $checkoutFile = Join-Path $env:MARGIN_QUALIFY_REPO 'package.json'
      foreach ($path in @($tempProbe, $checkoutFile)) {
        $volumes = @(Get-Volume -FilePath $path)
        if ($volumes.Count -ne 1 -or $volumes[0].CimInstanceProperties['DriveType'].Value -ne 3 -or
            $volumes[0].FileSystem -ne 'NTFS') {
          throw 'Use local NTFS for the checkout and temporary files.'
        }
      }
    } finally {
      [IO.File]::Delete($tempProbe)
    }
    Write-Output "$version ($($os.Version))"
  `;
  release = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(volumeCheck, 'utf16le').toString('base64')],
    { cwd, encoding: 'utf8', env: { ...env, MARGIN_QUALIFY_TEMP: temp, MARGIN_QUALIFY_REPO: cwd } }).trim();
  target = 'windows-x64-ntfs';
} else if (process.platform === 'linux' && process.arch === 'x64') {
  assert.doesNotMatch(kernelRelease(), /microsoft|wsl/i, 'Use native Ubuntu outside WSL.');
  const os = readFileSync('/etc/os-release', 'utf8');
  assert.match(os, /^ID=ubuntu$/m, 'Use Ubuntu 24.04 LTS x64.');
  assert.match(os, /^VERSION_ID="?24\.04"?$/m, 'Use Ubuntu 24.04 LTS x64.');
  for (const path of [temp, cwd]) {
    assert.equal(text('findmnt', ['--noheadings', '--output', 'FSTYPE', '--target', path]), 'ext4',
      'Use local ext4 for the checkout and temporary files.');
  }
  env.MARGIN_TEST_BIND_MOUNTS = '1';
  release = '24.04';
  target = 'ubuntu-x64-ext4';
} else {
  assert.fail('Use a native macOS ARM64, Windows x64, or Ubuntu x64 target.');
}

const options = { cwd, env, stdio: ['inherit', 2, 'inherit'] };
for (const command of ['install --frozen-lockfile', 'run typecheck', 'test']) {
  if (windows) execFileSync('cmd.exe', ['/d', '/c', 'pnpm ' + command], options);
  else execFileSync('pnpm', command.split(' '), options);
}
execFileSync(process.execPath, ['scripts/check-package.js', tarball, '--candidate'], options);
execFileSync(process.execPath, ['scripts/check-codex.js', tarball, ...(codex ? [codex] : [])], options);
verifyHash();

console.log(JSON.stringify({
  version, commit: commit.toLowerCase(), sha256: sha256.toLowerCase(), target, release, node: process.versions.node,
  checkedAt: new Date().toISOString(),
  automated: {
    typecheck: 'pass', fullSuite: 'pass', installedPackage: 'pass', freshCodex: 'pass'
  },
  manual: {
    secondAccount: 'pending',
    ...(windows ? { powerShellLauncher: 'pending' } : {}),
    ...(process.platform === 'darwin' ? { upgrade: 'pending' } : {})
  }
}, null, 2));
