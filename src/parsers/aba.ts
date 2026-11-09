import { formatDate, parseAbaDate } from '../shared/dates';
import { round2, sameMoney } from '../shared/money';
import { amountPhrases, findAccountLast3, findPeriod, firstBalanceBreak, parseTime, sum } from './common';
import { center, type Column, furnitureDetector, type Line, matchHeader, nearestColumn, StatementError } from './lines';
import type { ParsedRow, ParsedStatement } from './types';

const HEADER = {
  date: /\bdate\b/i,
  desc: /description|transaction details|details|particulars/i,
  in: /money\s*in|credit/i,
  out: /money\s*out|debit/i,
  bal: /balance/i,
};

const ROW_DATE_AT_START = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\s*(.*)$/i;
const OPENING = /(opening|beginning|previous|brought\s+forward|b\/f).*balance|balance.*(brought\s+forward|b\/f)/i;
const CLOSING = /(closing|ending|end of period).*balance|balance.*carried/i;

export function looksLikeAba(lines: Line[]): boolean {
  const head = lines.slice(0, 80).map((l) => l.text).join('\n');
  return /\bABA\b|Advanced Bank of Asia/i.test(head) && lines.some((l) => matchHeader(l, HEADER));
}

interface Cols { date: Column; desc: Column; in: Column; out: Column; bal: Column }

export function parseAba(lines: Line[]): ParsedStatement {
  const notes: string[] = [];
  const isFurniture = furnitureDetector(lines);
  const firstHeader = lines.findIndex((l) => matchHeader(l, HEADER));
  if (firstHeader < 0) throw new StatementError('ABA statement: could not find the table header (Date / Description / Money In / Money Out / Balance).');

  const headerLines = lines.slice(0, firstHeader).filter((l) => l.page === lines[firstHeader].page || l.page === 1);
  const accountLast3 = findAccountLast3(headerLines, /account\s*(?:no\.?|number|#)?\s*[:.]?/i, 'ABA');
  const period = findPeriod(lines, firstHeader);

  let opening: number | null = null;
  let closing: number | null = null;
  const rows: (ParsedRow & { _page: number; _y: number })[] = [];
  let cols: Cols | null = null;
  let last: { page: number; y: number; h: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = matchHeader(line, HEADER) as Cols | null;
    if (header) { cols = header; last = null; continue; }

    // Summary lines can sit above or inside the table.
    if ((OPENING.test(line.text) || CLOSING.test(line.text)) && !ROW_DATE_AT_START.test(line.phrases[0]?.text ?? '')) {
      const amts = amountPhrases(line);
      if (amts.length) {
        const v = amts[amts.length - 1].v;
        if (OPENING.test(line.text) && opening === null) opening = v;
        else if (CLOSING.test(line.text)) closing = v;
      }
      last = null;
      continue;
    }
    if (!cols || isFurniture(line)) { last = null; continue; }

    const amountMinX = Math.min(cols.in.x, cols.out.x, cols.bal.x) - 15;
    const first = line.phrases[0];
    const startMatch = first && first.x < cols.desc.x - 2 ? ROW_DATE_AT_START.exec(first.text) : null;
    const date = startMatch ? parseAbaDate(startMatch[1].replace(/\s+/g, ' ')) : null;
    const amounts = amountPhrases(line).filter((a) => center(a.p) >= amountMinX);

    if (date) {
      let moneyIn = 0, moneyOut = 0, balance: number | null = null;
      for (const a of amounts) {
        const col = nearestColumn(a.p, [cols.in, cols.out, cols.bal]);
        const v = Math.abs(a.v);
        if (col === cols.bal) { if (balance !== null) throw rowError(line, 'two balances'); balance = a.v; }
        else if (col === cols.in) moneyIn += v;
        else moneyOut += v;
      }
      if (balance === null) throw rowError(line, 'no running balance');
      if (moneyIn > 0 && moneyOut > 0) throw rowError(line, 'both Money In and Money Out');
      let time: string | null = null;
      const descParts: string[] = [];
      if (startMatch![2]) descParts.push(startMatch![2]);
      for (const p of line.phrases.slice(1)) {
        if (amounts.some((a) => a.p === p)) continue;
        const t = center(p) < cols.desc.x ? parseTime(p.text) : null;
        if (t) time = t; else descParts.push(p.text);
      }
      rows.push({ date, time, description: descParts.join(' ').trim(), moneyIn: round2(moneyIn), moneyOut: round2(moneyOut), balance, section: 0, _page: line.page, _y: line.y });
      last = { page: line.page, y: line.y, h: line.h };
      continue;
    }

    if (amounts.length) {
      if (/total/i.test(line.text)) { last = null; continue; }
      throw rowError(line, 'amounts on a line without a date');
    }

    // Continuation of the row above: same page, close below, inside the description/date columns.
    const close = last && line.page === last.page && line.y - last.y <= Math.max(last.h, line.h) * 2.6;
    const inColumns = line.phrases.every((p) => p.x >= cols!.date.x - 5 && center(p) < amountMinX);
    if (close && inColumns && rows.length) {
      const row = rows[rows.length - 1];
      for (const p of line.phrases) {
        const t = center(p) < cols.desc.x ? parseTime(p.text) : null;
        if (t && !row.time) row.time = t;
        else if (center(p) >= cols.desc.x - 2) row.description = `${row.description} ${p.text}`.trim();
        else if (!t) throw rowError(line, 'unexpected text in the date column');
      }
      last = { page: line.page, y: line.y, h: line.h };
      continue;
    }
    // Anything else (footers, notes, page furniture) is not part of a row.
    last = null;
  }

  // Order: oldest first. Some statements list newest first; detect from dates.
  let ordered: ParsedRow[] = rows.map(({ _page, _y, ...r }) => r);
  if (ordered.length > 1 && ordered[0].date > ordered[ordered.length - 1].date) {
    // Newest first: reverse, and the balance chain runs the other way.
    ordered = ordered.reverse();
    notes.push('Rows were listed newest-first; reordered.');
  }

  const derivedOpening = ordered.length ? round2(ordered[0].balance - ordered[0].moneyIn + ordered[0].moneyOut) : null;
  const open = opening ?? derivedOpening;
  if (open === null) throw new StatementError('ABA statement has no transactions and no opening balance. Nothing was saved.');
  if (opening === null) notes.push('No opening balance line found; used the first row.');

  const brk = firstBalanceBreak(open, ordered);
  if (brk >= 0) {
    const r = ordered[brk];
    const prev = brk === 0 ? open : ordered[brk - 1].balance;
    throw new StatementError(
      `ABA balance check failed on ${formatDate(r.date)} "${r.description.slice(0, 40)}": ${prev.toFixed(2)} + ${r.moneyIn.toFixed(2)} − ${r.moneyOut.toFixed(2)} should be ${(prev + r.moneyIn - r.moneyOut).toFixed(2)}, statement shows ${r.balance.toFixed(2)}. Stopped — nothing was saved.`,
    );
  }
  const finalBal = ordered.length ? ordered[ordered.length - 1].balance : open;
  if (closing !== null && !sameMoney(closing, finalBal))
    throw new StatementError(`ABA closing balance ${closing.toFixed(2)} doesn't match the last row's balance ${finalBal.toFixed(2)}. Stopped — nothing was saved.`);

  const periodStart = period?.start ?? ordered[0]?.date;
  const periodEnd = period?.end ?? ordered[ordered.length - 1]?.date;
  if (!periodStart || !periodEnd) throw new StatementError('Could not work out the statement dates. Nothing was saved.');
  if (!period) notes.push('No statement period in the header; used first and last row dates.');
  if (ordered.some((r) => r.date < periodStart || r.date > periodEnd))
    throw new StatementError('Some rows fall outside the statement period in the header. Stopped — nothing was saved.');

  const totalIn = sum(ordered.map((r) => r.moneyIn));
  const totalOut = sum(ordered.map((r) => r.moneyOut));
  return {
    bank: 'ABA',
    accountLast3,
    currency: 'USD',
    periodStart,
    periodEnd,
    periodFromHeader: !!period,
    opening: open,
    closing: finalBal,
    totalIn,
    totalOut,
    sections: [{ name: 'Account', periodStart, periodEnd, opening: open, closing: finalBal, totalIn, totalOut, rowCount: ordered.length }],
    rows: ordered,
    notes,
  };
}

function rowError(line: Line, why: string): StatementError {
  return new StatementError(`ABA page ${line.page}: couldn't read a row (${why}): "${line.text.slice(0, 80)}". Stopped — nothing was saved.`);
}
