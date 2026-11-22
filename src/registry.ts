import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

import { requireGitCheckout } from './git.ts';
import { entryPath, isNativeAbsolutePath, localFilesystem, requirePrivateAccess, tryFileLock, unlockFile, verifyVolume, windows, withDirectory, withEntry } from './filesystem.ts';
import { isMissing, openPrivateFile, readPrivateFile, requirePrivateDirectory } from './storage.ts';

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const root = z.strictObject({
  id,
  kind: z.enum(['git', 'context']),
  path: z.string().refine(path => isNativeAbsolutePath(path) && normalize(path) === path)
});
export function approvedHttpsUrl(value: string) {
  if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return undefined;
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || !url.hostname ||
      url.username || url.password || value.includes('#')) return undefined;
  return url.href;
}

const project = z.strictObject({
  name: z.string().min(1).optional(),
  noteSavesEnabled: z.boolean().optional(),
  approvedUrls: z.array(z.string().refine(value => approvedHttpsUrl(value) === value)).optional(),
  roots: z.array(root).min(1).refine(roots => new Set(roots.map(root => root.id)).size === roots.length)
});
const registry = z.strictObject({ projects: z.record(id, project) });

export type Root = z.infer<typeof root>;
export type Project = z.infer<typeof project>;

export class MarginError extends Error {
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.detail = detail;
  }
}

export function unsafeStorage(code: string, path: string) {
  if (windows) {
    return new MarginError(code, `Check ${path}. Use a private directory on a local NTFS drive. ` +
      'Remove other users’ access grants and links, or choose a directory under your Windows profile.');
  }
  return new MarginError(code, `Check ${JSON.stringify(path)}. Use a local ${localFilesystem} directory you own with mode 0700. ` +
    'Set files to mode 0600. Remove ACL grants and links, or choose a different private location.');
}

export function loadRegistry(path: string) {
  const destination = registryLocation(path);
  let contents;
  try {
    requirePrivateDirectory(dirname(destination));
    contents = readPrivateFile(destination, fd => readFileSync(fd, 'utf8'));
  } catch (error) {
    throw unsafeStorage('registry_unavailable', (error as NodeJS.ErrnoException).path ?? destination);
  }
  let loaded;
  try {
    loaded = registry.parse(JSON.parse(contents));
  } catch {
    throw new MarginError('registry_unavailable', `Check ${JSON.stringify(destination)}. Restore a valid registry file.`);
  }
  checkOutsideRoots(destination, Object.values(loaded.projects).flatMap(project => project.roots));
  return loaded;
}

export function registryLocation(path: string) {
  if ((windows ? path.split(/[\\/]/) : path.split(sep)).includes('..')) {
    throw new MarginError('registry_unavailable',
      `Check ${windows ? path : JSON.stringify(path)}. Use an absolute registry path without '..' segments.`);
  }
  try {
    return canonicalStoragePath(path, false);
  } catch {
    throw unsafeStorage('registry_unavailable', path);
  }
}

export function canonicalStoragePath(path: string, directory: boolean) {
  if (!isNativeAbsolutePath(path) || (windows ? path.split(/[\\/]/) : path.split(sep)).includes('..')) {
    throw new Error('Use an absolute path without parent segments.');
  }
  const normalized = normalize(path);
  verifyVolume(normalized);
  const location = windows ? normalized : resolveSystemAlias(normalized);
  const name = basename(location);
  const parent = canonicalParent(dirname(location));
  try {
    return withDirectory(parent, fd => withEntry(fd, name, directory, entryPath));
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(parent, name);
  }
}

function resolveSystemAlias(path: string) {
  // Allow root-owned aliases such as /tmp. Reject links inside managed paths.
  const systemDirectory = `/${path.split('/')[1]}`;
  const entry = lstatOrMissing(systemDirectory);
  return entry?.uid === 0 && entry.isSymbolicLink() && systemDirectory !== path
    ? join(realpathSync.native(systemDirectory), path.slice(systemDirectory.length))
    : path;
}

function canonicalParent(path: string): string {
  try {
    return withDirectory(path, entryPath);
  } catch (error) {
    if (!isMissing(error) || dirname(path) === path) throw error;
    return join(canonicalParent(dirname(path)), basename(path));
  }
}

function lstatOrMissing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function registryWriteLock(registry: string, mode: 'shared' | 'exclusive' = 'shared') {
  loadRegistry(registry);
  return acquireRegistryWriteLock(registry, mode);
}

function acquireRegistryWriteLock(registry: string, mode: 'shared' | 'exclusive') {
  const parent = dirname(registry);
  const hash = createHash('sha256').update(basename(registry)).digest('hex');
  // Keep the file so every process locks the same file identity.
  const path = join(parent, `.margin-writers-${hash}.lock`);
  let fd;
  let acquired = false;
  try {
    requirePrivateDirectory(parent);
    try {
      fd = openPrivateFile(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        fd = openSync(path, 'wx+', 0o600);
        requirePrivateAccess(fd);
      } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError;
        fd = openPrivateFile(path);
      }
    }
    acquired = tryFileLock(fd, mode);
  } catch (error) {
    throw unsafeStorage('registry_unavailable', (error as NodeJS.ErrnoException).path ?? path);
  } finally {
    if (!acquired && fd !== undefined) closeSync(fd);
  }
  if (!acquired) {
    throw new MarginError('registry_busy', `Wait for the Margin writer or note recovery command to finish. Check ${registry}.`);
  }
  const lock = fd;
  return {
    [Symbol.dispose]() {
      unlockFile(lock);
      closeSync(lock);
    }
  };
}

export function register(path: string, projectId: string, checkout: string, notes?: string) {
  id.parse(projectId);
  const roots: Root[] = [{ id: 'code', kind: 'git', path: directory(checkout) }];
  withDirectory(roots[0].path, requireGitCheckout);
  if (notes !== undefined) roots.push({ id: 'notes', kind: 'context', path: directory(notes) });

  checkOutsideRoots(registryLocation(path), roots);
  writeProject(path, projectId, old => ({
    ...old,
    roots: [...roots, ...(old?.roots.filter(root => root.id !== 'code' && root.id !== 'notes') ?? [])]
  }));
}

export function addCheckout(path: string, projectId: string, rootId: string, checkout: string) {
  id.parse(rootId);
  if (rootId === 'code' || rootId === 'notes') throw new Error('Choose a new root ID.');
  const root: Root = { id: rootId, kind: 'git', path: directory(checkout) };
  withDirectory(root.path, requireGitCheckout);
  checkOutsideRoots(registryLocation(path), [root]);
  writeProject(path, projectId, project => {
    if (!project) throw new MarginError('project_unavailable');
    return { ...project, roots: [...project.roots.filter(root => root.id !== rootId), root] };
  });
}

export function approveUrl(path: string, projectId: string, value: string) {
  const url = approvedHttpsUrl(value);
  if (!url) throw new Error('Provide an absolute HTTPS URL without credentials or a fragment.');
  writeProject(path, projectId, project => {
    if (!project) throw new MarginError('project_unavailable');
    return { ...project, approvedUrls: [...new Set([...(project.approvedUrls ?? []), url])] };
  });
}

export function setNoteSaves(path: string, projectId: string, enabled: boolean) {
  writeProject(path, projectId, project => {
    if (!project) throw new MarginError('project_unavailable');
    return { ...project, noteSavesEnabled: enabled };
  });
}

function writeProject(path: string, projectId: string, update: (current: Project | undefined) => Project) {
  id.parse(projectId);
  const destination = registryLocation(path);
  if (lstatOrMissing(destination)) loadRegistry(destination);
  const parent = dirname(destination);
  try {
    requirePrivateDirectory(parent, true);
  } catch (error) {
    throw unsafeStorage('registry_unavailable', (error as NodeJS.ErrnoException).path ?? parent);
  }
  using writer = acquireRegistryWriteLock(destination, 'shared');
  const lock = `${destination}.lock`;
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx+', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        readPrivateFile(lock, () => undefined);
      } catch {
        throw unsafeStorage('registry_unavailable', lock);
      }
      throw new Error(`Registry lock exists at ${lock}. Retry after the other Margin command finishes.`);
    }
    throw unsafeStorage('registry_unavailable', (error as NodeJS.ErrnoException).path ?? parent);
  }
  try {
    requirePrivateAccess(descriptor);
    const current = lstatOrMissing(destination) ? loadRegistry(destination) : { projects: {} };
    const old = Object.hasOwn(current.projects, projectId) ? current.projects[projectId] : undefined;
    const next = update(old);
    checkOutsideRoots(destination, [...Object.values(current.projects).flatMap(project => project.roots), ...next.roots]);
    const projects = { ...current.projects, [projectId]: next };
    const temporary = mkdtempSync(join(parent, '.margin-'));
    try {
      requirePrivateDirectory(temporary);
      const staged = join(temporary, 'projects.json');
      const fd = openSync(staged, 'wx+', 0o600);
      try {
        requirePrivateAccess(fd);
        writeFileSync(fd, JSON.stringify({ projects }, null, 2) + '\n');
      } finally {
        closeSync(fd);
      }
      renameSync(staged, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } finally {
    closeSync(descriptor);
    rmSync(lock);
  }
}

function directory(path: string) {
  try {
    if (!isNativeAbsolutePath(path)) throw new Error('Relative root path.');
    verifyVolume(normalize(path));
    const canonical = realpathSync.native(path);
    if (!isNativeAbsolutePath(canonical)) throw new Error('Unsupported root path.');
    withDirectory(canonical, () => undefined);
    return canonical;
  } catch {
    throw new MarginError('root_unavailable', `Use an absolute path to a local ${localFilesystem} directory. Check ${path}.`);
  }
}

export function checkOutsideRoots(path: string, roots: Root[], name = 'registry') {
  const within = (location: string) => {
    if (windows) return path === location || path.startsWith(location.endsWith(sep) ? location : location + sep);
    const suffix = relative(location, path);
    return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  const ancestors = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      ancestors.push(statSync(current, { bigint: true }));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(current) === current) break;
  }
  for (const root of roots) {
    let matches = within(root.path);
    try {
      const source = withDirectory(root.path, fd => fstatSync(fd, { bigint: true }));
      matches ||= ancestors.some(ancestor => ancestor.dev === source.dev && ancestor.ino === source.ino);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !['EACCES', 'ENOENT', 'ELOOP', 'ENOTDIR', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
    }
    if (matches) throw new Error(`Put the ${name} outside the source roots. Check ${path}.`);
  }
}
