import { fstatSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { evidenceFormat } from './evidence.ts';
import { git, requireGitCheckout } from './git.ts';
import { isWindowsPathSegment, readEntries, requirePrivateAccess, windows, withDirectory, withEntry } from './filesystem.ts';
import { MarginError, unsafeStorage, type Root } from './registry.ts';
import { isMissing } from './storage.ts';

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
      !segment.isWellFormed() || segment.includes('\0') || (windows && !isWindowsPathSegment(segment)) || isExcluded(segment))) return false;
  const name = segments.at(-1)!.toLowerCase();
  const extension = extname(name);
  return isNoteCitationPath(name) || extension === '.csv' || extension === '.txt' || name === 'license' ||
    evidenceFormat(name) !== undefined;
}

export function sourceId(projectId: string, rootId: string, relativePath: string) {
  return Buffer.from(JSON.stringify([projectId, rootId, relativePath])).toString('base64url');
}

function gitPaths(fd: number, relativePath?: string) {
  const pathspec = relativePath === undefined ? [] : ['--', relativePath];
  const bytes = git(fd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name',
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

function* contextPaths(root: Root, fd: number): Generator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const directories = [''];
  while (directories.length > 0) {
    const parent = directories.pop()!;
    let entries;
    try {
      entries = parent ? withEntry(fd, parent, true, directory => {
        if (root.id === savedNotesId) requirePrivateAccess(directory);
        return readEntries(directory);
      }, true) : readEntries(fd);
    } catch (error) {
      if (!parent) throw error;
      continue;
    }
    for (const [bytes, kind] of entries) {
      let name;
      try {
        name = decoder.decode(bytes);
      } catch {
        continue;
      }
      if (!isExcluded(name)) {
        const path = parent ? `${parent}/${name}` : name;
        if (kind === 'directory') directories.push(path);
        else yield path;
      }
    }
  }
}

function unavailableRoot(root: Root) {
  return root.id === savedNotesId
    ? unsafeStorage('root_unavailable', root.path)
    : new MarginError('root_unavailable');
}

function verifyRootPath(root: Root, fd: number) {
  try {
    withDirectory(root.path, current => {
      const original = fstatSync(fd, { bigint: true });
      const actual = fstatSync(current, { bigint: true });
      if (original.dev !== actual.dev || original.ino !== actual.ino) throw new Error('The root moved.');
    });
  } catch {
    throw unavailableRoot(root);
  }
}

function withRoot<T>(root: Root, use: (fd: number) => T) {
  let verified = false;
  try {
    return withDirectory(root.path, fd => {
      if (root.id === savedNotesId) requirePrivateAccess(fd);
      else if (root.path.toLowerCase().split(sep).includes(savedNotesDirectory)) {
        throw new MarginError('root_unavailable');
      }
      if (root.kind === 'git') {
        requireGitCheckout(fd);
        verifyRootPath(root, fd);
      }
      verified = true;
      return use(fd);
    });
  } catch (error) {
    if (verified) throw error;
    throw unavailableRoot(root);
  }
}

function useEntry<T>(root: Root, fd: number, relativePath: string, use: (fd: number) => T) {
  const privateNote = root.id === savedNotesId;
  if (privateNote) {
    for (let end = relativePath.indexOf('/'); end !== -1; end = relativePath.indexOf('/', end + 1)) {
      withEntry(fd, relativePath.slice(0, end), true, requirePrivateAccess, true);
    }
  }
  return withEntry(fd, relativePath, false, source => {
    if (privateNote) requirePrivateAccess(source);
    return use(source);
  }, windows || root.kind === 'context');
}

function noteAccessError(root: Root, relativePath: string, error: unknown) {
  if (root.id === savedNotesId && !isMissing(error)) {
    return unsafeStorage('note_storage_unavailable', join(root.path, relativePath));
  }
}

type SourceGap = { error: string; relativePath: string; detail?: string };
type SourceInventory = { paths: string[]; unreadable: SourceGap[] };
export type SourceReader = <T>(path: string, use: (fd: number) => T) => T;

export function withInventory<T>(root: Root,
  use: (inventory: SourceInventory, read: SourceReader) => T
) {
  return withRoot(root, fd => {
    function scan(): SourceInventory {
      const paths = root.kind === 'git' ? gitPaths(fd) : contextPaths(root, fd);
      const eligible: string[] = [];
      const unreadable: SourceGap[] = [];
      for (const path of paths) {
        if (!isSourcePath(path)) continue;
        try {
          useEntry(root, fd, path, () => eligible.push(path));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (root.id === savedNotesId || code === 'EACCES' || code === 'EPERM') {
            const issue = noteAccessError(root, path, error);
            unreadable.push({ error: issue?.message ?? 'source_unavailable', relativePath: path, detail: issue?.detail });
          }
        }
      }
      verifyRootPath(root, fd);
      return { paths: eligible, unreadable };
    }
    let inventory;
    try {
      inventory = scan();
    } catch (error) {
      if (error instanceof MarginError) throw error;
      throw new MarginError('root_scan_failed');
    }
    return use(inventory, (path, read) => readSource(root, fd, path, read));
  });
}

export function scanPaths(root: Root) {
  return withInventory(root, inventory => inventory);
}

function readSource<T>(root: Root, fd: number, path: string, read: (fd: number) => T) {
  let verified = false;
  try {
    return useEntry(root, fd, path, source => {
      verified = true;
      return read(source);
    });
  } catch (error) {
    if (error instanceof MarginError) throw error;
    const issue = verified ? undefined : noteAccessError(root, path, error);
    throw issue ?? new MarginError('source_unavailable');
  }
}

export function readLiveSource<T>(root: Root, relativePath: string, use: (fd: number) => T) {
  return withRoot(root, fd => {
    if (!isSourcePath(relativePath)) throw new MarginError('source_unavailable');
    if (root.kind === 'git') {
      let listed;
      try {
        listed = gitPaths(fd, relativePath).has(relativePath);
        verifyRootPath(root, fd);
      } catch {
        throw new MarginError('root_unavailable');
      }
      if (!listed) throw new MarginError('source_unavailable');
    }
    return readSource(root, fd, relativePath, use);
  });
}
