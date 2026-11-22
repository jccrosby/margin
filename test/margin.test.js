import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, toNamespacedPath } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
const linuxTest = linux ? test : test.skip;
const macTest = process.platform === 'darwin' ? test : test.skip;
const windowsTest = windows ? test : test.skip;
const commandTimeout = 15_000;

function linkDirectory(target, path) {
  symlinkSync(target, path, windows ? 'junction' : 'dir');
}

const entry = fileURLToPath(new URL('../src/margin.ts', import.meta.url));
const fixtures = new Set();
after(() => {
  for (const path of fixtures) {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function setup(t, prefix = 'margin-test-') {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => { fixtures.add(work); });
  const checkout = join(work, 'checkout');
  const notes = join(work, 'notes');
  const registry = join(work, 'private', 'projects.json');
  mkdirSync(checkout);
  mkdirSync(notes);
  const git = (...args) => run(checkout, 'git', ...args);
  git('init', '--quiet');
  if (windows) git('config', 'core.autocrlf', 'false');
  const cli = (...args) => run(work, process.execPath, entry, '--registry', registry, ...args);
  return { work, checkout, notes, registry, git, cli };
}

function run(cwd, command, ...args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: commandTimeout, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function stop(child, signal = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  const exited = once(child, 'exit');
  child.kill(signal);
  return exited;
}

async function connect(t, { work, registry, env = process.env, nodeArgs = [] }) {
  const child = spawn(process.execPath, [...nodeArgs, entry, '--registry', registry, 'serve'], { cwd: work, env });
  const messages = createInterface({ input: child.stdout });
  t.after(() => {
    messages.close();
    return stop(child);
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const receive = messages[Symbol.asyncIterator]();
  let sequence = 0;
  function send(method, params) {
    const id = ++sequence;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  }
  async function request(method, params) {
    const id = send(method, params);
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
    sendCall: (name, args) => send('tools/call', { name, arguments: args }),
    async stop(signal = 'SIGTERM') {
      return stop(child, signal);
    },
    callResult: (name, args) => request('tools/call', { name, arguments: args }),
    listTools: () => request('tools/list'),
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      return result.structuredContent;
    }
  };
}

test('the CLI reports the supported platforms when Node uses another architecture', t => {
  const fixture = setup(t);
  const unsupported = process.arch === 'arm64' ? 'x64' : 'arm64';
  const spoof = `Object.defineProperty(process, 'arch', { value: '${unsupported}' });`;
  const result = spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(spoof)}`, entry, '--registry', fixture.registry, 'serve'],
    { cwd: fixture.work, encoding: 'utf8', timeout: commandTimeout });
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /Run Margin on macOS ARM64, Windows x64, or Ubuntu x64/);
});

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
  put(fixture.checkout, 'unsupported.zip');
  put(fixture.notes, 'README.md');
  put(fixture.notes, 'id_ed25519');
  mkdirSync(join(fixture.notes, 'dist'));
  put(fixture.notes, 'dist/hidden.md');
  if (!windows) symlinkSync(join(fixture.notes, 'README.md'), join(fixture.checkout, 'linked.md'));
  linkDirectory(join(fixture.notes, 'dist'), join(fixture.notes, 'linked-directory'));
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
  assert.deepEqual(tools.map(tool => tool.name), ['list_projects', 'list_sources', 'read_source', 'search_project', 'open_evidence',
    'save_project_note']);
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
  if (windows) {
    assert.deepEqual(await read(sourceId('code', 'folder\\outside.md')), unavailable);
    assert.deepEqual(await read(sourceId('code', 'player.ts:stream.md')), unavailable);
  }
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

  linkDirectory(fixture.work, join(fixture.notes, 'link'));
  assert.deepEqual(await read(sourceId('notes', 'link/outside.md')), unavailable);
  writeFileSync(join(fixture.notes, '.env'), 'Password fixture\n');
  assert.deepEqual(await read(sourceId('notes', '.env')), unavailable);
  writeFileSync(join(fixture.checkout, '.gitignore'), 'player.ts\n');
  assert.deepEqual(await read(code.sourceId), unavailable);
  rmSync(requirement);
  assert.deepEqual(await read(note.sourceId), unavailable);
  const relocated = join(fixture.work, 'relocated');
  renameSync(fixture.notes, relocated);
  linkDirectory(relocated, fixture.notes);
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

macTest('reads a source whose Git path uses a different Unicode form', { timeout: 10000 }, async t => {
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

test('refresh indexes ranked passages and case-sensitive literal matches for one project', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  mkdirSync(join(fixture.checkout, 'src'));
  mkdirSync(join(fixture.checkout, 'nested', 'src'), { recursive: true });
  const player = 'export function checkEntitlement() { throw Error("ERR_ACCESS: expired"); }\n';
  writeFileSync(join(fixture.checkout, 'src', 'player.ts'), '// line\n'.repeat(40) + player + '// line\n'.repeat(40));
  writeFileSync(join(fixture.checkout, 'nested', 'src', 'player.ts'), 'Other file\n');
  writeFileSync(join(fixture.checkout, 'reference.txt'), 'See src/player.ts.\n');
  writeFileSync(join(fixture.notes, 'requirements.md'), 'Anonymous viewers can watch a playback preview.\n');
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const search = (query, mode) => client.call('search_project', { projectId: 'alpha', query, mode });
  const { hits: [code] } = await search('checkEntitlement', 'literal');
  assert.equal(code.relativePath, 'src/player.ts');
  assert.equal(code.startLine, 41);
  assert.equal(code.endLine, 80);
  assert.ok(code.text.startsWith(player));
  assert.equal(code.matchedOn, 'text');
  const { hits: [notes] } = await search('PLAYBACK: anonymous preview');
  assert.deepEqual([notes.rootId, notes.relativePath, notes.startLine, notes.endLine, notes.text], [
    'notes', 'requirements.md', 1, 1, 'Anonymous viewers can watch a playback preview.\n'
  ]);
  assert.equal((await search('anonymous OR preview')).hits.length, 0);
  assert.equal((await search('!!!')).hits.length, 0);
  assert.equal((await search('ERR_ACCESS: expired', 'literal')).hits.length, 1);
  assert.equal((await search('err_access: expired', 'literal')).hits.length, 0);
  assert.equal((await search('ERR_ACCESS expired', 'literal')).hits.length, 0);
  const { hits: [exact, partial, reference] } = await search('src/player.ts', 'literal');
  assert.deepEqual([exact.relativePath, partial.relativePath, reference.relativePath],
    ['src/player.ts', 'nested/src/player.ts', 'reference.txt']);
  assert.deepEqual(Object.keys(exact).sort(), ['matchedOn', 'relativePath', 'rootId', 'sourceId']);
});

test('search isolates ranking and orders tied passages by path and line', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  const other = join(fixture.work, 'other');
  mkdirSync(other);
  run(other, 'git', 'init', '--quiet');
  const code = 'ordinary line\n'.repeat(32) + 'sharedterm\n' + 'ordinary line\n'.repeat(39) + 'last\n';
  writeFileSync(join(fixture.checkout, 'Beta.ts'), code);
  writeFileSync(join(fixture.checkout, 'alpha.ts'), code);
  writeFileSync(join(fixture.checkout, 'A.txt'), 'firstword\n'.repeat(39) + 'boundary\nsecond');
  writeFileSync(join(other, 'Beta.ts'), 'sharedterm otherproject\n');
  writeFileSync(join(other, 'another.txt'), 'sharedterm\n'.repeat(100));
  writeFileSync(join(fixture.checkout, 'front.txt'), 'rare rare rare rare backup');
  writeFileSync(join(fixture.checkout, 'second.txt'), 'rare backup backup backup backup');
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(fixture.checkout, `backup-${i}.txt`), 'backup');
    writeFileSync(join(other, `rare-${i}.txt`), 'rare');
  }
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('register', 'beta', other);
  const client = await connect(t, fixture);
  const search = (projectId, query = 'sharedterm', mode) => client.call('search_project', { projectId, query, mode });

  assert.equal((await search('alpha')).coverage.roots[0].status, 'not_refreshed');
  fixture.cli('refresh', 'alpha');
  const before = await search('alpha');
  assert.equal(before.coverage.complete, true);
  assert.deepEqual(before.hits.map(hit => [hit.relativePath, hit.startLine, hit.endLine]),
    [['Beta.ts', 1, 40], ['Beta.ts', 33, 72], ['alpha.ts', 1, 40], ['alpha.ts', 33, 72]]);
  const ranked = await search('alpha', 'rare backup');
  assert.deepEqual(ranked.hits.map(hit => hit.relativePath), ['front.txt', 'second.txt']);
  fixture.cli('refresh', 'beta');
  assert.deepEqual(await search('alpha'), before);
  assert.deepEqual(await search('alpha', 'rare backup'), ranked);
  assert.deepEqual((await search('beta', 'Beta.ts', 'literal')).hits.map(hit => [hit.relativePath, hit.matchedOn]),
    [['Beta.ts', 'path']]);
  assert.notEqual((await search('beta')).hits[0].sourceId, before.hits[0].sourceId);
  const { hits: [crossing] } = await search('alpha', 'boundary\nsecond', 'literal');
  assert.deepEqual([crossing.startLine, crossing.endLine, crossing.text], [40, 41, 'boundary\nsecond']);
});

test('ranked passages stop at 32 KiB and preserve whole UTF-8 lines', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const fullLine = 'é'.repeat(16381) + ' end\r\n';
  assert.equal(Buffer.byteLength(fullLine), 32768);
  writeFileSync(join(fixture.checkout, 'cap.txt'), fullLine + 'laterword\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const search = query => client.call('search_project', { projectId: 'alpha', query });
  const { hits: [first] } = await search('end');
  assert.deepEqual([first.startLine, first.endLine, first.text], [1, 1, fullLine]);
  const { hits: [second] } = await search('laterword');
  assert.deepEqual([second.startLine, second.endLine, second.text], [2, 2, 'laterword\n']);
});

test('search suppresses stale evidence after edits, Git switches, renames, and deletions', { timeout: 20000 }, async t => {
  const fixture = setup(t);
  const path = join(fixture.checkout, 'player.ts');
  const notes = join(fixture.notes, 'requirements.md');
  const original = 'export const fixtureToken = true;\n';
  const commit = title => fixture.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-gpg-sign', '--quiet', '-m', title);
  writeFileSync(path, original);
  writeFileSync(notes, 'fixtureToken\n');
  fixture.git('add', 'player.ts');
  commit('original fixture');
  const firstBranch = fixture.git('branch', '--show-current').trim();
  fixture.git('switch', '-c', 'alternate');
  writeFileSync(path, '// shift\n' + original);
  fixture.git('add', 'player.ts');
  commit('shift the match');
  fixture.git('switch', firstBranch);
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const search = (query = 'fixtureToken', mode = 'literal') =>
    client.call('search_project', { projectId: 'alpha', query, mode });
  const { hits: [oldCode] } = await search();
  assert.equal(oldCode.startLine, 1);
  fixture.git('switch', 'alternate');
  let result = await search();
  assert.deepEqual(result.hits.map(hit => hit.rootId), ['notes']);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.roots[0].gaps.some(gap => gap.error === 'source_changed'));
  assert.equal((await client.call('read_source', { projectId: 'alpha', sourceId: oldCode.sourceId })).text,
    '// shift\n' + original);
  fixture.git('switch', firstBranch);
  writeFileSync(path, original + '// unrelated edit\n');
  assert.deepEqual((await search()).hits.map(hit => hit.rootId), ['notes']);
  const moved = join(fixture.checkout, 'moved.ts');
  renameSync(path, moved);
  rmSync(notes);
  result = await search();
  assert.equal(result.hits.length, 0);
  assert.equal(result.coverage.complete, false);
  fixture.cli('refresh', 'alpha');
  const { hits: [newCode] } = await search('fixtureToken', 'ranked');
  assert.equal(newCode.relativePath, 'moved.ts');
  assert.notEqual(newCode.sourceId, oldCode.sourceId);
  rmSync(fixture.checkout, { recursive: true });
  const listing = await client.call('list_sources', { projectId: 'alpha' });
  assert.equal(listing.coverage.complete, false);
  assert.deepEqual(listing.warnings, [{ rootId: 'code', error: 'root_unavailable' }]);
  assert.equal((await search()).hits.length, 0);
});

function refreshWithEnv(fixture, env) {
  return spawnSync(process.execPath, [entry, '--registry', fixture.registry, 'refresh', 'alpha'],
    { cwd: fixture.work, env, encoding: 'utf8' });
}

function shellQuote(text) {
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

function gitShim(fixture, failure) {
  const bin = join(fixture.work, 'bin');
  const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh
listing=
for arg do
  case "$arg" in
    ls-files) listing=1 ;;
    --) listing= ;;
  esac
done
if [ -n "$listing" ]; then
  ${failure}
fi
exec ${shellQuote(git)} "$@"
`, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test('partial refresh retains an unreadable source and publishes other changes', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  const retained = join(fixture.checkout, 'retained.ts');
  const other = join(fixture.checkout, 'other.ts');
  writeFileSync(retained, 'retainedWord\n');
  writeFileSync(other, 'oldWord\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  writeFileSync(retained, Buffer.from([0xc3]));
  writeFileSync(other, 'newWord\n');
  const refresh = refreshWithEnv(fixture, process.env);
  assert.equal(refresh.status, 1, refresh.stderr);
  assert.equal(JSON.parse(refresh.stdout).roots[0].status, 'partial');
  const client = await connect(t, fixture);
  const search = query => client.call('search_project', { projectId: 'alpha', query });
  const partial = await search('retainedWord');
  assert.equal(partial.hits.length, 0);
  assert.deepEqual(partial.coverage.roots[0].gaps, [{ error: 'source_unavailable', relativePath: 'retained.ts' }]);
  assert.equal((await search('oldWord')).hits.length, 0);
  assert.equal((await search('newWord')).hits.length, 1);
  writeFileSync(retained, 'retainedWord\n');
  assert.equal((await search('retainedWord')).hits.length, 1);
  fixture.cli('refresh', 'alpha');
  const recovered = await search('retainedWord');
  assert.equal(recovered.coverage.complete, true);
  assert.equal(recovered.hits.length, 1);
});

macTest('a failed root scan preserves that root index while another root publishes', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.checkout, 'code.ts'), 'fixtureWord\n');
  writeFileSync(join(fixture.notes, 'notes.md'), 'oldNote\n');
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('refresh', 'alpha');
  const env = gitShim(fixture, "printf 'code.ts\\000'; echo 'partial inventory' >&2; exit 0");
  writeFileSync(join(fixture.checkout, 'new.ts'), 'fixtureWord\n');
  writeFileSync(join(fixture.notes, 'notes.md'), 'newNote\n');
  const refresh = refreshWithEnv(fixture, env);
  assert.equal(refresh.status, 1, refresh.stderr);
  assert.deepEqual(JSON.parse(refresh.stdout).roots.map(root => root.status), ['failed', 'complete']);
  const client = await connect(t, { ...fixture, env });
  const search = query => client.call('search_project', { projectId: 'alpha', query });
  const result = await search('fixtureWord');
  assert.deepEqual(result.hits.map(hit => hit.relativePath), ['code.ts']);
  assert.deepEqual(result.coverage.roots[0].gaps, [{ error: 'root_scan_failed' }]);
  assert.equal((await search('newNote')).hits.length, 1);
  assert.equal((await search('oldNote')).hits.length, 0);
  const listing = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(listing.warnings, [{ rootId: 'code', error: 'root_scan_failed' }]);
});

macTest('an interrupted refresh keeps the last committed index and retry replaces it once', { timeout: 20000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.checkout, 'keep.ts'), 'fixtureWord\n');
  const removed = join(fixture.checkout, 'remove.ts');
  writeFileSync(removed, 'removedWord\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  rmSync(removed);
  writeFileSync(join(fixture.checkout, 'new.ts'), 'fixtureWord\n');
  const ready = join(fixture.work, 'refresh-ready');
  const env = gitShim(fixture, `touch ${shellQuote(ready)}; kill -STOP "$PPID"`);
  const child = spawn(process.execPath, [entry, '--registry', fixture.registry, 'refresh', 'alpha'],
    { cwd: fixture.work, env, stdio: 'ignore' });
  t.after(() => stop(child));
  const exited = once(child, 'exit');
  for (let attempt = 0; !existsSync(ready) && attempt < 100; attempt++) await delay(25);
  assert.equal(existsSync(ready), true);
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  const client = await connect(t, fixture);
  const search = query => client.call('search_project', { projectId: 'alpha', query });
  const interrupted = await search('fixtureWord');
  assert.deepEqual(interrupted.hits.map(hit => hit.relativePath), ['keep.ts']);
  assert.ok(interrupted.coverage.roots[0].gaps.some(gap => gap.error === 'refresh_unfinished'));
  fixture.cli('refresh', 'alpha');
  fixture.cli('refresh', 'alpha');
  const recovered = await search('fixtureWord');
  assert.equal(recovered.coverage.complete, true);
  assert.deepEqual(recovered.hits.map(hit => hit.relativePath), ['keep.ts', 'new.ts']);
  writeFileSync(removed, 'removedWord\n');
  assert.equal((await search('removedWord')).hits.length, 0);
});

test('a literal citation must include the complete match', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const longLine = 'x'.repeat(20000) + ' first\n';
  const nextLine = 'second ' + 'y'.repeat(20000) + '\n';
  writeFileSync(join(fixture.checkout, 'large.ts'), longLine + nextLine);
  writeFileSync(join(fixture.checkout, 'small.ts'), 'first\nsecond\n');
  writeFileSync(join(fixture.checkout, 'overlap.ts'), 'first\nsecond\n' +
    'padding\n'.repeat(37) + 'first\nsecond\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const results = await client.call('search_project', {
    projectId: 'alpha', query: 'first\nsecond', mode: 'literal'
  });
  assert.deepEqual(results.hits.map(hit => [hit.relativePath, hit.startLine, hit.endLine]),
    [['overlap.ts', 1, 40], ['overlap.ts', 40, 41], ['small.ts', 1, 2]]);
  assert.ok(results.hits.every(hit => hit.text.includes('first\nsecond')));
  assert.equal(results.coverage.complete, false);
  assert.deepEqual(results.coverage.roots[0].gaps, [{ error: 'citation_unavailable', relativePath: 'large.ts' }]);
});

(windows ? test.skip : test)('readers see the last commit while a refresh spills pages and after it dies', { timeout: 25000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.checkout, 'keep.ts'), 'fixtureWord\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  writeFileSync(join(fixture.checkout, 'big.ts'), 'fixtureWord\n' + ('// ' + 'x'.repeat(1000) + '\n').repeat(1200));
  const before = readdirSync(fixture.checkout, { recursive: true }).sort();
  const ready = join(fixture.work, 'staged');
  const preloader = join(fixture.work, 'pause.mjs');
  writeFileSync(preloader, `import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE') execute.call(this, 'PRAGMA cache_size = 1; PRAGMA cache_spill = 1');
  if (sql === 'COMMIT') {
    writeFileSync(${JSON.stringify(ready)}, '');
    process.kill(process.pid, 'SIGSTOP');
  }
  return execute.call(this, sql);
};
`);
  const child = spawn(process.execPath, ['--import', preloader, entry, '--registry', fixture.registry, 'refresh', 'alpha'],
    { cwd: fixture.work, stdio: 'ignore' });
  t.after(() => stop(child));
  const exited = once(child, 'exit');
  for (let attempt = 0; !existsSync(ready) && attempt < 160; attempt++) await delay(25);
  assert.equal(existsSync(ready), true);
  const client = await connect(t, fixture);
  const search = () => client.call('search_project', { projectId: 'alpha', query: 'fixtureWord', mode: 'literal' });
  const during = await search();
  assert.deepEqual(during.hits?.map(hit => hit.relativePath), ['keep.ts'], JSON.stringify(during));
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(await search(), during);
  assert.ok(during.coverage.roots[0].gaps.some(gap => gap.error === 'refresh_unfinished'));
  const privateDir = dirname(fixture.registry);
  const sidecars = readdirSync(privateDir).filter(name => /\.sqlite-(shm|wal)$/.test(name));
  assert.equal(sidecars.length, 2);
  assert.ok(sidecars.every(name => (statSync(join(privateDir, name)).mode & 0o077) === 0));
  assert.ok(statSync(join(privateDir, sidecars.find(name => name.endsWith('-wal')))).size > 32768);
  assert.deepEqual(readdirSync(fixture.checkout, { recursive: true }).sort(), before);
  fixture.cli('refresh', 'alpha');
  assert.deepEqual((await search()).hits.map(hit => hit.relativePath), ['big.ts', 'keep.ts']);
});


macTest('opens a versioned physical PDF page and reports a saved citation stale after edit', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const pdf = join(fixture.checkout, 'reference.pdf');
  writeFileSync(pdf, 'synthetic PDF bytes');
  fixture.cli('register', 'demo', fixture.checkout);
  const env = fixtureDocling(fixture.work, {
    texts: [
      { label: 'text', text: 'The first physical page.', prov: [{ page_no: 1 }] },
      { label: 'text', text: 'Maple owls require a blue marker.', prov: [{ page_no: 2 }] },
      { label: 'text', text: 'An unplaced paragraph.' },
      { label: 'caption', text: 'Cited figure Unplaced figure', prov: [
        { page_no: 2, charspan: [0, 12] }, { page_no: 3 }
      ] }
    ]
  });
  const refresh = runWithEnv(fixture, env, 'refresh', 'demo');
  assert.equal(refresh.status, 1, refresh.stderr || refresh.stdout);
  const client = await connect(t, fixture);
  const { hits: [hit], coverage } = await client.call('search_project', { projectId: 'demo', query: 'maple owls' });
  assert.deepEqual(coverage.roots[0].gaps, [{ error: 'citation_unavailable', relativePath: 'reference.pdf' }]);
  const { hits: [caption] } = await client.call('search_project', { projectId: 'demo', query: 'figure' });
  assert.deepEqual([caption.kind, caption.location, caption.text],
    ['caption', { page: 2, item: 4 }, 'Cited figure']);
  assert.deepEqual((await client.call('search_project', { projectId: 'demo', query: 'unplaced' })).hits, []);
  assert.equal(hit.kind, 'extracted_text');
  assert.deepEqual(hit.location, { page: 2, item: 2 });
  assert.equal(hit.text, 'Maple owls require a blue marker.');
  assert.match(hit.contentHash, /^[a-f0-9]{64}$/);
  const saved = { projectId: 'demo', sourceId: hit.sourceId, contentHash: hit.contentHash, location: hit.location };
  assert.equal((await client.call('open_evidence', saved)).text, hit.text);
  writeFileSync(pdf, 'edited synthetic PDF bytes');
  assert.deepEqual(await client.call('open_evidence', saved), { error: 'stale_citation' });
  assert.deepEqual((await client.call('search_project', { projectId: 'demo', query: 'maple owls' })).hits, []);
});

function fixtureDocling(work, document, mode) {
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docling'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const directory = args[args.indexOf('--output') + 1];
const filename = path.parse(args.at(-1)).name;
const output = path.join(directory, filename + '.json');
fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(document))});
${mode === undefined ? '' : `fs.chmodSync(output, ${mode});`}
`, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

function runWithEnv({ work, registry, timeout = commandTimeout }, env, ...args) {
  const result = spawnSync(process.execPath, [entry, '--registry', registry, ...args], {
    cwd: work, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL'
  });
  assert.ifError(result.error);
  return result;
}

macTest('distinguishes repeated Word headings in a second Git checkout', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const second = join(fixture.work, 'another-checkout');
  mkdirSync(second);
  run(second, 'git', 'init', '--quiet');
  writeFileSync(join(second, 'rules.docx'), 'synthetic Word bytes');
  fixture.cli('register', 'demo', fixture.checkout);
  fixture.cli('add-checkout', 'demo', 'second', second);
  const env = fixtureDocling(fixture.work, {
    texts: [
      { label: 'section_header', text: 'Routing', level: 1 },
      { label: 'paragraph', text: 'Use the west gate.' },
      { label: 'section_header', text: 'Routing', level: 1 },
      { label: 'paragraph', text: 'Use the north gate.' }
    ]
  });
  const refresh = runWithEnv(fixture, env, 'refresh', 'demo');
  assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);
  const client = await connect(t, fixture);
  const { hits } = await client.call('search_project', { projectId: 'demo', query: 'gate', mode: 'literal' });
  assert.deepEqual(hits.map(hit => [hit.rootId, hit.location]), [
    ['second', { headingPath: ['Routing'], paragraph: 2 }],
    ['second', { headingPath: ['Routing'], paragraph: 4 }]
  ]);
  const { sourceId, contentHash, location } = hits[1];
  assert.equal((await client.call('open_evidence', { projectId: 'demo', sourceId, contentHash, location })).text,
    'Use the north gate.');
});

test('fetches approved redirects and stops before an unapproved target', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const requests = join(fixture.work, 'requests.log');
  const response = join(fixture.work, 'approved.txt');
  writeFileSync(response, 'A synthetic limit of seven.');
  const shim = join(fixture.work, 'fetch-fixture.mjs');
  const lineText = 'other\n'.repeat(39) + 'boundary-start\nboundary-end\n' + 'x'.repeat(32769) + 'overlong';
  writeFileSync(shim, `
import { appendFileSync, readFileSync } from 'node:fs';
globalThis.fetch = async (url, { redirect }) => {
  if (redirect !== 'manual') throw new Error('Fixture requires manual redirects.');
  appendFileSync(${JSON.stringify(requests)}, url + '\\n');
  const path = new URL(url).pathname;
  if (path === '/redirect') return Response.redirect('https://example.test/approved');
  if (path === '/blocked') return Response.redirect('https://example.test/private');
  if (path === '/lines') return new Response(${JSON.stringify(lineText)}, { headers: { 'content-type': 'text/plain' } });
  if (path === '/approved') return new Response(readFileSync(${JSON.stringify(response)}), {
    headers: { 'content-type': 'text/plain' }
  });
  throw new Error('Unexpected request.');
};
`);
  fixture.cli('register', 'demo', fixture.checkout);
  fixture.cli('register', 'other', fixture.checkout);
  fixture.cli('approve-url', 'other', 'https://example.test/private');
  for (const path of ['redirect', 'approved', 'blocked', 'lines']) {
    fixture.cli('approve-url', 'demo', `https://example.test/${path}`);
  }
  const started = new Date().toISOString();
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(shim)}` };
  const refresh = runWithEnv(fixture, env, 'refresh', 'demo');
  assert.equal(refresh.status, 1, refresh.stderr || refresh.stdout);
  assert.ok(JSON.parse(refresh.stdout).roots.flatMap(root => root.gaps)
    .some(gap => gap.error === 'redirect_not_approved' && gap.relativePath === 'https://example.test/blocked'));
  assert.deepEqual(readFileSync(requests, 'utf8').trim().split('\n').map(url => new URL(url).pathname),
    ['/redirect', '/approved', '/approved', '/blocked', '/lines']);
  const client = await connect(t, fixture);
  const { hits } = await client.call('search_project', { projectId: 'demo', query: 'synthetic limit' });
  const redirected = hits.find(hit => hit.approvedUrl === 'https://example.test/redirect');
  assert.equal(redirected.finalUrl, 'https://example.test/approved');
  assert.match(redirected.retrievedAt, /Z$/);
  assert.ok(redirected.retrievedAt >= started && redirected.retrievedAt <= new Date().toISOString());
  assert.equal(redirected.contentHash, createHash('sha256').update('A synthetic limit of seven.').digest('hex'));
  assert.equal(redirected.kind, 'extracted_text');
  const { sourceId, contentHash, location } = redirected;
  const open = projectId => client.call('open_evidence', { projectId, sourceId, contentHash, location });
  assert.equal((await open('demo')).text, 'A synthetic limit of seven.');
  assert.deepEqual(await open('other'), { error: 'source_unavailable' });
  const searchLiteral = query => client.call('search_project', { projectId: 'demo', query, mode: 'literal' });
  const { hits: [crossing] } = await searchLiteral('boundary-start\nboundary-end');
  assert.deepEqual(crossing.location, { startLine: 40, endLine: 41 });
  const reopened = await client.call('open_evidence', {
    projectId: 'demo', sourceId: crossing.sourceId, contentHash: crossing.contentHash, location: crossing.location
  });
  assert.equal(reopened.text, 'boundary-start\nboundary-end\n');
  const missing = await searchLiteral('overlong');
  assert.deepEqual(missing.hits, []);
  assert.ok(missing.coverage.roots.flatMap(root => root.gaps).some(gap =>
    gap.error === 'citation_unavailable' && gap.relativePath === 'https://example.test/lines'));

  writeFileSync(response, 'A synthetic limit of eight.');
  assert.equal(runWithEnv(fixture, env, 'refresh', 'demo').status, 1);
  assert.deepEqual(await open('demo'), { error: 'stale_citation' });
  const updated = await client.call('open_evidence', { projectId: 'demo', sourceId });
  assert.equal(updated.text, 'A synthetic limit of eight.');
  assert.notEqual(updated.contentHash, contentHash);
});

test('reports a missing Docling executable when opening a document', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.notes, 'reference.pdf'), 'synthetic PDF bytes');
  fixture.cli('register', 'demo', fixture.checkout, fixture.notes);
  const bin = join(fixture.work, 'empty-bin');
  mkdirSync(bin);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = bin;
  const refresh = runWithEnv(fixture, env, 'refresh', 'demo');
  assert.equal(refresh.status, 1, refresh.stderr || refresh.stdout);
  const gap = JSON.parse(refresh.stdout).roots.flatMap(root => root.gaps).find(gap => gap.relativePath === 'reference.pdf');
  assert.equal(gap?.error, 'docling_unavailable');
  assert.match(gap.detail, /Install Docling/);
  const client = await connect(t, fixture);
  const { sources } = await client.call('list_sources', { projectId: 'demo' });
  const { sourceId } = sources.find(source => source.relativePath === 'reference.pdf');
  const opened = await client.call('open_evidence', { projectId: 'demo', sourceId });
  assert.deepEqual(opened.failures, ['docling_unavailable']);
  assert.equal(opened.failureDetails.docling_unavailable, gap.detail);
});

test('opens real PDF, Word, and image evidence through Docling', {
  skip: process.env.MARGIN_TEST_EXTRACTORS !== '1',
  timeout: 300000
}, async t => {
  const fixture = setup(t, 'margin evidence é ');
  const documents = [
    ['shipping.pdf', 'copper latch', 'extracted_text', { page: 2, item: 2 }],
    ['dispatch.docx', 'violet stamp', 'extracted_text', { headingPath: ['Dispatch', 'Checklist'], paragraph: 5 }],
    ['marker.png', 'BLUE', 'ocr', { image: 1, item: 1 }]
  ];
  for (const [file] of documents) {
    copyFileSync(new URL(`./fixtures/evidence/${file}`, import.meta.url), join(fixture.checkout, file));
  }
  fixture.cli('register', 'demo', fixture.checkout);
  const refresh = runWithEnv({ ...fixture, timeout: 270000 }, process.env, 'refresh', 'demo');
  assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);
  assert.deepEqual(readdirSync(fixture.checkout).sort(), ['.git', 'dispatch.docx', 'marker.png', 'shipping.pdf']);
  assert.equal(readdirSync(dirname(fixture.registry)).some(name => name.startsWith('.margin-evidence-')), false);
  const client = await connect(t, fixture);
  for (const [file, query, kind, location] of documents) {
    const { hits } = await client.call('search_project', { projectId: 'demo', query, mode: 'literal' });
    assert.equal(hits.length, 1, `${file}: ${JSON.stringify(hits)}`);
    const [hit] = hits;
    assert.deepEqual([hit.relativePath, hit.kind, hit.location], [file, kind, location]);
    const { sourceId, contentHash } = hit;
    const citation = { projectId: 'demo', sourceId, contentHash, location };
    assert.equal((await client.call('open_evidence', citation)).text, hit.text);
    if (kind === 'ocr') {
      const { content } = await client.callResult('open_evidence', { projectId: 'demo', sourceId });
      assert.deepEqual(content[1], {
        type: 'image', mimeType: 'image/png', data: readFileSync(join(fixture.checkout, file)).toString('base64')
      });
    }
    writeFileSync(join(fixture.checkout, file), 'changed fixture bytes');
    assert.deepEqual(await client.call('open_evidence', citation), { error: 'stale_citation' });
  }
});

macTest('opens the original image when no OCR text can be extracted', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAFc9GgdAAAAAElFTkSuQmCC', 'base64');
  writeFileSync(join(fixture.checkout, 'diagram.png'), png);
  fixture.cli('register', 'demo', fixture.checkout);
  const refresh = runWithEnv(fixture, fixtureDocling(fixture.work, { texts: [] }), 'refresh', 'demo');
  assert.equal(refresh.status, 1, refresh.stderr || refresh.stdout);
  const client = await connect(t, fixture);
  const { hits: [hit], coverage } = await client.call('search_project', {
    projectId: 'demo', query: 'diagram.png', mode: 'literal'
  });
  assert.deepEqual(coverage.roots[0].gaps, [{ error: 'ocr_unavailable', relativePath: 'diagram.png' }]);
  const { sourceId, contentHash, location } = hit;
  const { content, structuredContent } = await client.callResult('open_evidence', {
    projectId: 'demo', sourceId, contentHash, location
  });
  assert.deepEqual(content[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.equal(structuredContent, undefined);
  assert.equal(JSON.parse(content[0].text).kind, 'image');
  assert.deepEqual(JSON.parse(content[0].text).failures, ['ocr_unavailable']);
});

test('opens a timed transcript and reports the actual selected frame timestamp', { timeout: 15000 }, async t => {
  if (['ffmpeg', 'ffprobe'].some(command => spawnSync(command, ['-version']).error?.code === 'ENOENT')) {
    assert.notEqual(process.env.MARGIN_TEST_EXTRACTORS, '1', 'Install FFmpeg and ffprobe.');
    t.skip('FFmpeg is unavailable.');
    return;
  }
  const fixture = setup(t);
  copyFileSync(new URL('./fixtures/evidence/demo.mp4', import.meta.url), join(fixture.checkout, 'demo.mp4'));
  fixture.cli('register', 'demo', fixture.checkout);
  fixture.cli('refresh', 'demo');
  let clientEnv = process.env;
  if (!windows) {
    const ffmpeg = run(fixture.work, '/bin/sh', '-c', 'command -v ffmpeg').trim();
    const bin = join(fixture.work, 'bin');
    mkdirSync(bin);
    const noise = '[unrelated @ 0x1] config in time_base: 1/1\n[unrelated @ 0x1] n: 0 pts: 53\n';
    writeFileSync(join(bin, 'ffmpeg'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
process.stderr.write(${JSON.stringify(noise)});
const ffmpeg = spawnSync(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(ffmpeg.status ?? 1);
`, { mode: 0o700 });
    clientEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  }
  const client = await connect(t, { ...fixture, env: clientEnv });
  const { hits: [hit] } = await client.call('search_project', { projectId: 'demo', query: 'blue sign' });
  assert.equal(hit.kind, 'transcript');
  assert.deepEqual(hit.location, { startSeconds: 0.5, endSeconds: 1.8 });
  const { sourceId, contentHash, location } = hit;
  const open = args => client.callResult('open_evidence', { projectId: 'demo', sourceId, contentHash, ...args });
  assert.equal((await open({ location })).structuredContent.text, 'Use the blue sign.');
  const result = await open({ atSeconds: 1.1 });
  const frame = JSON.parse(result.content[0].text);
  assert.equal(frame.kind, 'frame');
  assert.deepEqual(frame.location, { timestampSeconds: 1.5 });
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal((await open({ location: frame.location })).content[1].data, result.content[1].data);
});

test('scores only complete live text evidence in the first five results', { timeout: 15000 }, t => {
  const fixture = setup(t);
  for (const position of [1, 2, 3, 4, 5, 6]) {
    writeFileSync(join(fixture.checkout, `private-${position}.ts`), 'const windowMarker = true;\n');
  }
  const code = join(fixture.checkout, 'private-feature.ts');
  const stale = join(fixture.checkout, 'private-stale.ts');
  writeFileSync(code, 'const pairMarker = true;\n');
  writeFileSync(join(fixture.notes, 'private-policy.md'), 'The pairMarker applies to the fixture.\n');
  writeFileSync(stale, 'const retiredMarker = true;\n');
  fixture.cli('register', 'demo', fixture.checkout, fixture.notes);
  fixture.cli('refresh', 'demo');
  writeFileSync(stale, '// The setting has changed.\n');

  const required = (relativePath, rootId = 'code', endLine = 1) => ({ rootId, relativePath, startLine: 1, endLine });
  const hiddenQuestion = 'A synthetic private question';
  const cases = [
    { id: 'pair', query: 'pairMarker', requires: [required('private-feature.ts'),
      required('private-policy.md', 'notes')], governs: 'The policy governs.' },
    { id: 'sixth', query: 'windowMarker', requires: [required('private-6.ts')] },
    { id: 'partial', query: 'pairMarker', requires: [required('private-feature.ts', 'code', 2)] },
    { id: 'stale', query: 'retiredMarker', requires: [required('private-stale.ts')] },
    { id: 'path-only', query: 'private-feature.ts', requires: [required('private-feature.ts')] }
  ].map(item => ({ ...item, projectId: 'demo', question: hiddenQuestion, mode: 'literal' }));
  const manifest = join(fixture.work, 'private', 'cases.json');
  writeFileSync(manifest, JSON.stringify({ cases }), { mode: 0o600 });
  const script = fileURLToPath(new URL('../scripts/score-retrieval.ts', import.meta.url));
  const runScore = (...args) => run(fixture.work, process.execPath, script,
    '--registry', fixture.registry, '--manifest', manifest, ...args);
  const output = runScore();
  const summary = JSON.parse(output);
  assert.deepEqual(Object.keys(summary).sort(), ['p95Ms', 'score', 'total']);
  assert.equal(summary.score, 1);
  assert.equal(summary.total, 5);
  assert.ok(Number.isFinite(summary.p95Ms) && summary.p95Ms >= 0);
  const details = JSON.parse(runScore('--details'));
  assert.deepEqual(details.cases.map(({ id, passed, missing }) => ({ id, passed, missing })), [
    { id: 'pair', passed: true, missing: [] },
    ...cases.slice(1).map(({ id, requires }) => ({ id, passed: false, missing: requires }))
  ]);
  assert.ok(!JSON.stringify(details).includes(hiddenQuestion));
  assert.ok(!JSON.stringify(details).includes('The pairMarker applies'));
});

macTest('ends a stalled score run without printing private data', { timeout: 12000 }, t => {
  const fixture = setup(t);
  fixture.cli('register', 'demo', fixture.checkout);
  const manifest = join(fixture.work, 'private', 'cases.json');
  writeFileSync(manifest, JSON.stringify({ cases: [{
    id: 'private-case', projectId: 'demo', question: 'Private fixture question', query: 'private-query', mode: 'literal',
    requires: [{ rootId: 'code', relativePath: 'private-file.ts', startLine: 1, endLine: 1 }]
  }] }), { mode: 0o600 });

  const bin = join(fixture.work, 'bin');
  const pidFile = join(fixture.work, 'server-pid');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid));
setTimeout(() => process.exit(1), 5000);
`, { mode: 0o700 });
  const clock = join(fixture.work, 'clock.mjs');
  writeFileSync(clock, `
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => schedule(callback, ms === 30_000 ? 2_000 : ms, ...args);
`);

  const script = fileURLToPath(new URL('../scripts/score-retrieval.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--registry', fixture.registry, '--manifest', manifest], {
    cwd: fixture.work, timeout: 9000, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${clock}` }
  });
  const serverPid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(result.status, 1, result.stderr || result.error?.message || 'Expected a timeout failure.');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /did not reply/);
  assert.doesNotMatch(result.stderr, /private-case|private-query|private-file|Private fixture question/);
  assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
});

test('a project must opt in to save notes, including on retry', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  const client = await connect(t, fixture);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.find(tool => tool.name === 'save_project_note')?.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false
  });

  const args = { projectId: 'alpha', requestId: 'handoff-1', title: 'Handoff', body: 'Review the playlist.' };
  const save = values => client.call('save_project_note', { ...args, ...values });
  const initialFiles = readdirSync(dirname(fixture.registry));
  assert.deepEqual(await save(), { error: 'note_saves_disabled' });
  assert.deepEqual(readdirSync(dirname(fixture.registry)), initialFiles);

  fixture.cli('note-saves', 'alpha', 'enable');
  const saved = await save();
  assert.equal(typeof saved.noteId, 'string');
  assert.equal(saved.createdAt, new Date(saved.createdAt).toISOString());
  fixture.cli('note-saves', 'alpha', 'disable');
  assert.deepEqual(await save(), { error: 'note_saves_disabled' });
  fixture.cli('note-saves', 'alpha', 'enable');
  assert.deepEqual(await save(), saved);
});

test('saved Markdown and code citations reopen in a fresh session and remain in the note after edits',
  { timeout: 10000 }, async t => {
    const fixture = setup(t);
    const paths = [join(fixture.notes, 'rollout.md'), join(fixture.checkout, 'player.ts')];
    const passages = ['# Airship rollout\n', 'export const airship = true;\r\n'];
    paths.forEach((path, index) => writeFileSync(path, passages[index]));
    const projectId = 'alpha';
    fixture.cli('register', projectId, fixture.checkout, fixture.notes);
    fixture.cli('note-saves', projectId, 'enable');
    fixture.cli('refresh', projectId);

    const writer = await connect(t, fixture);
    const search = await writer.call('search_project', { projectId, query: 'airship' });
    const hits = paths.map(path => search.hits.find(hit => hit.relativePath === basename(path)));
    const citations = hits.map(({ sourceId, contentHash, startLine, endLine }) =>
      ({ sourceId, contentHash, location: { startLine, endLine } }));
    const args = { projectId, requestId: 'cited-handoff', title: 'Handoff', body: 'Check the rollout.', citations };
    const saved = await writer.call('save_project_note', args);
    assert.ok(saved.noteId, JSON.stringify(saved));
    await writer.stop();

    const reader = await connect(t, fixture);
    const reopen = citation => reader.call('open_evidence', { projectId, ...citation });
    const read = () => reader.call('read_source', { projectId, sourceId: saved.noteId });
    const before = await read();
    const { citations: savedCitations } = JSON.parse(before.text.split('\n')[1]);
    assert.deepEqual(savedCitations, citations);
    assert.match(before.text, /# Handoff\n\nCheck the rollout\.$/);
    for (const [index, citation] of savedCitations.entries()) {
      assert.ok(!before.text.includes(passages[index]));
      const opened = await reopen(citation);
      assert.equal(opened.text, passages[index]);
      assert.deepEqual(opened.location, citation.location);
      assert.equal(opened.contentHash, citation.contentHash);

      writeFileSync(paths[index], index === 0 ? 'Changed after the save.\n' : Buffer.from([0xff]));
      assert.deepEqual(await reopen(citation), { error: 'stale_citation' });
    }
    assert.deepEqual(await read(), before);
    assert.deepEqual(await reader.call('save_project_note', args), saved);
    assert.deepEqual(await reader.call('save_project_note', { ...args, citations: citations.slice(1) }),
      { error: 'note_request_conflict' });
  });

test('a new save rejects cross-project, out-of-range, and unsupported citations', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.notes, 'rollout.md'), '# Airship rollout\n');
  writeFileSync(join(fixture.notes, 'status.txt'), 'Check the checklist.\n');
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('register', 'beta', fixture.checkout, fixture.notes);
  fixture.cli('note-saves', 'alpha', 'enable');
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const { hits: [{ sourceId, contentHash, startLine, endLine }] } =
    await client.call('search_project', { projectId: 'alpha', query: 'Airship', mode: 'literal' });
  const citation = { sourceId, contentHash, location: { startLine, endLine } };
  const { sources: [foreign] } = await client.call('list_sources', { projectId: 'beta' });
  const args = { projectId: 'alpha', requestId: 'invalid-citation', title: 'Handoff', body: 'Check the rollout.' };
  const save = citation => client.call('save_project_note', { ...args, citations: [citation] });
  assert.deepEqual(await save({ ...citation, sourceId: foreign.sourceId }), { error: 'source_unavailable' });
  assert.deepEqual(await save({ ...citation, location: { startLine, endLine: endLine + 1 } }),
    { error: 'evidence_unavailable' });
  assert.deepEqual(await save({ ...citation, text: '# Airship rollout\n' }), { error: 'invalid_argument' });
  const { hits: [plainText] } = await client.call('search_project', { projectId: 'alpha', query: 'checklist' });
  assert.equal(plainText.relativePath, 'status.txt');
  const plainCitation = { sourceId: plainText.sourceId, contentHash: plainText.contentHash,
    location: { startLine: plainText.startLine, endLine: plainText.endLine } };
  assert.deepEqual(await save(plainCitation), { error: 'evidence_unavailable' });
  const { sources } = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(sources.map(source => source.sourceId), [sourceId, plainText.sourceId]);
});

test('a fresh server can find a saved note through list, read, and both search modes',
  { timeout: 10000 }, async t => {
    const fixture = setup(t);
    fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
    fixture.cli('register', 'beta', fixture.checkout, fixture.notes);
    fixture.cli('note-saves', 'alpha', 'enable');

    const writer = await connect(t, fixture);
    const args = { projectId: 'alpha', requestId: '1', title: 'Handoff', body: 'Check the moonstone playlist.' };
    const { noteId } = await writer.call('save_project_note', args);
    const reader = await connect(t, fixture);
    const list = projectId => reader.call('list_sources', { projectId });
    const read = projectId => reader.call('read_source', { projectId, sourceId: noteId });
    const search = (projectId, mode) => reader.call('search_project', { projectId, query: 'moonstone', mode });
    const [{ sourceId, relativePath }] = (await list('alpha')).sources;
    assert.equal(sourceId, noteId);
    assert.match((await read('alpha')).text, /# Handoff\n\nCheck the moonstone playlist\.$/);
    assert.deepEqual((await list('beta')).sources, []);
    assert.deepEqual(await read('beta'), { error: 'source_unavailable' });
    for (const mode of ['ranked', 'literal']) {
      assert.ok((await search('alpha', mode)).hits.some(hit => hit.sourceId === noteId));
      assert.deepEqual((await search('beta', mode)).hits, []);
    }

    fixture.cli('refresh', 'alpha');
    assert.ok((await search('alpha', 'ranked')).hits.some(hit => hit.sourceId === noteId));

    const noteFiles = readdirSync(dirname(fixture.registry), { recursive: true })
      .filter(path => path.endsWith('.md'));
    assert.equal(noteFiles.length, 1);
    const notePath = join(dirname(fixture.registry), noteFiles[0]);
    assert.equal(basename(notePath), relativePath);
    writeFileSync(notePath, 'The local account changed this note.');
    assert.equal((await read('alpha')).text, 'The local account changed this note.');
    for (const mode of ['ranked', 'literal']) assert.deepEqual((await search('alpha', mode)).hits, []);
  });

test('saved project notes survive export, index rebuild, and restore', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  const projectId = 'alpha';
  fixture.cli('register', projectId, fixture.checkout, fixture.notes);
  fixture.cli('register', 'beta', fixture.checkout, fixture.notes);
  fixture.cli('note-saves', projectId, 'enable');
  writeFileSync(join(fixture.notes, 'rollout.md'), '# Rollout plan\n');
  fixture.cli('refresh', projectId);

  const writer = await connect(t, fixture);
  const { hits: [reference] } = await writer.call('search_project', { projectId, query: 'rollout' });
  const { sourceId, contentHash, startLine, endLine } = reference;
  const citations = [{ sourceId, contentHash, location: { startLine, endLine } }];
  const args = {
    projectId, requestId: 'export-1', title: 'Private handoff', body: 'Check the moonstone playlist.', citations
  };
  const { noteId, createdAt } = await writer.call('save_project_note', args);
  assert.ok(noteId);

  const list = (client, projectId) => client.call('list_sources', { projectId });
  const read = (client, projectId) => client.call('read_source', { projectId, sourceId: noteId });
  const search = (client, projectId, mode) => client.call('search_project', { projectId, query: 'moonstone', mode });
  const modes = ['ranked', 'literal'];
  const originalSources = (await list(writer, projectId)).sources;
  const originalNote = await read(writer, projectId);
  const originalHits = new Map();
  for (const mode of modes) {
    const { hits } = await search(writer, projectId, mode);
    assert.ok(hits.some(hit => hit.sourceId === noteId));
    originalHits.set(mode, hits);
  }
  await writer.stop();
  fixture.cli('note-saves', projectId, 'disable');

  const registryDirectory = dirname(fixture.registry);
  const storage = join(registryDirectory, '.margin-saved-notes');
  const [relativePath] = readdirSync(storage, { recursive: true }).filter(path => path.endsWith('.md'));
  const originalFile = readFileSync(join(storage, relativePath));
  assert.deepEqual(JSON.parse(originalFile.toString('utf8').split('\n')[1]), {
    noteId, projectId, createdAt, requestId: args.requestId, title: args.title, citations
  });
  assert.match(originalNote.text, /# Private handoff\n\nCheck the moonstone playlist\.$/);

  const backup = join(registryDirectory, 'Notes backup 春');
  fixture.cli('export-notes', backup);
  const [exported] = readdirSync(backup, { recursive: true }).filter(path => path.endsWith('.md'));
  assert.deepEqual(readFileSync(join(backup, exported)), originalFile);
  assert.ok(!readdirSync(backup, { recursive: true }).some(path => path.includes('.sqlite')));

  const index = fixture.registry + '.' + createHash('sha256').update(projectId).digest('hex') + '.sqlite';
  const clearIndex = () => {
    rmSync(index);
    for (const suffix of ['-wal', '-shm']) rmSync(index + suffix, { force: true });
  };
  const verifyRebuild = async () => {
    fixture.cli('refresh', projectId);
    assert.deepEqual(readFileSync(join(storage, relativePath)), originalFile);
    const reader = await connect(t, fixture);
    assert.deepEqual((await list(reader, projectId)).sources, originalSources);
    assert.deepEqual(await read(reader, projectId), originalNote);
    for (const mode of modes) {
      const { hits, coverage } = await search(reader, projectId, mode);
      assert.deepEqual(hits, originalHits.get(mode));
      assert.equal(coverage.complete, true);
    }
    return reader;
  };

  clearIndex();
  const rebuilt = await verifyRebuild();
  await rebuilt.stop();
  clearIndex();
  rmSync(storage, { recursive: true });
  fixture.cli('restore-notes', backup);
  fixture.cli('refresh', 'beta');
  const restored = await verifyRebuild();
  assert.deepEqual((await list(restored, 'beta')).sources.map(source => source.relativePath), ['rollout.md']);
  assert.deepEqual(await read(restored, 'beta'), { error: 'source_unavailable' });
  for (const mode of modes) assert.deepEqual((await search(restored, 'beta', mode)).hits, []);
});

test('recovery refuses existing destinations and unsafe note files', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  const projectId = 'alpha';
  fixture.cli('register', projectId, fixture.checkout);
  fixture.cli('note-saves', projectId, 'enable');
  const client = await connect(t, fixture);
  const { noteId } = await client.call('save_project_note', {
    projectId, requestId: 'recovery-safety', title: 'Handoff', body: 'Preserve this note.'
  });
  assert.ok(noteId);
  await client.stop();

  const directory = dirname(fixture.registry);
  const store = join(directory, '.margin-saved-notes');
  const backup = join(directory, 'backup');
  const [saved] = readdirSync(store, { recursive: true }).filter(path => path.endsWith('.md'));
  const note = join(store, saved);
  const original = readFileSync(note);
  const reject = (command, path, error, location = path) => {
    const result = runWithEnv(fixture, process.env, command, path);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(location), result.stderr);
    assert.match(result.stderr, error);
    return result.stderr;
  };

  reject('export-notes', join(fixture.checkout, 'backup'), /outside the source roots/);
  const privateFix = windows ? /local NTFS/ : /0600/;
  const sourceAlias = join(directory, 'source-alias');
  linkSync(toNamespacedPath(note), sourceAlias);
  assert.match(reject('export-notes', backup, /note_backup_unavailable/, note), privateFix);
  assert.equal(existsSync(backup), false);
  assert.deepEqual(readFileSync(note), original);
  rmSync(sourceAlias);

  fixture.cli('export-notes', backup);
  reject('export-notes', backup, /note_backup_destination_exists/);
  reject('restore-notes', backup, /note_backup_destination_exists/, store);
  assert.deepEqual(readFileSync(note), original);

  renameSync(store, join(directory, 'original-notes'));
  const [relativeBackupNote] = readdirSync(backup, { recursive: true }).filter(path => path.endsWith('.md'));
  const backupNote = join(backup, relativeBackupNote);
  const backupAlias = join(directory, 'backup-alias');
  linkSync(toNamespacedPath(backupNote), backupAlias);
  assert.match(reject('restore-notes', backup, /note_backup_unavailable/, backupNote), privateFix);
  assert.equal(existsSync(store), false);
  assert.deepEqual(readFileSync(backupNote), original);
  rmSync(backupAlias);
  fixture.cli('restore-notes', backup);
  assert.deepEqual(readFileSync(note), original);
});

test('retries recover a lost save response and concurrent calls never replace notes', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  const writer = await connect(t, fixture);
  const observer = await connect(t, fixture);
  const list = () => observer.call('list_sources', { projectId: 'alpha' });
  fixture.cli('register', 'beta', fixture.checkout);
  fixture.cli('note-saves', 'beta', 'enable');
  const args = { projectId: 'alpha', requestId: 'lost-response', title: 'A private handoff', body: 'Record this.' };
  writer.sendCall('save_project_note', args);
  let saved;
  for (let attempt = 0; !saved && attempt < 100; attempt++) {
    const { sources } = await list();
    [saved] = sources;
    if (!saved) await delay(25);
  }
  assert.ok(saved, 'The note did not commit');
  await writer.stop('SIGKILL');

  const { text } = await observer.call('read_source', { projectId: 'alpha', sourceId: saved.sourceId });
  const metadata = JSON.parse(text.split('\n')[1]);
  assert.deepEqual(metadata, {
    noteId: saved.sourceId, projectId: 'alpha', createdAt: metadata.createdAt,
    requestId: 'lost-response', title: 'A private handoff'
  });
  const fresh = await connect(t, fixture);
  const save = (client, overrides) => client.call('save_project_note', { ...args, ...overrides });
  assert.deepEqual(await save(fresh),
    { noteId: saved.sourceId, createdAt: new Date(metadata.createdAt).toISOString() });
  assert.deepEqual(await save(fresh, { title: 'Different title' }), { error: 'note_request_conflict' });
  const matching = await Promise.all([save(fresh, { requestId: 'matching' }), save(observer, { requestId: 'matching' })]);
  assert.ok(matching[0].noteId);
  assert.deepEqual(matching[1], matching[0]);

  const conflicting = await Promise.all([
    save(fresh, { requestId: 'conflict', body: 'First' }),
    save(observer, { requestId: 'conflict', body: 'Second' })
  ]);
  const winner = conflicting.findIndex(result => result.noteId);
  assert.notEqual(winner, -1);
  assert.deepEqual(conflicting[1 - winner], { error: 'note_request_conflict' });
  const committed = await observer.call('read_source', { projectId: 'alpha', sourceId: conflicting[winner].noteId });
  assert.ok(committed.text.endsWith(winner === 0 ? 'First' : 'Second'));

  const distinct = await Promise.all([save(fresh, { requestId: 'left' }), save(observer, { requestId: 'right' })]);
  const sources = (await list()).sources;
  const committedIds = [saved.sourceId, matching[0].noteId, conflicting[winner].noteId, ...distinct.map(note => note.noteId)];
  assert.equal(new Set(committedIds).size, 5);
  assert.deepEqual(sources.map(source => source.sourceId).sort(), committedIds.sort());

  const firstSaves = await Promise.all([save(fresh, { projectId: 'beta', requestId: 'left' }),
    save(observer, { projectId: 'beta', requestId: 'right' })]);
  assert.ok(firstSaves.every(result => result.noteId), JSON.stringify(firstSaves));
  assert.notEqual(firstSaves[0].noteId, firstSaves[1].noteId);
});

test('readers see only complete single-link notes during publication', { timeout: 25000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  const staged = join(fixture.work, 'save-staged');
  const release = join(fixture.work, 'release-staged');
  const published = join(fixture.work, 'save-published');
  const hook = join(fixture.work, 'pause.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync;
const remove = fs.rmSync;
const waiter = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync = (destination, data, options) => {
  if (typeof data === 'string' && data.includes('frozencaribou')) {
    write(destination, data.slice(0, data.length / 2), options);
    write(${JSON.stringify(staged)}, '');
    while (!fs.existsSync(${JSON.stringify(release)})) {
      Atomics.wait(waiter, 0, 0, 10);
    }
    return write(destination, data.slice(data.length / 2), options);
  }
  return write(destination, data, options);
};
fs.rmSync = (path, options) => {
  if (typeof path === 'string' && path.endsWith('.tmp')) {
    write(${JSON.stringify(published)}, '');
    Atomics.wait(waiter, 0, 0);
  }
  return remove(path, options);
};
syncBuiltinESMExports();
`);
  async function waitFor(path) {
    for (let attempt = 0; !existsSync(path) && attempt < 200; attempt++) await delay(25);
    assert.ok(existsSync(path), `The server did not reach ${basename(path)}`);
  }
  const startWriter = () => connect(t, { ...fixture, nodeArgs: ['--import', pathToFileURL(hook).href] });
  const args = { projectId: 'alpha', requestId: 'interrupt', title: 'Handoff', body: 'frozencaribou' };
  const writer = await startWriter();
  writer.sendCall('save_project_note', args);
  await waitFor(staged);
  const reader = await connect(t, fixture);
  const list = () => reader.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual((await list()).sources, []);
  const backup = join(dirname(fixture.registry), 'backup');
  for (const command of ['export-notes', 'restore-notes']) {
    const busy = runWithEnv(fixture, process.env, command, backup);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /registry_busy/);
    assert.equal(existsSync(backup), false);
  }
  assert.deepEqual(await writer.stop('SIGKILL'), [null, 'SIGKILL']);
  assert.deepEqual((await list()).sources, []);

  rmSync(staged);
  const retry = await startWriter();
  retry.sendCall('save_project_note', args);
  await waitFor(staged);
  writeFileSync(release, '');
  await waitFor(published);
  const privateDir = dirname(fixture.registry);
  const [relativePath] = readdirSync(privateDir, { recursive: true }).filter(path => path.endsWith('.md'));
  assert.ok(relativePath);
  const path = join(privateDir, relativePath);
  assert.equal(statSync(path).nlink, 1);
  const [{ sourceId }] = (await list()).sources;
  const { text } = await reader.call('read_source', { projectId: 'alpha', sourceId });
  assert.match(text, /\n# Handoff\n\nfrozencaribou$/);
  const { createdAt } = JSON.parse(text.split('\n')[1]);
  if (!windows) {
    for (let location = path; location !== privateDir; location = dirname(location)) {
      const { mode, uid } = statSync(location);
      assert.equal(mode & 0o077, 0);
      assert.equal(uid, process.getuid());
    }
  }
  assert.deepEqual(await retry.stop('SIGKILL'), [null, 'SIGKILL']);
  assert.deepEqual(await reader.call('save_project_note', args), { noteId: sourceId, createdAt });
  assert.deepEqual((await list()).sources.map(source => source.sourceId), [sourceId]);
  fixture.cli('export-notes', backup);
  assert.equal(readdirSync(backup, { recursive: true }).filter(path => path.endsWith('.md')).length, 1);
  assert.ok(!readdirSync(backup, { recursive: true }).some(path => path.endsWith('.tmp')));
});

test('saves reject long lines before writing and accept the read limit', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  const client = await connect(t, fixture);
  const body = 'pondwatch ' + 'é'.repeat((32 * 1024 - 10) / 2);
  const args = { projectId: 'alpha', requestId: 'line-limit', title: 'Handoff', body };
  const initialFiles = readdirSync(dirname(fixture.registry));
  assert.deepEqual(await client.call('save_project_note', { ...args, body: body + 'x' }), { error: 'line_too_long' });
  assert.deepEqual(await client.call('save_project_note', { ...args, title: body }), { error: 'line_too_long' });
  assert.deepEqual(readdirSync(dirname(fixture.registry)), initialFiles);

  const { noteId } = await client.call('save_project_note', args);
  assert.deepEqual(await client.call('save_project_note', { ...args, body: body + 'x' }),
    { error: 'note_request_conflict' });
  const first = await client.call('read_source', { projectId: 'alpha', sourceId: noteId });
  const rest = await client.call('read_source', { projectId: 'alpha', sourceId: noteId, startLine: first.nextStartLine });
  assert.equal(rest.text, body);
  for (const mode of ['ranked', 'literal']) {
    const { hits } = await client.call('search_project', { projectId: 'alpha', query: 'pondwatch', mode });
    assert.equal(hits[0].sourceId, noteId);
  }
});

test('two registries save and recover notes independently', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const second = { ...fixture, registry: join(dirname(fixture.registry), 'other.json') };
  const register = ['register', 'alpha', fixture.checkout, fixture.notes];
  fixture.cli(...register);
  fixture.cli('note-saves', 'alpha', 'enable');
  const secondCli = (...args) => run(second.work, process.execPath, entry, '--registry', second.registry, ...args);
  secondCli(...register);
  secondCli('note-saves', 'alpha', 'enable');
  const [firstClient, secondClient] = await Promise.all([connect(t, fixture), connect(t, second)]);
  const args = { projectId: 'alpha', requestId: 'shared-id', title: 'Handoff', body: 'Private details' };
  const [first, other] = await Promise.all([firstClient.call('save_project_note', args),
    secondClient.call('save_project_note', args)]);
  assert.notEqual(first.noteId, other.noteId);
  for (const [client, ownId, foreignId] of [[firstClient, first.noteId, other.noteId],
    [secondClient, other.noteId, first.noteId]]) {
    const { sources } = await client.call('list_sources', { projectId: 'alpha' });
    assert.deepEqual(sources.map(source => source.sourceId), [ownId]);
    assert.deepEqual(await client.call('read_source', { projectId: 'alpha', sourceId: foreignId }),
      { error: 'source_unavailable' });
  }
  const directory = dirname(fixture.registry);
  const backup = join(directory, 'first-backup');
  fixture.cli('export-notes', backup);
  assert.equal(readdirSync(backup, { recursive: true }).filter(path => path.endsWith('.md')).length, 1);
  const store = join(directory, '.margin-saved-notes', createHash('sha256').update(basename(fixture.registry)).digest('hex'));
  renameSync(store, join(directory, 'first-store'));
  const third = { ...fixture, registry: join(directory, 'third.json') };
  run(third.work, process.execPath, entry, '--registry', third.registry, ...register);
  const wrongRegistry = runWithEnv(third, process.env, 'restore-notes', backup);
  assert.equal(wrongRegistry.status, 1);
  assert.match(wrongRegistry.stderr, /Use the original registry path/);
  assert.ok(wrongRegistry.stderr.includes(JSON.stringify(fixture.registry)), wrongRegistry.stderr);
  fixture.cli('restore-notes', backup);
  const [firstSources, secondSources] = await Promise.all([
    firstClient.call('list_sources', { projectId: 'alpha' }), secondClient.call('list_sources', { projectId: 'alpha' })
  ]);
  assert.deepEqual(firstSources.sources.map(source => source.sourceId), [first.noteId]);
  assert.deepEqual(secondSources.sources.map(source => source.sourceId), [other.noteId]);
});

test('a save can finish when the cold index briefly reports a busy journal', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  const hook = join(fixture.work, 'busy.mjs');
  writeFileSync(hook, `import { DatabaseSync } from 'node:sqlite';
const prepare = DatabaseSync.prototype.prepare;
let busy = true;
DatabaseSync.prototype.prepare = function (sql) {
  if (busy && sql === 'PRAGMA journal_mode = WAL') {
    busy = false;
    throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  }
  return prepare.call(this, sql);
};
`);
  const client = await connect(t, { ...fixture, nodeArgs: ['--import', pathToFileURL(hook).href] });
  const result = await client.call('save_project_note',
    { projectId: 'alpha', requestId: 'cold-index', title: 'Handoff', body: 'Check coldstream.' });
  assert.ok(result.noteId, JSON.stringify(result));
  const found = await client.call('search_project', { projectId: 'alpha', query: 'coldstream' });
  assert.equal(found.hits[0].sourceId, result.noteId);
});

test('a matching save retry restores search for a committed note', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  writeFileSync(join(fixture.checkout, 'ordinary.md'), 'Read creekwatch.');
  fixture.cli('refresh', 'alpha');
  const directory = dirname(fixture.registry);
  const index = readdirSync(directory).find(name => name.endsWith('.sqlite'));
  assert.ok(index);
  function execFixtureSql(sql) {
    const db = new DatabaseSync(join(directory, index));
    try {
      db.exec(sql);
    } finally {
      // Close this connection so it removes its sidecars before Margin opens the index.
      db.close();
    }
  }
  execFixtureSql(`CREATE TRIGGER fail_indexing BEFORE INSERT ON ranges BEGIN
    SELECT RAISE(ABORT, 'Fixture indexing failure');
  END`);

  const writer = await connect(t, fixture);
  const args = { projectId: 'alpha', requestId: 'pending', title: 'Handoff', body: 'Check creekwatch.' };
  const pending = await writer.callResult('save_project_note', args);
  assert.equal(pending.isError, false);
  const { status, noteId } = pending.structuredContent;
  assert.equal(status, 'saved_search_pending');
  assert.ok(noteId);
  assert.equal(pending.structuredContent.detail, undefined);
  await writer.stop();

  const reader = await connect(t, fixture);
  const { sources } = await reader.call('list_sources', { projectId: 'alpha' });
  const saved = sources.find(source => source.rootId === '@saved-notes');
  assert.equal(saved.sourceId, noteId);
  const { text } = await reader.call('read_source', { projectId: 'alpha', sourceId: noteId });
  assert.ok(text.endsWith(args.body));
  const { createdAt } = JSON.parse(text.split('\n')[1]);
  assert.equal(createdAt, new Date(createdAt).toISOString());
  const search = mode => reader.call('search_project', { projectId: 'alpha', query: 'creekwatch', mode });
  for (const mode of ['literal', 'ranked']) {
    const result = await search(mode);
    assert.deepEqual(result.hits.map(hit => hit.relativePath), ['ordinary.md']);
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.coverage.roots.find(root => root.rootId === '@saved-notes').gaps,
      [{ error: 'source_not_indexed', relativePath: saved.relativePath }]);
  }

  execFixtureSql('DROP TRIGGER fail_indexing');
  assert.deepEqual(await reader.call('save_project_note', args), { noteId, createdAt });
  for (const mode of ['literal', 'ranked']) {
    const result = await search(mode);
    assert.ok(result.hits.some(hit => hit.sourceId === noteId));
    assert.equal(result.coverage.complete, true);
  }
  assert.deepEqual(readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.md'))
    .map(path => basename(path)), [saved.relativePath]);
});

test('unsafe saved note files block reads and retries without changing the note', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  const client = await connect(t, fixture);
  const args = { projectId: 'alpha', requestId: 'unsafe-note', title: 'Handoff', body: 'Preserve finchmarker.' };
  const { noteId } = await client.call('save_project_note', args);
  assert.ok(noteId);
  const directory = dirname(fixture.registry);
  const [note] = readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.md'));
  const path = join(directory, note);
  const before = readFileSync(path);
  if (windows) {
    // Give icacls a short path. Remove the alias before checking the note.
    const alias = join(directory, 'acl.md');
    linkSync(toNamespacedPath(path), alias);
    try {
      execFileSync('icacls.exe', [alias, '/grant', '*S-1-1-0:R']);
    } finally {
      rmSync(alias);
    }
    assert.equal(statSync(path).nlink, 1);
  } else if (linux) {
    execFileSync('setfacl', ['-m', 'u:65534:r--,m::---', path]);
  } else {
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', path]);
  }

  const read = await client.call('read_source', { projectId: 'alpha', sourceId: noteId });
  const retry = await client.call('save_project_note', args);
  for (const result of [read, retry]) {
    assert.equal(result.error, 'note_storage_unavailable');
    assert.ok(result.detail.includes(path));
    assert.match(result.detail, windows ? /NTFS/ : /0600/);
  }
  assert.deepEqual((await client.call('list_sources', { projectId: 'alpha' })).sources, []);
  for (const mode of ['ranked', 'literal']) {
    const { hits, coverage } = await client.call('search_project', { projectId: 'alpha', query: 'finchmarker', mode });
    assert.deepEqual(hits, []);
    const [gap] = coverage.roots.find(root => root.rootId === '@saved-notes').gaps;
    assert.deepEqual(gap, { error: read.error, detail: read.detail, relativePath: basename(path) });
  }
  assert.deepEqual(readFileSync(path), before);
});

test('unsafe saved note storage leaves ordinary sources discoverable', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('note-saves', 'alpha', 'enable');
  writeFileSync(join(fixture.checkout, 'ordinary.md'), 'Find sharedmarker in this source.');
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const { noteId } = await client.call('save_project_note',
    { projectId: 'alpha', requestId: 'hidden', title: 'Private handoff', body: 'Find sharedmarker in this note.' });
  assert.ok(noteId);
  const noteDirectory = join(dirname(fixture.registry), '.margin-saved-notes');
  const before = readdirSync(noteDirectory, { recursive: true });
  if (windows) execFileSync('icacls.exe', [noteDirectory, '/grant', '*S-1-1-0:RX']);
  else chmodSync(noteDirectory, 0o755);
  const denied = await client.call('save_project_note',
    { projectId: 'alpha', requestId: 'blocked', title: 'New note', body: 'Do not write this.' });
  assert.equal(denied.error, 'note_storage_unavailable');
  assert.ok(denied.detail.includes(noteDirectory));
  assert.deepEqual(readdirSync(noteDirectory, { recursive: true }), before);

  const listing = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(listing.sources?.map(source => source.relativePath), ['ordinary.md'], JSON.stringify(listing));
  const [warning] = listing.warnings;
  assert.equal(warning.rootId, '@saved-notes');
  assert.equal(warning.error, 'root_unavailable');
  assert.ok(warning.detail?.includes(noteDirectory));
  assert.match(warning.detail, windows ? /NTFS/ : /0700/);
  assert.equal(listing.coverage.complete, false);
  for (const mode of ['ranked', 'literal']) {
    const result = await client.call('search_project', { projectId: 'alpha', query: 'sharedmarker', mode });
    assert.deepEqual(result.hits.map(hit => hit.relativePath), ['ordinary.md']);
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.coverage.roots.find(root => root.rootId === '@saved-notes').gaps,
      [{ error: 'root_unavailable', detail: warning.detail }]);
  }
  const unavailable = await client.call('read_source', { projectId: 'alpha', sourceId: noteId });
  assert.equal(unavailable.error, 'note_storage_unavailable');
  assert.ok(unavailable.detail.includes(join(dirname(fixture.registry), '.margin-saved-notes')));
});

macTest('an inheritable ACL blocks registry access without changing existing files',
  { timeout: 10000, skip: process.platform !== 'darwin' }, async t => {
    const fixture = setup(t);
    fixture.cli('register', 'alpha', fixture.checkout);
    fixture.cli('note-saves', 'alpha', 'enable');
    writeFileSync(join(fixture.checkout, 'ordinary.md'), 'Read ordinarymarker.');
    fixture.cli('refresh', 'alpha');
    const directory = dirname(fixture.registry);
    execFileSync('/bin/chmod', ['+a', 'everyone allow read,search,file_inherit,directory_inherit', directory]);
    execFileSync('/usr/bin/xattr', ['-w', 'com.example.margin-fixture', 'acl-test', directory]);
    const before = readdirSync(directory);
    const client = await connect(t, fixture);
    const response = await client.call('save_project_note',
      { projectId: 'alpha', requestId: 'unsafe-parent', title: 'Private handoff', body: 'Protect the note.' });
    assert.equal(response.error, 'registry_unavailable');
    assert.ok(response.detail.includes(directory));
    assert.match(response.detail, /0700/);
    assert.equal((await client.call('list_projects')).error, 'registry_unavailable');
    assert.equal((await client.call('search_project', { projectId: 'alpha', query: 'ordinarymarker' })).error,
      'registry_unavailable');
    const refresh = runWithEnv(fixture, process.env, 'refresh', 'alpha');
    assert.equal(refresh.status, 1);
    assert.ok(refresh.stderr.includes(directory));
    assert.deepEqual(readdirSync(directory), before);
  });

macTest('a saved note stays private and discoverable when its index is unavailable',
  { timeout: 10000, skip: process.platform !== 'darwin' }, async t => {
    const fixture = setup(t);
    fixture.cli('register', 'alpha', fixture.checkout);
    fixture.cli('note-saves', 'alpha', 'enable');
    fixture.cli('refresh', 'alpha');
    const directory = dirname(fixture.registry);
    const [index] = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
    assert.ok(index);
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', join(directory, index)]);
    const before = readFileSync(join(directory, index));
    const client = await connect(t, fixture);
    const response = await client.call('save_project_note',
      { projectId: 'alpha', requestId: 'unsafe-index', title: 'Private handoff', body: 'Protect the note.' });
    assert.equal(response.status, 'saved_search_pending');
    assert.ok(response.noteId);
    const search = await client.call('search_project', { projectId: 'alpha', query: 'Protect' });
    assert.deepEqual(search.hits, []);
    assert.equal(search.coverage.complete, false);
    const savedNoteCoverage = coverage => coverage.roots.find(root => root.rootId === '@saved-notes');
    const [gap] = savedNoteCoverage(search.coverage).gaps;
    assert.equal(gap.error, 'index_unavailable');
    assert.ok(gap.detail?.includes(join(directory, index)));
    assert.match(gap.detail, /0600/);
    assert.equal(response.detail, gap.detail);
    const listing = await client.call('list_sources', { projectId: 'alpha' });
    assert.ok(listing.sources.some(source => source.sourceId === response.noteId));
    assert.deepEqual(savedNoteCoverage(listing.coverage).gaps, [gap]);
    const refresh = spawnSync(process.execPath, [entry, '--registry', fixture.registry, 'refresh', 'alpha'],
      { cwd: fixture.work, encoding: 'utf8' });
    assert.equal(refresh.status, 1);
    assert.match(refresh.stderr, /index_unavailable/);
    assert.deepEqual(readFileSync(join(directory, index)), before);

    renameSync(join(directory, index), join(directory, 'unavailable.sqlite.bak'));
    const missing = await client.call('search_project', { projectId: 'alpha', query: 'Protect' });
    const { sources } = await client.call('list_sources', { projectId: 'alpha' });
    const saved = sources.find(source => source.sourceId === response.noteId);
    assert.equal(missing.coverage.complete, false);
    assert.deepEqual(missing.coverage.roots.find(root => root.rootId === '@saved-notes').gaps,
      [{ error: 'source_not_indexed', relativePath: saved.relativePath }]);
  });


test('hard links stop live reads, refresh, search, and citation opens', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const path = join(fixture.checkout, 'entry.md');
  writeFileSync(path, 'needle before linking\n');
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const { hits: [hit] } = await client.call('search_project', { projectId: 'alpha', query: 'needle' });
  const { sourceId, contentHash, startLine, endLine } = hit;

  linkSync(path, join(fixture.work, 'alias.md'));
  const { sources } = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(sources, []);
  assert.deepEqual(await client.call('read_source', { projectId: 'alpha', sourceId }),
    { error: 'source_unavailable' });
  assert.deepEqual(await client.call('open_evidence', {
    projectId: 'alpha', sourceId, contentHash, location: { startLine, endLine }
  }), { error: 'source_unavailable' });
  for (const mode of ['ranked', 'literal']) {
    const search = await client.call('search_project', { projectId: 'alpha', query: 'needle', mode });
    assert.deepEqual(search.hits, []);
  }
  fixture.cli('refresh', 'alpha');
});


test('root aliases preserve Git IDs and matching citations after a root moves', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const alias = join(fixture.work, 'Alias café');
  const source = 'crème brûlée.md';
  writeFileSync(join(fixture.checkout, source), 'marker with stable content\n');
  linkDirectory(fixture.checkout, alias);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('add-checkout', 'alpha', 'extra', alias);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const findHit = async mode => {
    const { hits } = await client.call('search_project', { projectId: 'alpha', query: 'marker', mode });
    return hits.find(hit => hit.rootId === 'extra');
  };
  const hit = await findHit('ranked');
  assert.equal(hit.relativePath, source);
  assert.equal((await findHit('literal')).sourceId, hit.sourceId);
  const { sourceId, contentHash, startLine, endLine } = hit;
  const citation = { projectId: 'alpha', sourceId, contentHash, location: { startLine, endLine } };
  const moved = join(fixture.work, 'Checkout déplacé');
  renameSync(fixture.checkout, moved);
  rmSync(alias);
  linkDirectory(moved, alias);
  assert.deepEqual(await client.call('open_evidence', citation), { error: 'root_unavailable' });
  fixture.cli('add-checkout', 'alpha', 'extra', alias);
  assert.equal((await client.call('open_evidence', citation)).text, 'marker with stable content\n');
  writeFileSync(join(moved, source), 'marker with new content\n');
  assert.deepEqual(await client.call('open_evidence', citation), { error: 'stale_citation' });
});

(windows ? test.skip : test)('a source path replacement during read cannot change the opened file', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  const name = 'entry.md';
  const original = join(fixture.notes, name);
  const replacement = join(fixture.work, 'replacement.md');
  writeFileSync(original, 'verified content\n');
  writeFileSync(replacement, 'replacement content\n');
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  const hook = join(fixture.work, 'swap.mjs');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readSync;
const inode = fs.statSync(${JSON.stringify(original)}, { bigint: true }).ino;
let swapped = false;
fs.readSync = (fd, ...args) => {
  if (!swapped && fs.fstatSync(fd, { bigint: true }).ino === inode) {
    swapped = true;
    fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(original)});
  }
  return read(fd, ...args);
};
syncBuiltinESMExports();
`);
  const client = await connect(t, { ...fixture, nodeArgs: ['--import', pathToFileURL(hook).href] });
  const { sources: [{ sourceId }] } = await client.call('list_sources', { projectId: 'alpha' });
  const read = () => client.call('read_source', { projectId: 'alpha', sourceId });
  assert.equal((await read()).text, 'verified content\n');
  assert.equal((await read()).text, 'replacement content\n');
});

macTest('registration checks filesystem type and protects custom storage paths', t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  const before = readFileSync(fixture.registry);
  const wrongVolume = runWithEnv(fixture, process.env, 'register', 'beta', fixture.checkout, '/dev');
  assert.equal(wrongVolume.status, 1);
  assert.match(wrongVolume.stderr, /local APFS directory.*\/dev/);
  const link = join(fixture.work, 'Linked registry');
  symlinkSync(dirname(fixture.registry), link);
  const aliased = { ...fixture, registry: join(link, basename(fixture.registry)) };
  assert.equal(runWithEnv(aliased, process.env, 'register', 'beta', fixture.checkout).status, 1);

  chmodSync(fixture.work, 0o777);
  const unsafe = runWithEnv(fixture, process.env, 'register', 'beta', fixture.checkout);
  assert.equal(unsafe.status, 1);
  assert.ok(unsafe.stderr.includes(fixture.work));
  assert.match(unsafe.stderr, /0700/);
  assert.deepEqual(readFileSync(fixture.registry), before);
});

macTest('an ACL on a SQLite sidecar blocks access before SQLite opens it', t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  const directory = dirname(fixture.registry);
  const [index] = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
  const path = join(directory, `${index}-wal`);
  writeFileSync(path, 'unsafe sidecar fixture', { mode: 0o600 });
  execFileSync('/bin/chmod', ['+a', 'everyone allow read', path]);
  const refresh = runWithEnv(fixture, process.env, 'refresh', 'alpha');
  assert.equal(refresh.status, 1);
  assert.match(refresh.stderr, /index_unavailable/);
  assert.ok(refresh.stderr.includes(path));
  assert.equal(readFileSync(path, 'utf8'), 'unsafe sidecar fixture');
});


test('a registry path with a parent segment never selects another registry', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  const before = readFileSync(fixture.registry);
  const prefix = join(fixture.work, 'linked directory');
  linkDirectory(fixture.checkout, prefix);
  const ambiguous = { ...fixture, registry: `${prefix}/../private/projects.json` };
  const register = runWithEnv(ambiguous, process.env, 'register', 'beta', fixture.checkout);
  assert.equal(register.status, 1);
  assert.ok(register.stderr.includes(ambiguous.registry));
  assert.ok(register.stderr.includes("without '..'"));
  assert.deepEqual(readFileSync(fixture.registry), before);

  const client = await connect(t, ambiguous);
  const listing = await client.call('list_projects');
  assert.equal(listing.error, 'registry_unavailable');
  assert.ok(listing.detail?.includes(ambiguous.registry));
});

macTest('unsafe extractor output reports its location and keeps other sources searchable', { timeout: 10000 }, async t => {
  const fixture = setup(t);
  writeFileSync(join(fixture.checkout, 'evidence.pdf'), 'PDF fixture');
  writeFileSync(join(fixture.checkout, 'ordinary.md'), 'ordinarymarker');
  fixture.cli('register', 'alpha', fixture.checkout);
  const env = fixtureDocling(fixture.work, { texts: [] }, 0o644);
  const refresh = runWithEnv(fixture, env, 'refresh', 'alpha');
  assert.equal(refresh.status, 1);
  const { roots: [{ gaps: [gap] }] } = JSON.parse(refresh.stdout);
  assert.equal(gap.error, 'evidence_storage_unavailable');
  assert.equal(gap.relativePath, 'evidence.pdf');
  assert.ok(gap.detail?.includes(dirname(fixture.registry)));
  assert.match(gap.detail, /source\.json.*0600/);

  const client = await connect(t, fixture);
  const { sources } = await client.call('list_sources', { projectId: 'alpha' });
  const { sourceId } = sources.find(source => source.relativePath === 'evidence.pdf');
  const evidence = await client.call('open_evidence', { projectId: 'alpha', sourceId });
  assert.deepEqual(evidence.failures, ['evidence_storage_unavailable']);
  assert.equal(evidence.failureDetails?.evidence_storage_unavailable, gap.detail);
  const search = await client.call('search_project', { projectId: 'alpha', query: 'ordinarymarker' });
  assert.deepEqual(search.hits.map(hit => hit.relativePath), ['ordinary.md']);
});

(windows || linux ? test : test.skip)('local roots keep distinct Unicode spellings and skip directory links', { timeout: 15000 }, async t => {
  const fixture = setup(t);
  const first = 'caf\u00e9.md';
  const second = 'cafe\u0301.md';
  writeFileSync(join(fixture.notes, first), 'Original spelling.\n');
  writeFileSync(join(fixture.notes, second), 'Distinct spelling.\n');
  writeFileSync(join(fixture.work, 'outside.md'), 'Outside the root.\n');
  linkDirectory(fixture.work, join(fixture.notes, 'junction'));
  fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
  fixture.cli('refresh', 'alpha');
  const client = await connect(t, fixture);
  const { sources } = await client.call('list_sources', { projectId: 'alpha' });
  assert.deepEqual(sources.map(source => source.relativePath), [second, first]);
  assert.notEqual(sources[0].sourceId, sources[1].sourceId);
  for (const [index, text] of ['Distinct spelling.\n', 'Original spelling.\n'].entries()) {
    const sourceId = sources[index].sourceId;
    assert.equal((await client.call('read_source', { projectId: 'alpha', sourceId })).text, text);
  }
  const sourceId = Buffer.from(JSON.stringify(['alpha', 'notes', 'junction/outside.md'])).toString('base64url');
  assert.deepEqual(await client.call('read_source', { projectId: 'alpha', sourceId }), { error: 'source_unavailable' });
});

windowsTest('Windows CLI rejects unsupported path syntax and names it', t => {
  const fixture = setup(t, 'Margin é tests ');
  const paths = ['C:relative', '\\\\?\\C:\\device', '\\\\.\\C:\\device', 'C:\\checkout:stream', '\\\\localhost\\share'];
  for (const path of paths) {
    const result = runWithEnv(fixture, process.env, 'register', 'project', path);
    assert.equal(result.status, 1, result.error?.message);
    assert.ok(result.stderr.includes(path), result.stderr);
    assert.match(result.stderr, /local NTFS/);
  }
});

(windows || linux ? test : test.skip)('verified files support discovery, reads, search, and citations', { timeout: 30000 }, async t => {
  const fixture = setup(t, 'Margin é tests ');
  const { work, checkout, cli } = fixture;
  const text = 'Margin checks the citation.\nDistinct second line.\n';
  const name = 'Réponse.md';
  writeFileSync(join(checkout, name), text);
  const alias = join(work, 'Checkout alias');
  linkDirectory(checkout, alias);
  cli('register', 'project', alias);
  cli('refresh', 'project');
  const { call } = await connect(t, fixture);
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

  linkSync(join(checkout, name), join(work, 'Other name.md'));
  assert.equal((await call('read_source', { projectId, sourceId })).error, 'source_unavailable');
  assert.deepEqual((await search('ranked')).hits, []);
  rmSync(join(work, 'Other name.md'));

  const moved = join(work, 'Emplacement déplacé');
  renameSync(checkout, moved);
  linkDirectory(moved, checkout);
  assert.equal((await call('read_source', { projectId, sourceId })).error, 'root_unavailable');
  rmSync(alias);
  linkDirectory(moved, alias);
  cli('register', projectId, alias);
  assert.equal((await call('open_evidence', citation)).text, text);
  writeFileSync(join(moved, name), 'Changed content.\n');
  assert.equal((await call('open_evidence', citation)).error, 'stale_citation');
});

windowsTest('Windows refuses a registry with an unrelated access grant', t => {
  const fixture = setup(t);
  const { checkout, registry, cli } = fixture;
  cli('register', 'project', checkout);
  const contents = readFileSync(registry);
  execFileSync('icacls.exe', [registry, '/grant', '*S-1-1-0:R']);
  const result = runWithEnv(fixture, process.env, 'refresh', 'project');
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /registry_unavailable/);
  assert.match(result.stderr, /local NTFS/);
  assert.deepEqual(readFileSync(registry), contents);
});

windowsTest('Windows rejects a registry below an ancestor with untrusted delete-child rights', t => {
  const fixture = setup(t);
  const { checkout, registry, work, cli } = fixture;
  cli('register', 'project', checkout);
  const contents = readFileSync(registry);
  execFileSync('icacls.exe', [work, '/grant', '*S-1-1-0:(DC)']);
  const result = runWithEnv(fixture, process.env, 'refresh', 'project');
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /registry_unavailable/);
  assert.ok(result.stderr.includes(work), result.stderr);
  assert.deepEqual(readFileSync(registry), contents);
});

windowsTest('Windows refuses an unsafe SQLite sidecar before opening the index', t => {
  const fixture = setup(t);
  const { checkout, registry, cli } = fixture;
  cli('register', 'project', checkout);
  cli('refresh', 'project');
  const directory = dirname(registry);
  const [index] = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
  const path = join(directory, `${index}-wal`);
  const contents = 'unsafe sidecar fixture';
  writeFileSync(path, contents);
  execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:R']);
  const result = runWithEnv(fixture, process.env, 'refresh', 'project');
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /index_unavailable/);
  assert.ok(result.stderr.includes(path), result.stderr);
  assert.equal(readFileSync(path, 'utf8'), contents);
});


linuxTest('Ubuntu rejects unsupported filesystems and unsafe registry ancestors', t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  const before = readFileSync(fixture.registry);
  const wrongVolume = runWithEnv(fixture, process.env, 'register', 'beta', fixture.checkout, '/dev/shm');
  assert.equal(wrongVolume.status, 1);
  assert.match(wrongVolume.stderr, /local ext4 directory.*\/dev\/shm/);

  chmodSync(fixture.work, 0o777);
  const unsafe = runWithEnv(fixture, process.env, 'register', 'beta', fixture.checkout);
  assert.equal(unsafe.status, 1);
  assert.ok(unsafe.stderr.includes(fixture.work));
  assert.match(unsafe.stderr, /local ext4.*0700/);
  assert.deepEqual(readFileSync(fixture.registry), before);
});

linuxTest('Ubuntu refuses inheritable ACLs before writing registry changes', t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  const before = readFileSync(fixture.registry);
  const parent = dirname(fixture.registry);
  const files = readdirSync(parent);
  execFileSync('setfacl', ['-m', 'd:u:65534:r-x', parent]);
  assert.equal(statSync(parent).mode & 0o077, 0);

  const result = runWithEnv(fixture, process.env, 'register', 'beta', fixture.checkout);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /registry_unavailable/);
  assert.ok(result.stderr.includes(parent));
  assert.deepEqual(readFileSync(fixture.registry), before);
  assert.deepEqual(readdirSync(parent), files);
});

linuxTest('Ubuntu refuses an ACL on an owner-only SQLite sidecar before opening SQLite', t => {
  const fixture = setup(t);
  fixture.cli('register', 'alpha', fixture.checkout);
  fixture.cli('refresh', 'alpha');
  const directory = dirname(fixture.registry);
  const [index] = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
  const path = join(directory, `${index}-wal`);
  const contents = 'unsafe sidecar fixture';
  writeFileSync(path, contents, { mode: 0o600 });
  execFileSync('setfacl', ['-m', 'u:65534:r--,m::---', path]);
  assert.equal(statSync(path).mode & 0o077, 0);

  const result = runWithEnv(fixture, process.env, 'refresh', 'alpha');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /index_unavailable/);
  assert.ok(result.stderr.includes(path), result.stderr);
  assert.equal(readFileSync(path, 'utf8'), contents);
});

linuxTest('Ubuntu rejects bind mounts as roots and skips them inside roots',
  { skip: process.env.MARGIN_TEST_BIND_MOUNTS !== '1', timeout: 15000 }, async t => {
    const fixture = setup(t);
    const mountPoint = join(fixture.notes, 'bind');
    mkdirSync(mountPoint);
    writeFileSync(join(fixture.checkout, 'unrelated.md'), 'Outside the context root.\n');
    execFileSync('sudo', ['-n', 'mount', '--bind', fixture.checkout, mountPoint]);
    t.after(() => execFileSync('sudo', ['-n', 'umount', mountPoint]));

    fixture.cli('register', 'alpha', fixture.checkout, fixture.notes);
    fixture.cli('refresh', 'alpha');
    const result = runWithEnv(fixture, process.env, 'add-checkout', 'alpha', 'extra', mountPoint);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /local ext4/);
    assert.ok(result.stderr.includes(mountPoint), result.stderr);

    const client = await connect(t, fixture);
    const { sources } = await client.call('list_sources', { projectId: 'alpha' });
    assert.deepEqual(sources.map(source => [source.rootId, source.relativePath]), [['code', 'unrelated.md']]);
    const sourceId = Buffer.from(JSON.stringify(['alpha', 'notes', 'bind/unrelated.md'])).toString('base64url');
    assert.deepEqual(await client.call('read_source', { projectId: 'alpha', sourceId }), { error: 'source_unavailable' });
  });
