import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { contentHash } from './evidence.ts';
import { textLines } from './passages.ts';
import { maxBytes, readText } from './read.ts';
import { canonicalLocation, checkOutsideRoots, id, MarginError, type Root } from './registry.ts';
import { requireSource, savedNotesDirectory, savedNotesId, sourceId } from './sources.ts';

const inputText = z.string().refine(text => text.isWellFormed());
export const noteInput = z.strictObject({
  projectId: id,
  requestId: inputText.refine(text => text.length > 0),
  title: inputText.refine(text => text.trim().length > 0),
  body: inputText
});
type NoteInput = z.infer<typeof noteInput>;
const metadataSchema = z.strictObject({
  noteId: z.string(),
  projectId: id,
  createdAt: z.iso.datetime(),
  requestId: z.string(),
  title: z.string()
});

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function savedNoteRoot(registryPath: string, projectId: string, allRoots: Root[], create = false): Root | undefined {
  try {
    const registry = canonicalLocation(registryPath);
    const scope = [savedNotesDirectory, contentHash(basename(registry)), contentHash(projectId)];
    const location = join(dirname(registry), ...scope);
    checkOutsideRoots(location, allRoots, 'saved notes directory');
    let directory = dirname(registry);
    for (const segment of scope) {
      directory = join(directory, segment);
      if (create) {
        try {
          mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new MarginError('note_storage_unavailable');
      }
    }
    return { id: savedNotesId, kind: 'context', path: location };
  } catch (error) {
    if (!create && missing(error)) return undefined;
    throw new MarginError('note_storage_unavailable');
  }
}

function noteMarkdown({ projectId, requestId, title, body }: NoteInput, noteId: string, createdAt: string) {
  return `---\n${JSON.stringify({ noteId, projectId, createdAt, requestId, title })}\n---\n\n# ${title}\n\n${body}`;
}

function existingNote(root: Root, relativePath: string, args: NoteInput, noteId: string) {
  const contents = readText(requireSource(root, relativePath));
  let createdAt;
  try {
    const metadata = metadataSchema.parse(JSON.parse(contents.split('\n', 2)[1]));
    createdAt = metadata.createdAt;
  } catch {
    throw new MarginError('note_storage_unavailable');
  }
  if (contents !== noteMarkdown(args, noteId, createdAt)) throw new MarginError('note_request_conflict');
  return createdAt;
}

export function commitNote(registryPath: string, allRoots: Root[], args: NoteInput) {
  const registry = canonicalLocation(registryPath);
  const relativePath = `${contentHash(JSON.stringify([registry, args.requestId]))}.md`;
  const noteId = sourceId(args.projectId, savedNotesId, relativePath);
  const createdAt = new Date().toISOString();
  const text = noteMarkdown(args, noteId, createdAt);
  if (textLines(text).some(line => Buffer.byteLength(line) > maxBytes)) throw new MarginError('line_too_long');
  const root = savedNoteRoot(registry, args.projectId, allRoots, true)!;
  const path = join(root.path, relativePath);
  const reuse = () => ({ root, relativePath, noteId, createdAt: existingNote(root, relativePath, args, noteId) });

  try {
    if (lstatSync(path, { throwIfNoEntry: false })) return reuse();
    const staged = join(root.path, `${randomUUID()}.tmp`);
    const fd = openSync(staged, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
      // fix: Publish the complete file atomically without replacing a concurrent save.
      try {
        linkSync(staged, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return reuse();
      }
      const directory = openSync(root.path, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return { root, relativePath, noteId, createdAt };
    } finally {
      closeSync(fd);
      rmSync(staged);
    }
  } catch (error) {
    if (error instanceof MarginError) throw error;
    throw new MarginError('note_storage_unavailable');
  }
}
