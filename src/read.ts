import { fstatSync, readFileSync, readSync } from 'node:fs';
import { MarginError } from './registry.ts';

export const maxBytes = 32 * 1024;
export function readLines(fd: number, startLine: number, lineCount: number) {
  return readRange(fd, startLine, lineCount);
}

export function readBytes(fd: number, limit: number) {
  if (fstatSync(fd).size > limit) throw new MarginError('source_too_large');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (let size = readSync(fd, buffer); size > 0; size = readSync(fd, buffer)) {
    total += size;
    if (total > limit) throw new MarginError('source_too_large');
    chunks.push(Buffer.from(buffer.subarray(0, size)));
  }
  return Buffer.concat(chunks, total);
}

export function readText(fd: number, checkBytes?: (bytes: Buffer) => void) {
  const bytes = readFileSync(fd);
  checkBytes?.(bytes);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function readRange(fd: number, startLine: number, lineCount: number) {
  const buffer = Buffer.alloc(16 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const lines: string[] = [];
  let parts: Buffer[] = [];
  let line = 1;
  let bytes = 0;

  function finish(nextStartLine?: number) {
    const bounds = lines.length ? { startLine, endLine: startLine + lines.length - 1 } : {};
    return { ...bounds, text: lines.join(''), nextStartLine };
  }

  for (let size = readSync(fd, buffer); size > 0; size = readSync(fd, buffer)) {
    const chunk = buffer.subarray(0, size);
    let offset = 0;
    while (offset < size) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? size : newline + 1;
      if (line >= startLine) {
        if (lines.length === lineCount || bytes + end - offset > maxBytes) {
          if (!lines.length) throw new MarginError('line_too_long');
          return finish(line);
        }
        parts.push(Buffer.from(chunk.subarray(offset, end)));
        bytes += end - offset;
      }
      if (newline !== -1) {
        if (parts.length) {
          lines.push(decoder.decode(Buffer.concat(parts)));
          parts = [];
        }
        line++;
      }
      offset = end;
    }
  }

  if (parts.length) lines.push(decoder.decode(Buffer.concat(parts)));
  return finish();
}
