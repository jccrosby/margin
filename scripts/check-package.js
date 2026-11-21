import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

assert.ok(process.argv[2], 'Pass the path to the package tarball.');
const tarball = resolve(process.argv[2]);
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
  encoding: 'utf8'
}));
assert.ok(Array.isArray(manifest.os) && manifest.os.length === 1 && manifest.os[0] === 'darwin',
  'Release blocked. Run the required native checks and qualify the same tarball on all three targets before enabling cross-platform publication.');
assert.deepEqual(manifest.cpu, ['arm64']);
const sources = readdirSync(new URL('../src/', import.meta.url));
const compiledFiles = sources.filter(file => file.endsWith('.ts'))
  .map(file => `package/dist/${file.replace(/\.ts$/, '.js')}`);
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
assert.deepEqual(files.sort(), [
  'package/README.md', 'package/package.json', 'package/dist/macos.node', ...compiledFiles
].sort());
assert.equal(manifest.name, '@jccrosby/margin');
assert.deepEqual(manifest.bin, { margin: 'dist/margin.js' });

const work = realpathSync(mkdtempSync(join(tmpdir(), 'margin-package-')));
try {
  const checkout = join(work, 'checkout á');
  const extra = join(work, 'another checkout');
  const registry = join(work, 'registry', 'projects.json');
  for (const root of [checkout, extra]) {
    mkdirSync(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'Synthetic release check\n');
  }

  const registryArgs = ['--registry', registry];
  const pnpmArgs = ['dlx', '--reporter=silent', `--store-dir=${join(work, 'pnpm-store')}`, '--', tarball];
  const registration = execFileSync('pnpm', [...pnpmArgs, ...registryArgs, 'register', 'smoke', checkout], {
    cwd: work, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: join(work, 'pnpm-cache') }
  });
  assert.equal(registration.trim(), 'Registered smoke.');

  const npmArgs = ['--yes', '--package', tarball, '--', 'margin', ...registryArgs];
  const env = { ...process.env, npm_config_cache: join(work, 'npm-cache') };
  execFileSync('npx', [...npmArgs, 'add-checkout', 'smoke', 'extra', extra], { cwd: work, env });
  execFileSync('npx', [...npmArgs, 'refresh', 'smoke'], { cwd: work, env });

  const server = spawn('npx', [...npmArgs, 'serve'], { cwd: work, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: server.stdout });
  const deadline = setTimeout(() => server.kill(), 10_000);
  try {
    const responses = lines[Symbol.asyncIterator]();
    server.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'margin-package-check', version: '1' }
      }
    }) + '\n');
    const { value } = await responses.next();
    assert.ok(value, 'The installed MCP server closed without replying.');
    const response = JSON.parse(value);
    assert.equal(response.id, 1);
    assert.equal(response.result?.serverInfo?.name, 'margin', value);
    assert.equal(response.result.serverInfo.version, manifest.version, value);
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    for (const [index, name, args, key, expected] of [
      [2, 'list_projects', {}, 'projects', [{ projectId: 'smoke', name: 'smoke' }]],
      [3, 'list_sources', { projectId: 'smoke' }, 'sources', ['code', 'extra']]
    ]) {
      server.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: index, method: 'tools/call', params: { name, arguments: args }
      }) + '\n');
      const { value: reply } = await responses.next();
      assert.ok(reply, `The installed MCP server did not answer ${name}.`);
      const tool = JSON.parse(reply);
      assert.equal(tool.id, index);
      const items = tool.result?.structuredContent?.[key];
      const actual = key === 'sources' ? items?.map(source => source.rootId) : items;
      assert.deepEqual(actual, expected, reply);
    }
  } finally {
    clearTimeout(deadline);
    lines.close();
    server.stdin.end();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('Checked the tarball, both CLI launchers, and MCP project and source listings.');
