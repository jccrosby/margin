import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, lstatSync, openSync, rmSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { contentHash, lineLocation, versionHash } from './evidence.ts';
import { textLines } from './passages.ts';
import { maxBytes, readText } from './read.ts';
import { checkOutsideRoots, id, MarginError, registryLocation, unsafeStorage, type Root } from './registry.ts';
import { publishExclusive, requirePrivateAccess, withDirectory } from './macos.ts';
import { isMissing, requirePrivateDirectory } from './storage.ts';
import { readLiveSource, savedNotesDirectory, savedNotesId, sourceId } from './sources.ts';

const inputText = z.string().refine(text => text.isWellFormed());
const noteCitations = z.array(z.strictObject({ sourceId: z.string(), contentHash: versionHash, location: lineLocation }))
  .optional();
export const noteInput = z.strictObject({
  projectId: id,
  requestId: inputText.refine(text => text.length > 0),
  title: inputText.refine(text => text.trim().length > 0),
  body: inputText,
  citations: noteCitations
});
type NoteInput = z.infer<typeof noteInput>;
const metadataSchema = z.strictObject({
  noteId: z.string(),
  projectId: id,
  createdAt: z.iso.datetime(),
  requestId: z.string(),
  title: z.string(),
  citations: noteCitations
});

export function savedNoteRoot(registryPath: string, projectId: string, allRoots: Root[], create = false): Root | undefined {
  const registry = registryLocation(registryPath);
  const parent = dirname(registry);
  const scope = [savedNotesDirectory, contentHash(basename(registry)), contentHash(projectId)];
  const location = join(parent, ...scope);
  try {
    checkOutsideRoots(location, allRoots, 'saved notes directory');
    requirePrivateDirectory(parent);
    let directory = parent;
    for (const segment of scope) {
      directory = join(directory, segment);
      requirePrivateDirectory(directory, create);
    }
    return { id: savedNotesId, kind: 'context', path: location };
  } catch (error) {
    if (!create && isMissing(error)) return undefined;
    throw unsafeStorage('note_storage_unavailable', (error as NodeJS.ErrnoException).path ?? location);
  }
}

function noteMarkdown({ projectId, requestId, title, body, citations }: NoteInput, noteId: string, createdAt: string) {
  const metadata = { noteId, projectId, createdAt, requestId, title, citations: citations?.length ? citations : undefined };
  return `---\n${JSON.stringify(metadata)}\n---\n\n# ${title}\n\n${body}`;
}

function existingNote(root: Root, relativePath: string, args: NoteInput, noteId: string) {
  const contents = readLiveSource(root, relativePath, readText);
  let createdAt;
  try {
    const metadata = metadataSchema.parse(JSON.parse(contents.split('\n', 2)[1]));
    createdAt = metadata.createdAt;
  } catch {
    throw unsafeStorage('note_storage_unavailable', join(root.path, relativePath));
  }
  if (contents !== noteMarkdown(args, noteId, createdAt)) throw new MarginError('note_request_conflict');
  return createdAt;
}

export function commitNote(registryPath: string, allRoots: Root[], args: NoteInput, validateCitations: () => void) {
  const registry = registryLocation(registryPath);
  const relativePath = `${contentHash(JSON.stringify([registry, args.requestId]))}.md`;
  const noteId = sourceId(args.projectId, savedNotesId, relativePath);
  const reuse = (root: Root) => ({
    root, relativePath, noteId, createdAt: existingNote(root, relativePath, args, noteId)
  });

  try {
    const existingRoot = savedNoteRoot(registry, args.projectId, allRoots);
    if (existingRoot && lstatSync(join(existingRoot.path, relativePath), { throwIfNoEntry: false })) {
      return reuse(existingRoot);
    }
    const createdAt = new Date().toISOString();
    const text = noteMarkdown(args, noteId, createdAt);
    if (textLines(text).some(line => Buffer.byteLength(line) > maxBytes)) throw new MarginError('line_too_long');
    validateCitations();
    const root = existingRoot ?? savedNoteRoot(registry, args.projectId, allRoots, true)!;
    const path = join(root.path, relativePath);
    const staged = join(root.path, `${randomUUID()}.tmp`);
    const fd = openSync(staged, 'wx', 0o600);
    try {
      requirePrivateAccess(fd);
      writeFileSync(fd, text);
      fsyncSync(fd);
      // Publish without overwriting another save or creating a second hard link.
      try {
        publishExclusive(staged, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return reuse(root);
      }
      withDirectory(root.path, fsyncSync);
      return { root, relativePath, noteId, createdAt };
    } finally {
      closeSync(fd);
      rmSync(staged, { force: true });
    }
  } catch (error) {
    if (error instanceof MarginError) throw error;
    throw unsafeStorage('note_storage_unavailable', dirname(registry));
  }
}
