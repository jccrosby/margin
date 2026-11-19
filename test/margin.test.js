import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
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

async function connect(t, { work, registry, env = process.env }) {
  const child = spawn(process.execPath, [entry, '--registry', registry, 'serve'], { cwd: work, env });
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
  assert.deepEqual(tools.map(tool => tool.name), ['list_projects', 'list_sources', 'read_source', 'search_project']);
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

test('a failed root scan preserves that root index while another root publishes', { timeout: 15000 }, async t => {
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

test('an interrupted refresh keeps the last committed index and retry replaces it once', { timeout: 20000 }, async t => {
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
  t.after(() => child.kill('SIGKILL'));
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
