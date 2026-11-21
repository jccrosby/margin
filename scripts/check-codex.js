import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

assert.ok(process.argv[2], 'Pass the path to the Margin tarball.');
const tarball = resolve(process.argv[2]);
const windows = process.platform === 'win32';
const extractors = process.env.MARGIN_TEST_EXTRACTORS === '1';
const media = [
  ['shipping.pdf', 'copper latch', 'extracted_text'],
  ['dispatch.docx', 'violet stamp', 'extracted_text'],
  ['marker.png', 'BLUE', 'ocr'],
  ['demo.mp4', 'blue sign', 'transcript']
];
const work = realpathSync(mkdtempSync(join(tmpdir(), 'margin-codex-')));
try {
  const registry = join(work, 'Registry á', 'projects.json');
  const checkout = join(work, 'Café checkout');
  const extraCheckout = join(work, 'Extra checkout');
  const otherCheckout = join(work, 'Other checkout');
  const source = join(checkout, 'café.md');
  const text = 'Project checklist\nThe maple owls are ready.\n';
  execFileSync('git', ['init', '-q', checkout]);
  execFileSync('git', ['init', '-q', extraCheckout]);
  execFileSync('git', ['init', '-q', otherCheckout]);
  writeFileSync(source, text);
  writeFileSync(join(extraCheckout, 'extra.md'), 'This is a supplemental checkout.\n');
  writeFileSync(join(otherCheckout, 'other.md'), text);
  writeFileSync(join(checkout, '.npmrc'), 'registry=http://127.0.0.1:9/\nfetch-retries=0\n');
  if (extractors) {
    for (const [file] of media) {
      copyFileSync(new URL(`../test/fixtures/evidence/${file}`, import.meta.url), join(checkout, file));
    }
  }

  const env = { ...process.env, npm_config_cache: join(work, 'npm-cache') };
  const registryArgs = ['--registry', registry];
  const executable = windows ? process.execPath : 'npx';
  let args = ['--yes', '--package', tarball, '--', 'margin', ...registryArgs];
  if (windows) {
    const install = join(work, 'Margin é');
    const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(install);
    execFileSync(process.execPath, [npm, 'install', '--prefix', install, '--ignore-scripts', tarball], { cwd: work, env });
    args = [join(install, 'node_modules', '@jccrosby', 'margin', 'dist', 'margin.js'), ...registryArgs];
  }
  const margin = (...command) => execFileSync(executable, [...args, ...command], { cwd: work, env });
  margin('register', 'demo', checkout);
  margin('add-checkout', 'demo', 'extra', extraCheckout);
  margin('refresh', 'demo');
  margin('register', 'private', otherCheckout);
  margin('refresh', 'private');

  const launcher = windows ? executable : '/usr/bin/env';
  const launch = windows ? [...args, 'serve'] : ['-C', work, executable, ...args, 'serve'];
  const settings = [
    `mcp_servers={margin={command=${JSON.stringify(launcher)}, args=${JSON.stringify(launch)}, ` +
      `env={npm_config_cache=${JSON.stringify(join(work, 'codex-npm-cache'))}}}}`,
    `sqlite_home=${JSON.stringify(work)}`
  ].flatMap(setting => ['-c', setting]);
  const codex = process.argv[3] ?? 'codex';
  const useNode = windows && codex.endsWith('.js');
  const appServer = ['app-server', ...settings];
  const child = spawn(useNode ? process.execPath : codex, useNode ? [codex, ...appServer] : appServer, {
    cwd: checkout, env, stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(45_000)
  });
  const exited = once(child, 'close');
  void exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let sequence = 0;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  async function request(method, params) {
    const id = ++sequence;
    send({ jsonrpc: '2.0', id, method, params });
    for (;;) {
      const { value } = await replies.next();
      assert.ok(value, `Codex exited before replying to ${method}.`);
      const reply = JSON.parse(value);
      if (reply.id !== id) continue;
      assert.ok(!reply.error, JSON.stringify(reply.error));
      return reply.result;
    }
  }

  try {
    await request('initialize', { clientInfo: { name: 'margin-package-check', version: '1' } });
    send({ jsonrpc: '2.0', method: 'initialized' });
    const { thread } = await request('thread/start', { cwd: checkout, ephemeral: true });
    const callResult = async (tool, args, error) => {
      const reply = await request('mcpServer/tool/call', { threadId: thread.id, server: 'margin', tool, arguments: args });
      assert.equal(Boolean(reply.isError), Boolean(error), JSON.stringify(reply));
      if (error) assert.deepEqual(reply.structuredContent, { error });
      return reply;
    };
    const call = async (...args) => (await callResult(...args)).structuredContent;
    const projectId = 'demo';
    assert.deepEqual((await call('list_projects', {})).projects.map(project => project.projectId), ['demo', 'private']);
    const { sources } = await call('list_sources', { projectId });
    const expected = [['code', 'café.md'], ['extra', 'extra.md']];
    if (extractors) expected.push(...media.map(([file]) => ['code', file]));
    assert.deepEqual(sources.map(item => [item.rootId, item.relativePath]).sort(), expected.sort());
    const { sourceId } = sources.find(source => source.relativePath === 'café.md');
    const read = await call('read_source', { projectId, sourceId, startLine: 2, lineCount: 1 });
    assert.equal(read.text, 'The maple owls are ready.\n');
    await call('read_source', { projectId: 'private', sourceId }, 'source_unavailable');

    const search = mode => call('search_project', { projectId, query: 'maple owls are ready', mode });
    const { hits: ranked } = await search('ranked');
    const { hits: literal } = await search('literal');
    assert.deepEqual(ranked.map(hit => hit.sourceId), [sourceId]);
    assert.deepEqual(literal.map(hit => hit.sourceId), [sourceId]);
    const [{ contentHash, startLine, endLine, text: excerpt }] = ranked;
    const citation = { projectId, sourceId, contentHash, location: { startLine, endLine } };
    const opened = await call('open_evidence', citation);
    assert.equal(opened.contentHash, contentHash);
    assert.equal(opened.text, excerpt);
    writeFileSync(source, 'The new checklist has no birds.\n');
    assert.deepEqual((await search('ranked')).hits, []);
    assert.deepEqual((await search('literal')).hits, []);
    await call('open_evidence', citation, 'stale_citation');
    console.log('A fresh Codex thread read project text, searched both modes, and reopened matching evidence.');
    if (extractors) {
      for (const [file, query, kind] of media) {
        const { hits } = await call('search_project', { projectId, query, mode: 'literal' });
        const hit = hits.find(hit => hit.relativePath === file);
        assert.ok(hit, `Expected ${kind} from ${file}.`);
        const { sourceId, contentHash, location } = hit;
        const args = { projectId, sourceId, contentHash, location };
        const opened = await call('open_evidence', args);
        assert.deepEqual([opened.kind, opened.text, opened.location], [kind, hit.text, location]);
      }
      const image = async (file, extra = {}) => {
        const { sourceId } = sources.find(source => source.relativePath === file);
        const { content } = await callResult('open_evidence', { projectId, sourceId, ...extra });
        const [metadata, image] = content;
        assert.equal(image.type, 'image');
        assert.equal(image.mimeType, 'image/png');
        return { data: image.data, metadata: JSON.parse(metadata.text) };
      };
      const original = await image('marker.png');
      assert.equal(original.metadata.kind, 'image');
      assert.equal(original.data, readFileSync(join(checkout, 'marker.png')).toString('base64'));
      const frame = await image('demo.mp4', { atSeconds: 1.1 });
      assert.equal(frame.metadata.kind, 'frame');
      assert.deepEqual(frame.metadata.location, { timestampSeconds: 1.5 });
      assert.equal(Buffer.from(frame.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      console.log('The Codex thread reopened PDF, Word, OCR, transcript, image, and video frame evidence.');
    }
  } finally {
    lines.close();
    child.stdin.end();
    const stop = setTimeout(() => child.kill(), 1000);
    try {
      await exited;
    } finally {
      clearTimeout(stop);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
