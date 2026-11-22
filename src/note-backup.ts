import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { createPrivateDirectory, publishExclusive, requirePrivateAccess, syncDirectory, withDirectory, withEntry } from './filesystem.ts';
import { savedNoteStore } from './notes.ts';
import { canonicalStoragePath, checkOutsideRoots, loadRegistry, MarginError, registryLocation, registryWriteLock, unsafeStorage } from './registry.ts';
import { savedNotesDirectory } from './sources.ts';
import { isMissing, readPrivateFile, requirePrivateDirectory } from './storage.ts';

const manifestName = 'backup.json';
const manifestSchema = z.strictObject({ version: z.literal(1), registry: z.string() });
const projectDirectory = /^[a-f0-9]{64}$/;
const noteFile = /^[a-f0-9]{64}\.md$/;
const interruptedWrite = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;

export function backupProjectNotes(registryPath: string, backupPath: string, restore: boolean) {
  const registry = registryLocation(registryPath);
  using maintenance = registryWriteLock(registry, true);
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
    copyNotes(source, stagedStore);
    if (restore) inPrivateStorage(dirname(store), () => requirePrivateDirectory(dirname(store), true));
    else writePrivateFile(join(staged, manifestName), backupManifest(registry));
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

function copyNotes(source: string, destination: string) {
  inPrivateStorage(source, () => withDirectory(source, sourceFd => {
    requirePrivateAccess(sourceFd);
    for (const name of readdirSync(source)) {
      const project = join(source, name);
      const output = join(destination, name);
      inPrivateStorage(project, () => {
        if (!projectDirectory.test(name)) throw new Error('Unexpected note project directory.');
        withEntry(sourceFd, name, true, projectFd => {
          requirePrivateAccess(projectFd);
          inPrivateStorage(output, () => requirePrivateDirectory(output, true));
          for (const filename of readdirSync(project)) {
            const note = join(project, filename);
            const contents = inPrivateStorage(note, () => {
              if (!noteFile.test(filename) && !interruptedWrite.test(filename)) throw new Error('Unexpected note filename.');
              return withEntry(projectFd, filename, false, fd => {
                requirePrivateAccess(fd);
                if (noteFile.test(filename)) return readFileSync(fd);
              }, true);
            });
            if (contents !== undefined) writePrivateFile(join(output, filename), contents);
          }
          inPrivateStorage(output, () => syncDirectory(output));
        }, true);
      });
    }
  }));
  inPrivateStorage(destination, () => syncDirectory(destination));
}

function writePrivateFile(path: string, data: string | Buffer) {
  inPrivateStorage(path, () => {
    const fd = openSync(path, 'wx+', 0o600);
    try {
      requirePrivateAccess(fd);
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}
