import { closeSync, constants, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getSystemErrorName } from 'node:util';

const require = createRequire(import.meta.url);
export const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
export const localFilesystem = windows ? 'NTFS' : linux ? 'ext4' : 'APFS';
const addon = windows ? 'windows' : linux ? 'linux' : 'macos';
const macos = process.platform === 'darwin';
if ((!windows && !linux && !macos) || process.arch !== (macos ? 'arm64' : 'x64')) {
  throw new Error('Run Margin on macOS ARM64, Windows x64, or Ubuntu x64.');
}
const native = require(fileURLToPath(new URL(`../dist/${addon}.node`, import.meta.url))) as {
  verifyVolume(path: string): number;
  openDirectory(path: string): number;
  openEntry(directory: number, path: string, isDirectory: boolean, exact: boolean): number;
  entries(directory: number): [Buffer, 'directory' | 'file'][] | number;
  privateAccess(fd: number, ancestor: boolean): boolean | number;
  entryPath(fd: number): string | number;
  createPrivateDirectory(path: string): number;
  changeDirectory(fd: number): number;
  fileLock(fd: number, operation: number): boolean | number;
  publish(from: string, to: string): number;
};

const windowsErrors = new Map<number, string>([
  [2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [17, 'EXDEV'], [32, 'EACCES'], [50, 'ENOTSUP'],
  [80, 'EEXIST'], [87, 'EINVAL'], [123, 'EINVAL'], [183, 'EEXIST'], [267, 'ENOTDIR'],
  [681, 'ELOOP'], [1920, 'ELOOP'], [1921, 'ELOOP'], [4395, 'ELOOP']
]);

function fail(result: number): never {
  const code = windows ? windowsErrors.get(-result) ?? 'EIO' : getSystemErrorName(result);
  throw Object.assign(new Error(code), { code });
}

function check(result: number) {
  return result < 0 ? fail(result) : result;
}

export function isWindowsPathSegment(part: string) {
  return !/[\\/:<>"|?*\x00-\x1f]|[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part);
}

export function isNativeAbsolutePath(path: string) {
  if (!path.isWellFormed() || path.includes('\0')) return false;
  if (!windows) return path.startsWith('/');
  if (!/^[a-z]:[\\/]/i.test(path)) return false;
  return path.slice(3).split(/[\\/]/).every(part => !part || part === '.' || part === '..' || isWindowsPathSegment(part));
}

export function verifyVolume(path: string) {
  if (windows) check(native.verifyVolume(path));
}

export function createPrivateDirectory(path: string) {
  if (windows) check(native.createPrivateDirectory(path));
  else mkdirSync(path, { mode: 0o700 });
}

export function withDirectory<T>(path: string, use: (fd: number) => T): T {
  const fd = check(native.openDirectory(path));
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

export function openEntry(directory: number, path: string, isDirectory: boolean, exact = false) {
  return check(native.openEntry(directory, path, isDirectory, exact));
}

export function withEntry<T>(directory: number, path: string, isDirectory: boolean, use: (fd: number) => T,
  exact = false
): T {
  const fd = openEntry(directory, path, isDirectory, exact);
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

export function readEntries(fd: number) {
  const entries = native.entries(fd);
  if (typeof entries === 'number') fail(entries);
  return entries;
}

export function entryPath(fd: number) {
  const path = native.entryPath(fd);
  if (typeof path === 'number') fail(path);
  return path;
}

export function requirePrivateAccess(fd: number, ancestor = false) {
  if (native.privateAccess(fd, ancestor) !== true) throw new Error('Unsafe permissions, ownership, or ACL.');
}

export function tryFileLock(fd: number, exclusive: boolean) {
  const result = native.fileLock(fd, exclusive ? 2 : 1);
  return typeof result === 'number' ? fail(result) : result;
}

export function unlockFile(fd: number) {
  native.fileLock(fd, 0);
}

export function publishExclusive(from: string, to: string) {
  check(native.publish(from, to));
}

export function syncDirectory(path: string) {
  if (!windows) withDirectory(path, fsyncSync);
}

export function runInDirectory<T>(directory: number, run: (cwd?: string) => T): T {
  if (windows) return run(entryPath(directory));
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
