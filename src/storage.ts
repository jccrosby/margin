import { basename, dirname } from 'node:path';
import { createPrivateDirectory, requirePrivateAccess, withDirectory, withEntry } from './filesystem.ts';

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

export function readPrivateFile<T>(path: string, use: (fd: number) => T) {
  return withDirectory(dirname(path), directory => {
    requirePrivateAccess(directory);
    return withEntry(directory, basename(path), false, fd => {
      requirePrivateAccess(fd);
      return use(fd);
    });
  });
}
