import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const qualify = fileURLToPath(new URL('../scripts/qualify-candidate.js', import.meta.url));
const commit = '0123456789abcdef0123456789abcdef01234567';

test('qualification refuses an archive when its hash differs from the candidate record', t => {
  const work = mkdtempSync(join(tmpdir(), 'margin-qualify-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const tarball = join(work, 'margin.tgz');
  writeFileSync(tarball, 'Different candidate.');
  const result = spawnSync(process.execPath, [qualify, tarball, commit, '0'.repeat(64)], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /Candidate SHA-256 does not match/);
  assert.equal(result.stdout, '');
});

test('qualification refuses a candidate that lacks a native addon', t => {
  const work = mkdtempSync(join(tmpdir(), 'margin-qualify-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'package', 'dist'), { recursive: true });
  writeFileSync(join(work, 'package', 'package.json'), '{"name":"@jccrosby/margin"}');
  for (const addon of ['macos', 'windows']) {
    writeFileSync(join(work, 'package', 'dist', addon + '.node'), 'Synthetic addon.');
  }
  const tarball = join(work, 'margin.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', work, 'package']);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const result = spawnSync(process.execPath, [qualify, tarball, commit, sha256], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /Candidate is missing package\/dist\/linux\.node/);
  assert.equal(result.stdout, '');
});
