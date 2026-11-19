import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/margin.ts', import.meta.url));

function setup(t) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'margin-test-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const checkout = join(work, 'checkout');
  const notes = join(work, 'notes');
  const registry = join(work, 'private', 'projects.json');
  mkdirSync(checkout);
  mkdirSync(notes);
  const git = (...args) => run(checkout, 'git', ...args);
  git('init', '--quiet');
  const cli = (...args) => run(work, process.execPath, entry, '--registry', registry, ...args);
  return { work, checkout, notes, registry, git, cli };
}

function run(cwd, command, ...args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

async function connect(t, { work, registry }) {
  const child = spawn(process.execPath, [entry, '--registry', registry, 'serve'], { cwd: work });
  const messages = createInterface({ input: child.stdout });
  t.after(() => {
    messages.close();
    child.kill();
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const receive = messages[Symbol.asyncIterator]();
  let sequence = 0;
  async function request(method, params) {
    const id = ++sequence;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const { value } = await receive.next();
    assert.ok(value, stderr || 'Server closed without replying');
    const message = JSON.parse(value);
    assert.equal(message.id, id);
    assert.ok(!message.error, JSON.stringify(message.error));
    return message.result;
  }
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' }
  });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return {
    listTools: () => request('tools/list'),
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      return result.structuredContent;
    }
  };
}

test('the CLI registers roots and the MCP server lists projects with live cursors', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'zeta', fixture.checkout, fixture.notes);
  const secondCheckout = join(fixture.work, 'second-checkout');
  mkdirSync(secondCheckout);
  run(secondCheckout, 'git', 'init', '--quiet');
  fixture.cli('register', 'alpha', secondCheckout, fixture.notes);
  const client = await connect(t, fixture);
  assert.deepEqual(await client.call('list_projects'), {
    projects: [{ projectId: 'alpha', name: 'alpha' }, { projectId: 'zeta', name: 'zeta' }]
  });
  const first = await client.call('list_projects', { limit: 1 });
  fixture.cli('register', 'beta', secondCheckout, fixture.notes);
  assert.deepEqual(first.projects, [{ projectId: 'alpha', name: 'alpha' }]);
  assert.deepEqual(await client.call('list_projects', { cursor: first.nextCursor }), {
    projects: [{ projectId: 'beta', name: 'beta' }, { projectId: 'zeta', name: 'zeta' }]
  });
  assert.deepEqual(await client.call('list_projects', { limit: 0 }), { error: 'invalid_argument' });
});

test('inventory applies Git, format, and path rules on each live page', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const put = (root, path, text = 'fixture\n') => writeFileSync(join(root, path), text);
  put(fixture.checkout, '.gitignore', 'ignored*.ts\n');
  put(fixture.checkout, 'ignored-tracked.ts');
  put(fixture.checkout, '.env');
  fixture.git('add', '-f', 'ignored-tracked.ts', '.env');
  put(fixture.checkout, 'ignored-untracked.ts');
  put(fixture.checkout, 'README.md');
  put(fixture.checkout, '.env.example');
  put(fixture.checkout, 'unsupported.pdf');
  put(fixture.notes, 'README.md');
  put(fixture.notes, 'id_ed25519');
  mkdirSync(join(fixture.notes, 'dist'));
  put(fixture.notes, 'dist/hidden.md');
  symlinkSync(join(fixture.notes, 'README.md'), join(fixture.checkout, 'linked.md'));
  symlinkSync(join(fixture.notes, 'dist'), join(fixture.notes, 'linked-directory'));
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('register', 'beta', fixture.checkout, fixture.notes);
  const client = await connect(t, fixture);
  const first = await client.call('list_sources', { projectId: 'alpha', limit: 1 });
  assert.deepEqual(first.sources.map(source => [source.rootId, source.relativePath]), [['code', '.env.example']]);
  put(fixture.checkout, 'Zeta.ts');
  const second = await client.call('list_sources', { projectId: 'alpha', cursor: first.nextCursor });
  assert.deepEqual(second.sources.map(source => [source.rootId, source.relativePath]), [
    ['code', '.gitignore'], ['code', 'README.md'], ['code', 'Zeta.ts'], ['code', 'ignored-tracked.ts'],
    ['notes', 'README.md']
  ]);
  assert.notEqual(second.sources[1].sourceId, second.sources[4].sourceId);
  assert.deepEqual(await client.call('list_sources', { projectId: 'beta', cursor: first.nextCursor }),
    { error: 'invalid_argument' });
  assert.deepEqual(await client.call('list_projects', { cursor: first.nextCursor }),
    { error: 'invalid_argument' });
  assert.deepEqual(await client.call('list_sources', { projectId: 'constructor' }),
    { error: 'project_unavailable' });
  rmSync(fixture.checkout, { recursive: true });
  const remaining = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(remaining.sources, [second.sources[4]]);
  assert.deepEqual(remaining.warnings, [{ rootId: 'code', error: 'root_unavailable' }]);
});

test('reads live whole lines from both roots and rejects references outside them', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const player = join(fixture.checkout, 'player.ts');
  const requirement = join(fixture.notes, 'requirement.md');
  writeFileSync(player, 'const preview = true;\r\nexport { preview };\n');
  writeFileSync(requirement, 'Viewers may watch a preview.\nRead the full plan.\n');
  writeFileSync(join(fixture.work, 'outside.md'), 'Private data\n');
  const filesBefore = readdirSync(fixture.checkout, { recursive: true }).sort();
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('register', 'beta', fixture.checkout, fixture.notes);
  const client = await connect(t, fixture);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['list_projects', 'list_sources', 'read_source']);
  const { sources: [code, note] } = await client.call('list_sources', { projectId: 'alpha' });
  const read = (sourceId, range = {}, projectId = 'alpha') =>
    client.call('read_source', { projectId, sourceId, ...range });
  const sourceId = (rootId, path) => Buffer.from(JSON.stringify(['alpha', rootId, path])).toString('base64url');
  const unavailable = { error: 'source_unavailable' };
  assert.deepEqual(await read(code.sourceId, { lineCount: 1 }), {
    ...code, startLine: 1, endLine: 1, nextStartLine: 2, text: 'const preview = true;\r\n'
  });
  assert.deepEqual(await read(note.sourceId, { startLine: 2 }), {
    ...note, startLine: 2, endLine: 2, text: 'Read the full plan.\n'
  });
  assert.deepEqual(await read(note.sourceId, { startLine: 3 }), { ...note, text: '' });
  assert.deepEqual(await read(note.sourceId, { startLine: 2, lineCount: 1 }), {
    ...note, startLine: 2, endLine: 2, text: 'Read the full plan.\n'
  });
  assert.deepEqual(await read(note.sourceId, { lineCount: 501 }), { error: 'invalid_argument' });
  assert.deepEqual(await read(note.sourceId, { startLine: 0 }), { error: 'invalid_argument' });
  assert.deepEqual(await read(note.sourceId, {}, 'beta'), unavailable);
  assert.deepEqual(await read(sourceId('code', '../outside.md')), unavailable);
  assert.deepEqual(await read(sourceId('code', join(fixture.work, 'outside.md'))), unavailable);
  assert.deepEqual(await read('malformed'), unavailable);
  assert.deepEqual(readdirSync(fixture.checkout, { recursive: true }).sort(), filesBefore);

  const capLine = 'é'.repeat(16383) + '\r\n';
  writeFileSync(player, capLine + 'next');
  const bounded = await read(code.sourceId);
  assert.equal(Buffer.byteLength(bounded.text), 32768);
  assert.deepEqual(bounded, { ...code, startLine: 1, endLine: 1, nextStartLine: 2, text: capLine });
  assert.deepEqual(await read(code.sourceId, { startLine: 2 }), {
    ...code, startLine: 2, endLine: 2, text: 'next'
  });
  writeFileSync(player, capLine + 'x'.repeat(32769));
  assert.deepEqual(await read(code.sourceId, { startLine: 2 }), { error: 'line_too_long' });
  assert.deepEqual(await read(code.sourceId, { startLine: 3 }), { ...code, text: '' });

  symlinkSync(fixture.work, join(fixture.notes, 'link'));
  assert.deepEqual(await read(sourceId('notes', 'link/outside.md')), unavailable);
  writeFileSync(join(fixture.notes, '.env'), 'Password fixture\n');
  assert.deepEqual(await read(sourceId('notes', '.env')), unavailable);
  writeFileSync(join(fixture.checkout, '.gitignore'), 'player.ts\n');
  assert.deepEqual(await read(code.sourceId), unavailable);
  rmSync(requirement);
  assert.deepEqual(await read(note.sourceId), unavailable);
  const relocated = join(fixture.work, 'relocated');
  renameSync(fixture.notes, relocated);
  symlinkSync(relocated, fixture.notes);
  assert.deepEqual(await read(note.sourceId), { error: 'root_unavailable' });
  rmSync(fixture.notes);
  writeFileSync(join(relocated, 'requirement.md'), 'Revised.\n');
  fixture.cli('register', 'alpha', fixture.checkout, relocated);
  assert.deepEqual(await read(note.sourceId), { ...note, startLine: 1, endLine: 1, text: 'Revised.\n' });
});

test('register rejects registry paths inside a checkout, including case aliases', t => {
  const fixture = setup(t);
  const alias = join(fixture.work, 'CHECKOUT');
  const candidateRoots = existsSync(alias) ? [fixture.checkout, alias] : [fixture.checkout];
  for (const checkout of candidateRoots) {
    const registry = join(checkout, 'private', 'projects.json');
    const result = spawnSync(process.execPath, [
      entry, '--registry', registry, 'register', 'alpha', fixture.checkout, fixture.notes
    ], { cwd: fixture.work, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout || result.stderr);
    assert.match(result.stderr, /Put the registry outside the source roots/);
    assert.equal(existsSync(join(fixture.checkout, 'private')), false);
  }
});

test('reads a source whose Git path uses a different Unicode form', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const diskName = 'cafe\u0301.ts';
  const gitName = 'caf\u00e9.ts';
  writeFileSync(join(fixture.checkout, diskName), 'export const fixture = true;\n');
  fixture.git('config', 'core.precomposeUnicode', 'true');
  if (!existsSync(join(fixture.checkout, gitName)) ||
      fixture.git('ls-files', '-z', '--others') !== gitName + '\0' ||
      !readdirSync(fixture.checkout).includes(diskName)) {
    t.skip('Git and the filesystem use the same Unicode form.');
    return;
  }
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  const client = await connect(t, fixture);
  const { sources: [source] } = await client.call('list_sources', { projectId: 'alpha' });
  assert.equal(source?.relativePath, gitName);
  assert.deepEqual(await client.call('read_source', { projectId: 'alpha', sourceId: source.sourceId }), {
    ...source, startLine: 1, endLine: 1, text: 'export const fixture = true;\n'
  });
});
