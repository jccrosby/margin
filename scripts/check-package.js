import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

assert.ok(process.argv[2], 'Pass the path to the npm tarball.');
const tarball = resolve(process.argv[2]);
const sources = readdirSync(new URL('../src/', import.meta.url));
const compiledFiles = sources.filter(file => file.endsWith('.ts'))
  .map(file => `package/dist/${file.replace(/\.ts$/, '.js')}`);
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
assert.deepEqual(files.sort(), ['package/README.md', 'package/package.json', ...compiledFiles].sort());
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
  encoding: 'utf8'
}));
assert.equal(manifest.name, '@jccrosby/margin');

const work = realpathSync(mkdtempSync(join(tmpdir(), 'margin-package-')));
try {
  const checkout = join(work, 'checkout');
  const registry = join(work, 'registry', 'projects.json');
  mkdirSync(checkout);
  execFileSync('git', ['init', '--quiet'], { cwd: checkout });
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--no-save', tarball], { cwd: work, stdio: 'inherit' });

  const executable = join(work, 'node_modules', '.bin', 'margin');
  const registryArgs = ['--registry', registry];
  const registration = execFileSync(executable, [...registryArgs, 'register', 'smoke', checkout], {
    cwd: work, encoding: 'utf8'
  });
  assert.equal(registration.trim(), 'Registered smoke.');

  const server = spawn(executable, [...registryArgs, 'serve'], { cwd: work, stdio: ['pipe', 'pipe', 'inherit'] });
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
    server.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    const { value: tools } = await responses.next();
    assert.ok(tools, 'The installed MCP server did not list its tools.');
    const toolList = JSON.parse(tools);
    assert.equal(toolList.id, 2);
    assert.ok(toolList.result?.tools?.some(tool => tool.name === 'list_projects'), tools);
  } finally {
    clearTimeout(deadline);
    lines.close();
    server.kill();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('Checked the tarball files, installed CLI, and MCP handshake.');
