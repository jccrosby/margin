import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { id } from '../src/registry.ts';

const limit = 5;
const line = z.number().int().positive();
const requiredCitation = z.strictObject({
  rootId: id, relativePath: z.string().min(1), startLine: line, endLine: line
}).refine(range => range.startLine <= range.endLine);
const manifestSchema = z.strictObject({
  cases: z.array(z.strictObject({
    id, projectId: id, question: z.string().min(1), query: z.string().min(1),
    mode: z.enum(['literal', 'ranked']), requires: z.array(requiredCitation).min(1),
    governs: z.string().min(1).optional()
  })).min(1).refine(cases => new Set(cases.map(item => item.id)).size === cases.length)
});
const responseSchema = z.object({
  structuredContent: z.object({
    hits: z.array(z.object({
      sourceId: z.string().min(1), rootId: z.string(), relativePath: z.string(),
      matchedOn: z.enum(['path', 'text']), startLine: line.optional(), endLine: line.optional()
    })).max(limit)
  })
});

async function score(registry: string, manifest: z.infer<typeof manifestSchema>) {
  const margin = fileURLToPath(new URL('../src/margin.ts', import.meta.url));
  const child = spawn(process.execPath, [margin, '--registry', registry, 'serve'], {
    stdio: ['pipe', 'pipe', 'ignore']
  });
  const messages = createInterface({ input: child.stdout });
  child.on('error', () => messages.close());
  child.stdin.on('error', () => messages.close());
  try {
    const responses = messages[Symbol.asyncIterator]();
    let sequence = 0;
    const send = (message: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n',
        error => error ? reject(error) : resolve());
    });
    async function request(method: string, params: Record<string, unknown>) {
      const id = ++sequence;
      await send({ id, method, params });
      const { value, done } = await responses.next();
      if (done) throw new Error('Margin ended before replying.');
      const reply = JSON.parse(value);
      if (reply.id !== id || reply.error || !reply.result) throw new Error('Margin returned an invalid reply.');
      return reply.result;
    }
    await request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'margin-retrieval-scorer', version: '1' }
    });
    await send({ method: 'notifications/initialized' });

    const cases = [];
    for (const item of manifest.cases) {
      const { projectId, query, mode } = item;
      const started = performance.now();
      const result = await request('tools/call', { name: 'search_project', arguments: { projectId, query, mode, limit } });
      const latencyMs = performance.now() - started;
      const { structuredContent: { hits } } = responseSchema.parse(result);
      const missing = item.requires.filter(required => !hits.some(hit => hit.matchedOn === 'text' &&
        hit.rootId === required.rootId && hit.relativePath === required.relativePath &&
        hit.startLine !== undefined && hit.startLine <= required.startLine &&
        hit.endLine !== undefined && hit.endLine >= required.endLine));
      cases.push({ id: item.id, passed: missing.length === 0, latencyMs, missing });
    }
    return cases;
  } finally {
    messages.close();
    child.kill();
  }
}

try {
  const { values: { registry, manifest, details } } = parseArgs({
    options: { registry: { type: 'string' }, manifest: { type: 'string' }, details: { type: 'boolean' } }
  });
  if (!registry || !manifest || !isAbsolute(registry) || !isAbsolute(manifest)) {
    throw new Error('Absolute registry and manifest paths required.');
  }
  const cases = await score(registry, manifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))));
  const latencies = cases.map(item => item.latencyMs).sort((left, right) => left - right);
  const p95Ms = Number(latencies[Math.ceil(0.95 * latencies.length) - 1].toFixed(2));
  console.log(JSON.stringify({
    score: cases.filter(item => item.passed).length, total: cases.length, p95Ms,
    ...(details ? { cases } : {})
  }));
} catch {
  console.error('Could not score retrieval. Check the Margin server, registry, and private manifest.');
  console.error('Usage: node scripts/score-retrieval.ts --registry <absolute-path> --manifest <absolute-path> [--details]');
  process.exitCode = 1;
}
