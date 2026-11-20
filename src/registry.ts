import {
  closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

import { requireGitCheckout } from './git.ts';
import { entryPath, requirePrivateAccess, withDirectory, withEntry } from './macos.ts';
import { isMissing, readPrivateFile, requirePrivateDirectory } from './storage.ts';

export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const root = z.strictObject({
  id,
  kind: z.enum(['git', 'context']),
  path: z.string().refine(path => isAbsolute(path) && normalize(path) === path)
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
  return new MarginError(code, `Check ${JSON.stringify(path)}. Use a local APFS directory you own with mode 0700. ` +
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
  try {
    if (!isAbsolute(path) || !path.isWellFormed()) throw new Error('Invalid registry path.');
    const normalized = normalize(path);
    const systemDirectory = `/${normalized.split('/')[1]}`;
    const entry = lstatOrMissing(systemDirectory);
    // Allow root-owned aliases such as /tmp. Reject links inside managed paths.
    const location = entry?.uid === 0 && entry.isSymbolicLink() && systemDirectory !== normalized
      ? join(realpathSync.native(systemDirectory), normalized.slice(systemDirectory.length))
      : normalized;
    const name = basename(location);
    const parent = canonicalParent(dirname(location));
    try {
      return withDirectory(parent, fd => withEntry(fd, name, false, entryPath));
    } catch (error) {
      if (!isMissing(error)) throw error;
      return join(parent, name);
    }
  } catch {
    throw unsafeStorage('registry_unavailable', path);
  }
}

function canonicalParent(path: string): string {
  try {
    return withDirectory(path, entryPath);
  } catch (error) {
    if (!isMissing(error) || path === '/') throw error;
    return join(canonicalParent(dirname(path)), basename(path));
  }
}

function lstatOrMissing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  const lock = `${destination}.lock`;
  let descriptor;
  try {
    requirePrivateDirectory(parent, true);
    descriptor = openSync(lock, 'wx', 0o600);
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
      const fd = openSync(staged, 'wx', 0o600);
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
    if (!isAbsolute(path) || !path.isWellFormed()) throw new Error('Relative root path.');
    const canonical = realpathSync.native(path);
    withDirectory(canonical, () => undefined);
    return canonical;
  } catch {
    throw new MarginError('root_unavailable', `Use an absolute path to a local APFS directory. Check ${path}.`);
  }
}

export function checkOutsideRoots(path: string, roots: Root[], name = 'registry') {
  const within = (location: string) => {
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
