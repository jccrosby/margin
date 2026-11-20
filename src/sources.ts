import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { evidenceFormat } from './evidence.ts';
import { git, requireGitCheckout } from './git.ts';
import { MarginError, type Root } from './registry.ts';

export const savedNotesDirectory = '.margin-saved-notes';
export const savedNotesId = '@saved-notes';

const excluded = new Set([
  savedNotesDirectory,
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.aws',
  '.env', '.npmrc', '.netrc', 'id_dsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk',
  'id_rsa', 'identity'
]);
const noteCitationExtensions = new Set([
  '.c', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsonc', '.jsx', '.kt', '.kts', '.less', '.mjs', '.cjs', '.md', '.markdown', '.mdx', '.mts', '.cts', '.graphql', '.php',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx',
  '.vue', '.xml', '.yaml', '.yml', '.zsh'
]);
const noteCitationNames = new Set([
  '.editorconfig', '.env.example', '.gitattributes', '.gitignore', 'dockerfile', 'makefile', 'readme'
]);

function isExcluded(segment: string) {
  const name = segment.toLowerCase();
  return excluded.has(name) || (name.startsWith('.env.') && name !== '.env.example');
}

export function isNoteCitationPath(relativePath: string) {
  const name = basename(relativePath).toLowerCase();
  return noteCitationNames.has(name) || noteCitationExtensions.has(extname(name));
}

export function isSourcePath(relativePath: string) {
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
      segment.includes('\0') || isExcluded(segment))) return false;
  const name = segments.at(-1)!.toLowerCase();
  const extension = extname(name);
  return isNoteCitationPath(name) || extension === '.csv' || extension === '.txt' || name === 'license' ||
    evidenceFormat(name) !== undefined;
}

export function sourceId(projectId: string, rootId: string, relativePath: string) {
  return Buffer.from(JSON.stringify([projectId, rootId, relativePath])).toString('base64url');
}

function gitPaths(root: Root, relativePath?: string) {
  const pathspec = relativePath === undefined ? [] : ['--', relativePath];
  const bytes = git(root.path, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name',
    ...pathspec);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const paths = new Set<string>();
  let start = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    try {
      paths.add(decoder.decode(bytes.subarray(start, end)));
    } catch {
      // fix: Skip names that cannot round-trip through a UTF-8 source ID.
    }
    start = end + 1;
  }
  return paths;
}

function* notePaths(root: Root): Generator<string> {
  const directories = [''];
  while (directories.length > 0) {
    const parent = directories.pop()!;
    const directory = join(root.path, parent);
    if (realpathSync.native(directory) !== directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!isExcluded(entry.name)) {
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (entry.isDirectory()) directories.push(path);
        if (entry.isFile()) yield path;
      }
    }
  }
}

export function requireRoot(root: Root) {
  try {
    if (realpathSync.native(root.path) !== root.path || !lstatSync(root.path).isDirectory() ||
        (root.id !== savedNotesId && root.path.toLowerCase().split(sep).includes(savedNotesDirectory))) {
      throw new Error('Root must be a canonical directory.');
    }
    if (root.kind === 'git') requireGitCheckout(root.path);
  } catch {
    throw new MarginError('root_unavailable');
  }
}

function regularFile(root: Root, relativePath: string) {
  try {
    const segments = relativePath.split('/');
    let path = root.path;
    for (const directory of segments.slice(0, -1)) {
      path = join(path, directory);
      if (!lstatSync(path).isDirectory()) return undefined;
    }
    path = join(root.path, relativePath);
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    if (root.id === savedNotesId && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
      throw new MarginError('source_unavailable');
    }
    if (root.kind === 'context' && realpathSync.native(path) !== path) return undefined;
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new MarginError('source_unavailable');
  }
}

export function scanPaths(root: Root) {
  requireRoot(root);
  try {
    const paths = root.kind === 'git' ? gitPaths(root) : notePaths(root);
    const eligible: string[] = [];
    const unreadable: string[] = [];
    for (const path of paths) {
      if (!isSourcePath(path)) continue;
      try {
        if (regularFile(root, path)) eligible.push(path);
      } catch {
        unreadable.push(path);
      }
    }
    return { paths: eligible, unreadable };
  } catch {
    requireRoot(root);
    throw new MarginError('root_scan_failed');
  }
}

export function requireListedSource(root: Root, relativePath: string) {
  const path = isSourcePath(relativePath) && regularFile(root, relativePath);
  if (!path) throw new MarginError('source_unavailable');
  return path;
}

export function requireSource(root: Root, relativePath: string) {
  requireRoot(root);
  const path = requireListedSource(root, relativePath);
  try {
    if (root.kind === 'context' || gitPaths(root, relativePath).has(relativePath)) return path;
  } catch {
    throw new MarginError('root_unavailable');
  }
  throw new MarginError('source_unavailable');
}
