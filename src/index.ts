import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { literalPassages, rankedPassages, textLines } from './passages.ts';
import { maxBytes, readText } from './read.ts';
import { canonicalLocation, checkOutsideRoots, MarginError, type Root } from './registry.ts';
import { requireListedSource, requireSource, scanPaths, sourceId } from './sources.ts';

type Gap = { error: string; relativePath?: string };
type Refresh = { status: string; refreshedAt?: string; gaps: Gap[] };
export type Inventory = Map<string, ReturnType<typeof scanPaths> | { error: string }>;
type Source = { rootId: string; rootKey: string; relativePath: string; hash: string; text: string };
type Passage = { startLine: number; endLine: number; text: string };
type Ranked = Omit<Source, 'text'> & Passage;
type Hit = {
  sourceId: string; rootId: string; relativePath: string; matchedOn: 'path' | 'text'
} & Partial<Passage>;

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function rootKey(root: Root) {
  return JSON.stringify([root.id, root.kind, root.path]);
}

function indexPath(registryPath: string, projectId: string, roots: Root[]) {
  // fix: Hash IDs to keep case variants separate on case-insensitive filesystems.
  const path = `${canonicalLocation(registryPath)}.${hash(projectId)}.sqlite`;
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    checkOutsideRoots(canonicalLocation(candidate), roots, 'index');
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
        throw new MarginError('index_unavailable');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path;
}

const schema = `
  CREATE TABLE IF NOT EXISTS refreshes (
    rootKey TEXT PRIMARY KEY,
    rootId TEXT NOT NULL,
    attempt TEXT NOT NULL,
    status TEXT NOT NULL,
    refreshedAt TEXT,
    gaps TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    rootId TEXT NOT NULL,
    rootKey TEXT NOT NULL,
    relativePath TEXT NOT NULL,
    hash TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE (rootKey, relativePath)
  );
  CREATE TABLE IF NOT EXISTS ranges (
    id INTEGER PRIMARY KEY,
    source INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    startLine INTEGER NOT NULL,
    endLine INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ranges_source ON ranges(source);
  CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(text, content=ranges, content_rowid=id);
  CREATE TRIGGER IF NOT EXISTS ranges_insert AFTER INSERT ON ranges BEGIN
    INSERT INTO passages(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS ranges_delete AFTER DELETE ON ranges BEGIN
    INSERT INTO passages(passages, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

function openIndex(path: string, write: boolean) {
  try {
    if (write) closeSync(openSync(path, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
    else lstatSync(path);
    const db = new DatabaseSync(path, { readOnly: !write, timeout: 5000, enableForeignKeyConstraints: true });
    if (write) {
      try {
        // fix: Keep readers on the prior index while SQLite stages a root refresh.
        db.exec('PRAGMA cache_spill = OFF');
        db.exec(schema);
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return db;
  } catch (error) {
    if (!write && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MarginError('index_unavailable');
  }
}

function getRefresh(db: DatabaseSync | undefined, key: string): Refresh {
  const row = db?.prepare('SELECT status, refreshedAt, gaps FROM refreshes WHERE rootKey = ?').get(key);
  if (!row) return { status: 'not_refreshed', gaps: [] };
  const gaps: Gap[] = JSON.parse(row.gaps as string);
  if (row.status === 'refreshing') gaps.push({ error: 'refresh_unfinished' });
  return { status: row.status as string, refreshedAt: (row.refreshedAt ?? undefined) as string | undefined, gaps };
}

export function refreshProject(registryPath: string, projectId: string, roots: Root[], allRoots: Root[]) {
  const db = openIndex(indexPath(registryPath, projectId, allRoots), true)!;
  try {
    const registered = roots.map(root => root.id);
    const placeholders = registered.map(() => '?').join(', ');
    db.prepare(`DELETE FROM sources WHERE rootId NOT IN (${placeholders})`).run(...registered);
    db.prepare(`DELETE FROM refreshes WHERE rootId NOT IN (${placeholders})`).run(...registered);
    return roots.map(root => ({ rootId: root.id, ...refreshRoot(db, root) }));
  } finally {
    db.close();
  }
}

function refreshRoot(db: DatabaseSync, root: Root) {
  const key = rootKey(root);
  const attempt = randomUUID();
  db.prepare(`INSERT INTO refreshes VALUES (?, ?, ?, 'refreshing', NULL, '[]')
    ON CONFLICT(rootKey) DO UPDATE SET attempt = excluded.attempt, status = 'refreshing'`).run(key, root.id, attempt);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT attempt FROM refreshes WHERE rootKey = ?').get(key)?.attempt === attempt) {
      let inventory;
      try {
        inventory = scanPaths(root);
      } catch (error) {
        const gap = error instanceof MarginError ? error.message : 'root_scan_failed';
        db.prepare("UPDATE refreshes SET status = 'failed', gaps = ? WHERE rootKey = ?")
          .run(JSON.stringify([{ error: gap }]), key);
      }
      if (inventory) publishRoot(db, root, key, inventory);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getRefresh(db, key);
}

function publishRoot(db: DatabaseSync, root: Root, key: string, inventory: ReturnType<typeof scanPaths>) {
  const old = db.prepare('SELECT id, rootKey, relativePath, hash FROM sources WHERE rootId = ?').all(root.id);
  const retained = new Set([...inventory.paths, ...inventory.unreadable]);
  const previous = new Map(old.filter(row => row.rootKey === key).map(row => [row.relativePath, row]));
  const gaps: Gap[] = inventory.unreadable.map(relativePath => ({ error: 'source_unavailable', relativePath }));
  const removeSource = db.prepare('DELETE FROM sources WHERE id = ?');
  const addSource = db.prepare('INSERT INTO sources(rootId, rootKey, relativePath, hash, text) VALUES (?, ?, ?, ?, ?)');
  const addRange = db.prepare('INSERT INTO ranges(source, startLine, endLine, text) VALUES (?, ?, ?, ?)');

  for (const entry of old) {
    if (entry.rootKey !== key || !retained.has(entry.relativePath as string)) removeSource.run(entry.id);
  }
  for (const relativePath of inventory.paths) {
    let text;
    try {
      text = readText(requireListedSource(root, relativePath));
    } catch {
      gaps.push({ error: 'source_unavailable', relativePath });
      continue;
    }

    const lines = textLines(text);
    const sizes = lines.map(line => Buffer.byteLength(line));
    if (sizes.some(size => size > maxBytes)) gaps.push({ error: 'line_too_long', relativePath });
    const digest = hash(text);
    const entry = previous.get(relativePath);
    if (entry?.hash === digest) continue;
    if (entry) removeSource.run(entry.id);
    const { lastInsertRowid } = addSource.run(root.id, key, relativePath, digest, text);
    for (const passage of rankedPassages(lines, sizes)) {
      addRange.run(lastInsertRowid, passage.startLine, passage.endLine, passage.text);
    }
  }
  db.prepare('UPDATE refreshes SET status = ?, refreshedAt = ?, gaps = ? WHERE rootKey = ?')
    .run(gaps.length ? 'partial' : 'complete', new Date().toISOString(), JSON.stringify(gaps), key);
}

export function liveInventory(roots: Root[]): Inventory {
  const inventory: Inventory = new Map();
  for (const root of roots) {
    try {
      inventory.set(root.id, scanPaths(root));
    } catch (error) {
      if (!(error instanceof MarginError)) throw error;
      inventory.set(root.id, { error: error.message });
    }
  }
  return inventory;
}

type Coverage = ReturnType<typeof collectCoverage>;

function collectCoverage(db: DatabaseSync | undefined, roots: Root[], inventory: Inventory) {
  const coverage = roots.map(root => {
    const key = rootKey(root);
    const { status, refreshedAt, gaps } = getRefresh(db, key);
    const live = inventory.get(root.id)!;
    if ('error' in live) gaps.push(live);
    else {
      for (const relativePath of live.unreadable) gaps.push({ error: 'source_unavailable', relativePath });
      if (db && status !== 'not_refreshed') {
        const indexed = new Set(db.prepare('SELECT relativePath FROM sources WHERE rootKey = ?')
          .all(key).map(row => row.relativePath as string));
        const added = live.paths.filter(path => !indexed.delete(path));
        for (const path of live.unreadable) indexed.delete(path);
        if (added.length || indexed.size) gaps.push({ error: 'paths_changed' });
      }
    }
    const seen = new Set<string>();
    return { rootId: root.id, status, refreshedAt, gaps: gaps.filter(gap => {
      const key = JSON.stringify(gap);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) };
  });
  return { complete: coverage.every(root => root.status === 'complete' && !root.gaps.length), roots: coverage };
}

function withIndex<T>(
  registryPath: string, projectId: string, allRoots: Root[], read: (db: DatabaseSync | undefined) => T
) {
  const db = openIndex(indexPath(registryPath, projectId, allRoots), false);
  try {
    db?.exec('BEGIN');
    return read(db);
  } catch (error) {
    if (error instanceof MarginError) throw error;
    throw new MarginError('index_unavailable');
  } finally {
    db?.close();
  }
}

export function indexCoverage(registryPath: string, projectId: string, roots: Root[],
  allRoots: Root[], inventory: Inventory) {
  try {
    return withIndex(registryPath, projectId, allRoots, db => collectCoverage(db, roots, inventory));
  } catch {
    const coverage = collectCoverage(undefined, roots, inventory);
    for (const root of coverage.roots) root.gaps.push({ error: 'index_unavailable' });
    return coverage;
  }
}

function rankedQuery(query: string) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE tokens USING fts5(text); CREATE VIRTUAL TABLE terms USING fts5vocab(tokens, 'row')");
    db.prepare('INSERT INTO tokens VALUES (?)').run(query);
    return db.prepare('SELECT term FROM terms').all()
      .map(({ term }) => `"${String(term).replaceAll('"', '""')}"`).join(' AND ');
  } finally {
    db.close();
  }
}

function* candidates(db: DatabaseSync, query: string, mode: 'literal' | 'ranked') {
  if (mode === 'ranked') {
    const match = rankedQuery(query);
    if (!match) return;
    const rows = db.prepare(`SELECT s.rootId, s.rootKey, s.relativePath, s.hash, r.startLine, r.endLine, r.text
      FROM passages p JOIN ranges r ON r.id = p.rowid JOIN sources s ON s.id = r.source
      WHERE passages MATCH ? ORDER BY bm25(passages), s.rootId, s.relativePath, r.startLine`).iterate(match) as Iterable<Ranked>;
    for (const row of rows) yield { ...row, matchedOn: 'text' as const };
  } else {
    const paths = db.prepare(`SELECT rootId, rootKey, relativePath, hash FROM sources
      WHERE instr(relativePath, ?) > 0 ORDER BY relativePath != ?, rootId, relativePath`)
      .iterate(query, query) as Iterable<Omit<Source, 'text'>>;
    for (const row of paths) yield { ...row, matchedOn: 'path' as const };
    const sources = db.prepare(`SELECT rootId, rootKey, relativePath, hash, text FROM sources
      WHERE instr(text, ?) > 0 ORDER BY rootId, relativePath`).iterate(query) as Iterable<Source>;
    for (const { text, ...source } of sources) {
      for (const range of literalPassages(text, query)) yield { ...source, ...range, matchedOn: 'text' as const };
    }
  }
}

export function searchProject(registryPath: string, projectId: string, roots: Root[], allRoots: Root[],
  query: string, mode: 'literal' | 'ranked', limit: number) {
  const inventory = liveInventory(roots);
  return withIndex(registryPath, projectId, allRoots, db => {
    const coverage = collectCoverage(db, roots, inventory);
    const hits: Hit[] = [];
    if (db) {
      const verified = new Map<string, boolean>();
      for (const { rootKey: key, hash: expected, ...candidate } of candidates(db, query, mode)) {
        const { rootId, relativePath } = candidate;
        const root = roots.find(root => root.id === rootId && rootKey(root) === key);
        if (!root) continue;
        const cacheKey = JSON.stringify([key, relativePath]);
        if (!verified.has(cacheKey)) {
          const current = inventory.get(rootId)!;
          if ('error' in current && current.error === 'root_unavailable') continue;
          verified.set(cacheKey, verify(root, relativePath, expected, coverage));
        }
        if (!verified.get(cacheKey)) continue;
        hits.push({ sourceId: sourceId(projectId, rootId, relativePath), ...candidate });
        if (hits.length === limit) break;
      }
    }
    return { hits, coverage };
  });
}

function verify(root: Root, relativePath: string, expected: string, coverage: Coverage) {
  let error: string;
  try {
    const path = requireSource(root, relativePath);
    if (hash(readText(path)) === expected) return true;
    error = 'source_changed';
  } catch (cause) {
    error = cause instanceof MarginError ? cause.message : 'source_unavailable';
  }
  const { gaps } = coverage.roots.find(entry => entry.rootId === root.id)!;
  if (!gaps.some(gap => gap.error === error && gap.relativePath === relativePath)) gaps.push({ error, relativePath });
  coverage.complete = false;
  return false;
}
