// Edge-case kit: flexible synthetic layouts (no real data) for trying to break the parsers.
// Pages are built as PlacedText[][] and run through a real PDF + real pdf.js, or turned
// into TextItem[] directly when we want to simulate odd pdf.js output.
import { expect } from 'vitest';
import { extractItems, parseStatementItems, StatementError, type ParsedStatement, type TextItem } from '../../src/parsers/index';
import { loadPdfJs } from '../helpers/pdf';
import { makePdf, type PlacedText } from '../helpers/pdfgen';

export const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const W = (s: string, size = 9) => s.length * size * 0.5;
export const right = (xRight: number, text: string, y: number, size = 9): PlacedText => ({ x: xRight - W(text, size), y, text, size });

export async function itemsOf(pages: PlacedText[][]): Promise<TextItem[]> {
  return extractItems(await loadPdfJs(), makePdf(pages));
}

/** Direct conversion without pdf.js (widths approximated like the helpers do). */
export function itemsDirect(pages: PlacedText[][]): TextItem[] {
  return pages.flatMap((p, i) => p.map((t) => ({ str: t.text, x: t.x, y: t.y, w: W(t.text, t.size ?? 9), h: t.size ?? 9, page: i + 1 })));
}

export async function parsePages(pages: PlacedText[][]): Promise<ParsedStatement> {
  return parseStatementItems(await itemsOf(pages));
}

export type Outcome = { ok: true; st: ParsedStatement } | { ok: false; err: unknown };

export async function attempt(f: () => ParsedStatement | Promise<ParsedStatement>): Promise<Outcome> {
  try {
    return { ok: true, st: await f() };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Spec: either a StatementError, or a result that passes `check`. Never silently wrong, never a non-StatementError crash. */
export async function correctOrRefused(f: () => ParsedStatement | Promise<ParsedStatement>, check: (st: ParsedStatement) => void): Promise<Outcome> {
  const o = await attempt(f);
  if (!o.ok) {
    expect(o.err, `threw a non-StatementError: ${String(o.err)}`).toBeInstanceOf(StatementError);
    return o;
  }
  check(o.st);
  return o;
}

/** Spec: a plausible valid statement must parse, and pass `check`. */
export async function mustParse(f: () => ParsedStatement | Promise<ParsedStatement>, check: (st: ParsedStatement) => void = () => {}): Promise<ParsedStatement> {
  const o = await attempt(f);
  if (!o.ok) throw new Error(`rejected a valid statement: ${o.err instanceof Error ? o.err.message : String(o.err)}`);
  check(o.st);
  return o.st;
}

export async function mustRefuse(f: () => ParsedStatement | Promise<ParsedStatement>, re?: RegExp) {
  const o = await attempt(f);
  if (o.ok) throw new Error(`expected a StatementError but parsed ${o.st.rows.length} rows: ${JSON.stringify(o.st.rows.slice(0, 3))}`);
  expect(o.err).toBeInstanceOf(StatementError);
  if (re) expect((o.err as Error).message).toMatch(re);
}

// ---------------------------------------------------------------- ABA builder
export interface ARow {
  date: string; // "Aug 05, 2026"
  desc: string[];
  in?: number;
  out?: number;
  time?: string;
  /** override the printed balance (null = omit) */
  bal?: number | null;
  /** print the date only as this exact text */
  dateText?: string;
}

export interface AbaDoc {
  account?: string;
  currency?: string;
  period?: string | null;
  opening: number | null;
  /** rows for each page */
  pages: ARow[][];
  /** extra header lines on page 1 (y assigned in order after the standard ones) */
  headerLines?: PlacedText[][];
  /** replaces the standard header block entirely */
  customHeader?: (y: number) => { items: PlacedText[]; y: number };
  footer?: ((p: number, n: number) => PlacedText[]) | null;
  /** called after the last row of each page; y = next free y */
  afterRows?: (p: number, n: number, y: number) => PlacedText[];
  repeatHeader?: boolean;
  /** shift table columns on page p by dx */
  colShift?: (p: number) => number;
  closingLine?: boolean;
  rowGap?: number;
}

export function abaPages(o: AbaDoc): { pages: PlacedText[][]; balances: number[] } {
  let bal = o.opening ?? 0;
  const balances: number[] = [];
  const pages: PlacedText[][] = [];
  const n = o.pages.length;
  o.pages.forEach((rows, p) => {
    const dx = o.colShift?.(p) ?? 0;
    const t: PlacedText[] = [];
    t.push({ x: 40, y: 40, text: 'ABA BANK', size: 12 }, { x: 400, y: 40, text: 'ACCOUNT STATEMENT', size: 10 });
    let y = 70;
    if (p === 0) {
      if (o.customHeader) {
        const h = o.customHeader(y);
        t.push(...h.items);
        y = h.y;
      } else {
        t.push({ x: 40, y, text: 'Account Name: TEST PERSON' }); y += 14;
        for (const extra of o.headerLines ?? []) { t.push(...extra.map((e) => ({ ...e, y }))); y += 14; }
        t.push({ x: 40, y, text: `Account Number: ${o.account ?? '000 111 812'}` }); y += 14;
        t.push({ x: 40, y, text: `Currency: ${o.currency ?? 'USD'}` }); y += 14;
        if (o.period !== null) { t.push({ x: 40, y, text: `Period: ${o.period ?? 'Aug 01, 2026 - Aug 31, 2026'}` }); y += 14; }
        if (o.opening !== null) { t.push({ x: 40, y, text: 'Beginning Balance' }, right(560, money(o.opening), y)); y += 20; }
      }
    }
    if (p === 0 || o.repeatHeader !== false) {
      t.push({ x: 40 + dx, y, text: 'Date' }, { x: 125 + dx, y, text: 'Description' }, { x: 330 + dx, y, text: 'Money In' }, { x: 410 + dx, y, text: 'Money Out' }, { x: 515 + dx, y, text: 'Balance' });
      y += 16;
    }
    for (const r of rows) {
      bal = Math.round((bal + (r.in ?? 0) - (r.out ?? 0)) * 100) / 100;
      balances.push(bal);
      const printed = r.bal === undefined ? bal : r.bal;
      t.push({ x: 40 + dx, y, text: r.dateText ?? r.date });
      if (r.desc[0]) t.push({ x: 125 + dx, y, text: r.desc[0] });
      if (r.in) t.push(right(368 + dx, money(r.in), y));
      if (r.out) t.push(right(452 + dx, money(r.out), y));
      if (printed !== null) t.push(right(548 + dx, money(printed), y));
      if (r.time) t.push({ x: 40 + dx, y: y + 11, text: r.time });
      for (const extra of r.desc.slice(1)) { y += 11; t.push({ x: 125 + dx, y, text: extra }); }
      if (r.time && r.desc.length === 1) y += 11;
      y += o.rowGap ?? 15;
    }
    if (o.closingLine && p === n - 1) { t.push({ x: 40, y, text: 'Ending Balance' }, right(560, money(bal), y)); y += 15; }
    if (o.afterRows) t.push(...o.afterRows(p, n, y));
    const footer = o.footer === undefined ? (pp: number, nn: number) => [
      { x: 40, y: 800, text: 'Advanced Bank of Asia Ltd. Thank you for banking with us.', size: 7 },
      { x: 500, y: 815, text: `Page ${pp + 1} of ${nn}`, size: 7 },
    ] : o.footer;
    if (footer) t.push(...footer(p, n));
    pages.push(t);
  });
  return { pages, balances };
}

// ---------------------------------------------------------------- Revolut builder
export interface RRow {
  date: string; // "2 Mar 2026"
  desc: string[];
  in?: number;
  out?: number;
  extra?: string[];
}

export type RevBlock =
  | { kind: 'summary'; opening: number; out: number; in: number; closing: number; products?: { label: string; opening: number; out: number; in: number; closing: number }[]; total?: boolean }
  | { kind: 'heading'; text: string }
  | { kind: 'tableHeader'; dx?: number }
  | { kind: 'row'; row: RRow; opening?: number }
  | { kind: 'text'; x: number; text: string; size?: number; dy?: number }
  | { kind: 'pageBreak' }
  | { kind: 'gap'; dy: number };

export interface RevDoc {
  account?: string;
  iban?: string | null;
  headerExtra?: PlacedText[][];
  blocks: RevBlock[];
  footer?: ((p: number) => PlacedText[]) | null;
  symbol?: string;
}

const m = (n: number, c = '£') => `${n < 0 ? '-' : ''}${c}${money(Math.abs(n))}`;

/** Lay out Revolut blocks. Running balance is printed from the last summary's opening. */
export function revPages(o: RevDoc): PlacedText[][] {
  const c = o.symbol ?? '£';
  const pages: PlacedText[][] = [];
  let t: PlacedText[] = [];
  let y = 0;
  let bal = 0;
  let dx = 0;
  const footer = o.footer === undefined ? () => [
    { x: 40, y: 790, text: 'Report lost or stolen card', size: 7 },
    { x: 40, y: 800, text: 'Revolut Ltd is registered in England and Wales (No. 00000000). Test footer.', size: 7 },
  ] : o.footer;
  const newPage = () => {
    if (t.length) {
      if (footer) t.push(...footer(pages.length));
      pages.push(t);
    }
    t = [{ x: 40, y: 40, text: 'GBP Statement', size: 14 }, { x: 420, y: 40, text: 'Revolut', size: 12 }];
    y = 70;
  };
  newPage();
  t.push({ x: 40, y, text: 'TEST PERSON' }); y += 14;
  if (o.iban !== null) { t.push({ x: 40, y, text: 'IBAN' }, { x: 120, y, text: o.iban ?? 'GB00 REVO 0000 0000 0005 54' }); y += 14; }
  if (o.account !== '') { t.push({ x: 40, y, text: 'Account number' }, { x: 120, y, text: o.account ?? '00000554' }); y += 14; }
  for (const h of o.headerExtra ?? []) { t.push(...h.map((e) => ({ ...e, y }))); y += 14; }
  t.push({ x: 40, y, text: 'Sort code' }, { x: 120, y, text: '00-00-00' }); y += 24;
  for (const b of o.blocks) {
    if (b.kind === 'pageBreak') { newPage(); continue; }
    if (b.kind === 'gap') { y += b.dy; continue; }
    if (b.kind === 'summary') {
      t.push({ x: 40, y, text: 'Balance summary', size: 11 }); y += 16;
      t.push({ x: 40, y, text: 'Product' }, { x: 220, y, text: 'Opening balance' }, { x: 320, y, text: 'Money out' }, { x: 400, y, text: 'Money in' }, { x: 470, y, text: 'Closing balance' }); y += 14;
      const prods = b.products ?? [{ label: 'Account (Current Account)', opening: b.opening, out: b.out, in: b.in, closing: b.closing }];
      for (const p of prods) { t.push({ x: 40, y, text: p.label }, right(285, m(p.opening, c), y), right(365, m(p.out, c), y), right(440, m(p.in, c), y), right(540, m(p.closing, c), y)); y += 14; }
      if (b.total !== false) { t.push({ x: 40, y, text: 'Total' }, right(285, m(b.opening, c), y), right(365, m(b.out, c), y), right(440, m(b.in, c), y), right(540, m(b.closing, c), y)); y += 14; }
      t.push({ x: 40, y, text: 'The balance on your statement might differ from the balance shown in your app.', size: 7 }); y += 20;
      bal = prods[0].opening;
      continue;
    }
    if (b.kind === 'heading') { t.push({ x: 40, y, text: b.text, size: 11 }); y += 16; continue; }
    if (b.kind === 'tableHeader') {
      dx = b.dx ?? 0;
      t.push({ x: 40 + dx, y, text: 'Date' }, { x: 120 + dx, y, text: 'Description' }, { x: 350 + dx, y, text: 'Money out' }, { x: 430 + dx, y, text: 'Money in' }, { x: 515 + dx, y, text: 'Balance' });
      y += 16;
      continue;
    }
    if (b.kind === 'text') { y += b.dy ?? 0; t.push({ x: b.x, y, text: b.text, size: b.size }); y += 12; continue; }
    const r = b.row;
    if (b.opening !== undefined) bal = b.opening;
    bal = Math.round((bal + (r.in ?? 0) - (r.out ?? 0)) * 100) / 100;
    t.push({ x: 40 + dx, y, text: r.date });
    if (r.desc[0]) t.push({ x: 120 + dx, y, text: r.desc[0] });
    if (r.out) t.push(right(392 + dx, m(r.out, c), y));
    if (r.in) t.push(right(468 + dx, m(r.in, c), y));
    t.push(right(548 + dx, m(bal, c), y));
    for (const d of r.desc.slice(1)) { y += 11; t.push({ x: 120 + dx, y, text: d }); }
    for (const e of r.extra ?? []) { y += 10; t.push({ x: 120 + dx, y, text: e, size: 7 }); }
    y += 15;
  }
  newPage();
  return pages;
}

/** One Revolut section: summary computed from rows, heading, header, rows. */
export function revSection(opening: number, from: string, to: string, rows: RRow[], opts: { pageBreakAfter?: number[] } = {}): RevBlock[] {
  const out = round2(rows.reduce((a, r) => a + (r.out ?? 0), 0));
  const inn = round2(rows.reduce((a, r) => a + (r.in ?? 0), 0));
  const blocks: RevBlock[] = [
    { kind: 'summary', opening, out, in: inn, closing: round2(opening + inn - out) },
    { kind: 'heading', text: `Account transactions from ${from} to ${to}` },
    { kind: 'tableHeader' },
  ];
  rows.forEach((row, i) => {
    blocks.push({ kind: 'row', row });
    if (opts.pageBreakAfter?.includes(i)) blocks.push({ kind: 'pageBreak' }, { kind: 'tableHeader' });
  });
  return blocks;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
