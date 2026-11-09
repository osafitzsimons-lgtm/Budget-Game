// Turn pdf.js text items into lines and "phrases" using their x/y positions.

export interface TextItem {
  str: string;
  /** left edge, PDF points */
  x: number;
  /** baseline measured from the TOP of the page (so larger = lower) */
  y: number;
  w: number;
  h: number;
  page: number;
}

/** Adjacent items on a line merged into one piece of text (e.g. "Money" + "In"). */
export interface Phrase {
  text: string;
  x: number;
  right: number;
  y: number;
  h: number;
}

export interface Line {
  page: number;
  y: number;
  h: number;
  items: TextItem[];
  phrases: Phrase[];
  text: string;
}

export class StatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementError';
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function toPhrases(items: TextItem[]): Phrase[] {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const out: Phrase[] = [];
  for (const it of sorted) {
    const text = it.str.replace(/\s+/g, ' ');
    if (!text.trim()) continue;
    const prev = out[out.length - 1];
    // Merge when the gap is smaller than roughly one character width.
    const gap = prev ? it.x - prev.right : Infinity;
    if (prev && gap < Math.max(1.5, it.h * 0.6)) {
      const space = gap > it.h * 0.12 && !prev.text.endsWith(' ') && !text.startsWith(' ') ? ' ' : '';
      prev.text += space + text;
      prev.right = Math.max(prev.right, it.x + it.w);
    } else {
      out.push({ text, x: it.x, right: it.x + it.w, y: it.y, h: it.h });
    }
  }
  for (const p of out) p.text = p.text.trim();
  return out.filter((p) => p.text);
}

/** Group items into lines: items whose baselines are within a fraction of the text height share a line. */
export function groupLines(items: TextItem[]): Line[] {
  const pages = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const list = pages.get(it.page) ?? [];
    list.push(it);
    pages.set(it.page, list);
  }
  const lines: Line[] = [];
  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const its = pages.get(page)!.sort((a, b) => a.y - b.y || a.x - b.x);
    const tol = Math.max(1, median(its.map((i) => i.h)) * 0.35);
    let cur: TextItem[] = [];
    let curY = -Infinity;
    const flush = () => {
      if (!cur.length) return;
      const phrases = toPhrases(cur);
      lines.push({ page, y: median(cur.map((i) => i.y)), h: median(cur.map((i) => i.h)), items: cur, phrases, text: phrases.map((p) => p.text).join(' ') });
      cur = [];
    };
    for (const it of its) {
      if (cur.length && Math.abs(it.y - curY) > tol) flush();
      if (!cur.length) curY = it.y;
      cur.push(it);
    }
    flush();
  }
  return lines;
}

/**
 * Page furniture: lines (digits ignored) repeated at the same height on most pages,
 * e.g. bank name, "Page 3 of 9", column headers. Returns a predicate.
 */
export function furnitureDetector(lines: Line[]): (l: Line) => boolean {
  const pageCount = new Set(lines.map((l) => l.page)).size;
  if (pageCount < 2) return (l) => /^page \d+( of \d+)?$/i.test(l.text);
  const norm = (l: Line) => l.text.replace(/\d/g, '#').toLowerCase();
  const key = (l: Line) => `${Math.round(l.y / 3)}|${norm(l)}`;
  const pagesFor = new Map<string, Set<number>>();
  // Heights at which each text appears anywhere. Real headers/footers sit at one height;
  // description text like "PHNOM PENH KH" turns up at many heights, so it is never furniture.
  const heightsFor = new Map<string, Set<number>>();
  for (const l of lines) {
    const k = key(l);
    const s = pagesFor.get(k) ?? new Set<number>();
    s.add(l.page);
    pagesFor.set(k, s);
    const h = heightsFor.get(norm(l)) ?? new Set<number>();
    h.add(Math.round(l.y / 3));
    heightsFor.set(norm(l), h);
  }
  const need = Math.max(2, Math.ceil(pageCount * 0.6));
  return (l) =>
    /^page \d+( of \d+)?$/i.test(l.text) ||
    ((pagesFor.get(key(l))?.size ?? 0) >= need && (heightsFor.get(norm(l))?.size ?? 0) <= 2);
}

export interface Column {
  name: string;
  x: number;
  right: number;
}

export const center = (p: { x: number; right: number }) => (p.x + p.right) / 2;

/** Assign a phrase to the nearest of the given columns, by centre or right edge (numbers are often right-aligned). */
export function nearestColumn(p: Phrase, cols: Column[]): Column {
  let best = cols[0];
  let bestD = Infinity;
  for (const c of cols) {
    const d = Math.min(Math.abs(center(p) - center(c)), Math.abs(p.right - c.right));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Find a header line containing phrases matching each pattern (in order of appearance not required). */
export function matchHeader(line: Line, patterns: Record<string, RegExp>): Record<string, Column> | null {
  const found: Record<string, Column> = {};
  for (const [name, re] of Object.entries(patterns)) {
    let hit: Column | null = null;
    for (const ph of line.phrases) {
      const m = new RegExp(re.source, re.flags.replace('g', '')).exec(ph.text);
      if (!m) continue;
      // If several headers got merged into one phrase, estimate this header's position by character offset.
      const per = (ph.right - ph.x) / Math.max(1, ph.text.length);
      hit = { name, x: ph.x + m.index * per, right: ph.x + (m.index + m[0].length) * per };
      break;
    }
    if (!hit) return null;
    found[name] = hit;
  }
  return found;
}
