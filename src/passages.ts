import { maxBytes } from './read.ts';

const maxLines = 40;
const overlap = 8;

export function textLines(text: string) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function passageEnd(sizes: number[], start: number) {
  let end = start;
  let bytes = 0;
  while (end < sizes.length && end - start < maxLines && bytes + sizes[end] <= maxBytes) {
    bytes += sizes[end++];
  }
  return end;
}

export function* rankedPassages(lines: string[], sizes: number[]) {
  for (let start = 0; start < lines.length;) {
    const end = passageEnd(sizes, start);
    if (end > start) {
      yield { startLine: start + 1, endLine: end, text: lines.slice(start, end).join('') };
    }
    if (end === lines.length) break;
    start = sizes[end] > maxBytes ? end + 1 : Math.max(start + 1, end - overlap);
  }
}

export function* literalPassages(text: string, query: string) {
  const lines = textLines(text);
  const sizes = lines.map(line => Buffer.byteLength(line));
  let offset = 0;
  const lineEnds = lines.map(line => offset += line.length);
  let line = 0;
  let citedUntil = 0;
  for (let match = text.indexOf(query); match !== -1; match = text.indexOf(query, match + 1)) {
    const matchEnd = match + query.length;
    if (matchEnd <= citedUntil) continue;
    while (lineEnds[line] <= match) line++;
    const end = passageEnd(sizes, line);
    if (end === line || lineEnds[end - 1] < matchEnd) {
      yield undefined;
      continue;
    }
    yield { startLine: line + 1, endLine: end, text: lines.slice(line, end).join('') };
    citedUntil = lineEnds[end - 1];
  }
}
