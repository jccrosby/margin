import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';

import { maxBytes, readBytes } from './read.ts';
import { MarginError, unsafeStorage } from './registry.ts';
import { requirePrivateAccess } from './macos.ts';
import { readPrivateFile, requirePrivateDirectory } from './storage.ts';

const formats = new Map<string, 'pdf' | 'docx' | 'image' | 'video'>([
  ['.pdf', 'pdf'], ['.docx', 'docx'], ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.mkv', 'video'], ['.webm', 'video']
]);

export function evidenceFormat(path: string) {
  return formats.get(extname(path).toLowerCase());
}

const ordinal = z.number().int().positive();
const seconds = z.number().finite().nonnegative();
export const versionHash = z.string().regex(/^[a-f0-9]{64}$/);
export const lineLocation = z.strictObject({ startLine: ordinal, endLine: ordinal });
export type LineLocation = z.infer<typeof lineLocation>;
export const evidenceLocation = z.union([
  z.strictObject({ page: ordinal, item: ordinal }),
  z.strictObject({ headingPath: z.array(z.string()), paragraph: ordinal }),
  z.strictObject({ image: z.literal(1), item: ordinal.optional() }),
  z.strictObject({ startSeconds: seconds, endSeconds: seconds }),
  z.strictObject({ timestampSeconds: seconds }),
  lineLocation,
  z.strictObject({ item: ordinal }),
  z.strictObject({})
]);

type Location = z.infer<typeof evidenceLocation>;
export type EvidenceItem = {
  kind: 'extracted_text' | 'ocr' | 'caption' | 'transcript' | 'image' | 'frame' | 'link' | 'source';
  location: Location;
  text?: string;
};

export type Evidence = {
  items: EvidenceItem[]; errors: string[]; failureDetails?: Record<string, string>;
  retrieval?: Retrieval; approvalsUsed?: string[]; lineBased?: true
};
export function recordExtractionError(evidence: Evidence, cause: unknown) {
  const code = cause instanceof MarginError ? cause.message : 'extraction_failed';
  evidence.errors.push(code);
  if (cause instanceof MarginError && cause.detail) {
    evidence.failureDetails = { ...evidence.failureDetails, [code]: cause.detail };
  }
}

export type Retrieval = { approvedUrl: string; finalUrl: string; retrievedAt: string };
export type ImageBlock = { type: 'image'; mimeType: string; data: string };

const maxInputBytes = 128 * 1024 * 1024;
const maxImageBytes = 4 * 1024 * 1024;
const maxExtractedBytes = 16 * 1024 * 1024;
const commandTimeout = 120_000;

export function contentHash(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readEvidenceBytes(fd: number) {
  return readBytes(fd, maxInputBytes);
}

function withSnapshot<T>(parent: string, bytes: Buffer, extension: string, use: (directory: string, path: string) => T) {
  let directory;
  try {
    requirePrivateDirectory(parent);
    directory = mkdtempSync(join(parent, '.margin-evidence-'));
  } catch {
    throw unsafeStorage('evidence_storage_unavailable', parent);
  }
  try {
    const path = join(directory, `source${extension}`);
    try {
      requirePrivateDirectory(directory);
      const fd = openSync(path, 'wx', 0o600);
      try {
        requirePrivateAccess(fd);
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw unsafeStorage('evidence_storage_unavailable', directory);
    }
    return use(directory, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(directory: string, command: string, args: string[], maxBuffer = maxExtractedBytes) {
  const result = spawnSync('/bin/sh', ['-c', 'umask 077; exec "$@"', 'margin', command, ...args], {
    env: { ...process.env, TMPDIR: directory },
    timeout: commandTimeout, killSignal: 'SIGKILL', maxBuffer, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status === 127) throw new MarginError(`${command}_unavailable`);
  if (result.error || result.status !== 0) throw new MarginError(`${command}_failed`);
  return { stdout: result.stdout, stderr: result.stderr.toString('utf8') };
}

const doclingOutput = z.object({
  texts: z.array(z.object({
    label: z.string(),
    text: z.string(),
    level: ordinal.optional(),
    prov: z.array(z.object({
      page_no: ordinal.optional().catch(undefined),
      charspan: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional().catch(undefined)
    }).catch({})).optional()
  }))
});

function docling(bytes: Buffer, extension: string, scratchParent: string) {
  const format = evidenceFormat(`source${extension}`);
  return withSnapshot(scratchParent, bytes, extension, (directory, path) => {
    const options = extension === '.html' ? ['--html-image-fetch', 'none'] : [];
    if (format !== 'image') options.push('--no-ocr');
    run(directory, 'docling', ['--to', 'json', '--output', directory, ...options, path]);
    const output = join(directory, 'source.json');
    let bytes;
    try {
      bytes = readPrivateFile(output, fd => readBytes(fd, maxExtractedBytes));
    } catch (error) {
      if (error instanceof MarginError && error.message === 'source_too_large') {
        throw new MarginError('extraction_too_large');
      }
      throw unsafeStorage('evidence_storage_unavailable', output);
    }
    return doclingOutput.parse(JSON.parse(bytes.toString('utf8'))).texts;
  });
}

export function extractDocument(bytes: Buffer, extension: string, errors: string[], scratchParent: string): EvidenceItem[] {
  const headings: string[] = [];
  const format = evidenceFormat(`source${extension}`);
  return docling(bytes, extension, scratchParent).flatMap(({ label, text, level, prov }, index): EvidenceItem[] => {
    const item = index + 1;
    if (format === 'docx' && label === 'section_header') {
      const depth = level ?? 1;
      headings.length = Math.min(headings.length, depth - 1);
      headings[depth - 1] = text;
    }
    if (!text.trim()) return [];
    const kind = label === 'caption' ? 'caption' : format === 'image' ? 'ocr' : 'extracted_text';
    if (format === 'pdf') {
      const pages = new Set(prov?.map(entry => entry.page_no).filter(page => page !== undefined));
      if (pages.size === 1 && prov?.every(entry => entry.page_no !== undefined)) {
        return [{ kind, location: { page: [...pages][0], item }, text }];
      }
      const characters = Array.from(text);
      const passages = new Map<number, string[]>();
      const cited = new Uint8Array(characters.length);
      for (const { page_no: page, charspan } of prov ?? []) {
        if (page === undefined || !charspan || charspan[0] >= charspan[1] || charspan[1] > characters.length) {
          continue;
        }
        cited.fill(1, ...charspan);
        const fragment = characters.slice(...charspan).join('');
        if (!fragment.trim()) continue;
        const previous = passages.get(page) ?? [];
        previous.push(fragment);
        passages.set(page, previous);
      }
      if (characters.some((character, index) => !cited[index] && character.trim()) &&
          !errors.includes('citation_unavailable')) errors.push('citation_unavailable');
      return Array.from(passages, ([page, fragments]) => ({ kind, location: { page, item }, text: fragments.join(' ') }));
    }
    if (format === 'docx') {
      return [{ kind, location: { headingPath: headings.filter(Boolean), paragraph: item }, text }];
    }
    return [{ kind, location: format === 'image' ? { image: 1, item } : { item }, text }];
  });
}

function mediaInput(path: string, extension: string) {
  const format = ['.mkv', '.webm'].includes(extension) ? 'matroska' : 'mov';
  return ['-protocol_whitelist', 'file,pipe', '-f', format, '-i', path];
}

function transcript(bytes: Buffer, extension: string, scratchParent: string): EvidenceItem[] {
  return withSnapshot(scratchParent, bytes, extension, (directory, path) => {
    const input = mediaInput(path, extension);
    const { stdout: streams } = run(directory, 'ffprobe', ['-v', 'error', ...input,
      '-select_streams', 's:0', '-show_entries', 'stream=index', '-of', 'csv=p=0']);
    if (!streams.toString('utf8').trim()) return [];
    const { stdout } = run(directory, 'ffmpeg', ['-v', 'error', '-nostdin', '-copyts', '-start_at_zero', ...input,
      '-map', '0:s:0', '-vn', '-an', '-f', 'webvtt', 'pipe:1']);
    const cues = /^((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})[^\n]*\n((?:[^\n]+\n?)+)/gm;
    const parseTime = (value: string) => value.split(':').reduce((time, part) => time * 60 + Number(part), 0);
    return Array.from(stdout.toString('utf8').matchAll(cues), ([, start, end, text]) => ({
      kind: 'transcript', location: { startSeconds: parseTime(start), endSeconds: parseTime(end) }, text: text.trim()
    }));
  });
}

export function extractEvidence(bytes: Buffer, path: string, scratchParent: string): Evidence {
  const format = evidenceFormat(path);
  const extension = extname(path).toLowerCase();
  const items: EvidenceItem[] = format === 'image' ? [{ kind: 'image', location: { image: 1 } }] : [];
  const errors: string[] = [];
  const evidence: Evidence = { items, errors };
  try {
    const extracted = format === 'video' ? transcript(bytes, extension, scratchParent) : extractDocument(bytes, extension, errors, scratchParent);
    if (!extracted.length && !errors.length) {
      errors.push(format === 'video' ? 'transcript_unavailable' : format === 'image' ? 'ocr_unavailable' : 'no_extractable_text');
    }
    for (const item of extracted) {
      if (Buffer.byteLength(item.text!) <= maxBytes) items.push(item);
      else if (!errors.includes('evidence_too_large')) errors.push('evidence_too_large');
    }
  } catch (error) {
    recordExtractionError(evidence, error);
  }
  return evidence;
}

export function imageBlock(bytes: Buffer, mimeType: string): ImageBlock {
  if (bytes.length > maxImageBytes) throw new MarginError('image_too_large');
  return { type: 'image', mimeType, data: bytes.toString('base64') };
}

export function originalImage(bytes: Buffer, path: string) {
  const png = extname(path).toLowerCase() === '.png';
  const signature = png ? '89504e470d0a1a0a' : 'ffd8ff';
  if (!bytes.subarray(0, signature.length / 2).equals(Buffer.from(signature, 'hex'))) {
    throw new MarginError('image_invalid');
  }
  return imageBlock(bytes, png ? 'image/png' : 'image/jpeg');
}

export function videoFrame(bytes: Buffer, path: string, atSeconds: number, scratchParent: string) {
  const extension = extname(path).toLowerCase();
  return withSnapshot(scratchParent, bytes, extension, (directory, snapshot) => {
    const offset = Math.max(0, atSeconds - 1e-9);
    const { stdout, stderr } = run(directory, 'ffmpeg', [
      '-hide_banner', '-nostdin', '-copyts', '-start_at_zero', ...mediaInput(snapshot, extension), '-map', '0:v:0', '-an',
      '-vf', `select=gte(t\\,${offset.toFixed(9)}),scale=1280:1280:force_original_aspect_ratio=decrease,showinfo`,
      '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'
    ]);
    const showinfo = stderr.split('\n')
      .filter(line => /^(?:\[[^\]]+\]\s*)*\[Parsed_showinfo_\d+ @ [^\]]+\]/.test(line)).join('\n');
    const timeBase = showinfo.match(/config in time_base: (\d+)\/(\d+)/);
    const pts = showinfo.match(/\bn:\s*0\s+pts:\s*(-?\d+)/);
    if (!stdout.length || !timeBase || !pts) throw new MarginError('frame_unavailable');
    const timestampSeconds = Number(pts[1]) * Number(timeBase[1]) / Number(timeBase[2]);
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) throw new MarginError('frame_unavailable');
    return { location: { timestampSeconds }, image: imageBlock(stdout, 'image/png') };
  });
}
