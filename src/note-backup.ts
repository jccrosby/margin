import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { createPrivateDirectory, publishExclusive, requirePrivateAccess, syncDirectory, withDirectory, withEntry } from './filesystem.ts';
import { savedNoteStore } from './notes.ts';
import { canonicalStoragePath, checkOutsideRoots, loadRegistry, MarginError, registryLocation, registryWriteLock, unsafeStorage } from './registry.ts';
import { savedNotesDirectory } from './sources.ts';
import { isMissing, readPrivateFile, requirePrivateDirectory, writePrivateFile } from './storage.ts';

const manifestName = 'backup.json';
const manifestSchema = z.strictObject({ version: z.literal(1), registry: z.string() });
const projectDirectory = /^[a-f0-9]{64}$/;
const noteFile = /^[a-f0-9]{64}\.md$/;
const interruptedWrite = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;

export function backupProjectNotes(registryPath: string, backupPath: string, restore: boolean) {
  const registry = registryLocation(registryPath);
  using maintenance = registryWriteLock(registry, 'exclusive');
  const { projects } = loadRegistry(registry);
  const allRoots = Object.values(projects).flatMap(project => project.roots);
  const store = savedNoteStore(registry);
  const backup = inPrivateStorage(backupPath, () => canonicalStoragePath(backupPath, true));
  for (const [path, name] of [[backup, 'backup directory'], [store, 'saved notes directory']]) {
    checkOutsideRoots(path, allRoots, name);
    for (const root of allRoots) {
      checkOutsideRoots(root.path, [{ id: name, kind: 'context', path }], 'source root');
    }
  }
  if (backup.toLowerCase().split(sep).includes(savedNotesDirectory)) {
    throw new MarginError('note_backup_unavailable', `Choose a backup directory outside ${savedNotesDirectory}. Check ${backup}.`);
  }
  const destination = restore ? store : backup;
  const source = restore ? join(backup, savedNotesDirectory) : store;
  inPrivateStorage(dirname(backup), () => requirePrivateDirectory(dirname(backup)));
  if (restore) {
    inPrivateStorage(dirname(store), () => {
      try {
        requirePrivateDirectory(dirname(store));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    });
    requireAbsent(destination);
    inPrivateStorage(backup, () => requirePrivateDirectory(backup));
    const manifest = join(backup, manifestName);
    const original = readOriginalRegistry(manifest);
    if (original !== registry) {
      throw new MarginError('note_backup_unavailable', `Use the original registry path ${JSON.stringify(original)}. Check ${manifest}.`);
    }
  } else {
    requireAbsent(destination);
  }

  inPrivateStorage(source, () => requirePrivateDirectory(source));
  const staged = join(restore ? dirname(registry) : dirname(backup), `.margin-backup-${randomUUID()}`);
  inPrivateStorage(staged, () => createPrivateDirectory(staged));
  try {
    const stagedStore = restore ? staged : join(staged, savedNotesDirectory);
    inPrivateStorage(stagedStore, () => requirePrivateDirectory(stagedStore, true));
    copyNotes(source, stagedStore, restore);
    if (restore) inPrivateStorage(dirname(store), () => requirePrivateDirectory(dirname(store), true));
    else {
      const manifest = join(staged, manifestName);
      inPrivateStorage(manifest, () => writePrivateFile(manifest, backupManifest(registry)));
    }
    inPrivateStorage(destination, () => {
      syncDirectory(staged);
      try {
        publishExclusive(staged, destination);
      } catch (error) {
        requireAbsent(destination);
        throw error;
      }
      syncDirectory(dirname(destination));
    });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

function readOriginalRegistry(path: string) {
  const contents = inPrivateStorage(path, () => readPrivateFile(path, fd => readFileSync(fd, 'utf8')));
  try {
    return manifestSchema.parse(JSON.parse(contents)).registry;
  } catch {
    throw new MarginError('note_backup_unavailable', `Choose a backup created by export-notes. Check ${path}.`);
  }
}

function backupManifest(registry: string) {
  return JSON.stringify({ version: 1, registry }) + '\n';
}

function requireAbsent(path: string) {
  if (inPrivateStorage(path, () => lstatSync(path, { throwIfNoEntry: false }))) {
    throw new MarginError('note_backup_destination_exists', `Choose an unused backup path or restore to a missing note store. Check ${path}.`);
  }
}

function inPrivateStorage<T>(path: string, use: () => T) {
  try {
    return use();
  } catch (error) {
    if (error instanceof MarginError) throw error;
    throw unsafeStorage('note_backup_unavailable', (error as NodeJS.ErrnoException).path ?? path);
  }
}

function invalidNoteLayout(path: string, restore: boolean) {
  const fix = restore ? 'Choose an intact backup created by export-notes.'
    : 'Move the unexpected entry out of the saved note store, then retry.';
  return new MarginError('note_backup_invalid_layout', `Unexpected entry at ${JSON.stringify(path)}. ${fix}`);
}

function copyNotes(source: string, destination: string, restore: boolean) {
  inPrivateStorage(source, () => withDirectory(source, sourceFd => {
    requirePrivateAccess(sourceFd);
    for (const name of readdirSync(source)) {
      const project = join(source, name);
      const output = join(destination, name);
      if (!projectDirectory.test(name)) throw invalidNoteLayout(project, restore);
      inPrivateStorage(project, () => {
        withEntry(sourceFd, name, true, projectFd => {
          requirePrivateAccess(projectFd);
          inPrivateStorage(output, () => requirePrivateDirectory(output, true));
          for (const filename of readdirSync(project)) {
            const note = join(project, filename);
            const saved = noteFile.test(filename);
            if (!saved && !interruptedWrite.test(filename)) throw invalidNoteLayout(note, restore);
            const contents = inPrivateStorage(note, () => withEntry(projectFd, filename, false, fd => {
              requirePrivateAccess(fd);
              if (saved) return readFileSync(fd);
            }, true));
            if (contents !== undefined) {
              const target = join(output, filename);
              inPrivateStorage(target, () => writePrivateFile(target, contents));
            }
          }
          inPrivateStorage(output, () => syncDirectory(output));
        }, true);
      });
    }
  }));
  inPrivateStorage(destination, () => syncDirectory(destination));
}
