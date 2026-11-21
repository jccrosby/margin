import { closeSync, constants, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';

const require = createRequire(import.meta.url);
const native = require(fileURLToPath(new URL('../dist/macos.node', import.meta.url))) as {
  openDirectory(path: string): number;
  openEntry(directory: number, path: string, isDirectory: boolean, exact: boolean): number;
  entries(directory: number): [Buffer, 'directory' | 'file'][] | number;
  privateAccess(fd: number, ancestor: boolean): boolean | number;
  entryPath(fd: number): string | number;
  changeDirectory(fd: number): number;
  publish(from: string, to: string): number;
};

function check(result: number) {
  if (result >= 0) return result;
  const code = getSystemErrorName(result);
  throw Object.assign(new Error(code), { code });
}

export function withDirectory<T>(path: string, use: (fd: number) => T): T {
  const fd = check(native.openDirectory(path));
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

export function withEntry<T>(directory: number, path: string, isDirectory: boolean, use: (fd: number) => T,
  exact = false
): T {
  const fd = check(native.openEntry(directory, path, isDirectory, exact));
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

export function readEntries(fd: number) {
  const entries = native.entries(fd);
  if (typeof entries === 'number') throw new Error(getSystemErrorName(entries));
  return entries;
}

export function entryPath(fd: number) {
  const path = native.entryPath(fd);
  if (typeof path === 'number') throw new Error(getSystemErrorName(path));
  return path;
}

export function requirePrivateAccess(fd: number, ancestor = false) {
  if (native.privateAccess(fd, ancestor) !== true) throw new Error('Unsafe permissions, ownership, or ACL.');
}

export function publishExclusive(from: string, to: string) {
  check(native.publish(from, to));
}

export function runInDirectory<T>(directory: number, run: () => T): T {
  // Git inherits the verified directory. Keep this callback synchronous.
  const cwd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    check(native.changeDirectory(directory));
    try {
      return run();
    } finally {
      check(native.changeDirectory(cwd));
    }
  } finally {
    closeSync(cwd);
  }
}
