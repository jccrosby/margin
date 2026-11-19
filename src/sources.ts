import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join } from 'node:path';
import { git, requireGitCheckout } from './git.ts';
import { MarginError, type Root } from './registry.ts';

const excluded = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.aws',
  '.env', '.npmrc', '.netrc', 'id_dsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk',
  'id_rsa', 'identity'
]);
const textExtensions = new Set([
  '.c', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsonc', '.jsx', '.kt', '.kts', '.less', '.mjs', '.cjs', '.md', '.markdown', '.mdx', '.mts', '.cts', '.graphql', '.php',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml', '.zsh'
]);
const textNames = new Set([
  '.editorconfig', '.env.example', '.gitattributes', '.gitignore', 'dockerfile', 'license', 'makefile', 'readme'
]);

function isExcluded(segment: string) {
  const name = segment.toLowerCase();
  return excluded.has(name) || (name.startsWith('.env.') && name !== '.env.example');
}

export function isSourcePath(relativePath: string) {
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
      segment.includes('\0') || isExcluded(segment))) return false;
  const name = segments.at(-1)!.toLowerCase();
  return textNames.has(name) || textExtensions.has(extname(name));
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
    if (realpathSync.native(root.path) !== root.path || !lstatSync(root.path).isDirectory()) {
      throw new Error('Root must be a canonical directory.');
    }
    if (root.kind === 'git') requireGitCheckout(root.path);
  } catch {
    throw new MarginError('root_unavailable');
  }
}

function regularFile(root: Root, relativePath: string) {
  try {
    const path = join(root.path, relativePath);
    if (realpathSync.native(path) === path && lstatSync(path).isFile()) return path;
  } catch {
    return undefined;
  }
}

export function listPaths(root: Root) {
  requireRoot(root);
  try {
    const paths = root.kind === 'git' ? gitPaths(root) : notePaths(root);
    return Array.from(paths).filter(path => isSourcePath(path) && regularFile(root, path));
  } catch {
    throw new MarginError('root_unavailable');
  }
}

export function requireSource(root: Root, relativePath: string) {
  requireRoot(root);
  const path = regularFile(root, relativePath);
  try {
    if (path && (root.kind === 'context' || gitPaths(root, relativePath).has(relativePath))) return path;
  } catch {
    throw new MarginError('root_unavailable');
  }
  throw new MarginError('source_unavailable');
}
