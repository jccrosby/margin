import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { MarginError } from './registry.ts';

export const maxBytes = 32 * 1024;
// fix: Darwin O_NOFOLLOW_ANY rejects symlinks in every path component during open.
const nofollow = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;

function readSource<T>(path: string, read: (fd: number) => T) {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | nofollow);
    try {
      if (!fstatSync(fd).isFile()) throw new MarginError('source_unavailable');
      return read(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof MarginError) throw error;
    throw new MarginError('source_unavailable');
  }
}

export function readLines(path: string, startLine: number, lineCount: number) {
  return readSource(path, fd => readRange(fd, startLine, lineCount));
}

export function readBytes(path: string, limit: number) {
  return readSource(path, fd => {
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
  });
}

export function readText(path: string, checkBytes?: (bytes: Buffer) => void) {
  return readSource(path, fd => {
    const bytes = readFileSync(fd);
    checkBytes?.(bytes);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  });
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
