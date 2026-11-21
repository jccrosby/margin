import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checkPackage = fileURLToPath(new URL('../scripts/check-package.js', import.meta.url));

test('the release check blocks archives that admit another platform', t => {
  const work = mkdtempSync(join(tmpdir(), 'margin-release-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'package'));

  for (const os of [undefined, ['darwin', 'linux'], ['!win32']]) {
    const tarball = join(work, 'margin.tgz');
    writeFileSync(join(work, 'package', 'package.json'), JSON.stringify({ os }));
    execFileSync('tar', ['-czf', tarball, '-C', work, 'package/package.json']);
    const result = spawnSync(process.execPath, [checkPackage, tarball], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.error?.message);
    assert.match(result.stderr, /Release blocked\..*qualify the same tarball/);
  }
});
