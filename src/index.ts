import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  contentHash as hash, evidenceFormat, extractEvidence, originalImage, readEvidenceBytes, videoFrame,
  type Evidence, type EvidenceItem, type LineLocation, type Retrieval
} from './evidence.ts';
import { fetchEvidence, linksId } from './links.ts';
import { literalPassages, passageAtLines, rankedPassages, textLines } from './passages.ts';
import { maxBytes, readText } from './read.ts';
import { canonicalLocation, checkOutsideRoots, hasDarwinAcl, MarginError, type Project, type Root } from './registry.ts';
import { requireListedSource, requireSource, savedNotesId, scanPaths, sourceId } from './sources.ts';

type IndexRoot = Root | { id: typeof linksId; kind: 'links'; path: ''; urls: string[] };

export function indexRoots(project: Project, savedNotes?: Root): IndexRoot[] {
  const roots: IndexRoot[] = [...project.roots];
  const urls = project.approvedUrls;
  if (urls?.length) roots.push({ id: linksId, kind: 'links', path: '', urls });
  if (savedNotes) roots.push(savedNotes);
  return roots;
}

type Gap = { error: string; relativePath?: string };
type Refresh = { status: string; refreshedAt?: string; gaps: Gap[] };
export type Inventory = Map<string, ReturnType<typeof scanPaths> | { error: string }>;
type Source = { rootId: string; rootKey: string; relativePath: string; hash: string; text: string };
type Passage = { startLine: number; endLine: number; text: string };
type Ranked = Omit<Source, 'text'> & Passage;
type Hit = {
  sourceId: string; rootId: string; relativePath: string; matchedOn: 'path' | 'text'
} & Partial<Passage & EvidenceItem & Retrieval & { contentHash: string }>;

function rootKey(root: IndexRoot) {
  return JSON.stringify([root.id, root.kind, root.path]);
}

function indexPath(registryPath: string, projectId: string, roots: Root[], privateNotes = false) {
  // fix: Hash IDs to keep case variants separate on case-insensitive filesystems.
  const path = `${canonicalLocation(registryPath)}.${hash(projectId)}.sqlite`;
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    checkOutsideRoots(candidate, roots, 'index');
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
          (privateNotes && (stat.uid !== process.getuid?.() || hasDarwinAcl(candidate)))) {
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
  CREATE TABLE IF NOT EXISTS evidence (
    source INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    data TEXT NOT NULL
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

const busyTimeout = 5000;
const sqliteBusy = 5;

function enableWal(db: DatabaseSync) {
  const deadline = performance.now() + busyTimeout;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      if (db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode === 'wal') return;
      throw new MarginError('index_unavailable');
    } catch (error) {
      const { errcode = 0 } = error as { errcode?: number };
      if ((errcode & 0xff) !== sqliteBusy || performance.now() >= deadline) throw error;
      // fix: SQLite can skip its busy timeout during a journal mode change.
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
}

function openIndex(path: string, write: boolean) {
  try {
    if (write) closeSync(openSync(path, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
    else lstatSync(path);
    const db = new DatabaseSync(path, { readOnly: !write, timeout: busyTimeout, enableForeignKeyConstraints: true });
    if (write) {
      try {
        // fix: WAL lets read-only clients read the last commit after a writer dies.
        enableWal(db);
        db.exec('PRAGMA synchronous = FULL');
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

export async function refreshProject(registryPath: string, projectId: string, roots: IndexRoot[], allRoots: Root[],
  privateNotes = false) {
  const db = openIndex(indexPath(registryPath, projectId, allRoots, privateNotes), true)!;
  try {
    const registered = [...roots.map(root => root.id), savedNotesId];
    const placeholders = registered.map(() => '?').join(', ');
    db.prepare(`DELETE FROM sources WHERE rootId NOT IN (${placeholders})`).run(...registered);
    db.prepare(`DELETE FROM refreshes WHERE rootId NOT IN (${placeholders})`).run(...registered);
    const refreshed = [];
    for (const root of roots) refreshed.push({ rootId: root.id, ...await refreshRoot(db, root) });
    return refreshed;
  } finally {
    db.close();
  }
}

async function refreshRoot(db: DatabaseSync, root: IndexRoot) {
  const key = rootKey(root);
  const attempt = randomUUID();
  db.prepare(`INSERT INTO refreshes VALUES (?, ?, ?, 'refreshing', NULL, '[]')
    ON CONFLICT(rootKey) DO UPDATE SET attempt = excluded.attempt, status = 'refreshing'`).run(key, root.id, attempt);
  const links = root.kind === 'links' ? await getLinks(root.urls) : undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT attempt FROM refreshes WHERE rootKey = ?').get(key)?.attempt === attempt) {
      if (root.kind === 'links') {
        publishLinks(db, root, key, links!);
      } else {
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
  const publishText = textPublisher(db, root.id, key);
  for (const entry of old) {
    if (entry.rootKey !== key || !retained.has(entry.relativePath as string)) removeSource.run(entry.id);
  }
  for (const relativePath of inventory.paths) {
    let text;
    let bytes;
    const format = evidenceFormat(relativePath);
    try {
      const path = requireListedSource(root, relativePath);
      if (format) bytes = readEvidenceBytes(path);
      text = format ? '' : readText(path);
    } catch (cause) {
      gaps.push({ error: cause instanceof MarginError ? cause.message : 'source_unavailable', relativePath });
      continue;
    }

    const entry = previous.get(relativePath);
    if (bytes) {
      const digest = hash(bytes);
      let evidence = entry?.hash === digest ? storedEvidence(db, root.id, key, relativePath)?.evidence : undefined;
      if (evidence && !evidence.errors.length) continue;
      evidence = extractEvidence(bytes, relativePath);
      for (const error of evidence.errors) gaps.push({ error, relativePath });
      if (entry) removeSource.run(entry.id);
      saveEvidence(db, root.id, key, relativePath, digest, evidence);
      continue;
    }

    if (publishText(relativePath, text, entry)) {
      gaps.push({ error: 'line_too_long', relativePath });
    }
  }
  publishStatus(db, key, gaps);
}

function textPublisher(db: DatabaseSync, rootId: string, key: string) {
  const removeSource = db.prepare('DELETE FROM sources WHERE id = ?');
  const addSource = db.prepare('INSERT INTO sources(rootId, rootKey, relativePath, hash, text) VALUES (?, ?, ?, ?, ?)');
  const addRange = db.prepare('INSERT INTO ranges(source, startLine, endLine, text) VALUES (?, ?, ?, ?)');

  return (relativePath: string, text: string, previous?: Record<string, SQLOutputValue>) => {
    const lines = textLines(text);
    const sizes = lines.map(line => Buffer.byteLength(line));
    const digest = hash(text);
    if (previous?.hash !== digest) {
      if (previous) removeSource.run(previous.id);
      const { lastInsertRowid } = addSource.run(rootId, key, relativePath, digest, text);
      for (const passage of rankedPassages(lines, sizes)) {
        addRange.run(lastInsertRowid, passage.startLine, passage.endLine, passage.text);
      }
    }
    return sizes.some(size => size > maxBytes);
  };
}

export function indexSavedNote(registryPath: string, projectId: string, allRoots: Root[], root: Root,
  relativePath: string) {
  const db = openIndex(indexPath(registryPath, projectId, allRoots, true), true)!;
  try {
    db.exec('BEGIN IMMEDIATE');
    const key = rootKey(root);
    const previous = db.prepare('SELECT id, hash FROM sources WHERE rootKey = ? AND relativePath = ?')
      .get(key, relativePath);
    const text = readText(requireSource(root, relativePath));
    const gaps = getRefresh(db, key).gaps.filter(gap => gap.relativePath !== relativePath);
    const publishText = textPublisher(db, root.id, key);
    if (publishText(relativePath, text, previous)) {
      gaps.push({ error: 'line_too_long', relativePath });
    }
    db.prepare("INSERT OR IGNORE INTO refreshes VALUES (?, ?, '', 'complete', NULL, '[]')").run(key, root.id);
    publishStatus(db, key, gaps);
    db.exec('COMMIT');
  } catch {
    throw new MarginError('index_unavailable');
  } finally {
    db.close();
  }
}

async function getLinks(urls: string[]) {
  const successes = new Map<string, Awaited<ReturnType<typeof fetchEvidence>>>();
  const gaps: Gap[] = [];
  for (const url of urls) {
    try {
      const fetched = await fetchEvidence(url, urls);
      successes.set(url, fetched);
      for (const error of fetched.evidence.errors) gaps.push({ error, relativePath: url });
    } catch (cause) {
      gaps.push({ error: cause instanceof MarginError ? cause.message : 'fetch_failed', relativePath: url });
    }
  }
  return { successes, gaps };
}

function publishLinks(db: DatabaseSync, root: IndexRoot, key: string, { successes, gaps }: Awaited<ReturnType<typeof getLinks>>) {
  db.prepare('DELETE FROM sources WHERE rootKey = ?').run(key);
  for (const [url, { digest, evidence, sourceText }] of successes) {
    saveEvidence(db, root.id, key, url, digest, evidence, sourceText);
  }
  publishStatus(db, key, gaps);
}

function saveEvidence(db: DatabaseSync, rootId: string, key: string, path: string, digest: string,
  evidence: Evidence, sourceText?: string) {
  const addSource = db.prepare('INSERT INTO sources(rootId, rootKey, relativePath, hash, text) VALUES (?, ?, ?, ?, ?)');
  const { lastInsertRowid } = addSource.run(rootId, key, path, digest,
    sourceText ?? evidence.items.map(item => item.text ?? '').join('\n'));
  db.prepare('INSERT INTO evidence(source, data) VALUES (?, ?)').run(lastInsertRowid, JSON.stringify(evidence));
  const addRange = db.prepare('INSERT INTO ranges(source, startLine, endLine, text) VALUES (?, ?, ?, ?)');
  // feat: Store the item position for evidence ranges so search can recover its locator.
  for (const [index, item] of evidence.items.entries()) {
    const itemPosition = index + 1;
    if (item.text) addRange.run(lastInsertRowid, itemPosition, itemPosition, item.text);
  }
}

function publishStatus(db: DatabaseSync, key: string, gaps: Gap[]) {
  db.prepare('UPDATE refreshes SET status = ?, refreshedAt = ?, gaps = ? WHERE rootKey = ?')
    .run(gaps.length ? 'partial' : 'complete', new Date().toISOString(), JSON.stringify(gaps), key);
}

export function liveInventory(roots: IndexRoot[]): Inventory {
  const inventory: Inventory = new Map();
  for (const root of roots) {
    try {
      inventory.set(root.id, root.kind === 'links' ? { paths: root.urls, unreadable: [] } : scanPaths(root));
    } catch (error) {
      if (!(error instanceof MarginError)) throw error;
      inventory.set(root.id, { error: error.message });
    }
  }
  return inventory;
}

type Coverage = ReturnType<typeof collectCoverage>;

function collectCoverage(db: DatabaseSync | undefined, roots: IndexRoot[], inventory: Inventory,
  indexUnavailable = false
) {
  const coverage = roots.map(root => {
    const key = rootKey(root);
    const { status, refreshedAt, gaps } = getRefresh(db, key);
    const live = inventory.get(root.id)!;
    const savedNotes = root.id === savedNotesId;
    if (indexUnavailable) gaps.push({ error: 'index_unavailable' });
    if ('error' in live) gaps.push(live);
    else {
      for (const relativePath of live.unreadable) gaps.push({ error: 'source_unavailable', relativePath });
      if (!indexUnavailable && (savedNotes || (db && status !== 'not_refreshed'))) {
        const indexed = new Set(db?.prepare('SELECT relativePath FROM sources WHERE rootKey = ?')
          .all(key).map(row => row.relativePath as string));
        const failed = new Set(gaps.map(gap => gap.relativePath));
        const added = live.paths.filter(path => !indexed.delete(path) && (root.kind !== 'links' || !failed.has(path)));
        for (const path of live.unreadable) indexed.delete(path);
        if (savedNotes) {
          for (const relativePath of added) gaps.push({ error: 'source_not_indexed', relativePath });
        }
        if (indexed.size || (added.length && !savedNotes)) gaps.push({ error: 'paths_changed' });
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
  registryPath: string, projectId: string, allRoots: Root[], read: (db: DatabaseSync | undefined) => T,
  privateNotes = false
) {
  const db = openIndex(indexPath(registryPath, projectId, allRoots, privateNotes), false);
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

export function indexCoverage(registryPath: string, projectId: string, roots: IndexRoot[],
  allRoots: Root[], inventory: Inventory) {
  try {
    return withIndex(registryPath, projectId, allRoots, db => collectCoverage(db, roots, inventory),
      roots.some(root => root.id === savedNotesId));
  } catch {
    return collectCoverage(undefined, roots, inventory, true);
  }
}

function storedEvidence(db: DatabaseSync | undefined, rootId: string, key: string, relativePath: string) {
  if (!db?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'evidence'").get()) return undefined;
  const row = db.prepare(`SELECT s.hash, s.text, e.data FROM sources s JOIN evidence e ON e.source = s.id
    WHERE s.rootId = ? AND s.rootKey = ? AND s.relativePath = ?`).get(rootId, key, relativePath);
  if (row) {
    const evidence = JSON.parse(row.data as string) as Evidence;
    return { contentHash: row.hash as string, evidence, sourceText: evidence.lineBased ? row.text as string : undefined };
  }
}

export function readTextPassage(root: Root, relativePath: string, requestedHash: string, location: LineLocation) {
  if (evidenceFormat(relativePath)) throw new MarginError('evidence_unavailable');
  const sourceText = readText(requireSource(root, relativePath), bytes => {
    if (hash(bytes) !== requestedHash) throw new MarginError('stale_citation');
  });
  const text = passageAtLines(sourceText, location.startLine, location.endLine);
  if (text === undefined) throw new MarginError('evidence_unavailable');
  return text;
}

export function openEvidence(registryPath: string, projectId: string, root: IndexRoot, allRoots: Root[],
  relativePath: string, requestedHash: string | undefined, location: EvidenceItem['location'] | undefined,
  atSeconds: number | undefined) {
  const format = evidenceFormat(relativePath);
  const lookup = () => withIndex(registryPath, projectId, allRoots, db =>
    storedEvidence(db, root.id, rootKey(root), relativePath));
  const source = { sourceId: sourceId(projectId, root.id, relativePath), rootId: root.id, relativePath };
  if (root.kind === 'links') {
    if (atSeconds !== undefined) throw new MarginError('invalid_argument');
    if (!root.urls.includes(relativePath)) throw new MarginError('source_unavailable');
    const indexed = lookup();
    if (!indexed || !allowsRetrieval(root.urls, indexed.evidence)) throw new MarginError('refresh_required');
    const { contentHash, evidence } = indexed;
    if (requestedHash && requestedHash !== contentHash) throw new MarginError('stale_citation');
    let item: EvidenceItem | undefined;
    if (indexed.sourceText !== undefined && location && 'startLine' in location) {
      const text = passageAtLines(indexed.sourceText, location.startLine, location.endLine);
      if (text === undefined) throw new MarginError('evidence_unavailable');
      item = { kind: 'extracted_text', location, text };
    } else {
      item = selectEvidence(evidence, location, item => item.text !== undefined);
    }
    return { data: { ...source, contentHash, ...evidence.retrieval, failures: evidence.errors,
      ...(item ?? { kind: 'link', location: {} }) } };
  }
  if (!format) {
    if (!requestedHash || !location || !('startLine' in location)) throw new MarginError('evidence_unavailable');
    const { startLine, endLine } = location;
    const text = readTextPassage(root, relativePath, requestedHash, { startLine, endLine });
    return { data: { ...source, contentHash: requestedHash, kind: 'extracted_text', location, text, failures: [] } };
  }
  if (atSeconds !== undefined && format !== 'video') throw new MarginError('invalid_argument');
  const bytes = readEvidenceBytes(requireSource(root, relativePath));
  const contentHash = hash(bytes);
  if (requestedHash && requestedHash !== contentHash) throw new MarginError('stale_citation');
  const media = format === 'image' || (format === 'video' && (atSeconds !== undefined ||
    (location && 'timestampSeconds' in location)));
  let indexed;
  const failures = [];
  try {
    indexed = lookup();
  } catch (error) {
    if (!media || !(error instanceof MarginError) || error.message !== 'index_unavailable') throw error;
    failures.push(error.message);
  }
  const evidence = indexed?.contentHash === contentHash ? indexed.evidence : undefined;
  const base = {
    ...source, contentHash, failures: evidence?.errors ?? failures
  };
  if (format === 'image' && (!location || ('image' in location && !('item' in location)))) {
    return { data: { ...base, kind: 'image', location: { image: 1 } }, image: originalImage(bytes, relativePath) };
  }
  if (format === 'video' && (atSeconds !== undefined || (location && 'timestampSeconds' in location))) {
    const timestamp = location && 'timestampSeconds' in location ? location.timestampSeconds : atSeconds!;
    const frame = videoFrame(bytes, relativePath, timestamp);
    if (atSeconds === undefined && Math.abs(frame.location.timestampSeconds - timestamp) > 1e-9) {
      throw new MarginError('evidence_unavailable');
    }
    return { data: { ...base, kind: 'frame', location: frame.location }, image: frame.image };
  }
  if (!evidence) throw new MarginError('refresh_required');
  const item = selectEvidence(evidence, location, item => item.text !== undefined);
  return { data: { ...base, ...(item ?? { kind: 'source', location: {} }) } };
}

function allowsRetrieval(urls: string[], evidence: Evidence) {
  return evidence.approvalsUsed?.every(url => urls.includes(url)) === true;
}

function selectEvidence(evidence: Evidence, location: EvidenceItem['location'] | undefined,
  defaultItem: (item: EvidenceItem) => boolean) {
  if (location && !Object.keys(location).length) return undefined;
  const item = location
    ? evidence.items.find(item => JSON.stringify(item.location) === JSON.stringify(location))
    : evidence.items.find(defaultItem);
  if (location && !item) throw new MarginError('evidence_unavailable');
  return item;
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
      if (source.rootId === linksId || evidenceFormat(source.relativePath)) {
        yield { ...source, matchedOn: 'text' as const };
        continue;
      }
      for (const range of literalPassages(text, query)) {
        if (range) yield { ...source, ...range, matchedOn: 'text' as const };
        else yield { ...source, missingCitation: true };
      }
    }
  }
}

export function searchProject(registryPath: string, projectId: string, roots: IndexRoot[], allRoots: Root[],
  query: string, mode: 'literal' | 'ranked', limit: number) {
  const inventory = liveInventory(roots);
  const search = () => withIndex(registryPath, projectId, allRoots, db => {
    const coverage = collectCoverage(db, roots, inventory);
    const hits: Hit[] = [];
    if (db) {
      const verified = new Map<string, boolean>();
      const snapshots = new Map<string, ReturnType<typeof storedEvidence>>();
      for (const { rootKey: key, hash: expected, ...candidate } of candidates(db, query, mode)) {
        const { rootId, relativePath } = candidate;
        const root = roots.find(root => root.id === rootId && rootKey(root) === key);
        if (!root) continue;
        const cacheKey = JSON.stringify([key, relativePath]);
        if (!verified.has(cacheKey)) {
          const current = inventory.get(rootId)!;
          if ('error' in current && current.error === 'root_unavailable') continue;
          verified.set(cacheKey, root.kind === 'links'
            ? root.urls.includes(relativePath)
            : verify(root, relativePath, expected, coverage));
        }
        if (!verified.get(cacheKey)) continue;
        if ('missingCitation' in candidate) {
          recordGap(coverage, rootId, { error: 'citation_unavailable', relativePath });
          continue;
        }
        if (root.kind === 'links' || evidenceFormat(relativePath)) {
          if (!snapshots.has(cacheKey)) {
            snapshots.set(cacheKey, storedEvidence(db, rootId, key, relativePath));
          }
          const snapshot = snapshots.get(cacheKey);
          if (!snapshot) continue;
          const { evidence: stored, sourceText } = snapshot;
          if (root.kind === 'links' && !allowsRetrieval(root.urls, stored)) {
            recordGap(coverage, rootId, { error: 'redirect_not_approved', relativePath });
            continue;
          }
          const matchedOn = candidate.matchedOn;
          const source = { sourceId: sourceId(projectId, rootId, relativePath), rootId, relativePath,
            contentHash: expected, ...stored.retrieval };
          if (matchedOn === 'path') {
            const item = stored.items[0];
            const kind: EvidenceItem['kind'] = root.kind === 'links' ? 'link' : 'source';
            const cite = item ? { kind: item.kind, location: item.location } : { kind, location: {} };
            hits.push({ ...source, matchedOn, ...cite });
          } else if (mode === 'literal' && sourceText !== undefined) {
            for (const passage of literalPassages(sourceText, query)) {
              if (!passage) {
                recordGap(coverage, rootId, { error: 'citation_unavailable', relativePath });
                continue;
              }
              const { text, ...location } = passage;
              hits.push({ ...source, matchedOn: 'text', kind: 'extracted_text', location, text });
              if (hits.length === limit) break;
            }
          } else {
            const itemPosition = 'startLine' in candidate ? candidate.startLine : undefined;
            const items = mode === 'ranked' && itemPosition !== undefined
              ? [stored.items[itemPosition - 1]]
              : stored.items.filter(item => item.text?.includes(query));
            for (const item of items) {
              if (!item) continue;
              hits.push({ ...source, matchedOn: 'text', ...item });
              if (hits.length === limit) break;
            }
          }
          if (hits.length === limit) break;
          continue;
        }
        const source = { sourceId: sourceId(projectId, rootId, relativePath), ...candidate };
        hits.push(candidate.matchedOn === 'text' ? { ...source, contentHash: expected } : source);
        if (hits.length === limit) break;
      }
    }
    return { hits, coverage };
  }, roots.some(root => root.id === savedNotesId));
  try {
    return search();
  } catch (error) {
    if (error instanceof MarginError && error.message !== 'index_unavailable') throw error;
    const notes = inventory.get(savedNotesId);
    if (!notes || !('paths' in notes) || !notes.paths.length) throw error;
    return { hits: [], coverage: collectCoverage(undefined, roots, inventory, true) };
  }
}

function verify(root: Root, relativePath: string, expected: string, coverage: Coverage) {
  let error: string;
  try {
    const path = requireSource(root, relativePath);
    if (hash(evidenceFormat(relativePath) ? readEvidenceBytes(path) : readText(path)) === expected) return true;
    error = 'source_changed';
  } catch (cause) {
    error = cause instanceof MarginError ? cause.message : 'source_unavailable';
  }
  recordGap(coverage, root.id, { error, relativePath });
  return false;
}

function recordGap(coverage: Coverage, rootId: string, gap: Gap) {
  const { gaps } = coverage.roots.find(entry => entry.rootId === rootId)!;
  if (!gaps.some(entry => entry.error === gap.error && entry.relativePath === gap.relativePath)) gaps.push(gap);
  coverage.complete = false;
}
