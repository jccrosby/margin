import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checkPackage = fileURLToPath(new URL('../scripts/check-package.js', import.meta.url));

test('the release check blocks archives outside the macOS release scope', t => {
  const work = mkdtempSync(join(tmpdir(), 'margin-release-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'package'));

  for (const overrides of [
    { os: undefined },
    { os: ['darwin', 'linux'] },
    { os: ['!win32'] },
    { cpu: ['arm64', 'x64'] },
    { private: true }
  ]) {
    const tarball = join(work, 'margin.tgz');
    const manifest = { os: ['darwin'], cpu: ['arm64'], ...overrides };
    writeFileSync(join(work, 'package', 'package.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', tarball, '-C', work, 'package/package.json']);
    const result = spawnSync(process.execPath, [checkPackage, tarball], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.error?.message);
    assert.match(result.stderr, overrides.private ? /Release blocked\..*local testing/ :
      /Release blocked\..*macOS on Apple silicon/);
  }
});
