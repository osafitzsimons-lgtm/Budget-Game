import { findDates, formatDate, parseDmyDate } from '../shared/dates';
import { parseAmount, round2, sameMoney } from '../shared/money';
import { DASH_ONLY, findAccountLast3, firstBalanceBreak, isNote, NOT_A_PAYEE, sum } from './common';
import { center, type Column, type Line, matchHeader, nearestColumn, type Phrase, StatementError } from './lines';
import type { ParsedRow, ParsedSection, ParsedStatement } from './types';

const TABLE_HEADER = {
  date: /\bdate\b/i,
  desc: /description/i,
  out: /money\s*out/i,
  in: /money\s*in/i,
};
const SUMMARY_HEADER = {
  opening: /opening\s*balance/i,
  out: /money\s*out/i,
  in: /money\s*in/i,
  closing: /closing\s*balance/i,
};

const ACCOUNT_LABEL = /\b(?:account\s*(?:no\.?|number)|IBAN)\b\s*[:.]?/i;
const DATE_AT_START = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\s*(.*)$/i;
/** Detail lines that belong to the row above. Their contents are not stored. */
const EXTRA = /^(Revolut Rate|Rate:|To:|From:|Card:|Reference:|Fee:|Exchanged|Exchange rate|ATM fee)/i;
/** Table headings: "Account transactions from …", "Reverted transactions from …", "Pending from …". */
const HEADING = /^(?:([A-Za-z]+(?:\s[A-Za-z]+)?)\s+transactions\b|(pending|reverted)\s+from\b)/i;
const LOOKS_LIKE_MONEY = /\d[\d,]*\.\d{2}/;
const FOREIGN = /[€$¥]|\b(?:EUR|USD|KHR)\b/;

function summaryIndex(lines: Line[]): number {
  return lines.findIndex((l) => /^balance summary\b/i.test(l.text));
}

/** A Revolut statement: "Revolut" above the first balance summary, and an "Account transactions" table. */
export function looksLikeRevolut(lines: Line[]): boolean {
  const s = summaryIndex(lines);
  if (s < 0) return false;
  return /Revolut/i.test(lines.slice(0, s).map((l) => l.text).join('\n')) && lines.some((l) => /^account transactions\b/i.test(l.text));
}

interface Section {
  name: string;
  opening: number;
  out: number;
  in: number;
  closing: number;
  periodStart: string | null;
  periodEnd: string | null;
  rows: (ParsedRow & { printed: number | null })[];
}
interface Anchor { page: number; y: number; h: number }

export function parseRevolut(lines: Line[]): ParsedStatement {
  const notes: string[] = [];
  // The account number is read from the header only (detail lines can mention other people's IBANs).
  const s0 = summaryIndex(lines);
  const accountLast3 = findAccountLast3(lines.slice(0, Math.max(0, s0)), ACCOUNT_LABEL, 'Revolut');

  const sections: Section[] = [];
  let pendingSummary = false;
  let summaryCols: Record<string, Column> | null = null;
  let candidates: { label: string; vals: Record<string, number> }[] = [];
  let mode: 'none' | 'account' | 'ignore' = 'none';
  let cols: Record<string, Column> | null = null;
  let last: Anchor | null = null;
  let rowOpen = false;
  let afterHeader = false;
  let current: Section | null = null as Section | null;

  const rowError = (line: Line, why: string) =>
    new StatementError(`Revolut page ${line.page}: couldn't read a row (${why}): "${line.text.slice(0, 80)}". Stopped — nothing was saved.`);
  const notGbp = (line: Line) => new StatementError(`Revolut: only GBP statements are supported, found "${line.text.slice(0, 60)}". Nothing was saved.`);

  const finishSummary = () => {
    if (!pendingSummary) return;
    pendingSummary = false;
    if (!candidates.length) throw new StatementError('Revolut: found a "Balance summary" with no balances. Stopped — nothing was saved.');
    // The account's own line: "Account (…)". A Total line also counts pockets, so it's only used when it's the only line.
    const accounts = candidates.filter((c) => /^account\b/i.test(c.label));
    const others = candidates.filter((c) => !/^total\b/i.test(c.label));
    const pick = accounts.length === 1 ? accounts[0] : others.length === 1 ? others[0] : candidates.length === 1 ? candidates[0] : null;
    if (!pick) throw new StatementError('Revolut: the balance summary lists several products and none is the account. This layout is not supported. Nothing was saved.');
    const v = pick.vals;
    current = { name: pick.label || `Section ${sections.length + 1}`, opening: v.opening, out: v.out, in: v.in, closing: v.closing, periodStart: null, periodEnd: null, rows: [] };
    sections.push(current);
    candidates = [];
  };

  for (const line of lines) {
    const t = line.text.trim();
    const first = line.phrases[0];

    if (/^balance summary\b/i.test(t)) {
      finishSummary();
      pendingSummary = true;
      summaryCols = null;
      mode = 'none';
      last = null;
      continue;
    }
    if (pendingSummary) {
      const sh = matchHeader(line, SUMMARY_HEADER);
      if (sh) { summaryCols = sh; continue; }
      const money = line.phrases.filter((p) => LOOKS_LIKE_MONEY.test(p.text));
      if (summaryCols && money.length === 4) {
        if (money.some((p) => FOREIGN.test(p.text))) throw notGbp(line);
        const vals: Record<string, number> = {};
        for (const p of money) {
          const v = parseAmount(p.text);
          const c = nearestColumn(p, Object.values(summaryCols));
          if (v === null || c.name in vals) throw new StatementError(`Revolut: couldn't read the balance summary line "${t}". Nothing was saved.`);
          vals[c.name] = v;
        }
        const label = line.phrases.filter((p) => !money.includes(p)).map((p) => p.text).join(' ').trim();
        candidates.push({ label, vals });
        continue;
      }
      if (HEADING.test(t)) finishSummary();
      else continue;
    }

    const dm = first && cols && first.x < cols.desc.x - 2 ? DATE_AT_START.exec(first.text) : null;
    const date = dm ? parseDmyDate(dm[1].replace(/\s+/g, ' ')) : null;
    const closeToRow = !!last && line.page === last.page && line.y - last.y <= Math.max(last.h, line.h) * 2.6;

    // Detail lines under a row (To:, Card:, Revolut Rate, Fee:, Reference:) are never headings or rows.
    if (!date && EXTRA.test(t) && (closeToRow || (afterHeader && last))) {
      last = { page: line.page, y: line.y, h: line.h };
      afterHeader = false;
      continue;
    }

    const heading = !date ? HEADING.exec(t) : null;
    if (heading && !matchHeader(line, TABLE_HEADER) && line.phrases.length <= 3) {
      const kind = (heading[1] ?? heading[2]).toLowerCase();
      last = null;
      cols = null;
      if (kind === 'account') {
        if (!current) throw new StatementError('Revolut: "Account transactions" table with no balance summary before it. This layout is not supported. Nothing was saved.');
        const ds = findDates(t);
        if (ds.length >= 2) { current.periodStart = ds[0]; current.periodEnd = ds[1]; }
        mode = 'account';
      } else if (kind === 'reverted' || kind === 'pending') {
        mode = 'ignore';
      } else if (/\bfrom\b/i.test(t)) {
        throw new StatementError(`Revolut: unknown table "${t.slice(0, 60)}". Only "Account transactions" is supported. Nothing was saved.`);
      }
      continue;
    }

    if (mode !== 'account') continue;
    const header = matchHeader(line, TABLE_HEADER);
    if (header) {
      cols = header;
      const bal = line.phrases.find((p) => /^balance$/i.test(p.text));
      if (bal) cols.bal = { name: 'bal', x: bal.x, right: bal.right };
      afterHeader = !!last;
      continue;
    }
    if (!cols) continue;

    const amountMinX = Math.min(cols.out.x, cols.in.x) - 15;
    const zone = line.phrases.filter((p) => center(p) >= amountMinX);

    if (date) {
      const amountCols = [cols.out, cols.in, ...(cols.bal ? [cols.bal] : [])];
      let out = 0, inn = 0, n = 0;
      let printed: number | null = null;
      for (const p of zone) {
        if (DASH_ONLY.test(p.text)) continue;
        if (FOREIGN.test(p.text) && LOOKS_LIKE_MONEY.test(p.text)) throw notGbp(line);
        const v = parseAmount(p.text);
        if (v === null) {
          if (LOOKS_LIKE_MONEY.test(p.text)) throw rowError(line, `unreadable amount "${p.text}"`);
          continue;
        }
        const c = nearestColumn(p, amountCols);
        if (c === cols.out) { out += Math.abs(v); n++; }
        else if (c === cols.in) { inn += Math.abs(v); n++; }
        else printed = v;
      }
      if (n !== 1) throw rowError(line, n === 0 ? 'no Money in or Money out amount' : 'more than one amount');
      const desc = [dm![2], ...line.phrases.slice(1).filter((p: Phrase) => center(p) < amountMinX).map((p) => p.text)].join(' ').trim();
      current!.rows.push({ date, time: null, description: desc, moneyIn: round2(inn), moneyOut: round2(out), balance: 0, section: sections.length - 1, printed });
      last = { page: line.page, y: line.y, h: line.h };
      rowOpen = true;
      afterHeader = false;
      continue;
    }

    const money = zone.filter((p) => LOOKS_LIKE_MONEY.test(p.text) && !DASH_ONLY.test(p.text));
    if (money.length) throw rowError(line, 'amounts on a line without a date');

    // Text only: a wrapped description, or a note/footer/legal text that must not be glued on.
    if (NOT_A_PAYEE.test(t) || isNote(t)) { if (last && line.page === last.page) rowOpen = false; continue; }
    const inDesc = line.phrases.every((p) => p.x >= cols!.desc.x - 3 && center(p) < amountMinX);
    const closeBelow = !!last && ((rowOpen && closeToRow) || (afterHeader && line.page > last.page));
    if (inDesc && closeBelow && current?.rows.length) {
      const row = current.rows[current.rows.length - 1];
      row.description = `${row.description} ${t}`.trim();
      last = { page: line.page, y: line.y, h: line.h };
      rowOpen = true;
      afterHeader = false;
      continue;
    }
    if (last && line.page === last.page) rowOpen = false;
    afterHeader = false;
  }
  finishSummary();

  if (!sections.length) throw new StatementError('Revolut: no balance summary found. This layout is not supported. Nothing was saved.');

  sections.forEach((s, i) => {
    const label = `Revolut section ${i + 1}`;
    // When the statement prints a running balance on every row, it must chain; it also fixes the row order.
    if (s.rows.length && s.rows.every((r) => r.printed !== null)) {
      const asRows = (rs: typeof s.rows) => rs.map((r) => ({ ...r, balance: r.printed! }));
      const printedOrder = asRows(s.rows);
      const reversed = asRows([...s.rows].reverse());
      if (firstBalanceBreak(s.opening, printedOrder) === -1) s.rows = printedOrder;
      else if (firstBalanceBreak(s.opening, reversed) === -1) { s.rows = reversed; notes.push(`${label}: rows were listed newest-first; reordered.`); }
      else {
        const k = firstBalanceBreak(s.opening, printedOrder);
        const r = printedOrder[k];
        throw new StatementError(`${label}: the running balance doesn't add up on ${formatDate(r.date)} "${r.description.slice(0, 40)}". Stopped — nothing was saved.`);
      }
    }
    const out = sum(s.rows.map((r) => r.moneyOut));
    const inn = sum(s.rows.map((r) => r.moneyIn));
    if (!sameMoney(out, s.out)) throw new StatementError(`${label}: rows add up to £${out.toFixed(2)} money out but the summary says £${s.out.toFixed(2)}. Stopped — nothing was saved.`);
    if (!sameMoney(inn, s.in)) throw new StatementError(`${label}: rows add up to £${inn.toFixed(2)} money in but the summary says £${s.in.toFixed(2)}. Stopped — nothing was saved.`);
    if (!sameMoney(round2(s.opening + inn - out), s.closing))
      throw new StatementError(`${label}: opening £${s.opening.toFixed(2)} + in £${inn.toFixed(2)} − out £${out.toFixed(2)} ≠ closing £${s.closing.toFixed(2)}. Stopped — nothing was saved.`);
  });
  const ordered = orderSections(sections);

  const rows: ParsedRow[] = [];
  let bal = ordered[0].opening;
  ordered.forEach((s, i) => {
    for (const { printed: _p, ...r } of s.rows) {
      bal = round2(bal + r.moneyIn - r.moneyOut);
      rows.push({ ...r, balance: bal, section: i });
    }
  });

  const starts = ordered.map((s) => s.periodStart ?? s.rows[0]?.date).filter(Boolean) as string[];
  const ends = ordered.map((s) => s.periodEnd ?? s.rows[s.rows.length - 1]?.date).filter(Boolean) as string[];
  if (!starts.length || !ends.length) throw new StatementError('Revolut: could not work out the statement dates. Nothing was saved.');
  const periodFromHeader = ordered.every((s) => s.periodStart && s.periodEnd);
  const periodStart = starts.sort()[0];
  const periodEnd = ends.sort()[ends.length - 1];
  for (const s of ordered)
    for (const r of s.rows)
      if (s.periodStart && s.periodEnd && (r.date < s.periodStart || r.date > s.periodEnd))
        throw new StatementError(`Revolut: a row dated ${formatDate(r.date)} is outside its table's dates. Stopped — nothing was saved.`);

  const parsedSections: ParsedSection[] = ordered.map((s) => ({
    name: s.name,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    opening: s.opening,
    closing: s.closing,
    totalIn: s.in,
    totalOut: s.out,
    rowCount: s.rows.length,
  }));

  return {
    bank: 'REV',
    accountLast3,
    currency: 'GBP',
    periodStart,
    periodEnd,
    periodFromHeader,
    opening: ordered[0].opening,
    closing: ordered[ordered.length - 1].closing,
    totalIn: sum(rows.map((r) => r.moneyIn)),
    totalOut: sum(rows.map((r) => r.moneyOut)),
    sections: parsedSections,
    rows,
    notes,
  };
}

function orderSections(sections: Section[]): Section[] {
  if (sections.length === 1) return sections;
  // Try the printed order, then reversed: each closing must equal the next opening.
  const chains = (ss: Section[]) => ss.every((s, i) => i === 0 || sameMoney(ss[i - 1].closing, s.opening, 0.01));
  if (chains(sections)) return sections;
  const rev = [...sections].reverse();
  if (chains(rev)) return rev;
  throw new StatementError(
    `Revolut: the ${sections.length} sections don't join up (each section's closing balance should be the next one's opening). This layout is not supported. Nothing was saved.`,
  );
}
