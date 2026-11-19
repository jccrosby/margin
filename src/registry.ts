import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

import { requireGitCheckout } from './git.ts';

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
  approvedUrls: z.array(z.string().refine(value => approvedHttpsUrl(value) === value)).optional(),
  roots: z.array(root).min(1).refine(roots => new Set(roots.map(root => root.id)).size === roots.length)
});
const registry = z.strictObject({ projects: z.record(id, project) });

export type Root = z.infer<typeof root>;
export type Project = z.infer<typeof project>;

export class MarginError extends Error {}

export function loadRegistry(path: string) {
  return registry.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function canonicalLocation(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || lstatOrMissing(path)) throw error;
    return join(canonicalLocation(dirname(path)), relative(dirname(path), path));
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
  requireGitCheckout(roots[0].path);
  if (notes !== undefined) roots.push({ id: 'notes', kind: 'context', path: directory(notes) });

  checkOutsideRoots(canonicalLocation(path), roots);
  writeProject(path, projectId, old => ({
    ...old,
    roots: [...roots, ...(old?.roots.filter(root => root.id !== 'code' && root.id !== 'notes') ?? [])]
  }));
}

export function addCheckout(path: string, projectId: string, rootId: string, checkout: string) {
  id.parse(rootId);
  if (rootId === 'code' || rootId === 'notes') throw new Error('Choose a new root ID.');
  const root: Root = { id: rootId, kind: 'git', path: directory(checkout) };
  requireGitCheckout(root.path);
  checkOutsideRoots(canonicalLocation(path), [root]);
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

function writeProject(path: string, projectId: string, update: (current: Project | undefined) => Project) {
  id.parse(projectId);
  const destination = canonicalLocation(path);
  if (lstatOrMissing(destination)) {
    checkOutsideRoots(destination, Object.values(loadRegistry(destination).projects).flatMap(project => project.roots));
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const lock = `${destination}.lock`;
  const descriptor = openSync(lock, 'wx', 0o600);
  try {
    const current = lstatOrMissing(destination) ? loadRegistry(destination) : { projects: {} };
    const old = Object.hasOwn(current.projects, projectId) ? current.projects[projectId] : undefined;
    const next = update(old);
    checkOutsideRoots(destination, [...Object.values(current.projects).flatMap(project => project.roots), ...next.roots]);
    const projects = { ...current.projects, [projectId]: next };
    const temporary = mkdtempSync(join(dirname(destination), '.margin-'));
    try {
      const staged = join(temporary, 'projects.json');
      writeFileSync(staged, JSON.stringify({ projects }, null, 2) + '\n', { mode: 0o600 });
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
  if (!isAbsolute(path)) throw new Error('Use absolute root paths.');
  const canonical = realpathSync.native(path);
  if (!lstatSync(canonical).isDirectory()) throw new Error('A root must be a directory.');
  return canonical;
}

export function checkOutsideRoots(path: string, roots: Root[], name = 'registry') {
  for (const root of roots) {
    const locations = [root.path];
    try {
      locations.push(canonicalLocation(root.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !['EACCES', 'ENOENT', 'ELOOP', 'ENOTDIR', 'EPERM'].includes(code)) throw error;
    }
    if (locations.some(location => {
      const suffix = relative(location, path);
      return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
    })) {
      throw new Error(`Put the ${name} outside the source roots.`);
    }
  }
}
