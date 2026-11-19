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
const project = z.strictObject({
  name: z.string().min(1).optional(),
  roots: z.array(root).min(1).refine(roots => new Set(roots.map(root => root.id)).size === roots.length)
});
const registry = z.strictObject({ projects: z.record(id, project) });

export type Root = z.infer<typeof root>;
export type Project = z.infer<typeof project>;

export class MarginError extends Error {}

export function loadRegistry(path: string) {
  return registry.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function canonicalLocation(path: string): string {
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

  const destination = canonicalLocation(path);
  checkOutsideRoots(destination, roots);
  if (lstatOrMissing(destination)) {
    checkOutsideRoots(destination, Object.values(loadRegistry(destination).projects).flatMap(project => project.roots));
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const lock = `${destination}.lock`;
  const descriptor = openSync(lock, 'wx', 0o600);
  try {
    const current = lstatOrMissing(destination) ? loadRegistry(destination) : { projects: {} };
    checkOutsideRoots(destination, Object.values(current.projects).flatMap(project => project.roots));
    const projects = {
      ...current.projects,
      [projectId]: { ...(Object.hasOwn(current.projects, projectId) ? current.projects[projectId] : undefined), roots }
    };
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

function checkOutsideRoots(path: string, roots: Root[]) {
  for (const root of roots) {
    const location = canonicalLocation(root.path);
    const suffix = relative(location, path);
    if (!suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) {
      throw new Error('Put the registry outside the source roots.');
    }
  }
}
