import { findDates, formatDate, parseDmyDate } from '../shared/dates';
import { round2, sameMoney } from '../shared/money';
import { amountPhrases, findAccountLast3, sum } from './common';
import { center, type Column, furnitureDetector, type Line, matchHeader, nearestColumn, StatementError } from './lines';
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

const ROW_DATE_AT_START = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\s*(.*)$/i;
/** Detail lines that belong to the row above. Their contents are not stored. */
const EXTRA = /^(Revolut Rate|Rate:|To:|From:|Card:|Reference:|Fee:|Exchanged|Exchange rate|ATM fee)/i;
const LEGAL = /Revolut Ltd|Revolut Bank|registered in|authori[sz]ed by|Financial Conduct|Prudential Regulation|Report lost or stolen|Get help directly|Scan the QR|©|deposit insurance|FSCS|Financial Services Compensation|balance on your statement might differ|www\.revolut|revolut\.com|\+44 ?20/i;

export function looksLikeRevolut(lines: Line[]): boolean {
  const all = lines.map((l) => l.text).join('\n');
  return /Revolut/i.test(all) && /Account transactions/i.test(all);
}

interface Section {
  name: string;
  opening: number;
  out: number;
  in: number;
  closing: number;
  periodStart: string | null;
  periodEnd: string | null;
  rows: ParsedRow[];
}

export function parseRevolut(lines: Line[]): ParsedStatement {
  const notes: string[] = [];
  const isFurniture = furnitureDetector(lines);
  const accountLast3 = findAccountLast3(lines.filter((l) => l.page === 1), /\b(account\s*(?:no\.?|number)|IBAN)\b\s*[:.]?/i, 'Revolut');

  const sections: Section[] = [];
  let pendingSummary = false;
  let summaryCols: Record<string, Column> | null = null;
  let summaryCandidates: { label: string; vals: Record<string, number> }[] = [];
  let mode: 'none' | 'account' | 'ignore' = 'none';
  let cols: Record<string, Column> | null = null;
  let last: { page: number; y: number; h: number } | null = null;
  let current: Section | null = null as Section | null;

  const finishSummary = () => {
    if (!pendingSummary) return;
    pendingSummary = false;
    if (!summaryCandidates.length) throw new StatementError('Revolut: found a "Balance summary" with no balances. Stopped — nothing was saved.');
    const total = summaryCandidates.find((c) => /^total\b/i.test(c.label));
    const products = summaryCandidates.filter((c) => !/^total\b/i.test(c.label));
    const pick = total ?? (products.length === 1 ? products[0] : null);
    if (!pick) throw new StatementError('Revolut: the balance summary has several products and no Total line. This layout is not supported. Nothing was saved.');
    const v = pick.vals;
    current = { name: products[0]?.label || `Section ${sections.length + 1}`, opening: v.opening, out: v.out, in: v.in, closing: v.closing, periodStart: null, periodEnd: null, rows: [] };
    sections.push(current);
    summaryCandidates = [];
  };

  for (const line of lines) {
    const t = line.text;
    if ((pendingSummary || mode === 'account') && line.phrases.some((p) => /^-?(?:[€$¥]|EUR|USD|KHR)\s?\d[\d,]*\.\d{2}$/.test(p.text)))
      throw new StatementError(`Revolut: only GBP statements are supported, found "${t.slice(0, 60)}". Nothing was saved.`);

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
      const amts = amountPhrases(line);
      if (summaryCols && amts.length === 4) {
        checkCurrency(line, amts.map((a) => a.p.text));
        const vals: Record<string, number> = {};
        for (const a of amts) {
          const c = nearestColumn(a.p, Object.values(summaryCols));
          if (c.name in vals) throw new StatementError(`Revolut: couldn't read the balance summary line "${t}". Nothing was saved.`);
          vals[c.name] = a.v;
        }
        const label = line.phrases.filter((p) => !amts.some((a) => a.p === p)).map((p) => p.text).join(' ').trim();
        summaryCandidates.push({ label, vals });
        continue;
      }
      if (/transactions\b/i.test(t)) finishSummary();
      else continue;
    }

    const tableHeading = /^(.*?)\btransactions\b(.*)$/i.exec(t);
    if (tableHeading && !ROW_DATE_AT_START.test(line.phrases[0]?.text ?? '') && !matchHeader(line, TABLE_HEADER) && line.phrases.length <= 3 && /from|to|\d{4}/i.test(tableHeading[2] + tableHeading[1])) {
      const kind = tableHeading[1].trim().toLowerCase();
      last = null;
      cols = null;
      if (kind === 'account') {
        if (!current) throw new StatementError('Revolut: "Account transactions" table with no balance summary before it. This layout is not supported. Nothing was saved.');
        const ds = findDates(t);
        if (ds.length >= 2) { current.periodStart = ds[0]; current.periodEnd = ds[1]; }
        mode = 'account';
      } else if (kind === 'reverted' || kind === 'pending') {
        mode = 'ignore';
      } else {
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
      last = null;
      continue;
    }
    if (!cols || isFurniture(line)) { last = null; continue; }
    if (LEGAL.test(t)) { last = null; continue; }

    const amountMinX = Math.min(cols.out.x, cols.in.x) - 15;
    const first = line.phrases[0];
    const sm = first && first.x < cols.desc.x - 2 ? ROW_DATE_AT_START.exec(first.text) : null;
    const date = sm ? parseDmyDate(sm[1].replace(/\s+/g, ' ')) : null;
    const amounts = amountPhrases(line).filter((a) => center(a.p) >= amountMinX);

    if (date) {
      checkCurrency(line, amounts.map((a) => a.p.text));
      const amountCols = [cols.out, cols.in, ...(cols.bal ? [cols.bal] : [])];
      let out = 0, inn = 0, nIn = 0, nOut = 0;
      for (const a of amounts) {
        const c = nearestColumn(a.p, amountCols);
        if (c === cols.out) { out += Math.abs(a.v); nOut++; }
        else if (c === cols.in) { inn += Math.abs(a.v); nIn++; }
      }
      if (nIn + nOut !== 1) throw rowError(line, nIn + nOut === 0 ? 'no Money in or Money out amount' : 'more than one amount');
      const desc = [sm![2], ...line.phrases.slice(1).filter((p) => !amounts.some((a) => a.p === p)).map((p) => p.text)].join(' ').trim();
      current!.rows.push({ date, time: null, description: desc, moneyIn: round2(inn), moneyOut: round2(out), balance: 0, section: sections.length - 1 });
      last = { page: line.page, y: line.y, h: line.h };
      continue;
    }

    const close = last && line.page === last.page && line.y - last.y <= Math.max(last.h, line.h) * 2.6;
    if (close && EXTRA.test(t)) {
      last = { page: line.page, y: line.y, h: line.h };
      continue; // detail line for the row above (rate, To:, Card:, Reference:, Fee:) — not stored
    }
    if (close && line.phrases.every((p) => center(p) < amountMinX) && line.phrases[0].x >= cols.desc.x - 5) {
      if (!EXTRA.test(t)) {
        const row = current!.rows[current!.rows.length - 1];
        row.description = `${row.description} ${t}`.trim();
      }
      last = { page: line.page, y: line.y, h: line.h };
      continue;
    }
    if (amounts.length) throw rowError(line, 'amounts on a line without a date');
    last = null; // footer or other text
  }
  finishSummary();

  if (!sections.length) throw new StatementError('Revolut: no balance summary found. This layout is not supported. Nothing was saved.');

  // Check each section, then order sections so each one's closing is the next one's opening.
  sections.forEach((s, i) => {
    const out = sum(s.rows.map((r) => r.moneyOut));
    const inn = sum(s.rows.map((r) => r.moneyIn));
    const label = `Revolut section ${i + 1}`;
    if (!sameMoney(out, s.out)) throw new StatementError(`${label}: rows add up to £${out.toFixed(2)} money out but the summary says £${s.out.toFixed(2)}. Stopped — nothing was saved.`);
    if (!sameMoney(inn, s.in)) throw new StatementError(`${label}: rows add up to £${inn.toFixed(2)} money in but the summary says £${s.in.toFixed(2)}. Stopped — nothing was saved.`);
    if (!sameMoney(round2(s.opening + inn - out), s.closing))
      throw new StatementError(`${label}: opening £${s.opening.toFixed(2)} + in £${inn.toFixed(2)} − out £${out.toFixed(2)} ≠ closing £${s.closing.toFixed(2)}. Stopped — nothing was saved.`);
  });
  const ordered = orderSections(sections);

  const rows: ParsedRow[] = [];
  let bal = ordered[0].opening;
  ordered.forEach((s, i) => {
    for (const r of s.rows) {
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

function checkCurrency(line: Line, amountTexts: string[]) {
  if (amountTexts.some((a) => /[€$¥]|\b(EUR|USD|KHR)\b/.test(a)))
    throw new StatementError(`Revolut: only GBP statements are supported, found "${line.text.slice(0, 60)}". Nothing was saved.`);
}

function rowError(line: Line, why: string): StatementError {
  return new StatementError(`Revolut page ${line.page}: couldn't read a row (${why}): "${line.text.slice(0, 80)}". Stopped — nothing was saved.`);
}
