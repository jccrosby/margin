import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/margin.ts', import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(process.env.LOCALAPPDATA || tmpdir(), 'Margin é tests '));
  t.after(() => rmSync(home, { force: true, recursive: true }));
  const checkout = join(home, 'Project café');
  const registry = join(home, 'Private registry', 'projects.json');
  mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  function cli(...args) {
    return spawnSync(process.execPath, [entry, '--registry', registry, ...args], { encoding: 'utf8' });
  }
  function run(...args) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  }
  return { home, checkout, registry, cli, run };
}

async function connect(t, registry) {
  const server = spawn(process.execPath, [entry, '--registry', registry, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: server.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let stderr = '';
  server.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    lines.close();
    if (server.exitCode === null) {
      const closed = once(server, 'exit');
      server.kill();
      await closed;
    }
  });
  let sequence = 0;
  async function request(method, params) {
    const id = ++sequence;
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const { value } = await replies.next();
    assert.ok(value, stderr);
    const response = JSON.parse(value);
    assert.equal(response.id, id);
    assert.ok(!response.error, value);
    return response.result.structuredContent ?? response.result;
  }
  await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'windows-test', version: '1' }
  });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return (name, args) => request('tools/call', { name, arguments: args });
}

const windows = { skip: process.platform !== 'win32', timeout: 30000 };

test('Windows CLI rejects unsupported path syntax and names it', windows, t => {
  const { cli } = fixture(t);
  const paths = ['C:relative', '\\\\?\\C:\\device', '\\\\.\\C:\\device', 'C:\\checkout:stream', '\\\\localhost\\share'];
  for (const path of paths) {
    const result = cli('register', 'project', path);
    assert.equal(result.status, 1, result.error?.message);
    assert.ok(result.stderr.includes(path), result.stderr);
    assert.match(result.stderr, /local NTFS/);
  }
});

test('Windows uses verified files for discovery, reads, search, and citations', windows, async t => {
  const { home, checkout, registry, run } = fixture(t);
  const text = 'Margin checks the citation.\nDistinct second line.\n';
  const name = 'Réponse.md';
  writeFileSync(join(checkout, name), text);
  const alias = join(home, 'Checkout alias');
  symlinkSync(checkout, alias, 'junction');
  run('register', 'project', alias);
  run('refresh', 'project');
  const call = await connect(t, registry);
  const projectId = 'project';
  const listed = await call('list_sources', { projectId });
  const { sourceId } = listed.sources.find(source => source.relativePath === name);
  const read = await call('read_source', { projectId, sourceId, startLine: 2, lineCount: 1 });
  assert.equal(read.text, 'Distinct second line.\n');

  const search = mode => call('search_project', { projectId, query: 'Margin checks', mode });
  const [hit] = (await search('ranked')).hits;
  assert.equal(hit.sourceId, sourceId);
  assert.equal((await search('literal')).hits[0].sourceId, sourceId);
  const citation = { projectId, sourceId, contentHash: hit.contentHash,
    location: { startLine: hit.startLine, endLine: hit.endLine } };

  linkSync(join(checkout, name), join(home, 'Other name.md'));
  assert.equal((await call('read_source', { projectId, sourceId })).error, 'source_unavailable');
  assert.deepEqual((await search('ranked')).hits, []);
  rmSync(join(home, 'Other name.md'));

  const moved = join(home, 'Emplacement déplacé');
  renameSync(checkout, moved);
  symlinkSync(moved, checkout, 'junction');
  assert.equal((await call('read_source', { projectId, sourceId })).error, 'root_unavailable');
  rmSync(alias);
  symlinkSync(moved, alias, 'junction');
  run('register', projectId, alias);
  assert.equal((await call('open_evidence', citation)).text, text);
  writeFileSync(join(moved, name), 'Changed content.\n');
  assert.equal((await call('open_evidence', citation)).error, 'stale_citation');
});

test('Windows refuses a registry with an unrelated access grant', windows, t => {
  const { checkout, registry, run, cli } = fixture(t);
  run('register', 'project', checkout);
  const contents = readFileSync(registry);
  execFileSync('icacls.exe', [registry, '/grant', '*S-1-1-0:(R)']);
  const result = cli('refresh', 'project');
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /registry_unavailable/);
  assert.match(result.stderr, /local NTFS/);
  assert.deepEqual(readFileSync(registry), contents);
});
