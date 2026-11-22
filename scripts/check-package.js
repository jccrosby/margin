import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

assert.ok(process.argv[2], 'Pass the path to the package tarball.');
assert.ok(process.argv[3] === undefined || process.argv[3] === '--candidate', 'Use --candidate to test a release candidate.');
const tarball = resolve(process.argv[2]);
const candidate = process.argv[3] === '--candidate';
const windows = process.platform === 'win32';
const macos = process.platform === 'darwin';
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
  encoding: 'utf8'
}));
if (candidate) {
  assert.ok(manifest.os?.includes(process.platform), 'The tarball must support this operating system.');
  assert.ok(manifest.cpu?.includes(process.arch), 'The tarball must support this architecture.');
} else {
  assert.ok(Array.isArray(manifest.os) && manifest.os.length === 1 && manifest.os[0] === 'darwin',
    'Release blocked. Run the required native checks and qualify the same tarball on all three targets before enabling cross-platform publication.');
  assert.deepEqual(manifest.cpu, ['arm64']);
}
const sources = readdirSync(new URL('../src/', import.meta.url));
const compiledFiles = sources.filter(file => file.endsWith('.ts'))
  .map(file => `package/dist/${file.replace(/\.ts$/, '.js')}`);
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split(/\r?\n/);
const addons = { darwin: 'macos', win32: 'windows', linux: 'linux' };
const requiredAddon = `package/dist/${addons[process.platform]}.node`;
const optionalAddons = candidate ? Object.values(addons).map(name => `package/dist/${name}.node`)
  .filter(path => path !== requiredAddon && files.includes(path)) : [];
assert.deepEqual(files.sort(), [
  'package/README.md', 'package/package.json', requiredAddon, ...optionalAddons, ...compiledFiles
].sort());
assert.equal(manifest.name, '@jccrosby/margin');
assert.deepEqual(manifest.bin, { margin: 'dist/margin.js' });

const work = realpathSync(mkdtempSync(join(tmpdir(), 'margin-package-')));
try {
  const checkout = join(work, 'checkout á');
  const extra = join(work, 'another checkout');
  const registry = join(work, 'Registry á', 'projects.json');
  for (const root of [checkout, extra]) {
    mkdirSync(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'Synthetic release check\n');
  }

  const registryArgs = ['--registry', registry];
  const env = { ...process.env, npm_config_cache: join(work, 'npm-cache') };
  let executable;
  let args;
  if (windows) {
    const install = join(work, 'Margin á');
    const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(install);
    execFileSync(process.execPath, [npm, 'install', '--prefix', install, '--ignore-scripts', tarball], {
      cwd: work, env, stdio: 'inherit'
    });
    executable = process.execPath;
    args = [join(install, 'node_modules', '@jccrosby', 'margin', 'dist', 'margin.js'), ...registryArgs];
  } else {
    executable = 'npx';
    args = ['--yes', '--package', tarball, '--', 'margin', ...registryArgs];
  }
  if (macos) {
    const pnpmArgs = ['dlx', '--reporter=silent', '--', tarball];
    const registration = execFileSync('pnpm', [...pnpmArgs, ...registryArgs, 'register', 'smoke', checkout], {
      cwd: work, encoding: 'utf8', env: {
        ...process.env, PNPM_CONFIG_STORE_DIR: join(work, 'pnpm-store'), XDG_CACHE_HOME: join(work, 'pnpm-cache')
      }
    });
    assert.equal(registration.trim(), 'Registered smoke.');
  } else {
    assert.equal(execFileSync(executable, [...args, 'register', 'smoke', checkout], {
      cwd: work, env, encoding: 'utf8'
    }).trim(), 'Registered smoke.');
  }
  execFileSync(executable, [...args, 'add-checkout', 'smoke', 'extra', extra], { cwd: work, env });
  execFileSync(executable, [...args, 'refresh', 'smoke'], { cwd: work, env });

  const server = spawn(executable, [...args, 'serve'], { cwd: work, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  const deadline = setTimeout(() => {
    lines.close();
    server.kill();
  }, 15_000);
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
    const stop = setTimeout(() => server.kill(), 1000);
    await exited;
    clearTimeout(stop);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('Checked the tarball, installed CLI, and MCP project and source listings.');
