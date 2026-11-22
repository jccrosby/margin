import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createPrivateDirectory, openEntry, requirePrivateAccess, withDirectory } from './filesystem.ts';

export function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function requirePrivateDirectory(path: string, create = false) {
  const parents = [path];
  while (dirname(parents[0]) !== parents[0]) parents.unshift(dirname(parents[0]));
  for (const directory of parents) {
    const inspect = () => {
      try {
        withDirectory(directory, fd => requirePrivateAccess(fd, directory !== path));
      } catch (error) {
        throw Object.assign(error as Error, { path: directory });
      }
    };
    try {
      inspect();
    } catch (error) {
      if (!create || !isMissing(error)) throw error;
      try {
        createPrivateDirectory(directory);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      inspect();
    }
  }
}

function openVerifiedFile(directory: number, name: string) {
  requirePrivateAccess(directory);
  const fd = openEntry(directory, name, false);
  try {
    requirePrivateAccess(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function openPrivateFile(path: string) {
  return withDirectory(dirname(path), directory => openVerifiedFile(directory, basename(path)));
}

export function readPrivateFile<T>(path: string, use: (fd: number) => T) {
  return withDirectory(dirname(path), directory => {
    const fd = openVerifiedFile(directory, basename(path));
    try {
      return use(fd);
    } finally {
      closeSync(fd);
    }
  });
}

export function writePrivateFile(path: string, data: string | Buffer) {
  const fd = openSync(path, 'wx+', 0o600);
  try {
    requirePrivateAccess(fd);
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
