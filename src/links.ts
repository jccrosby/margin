import { contentHash, extractDocument, type Evidence, type EvidenceItem } from './evidence.ts';
import { rankedPassages, textLines } from './passages.ts';
import { maxBytes } from './read.ts';
import { approvedHttpsUrl, MarginError } from './registry.ts';

export const linksId = '@links';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRequests = 6;
const maxResponseBytes = 8 * 1024 * 1024;

export async function fetchEvidence(approvedUrl: string, approvals: string[]) {
  const signal = AbortSignal.timeout(15_000);
  const requested: string[] = [];
  let current = approvedUrl;
  for (let request = 0; request < maxRequests; request++) {
    if (!approvals.includes(current)) throw new MarginError('redirect_not_approved');
    if (requested.includes(current)) throw new MarginError('redirect_loop');
    requested.push(current);
    const response = await fetch(current, { redirect: 'manual', signal });
    if (redirectStatuses.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      const resolved = location && URL.parse(location, current);
      const next = resolved && approvedHttpsUrl(resolved.href);
      if (!next) throw new MarginError('invalid_redirect');
      if (!approvals.includes(next)) throw new MarginError('redirect_not_approved');
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MarginError(`http_${response.status}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxResponseBytes) throw new MarginError('response_too_large');
        chunks.push(Buffer.from(chunk));
      }
    }
    const bytes = Buffer.concat(chunks, size);
    const evidence: Evidence = {
      retrieval: { approvedUrl, finalUrl: current, retrievedAt: new Date().toISOString() },
      approvalsUsed: requested, items: [], errors: []
    };
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    let sourceText;
    try {
      const parsed = linkItems(bytes, mediaType, evidence.errors);
      evidence.items = parsed.items;
      sourceText = parsed.sourceText;
      if (sourceText !== undefined) evidence.lineBased = true;
      if (!evidence.items.length && !evidence.errors.length) evidence.errors.push('no_extractable_text');
    } catch (error) {
      evidence.errors.push(error instanceof MarginError ? error.message : 'extraction_failed');
    }
    return { digest: contentHash(bytes), evidence, sourceText };
  }
  throw new MarginError('redirect_limit');
}

function linkItems(bytes: Buffer, mediaType: string | undefined, errors: string[]):
  { items: EvidenceItem[]; sourceText?: string } {
  if (mediaType === 'text/html' || mediaType === 'application/pdf') {
    const items = extractDocument(bytes, mediaType === 'text/html' ? '.html' : '.pdf', errors);
    if (items.some(item => Buffer.byteLength(item.text!) > maxBytes)) errors.push('evidence_too_large');
    return { items: items.filter(item => Buffer.byteLength(item.text!) <= maxBytes) };
  }
  if (mediaType === 'text/plain' || mediaType === 'text/markdown' || mediaType === 'application/json') {
    const sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const lines = textLines(sourceText);
    const sizes = lines.map(line => Buffer.byteLength(line));
    if (sizes.some(size => size > maxBytes)) errors.push('line_too_long');
    const items = Array.from(rankedPassages(lines, sizes), ({ startLine, endLine, text }): EvidenceItem =>
      ({ kind: 'extracted_text', location: { startLine, endLine }, text }));
    return { items, sourceText };
  }
  throw new MarginError('unsupported_content_type');
}
