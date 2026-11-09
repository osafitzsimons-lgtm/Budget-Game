// Synthetic statements (no real data). Layouts mimic the structure described for
// ABA and Revolut PDFs: headers, wrapped descriptions, repeated page furniture,
// detail lines, reverted tables and legal footers.
import { makePdf, type PlacedText } from './pdfgen';

const W = (s: string, size = 9) => s.length * size * 0.5; // rough width for right-aligning
const right = (xRight: number, text: string, y: number): PlacedText => ({ x: xRight - W(text), y, text });
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface SynthRow {
  date: string; // ABA: "Aug 05, 2026"; Revolut: "2 Mar 2026"
  desc: string[]; // first line + wrapped continuation lines
  in?: number;
  out?: number;
  time?: string;
  extra?: string[]; // Revolut detail lines
}

export interface AbaOptions {
  accountNumber?: string;
  period?: string | null;
  opening: number;
  rows: SynthRow[];
  rowsPerPage?: number;
  newestFirst?: boolean;
  breakBalanceAt?: number;
  omitHeaderTable?: boolean;
}

export function abaStatement(o: AbaOptions): Uint8Array {
  const rowsPerPage = o.rowsPerPage ?? 12;
  let bal = o.opening;
  const withBal = o.rows.map((r, i) => {
    bal = Math.round((bal + (r.in ?? 0) - (r.out ?? 0)) * 100) / 100;
    return { ...r, bal: o.breakBalanceAt === i ? bal + 1 : bal };
  });
  const list = o.newestFirst ? [...withBal].reverse() : withBal;
  const pages: PlacedText[][] = [];
  const pageCount = Math.max(1, Math.ceil(list.length / rowsPerPage));
  for (let p = 0; p < pageCount; p++) {
    const t: PlacedText[] = [];
    t.push({ x: 40, y: 40, text: 'ABA BANK', size: 12 }, { x: 400, y: 40, text: 'ACCOUNT STATEMENT', size: 10 });
    let y = 70;
    if (p === 0) {
      t.push({ x: 40, y, text: 'Account Name: TEST PERSON' }); y += 14;
      t.push({ x: 40, y, text: `Account Number: ${o.accountNumber ?? '000 111 812'}` }); y += 14;
      t.push({ x: 40, y, text: 'Currency: USD' }); y += 14;
      if (o.period !== null) { t.push({ x: 40, y, text: `Period: ${o.period ?? 'Aug 05, 2026 - Aug 31, 2026'}` }); y += 14; }
      t.push({ x: 40, y, text: 'Beginning Balance' }, right(560, money(o.opening), y)); y += 20;
    }
    if (!o.omitHeaderTable) {
      t.push({ x: 40, y, text: 'Date' }, { x: 125, y, text: 'Description' }, { x: 330, y, text: 'Money In' }, { x: 410, y, text: 'Money Out' }, { x: 515, y, text: 'Balance' });
    }
    y += 16;
    for (const r of list.slice(p * rowsPerPage, (p + 1) * rowsPerPage)) {
      t.push({ x: 40, y, text: r.date }, { x: 125, y, text: r.desc[0] });
      if (r.in) t.push(right(368, money(r.in), y));
      if (r.out) t.push(right(452, money(r.out), y));
      t.push(right(548, money(r.bal), y));
      if (r.time) t.push({ x: 40, y: y + 11, text: r.time });
      for (const extra of r.desc.slice(1)) { y += 11; t.push({ x: 125, y, text: extra }); }
      if (r.time && r.desc.length === 1) y += 11;
      y += 15;
    }
    t.push({ x: 40, y: 800, text: 'Advanced Bank of Asia Ltd. Thank you for banking with us.', size: 7 });
    t.push({ x: 500, y: 815, text: `Page ${p + 1} of ${pageCount}`, size: 7 });
    pages.push(t);
  }
  return makePdf(pages);
}

export interface RevSection {
  opening: number;
  from: string; // "1 August 2026"
  to: string;
  rows: SynthRow[];
  reverted?: SynthRow[];
}

export interface RevOptions {
  accountNumber?: string;
  sections: RevSection[];
  rowsPerPage?: number;
  wrongSummaryOut?: boolean;
  currencySymbol?: string;
}

export function revolutStatement(o: RevOptions): Uint8Array {
  const rowsPerPage = o.rowsPerPage ?? 14;
  const c = o.currencySymbol ?? '£';
  const m = (n: number) => `${c}${money(n)}`;
  const pages: PlacedText[][] = [];
  let t: PlacedText[] = [];
  let y = 0;
  const newPage = () => {
    if (t.length) {
      t.push({ x: 40, y: 790, text: 'Report lost or stolen card', size: 7 });
      t.push({ x: 40, y: 800, text: 'Revolut Ltd is registered in England and Wales (No. 00000000). Test footer.', size: 7 });
      pages.push(t);
    }
    t = [{ x: 40, y: 40, text: 'GBP Statement', size: 14 }, { x: 420, y: 40, text: 'Revolut', size: 12 }];
    y = 70;
  };
  newPage();
  t.push({ x: 40, y, text: 'TEST PERSON' }); y += 14;
  t.push({ x: 40, y, text: 'IBAN' }, { x: 120, y, text: `GB00 REVO 0000 0000 ${o.accountNumber ?? '0000 554'}`.replace(/\s+/g, ' ') }); y += 14;
  t.push({ x: 40, y, text: 'Account number' }, { x: 120, y, text: o.accountNumber ? o.accountNumber.replace(/\D/g, '').slice(-8) : '00000554' }); y += 14;
  t.push({ x: 40, y, text: 'Sort code' }, { x: 120, y, text: '00-00-00' }); y += 24;

  const tableHeader = () => {
    t.push({ x: 40, y, text: 'Date' }, { x: 120, y, text: 'Description' }, { x: 350, y, text: 'Money out' }, { x: 430, y, text: 'Money in' }, { x: 515, y, text: 'Balance' });
    y += 16;
  };
  for (const s of o.sections) {
    const out = s.rows.reduce((a, r) => a + (r.out ?? 0), 0);
    const inn = s.rows.reduce((a, r) => a + (r.in ?? 0), 0);
    const closing = Math.round((s.opening + inn - out) * 100) / 100;
    if (y > 600) newPage();
    t.push({ x: 40, y, text: 'Balance summary', size: 11 }); y += 16;
    t.push({ x: 40, y, text: 'Product' }, { x: 220, y, text: 'Opening balance' }, { x: 320, y, text: 'Money out' }, { x: 400, y, text: 'Money in' }, { x: 470, y, text: 'Closing balance' }); y += 14;
    const sumOut = o.wrongSummaryOut ? out + 1 : out;
    t.push({ x: 40, y, text: 'Account (Current Account)' }, right(285, m(s.opening), y), right(365, m(sumOut), y), right(440, m(inn), y), right(540, m(closing), y)); y += 14;
    t.push({ x: 40, y, text: 'Total' }, right(285, m(s.opening), y), right(365, m(sumOut), y), right(440, m(inn), y), right(540, m(closing), y)); y += 14;
    t.push({ x: 40, y, text: 'The balance on your statement might differ from the balance shown in your app.', size: 7 }); y += 20;
    t.push({ x: 40, y, text: `Account transactions from ${s.from} to ${s.to}`, size: 11 }); y += 16;
    tableHeader();
    let bal = s.opening;
    let n = 0;
    for (const r of s.rows) {
      if ((n > 0 && n % rowsPerPage === 0) || y > 720) { newPage(); tableHeader(); }
      n++;
      bal = Math.round((bal + (r.in ?? 0) - (r.out ?? 0)) * 100) / 100;
      t.push({ x: 40, y, text: r.date }, { x: 120, y, text: r.desc[0] });
      if (r.out) t.push(right(392, m(r.out), y));
      if (r.in) t.push(right(468, m(r.in), y));
      t.push(right(548, m(bal), y));
      for (const d of r.desc.slice(1)) { y += 11; t.push({ x: 120, y, text: d }); }
      for (const e of r.extra ?? []) { y += 10; t.push({ x: 120, y, text: e, size: 7 }); }
      y += 15;
    }
    if (s.reverted?.length) {
      y += 10;
      t.push({ x: 40, y, text: `Reverted transactions from ${s.from} to ${s.to}`, size: 11 }); y += 16;
      t.push({ x: 40, y, text: 'Date (started)' }, { x: 120, y, text: 'Description' }, { x: 350, y, text: 'Money out' }, { x: 430, y, text: 'Money in' }); y += 16;
      for (const r of s.reverted) {
        t.push({ x: 40, y, text: r.date }, { x: 120, y, text: r.desc[0] });
        if (r.out) t.push(right(392, m(r.out), y));
        if (r.in) t.push(right(468, m(r.in), y));
        y += 15;
      }
    }
    y += 20;
  }
  newPage(); // pushes the last page (with its footer)
  return makePdf(pages);
}

/** Deterministic pseudo-random generator for bulk synthetic rows. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
