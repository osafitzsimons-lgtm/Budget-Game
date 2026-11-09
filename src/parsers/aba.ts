import { formatDate, parseAbaDate } from '../shared/dates';
import { parseAmount, round2, sameMoney } from '../shared/money';
import { DASH_ONLY, findAccountLast3, findPeriod, firstBalanceBreak, isNote, NOT_A_PAYEE, parseTime, sum } from './common';
import { center, type Column, furnitureDetector, type Line, matchHeader, nearestColumn, type Phrase, StatementError } from './lines';
import type { ParsedRow, ParsedStatement } from './types';

const HEADER = {
  date: /\bdate\b/i,
  desc: /description|transaction details|details|particulars/i,
  in: /money\s*in|credit/i,
  out: /money\s*out|debit/i,
  bal: /balance/i,
};

const ACCOUNT_LABEL = /\b(?:account\s*(?:no\.?|number|#)|a\/c\s*(?:no\.?|number)?)\s*[:.]?/i;
const DATE_AT_START = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\s*(.*)$/i;
const TIME_AT_START = /^(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)(?:\s+(.*))?$/i;
// Summary lines must START with these words, so "VENDING MACHINE BALANCE" or "PAYMENT OF PREVIOUS BALANCE" in a
// wrapped description is never mistaken for one.
const OPENING = /^(?:(?:opening|beginning|starting|previous)\s+balance|balance\s+(?:brought\s+forward|b\/f)|brought\s+forward)\b/i;
const CLOSING = /^(?:closing|ending)\s+balance\b/i;
const CARRIED = /^(?:balance\s+carried\s+forward|carried\s+forward|balance\s+c\/f)\b/i;
const TOTALS = /^(?:sub-?\s?total|total)\b/i;
const LOOKS_LIKE_MONEY = /\d[\d,]*\.\d{2}/;

function headerIndex(lines: Line[]): number {
  return lines.findIndex((l) => matchHeader(l, HEADER));
}

/** An ABA statement: the bank's name above the transactions table (or its full name/website anywhere). */
export function looksLikeAba(lines: Line[]): boolean {
  const h = headerIndex(lines);
  if (h < 0) return false;
  const head = lines.slice(0, h).map((l) => l.text).join('\n');
  return /\bABA\b|Advanced Bank of Asia|ababank/i.test(head) || lines.some((l) => /Advanced Bank of Asia|ababank\.com/i.test(l.text));
}

interface Cols { date: Column; desc: Column; in: Column; out: Column; bal: Column }
interface Anchor { page: number; y: number; h: number }

export function parseAba(lines: Line[]): ParsedStatement {
  const notes: string[] = [];
  const h0 = headerIndex(lines);
  if (h0 < 0) throw new StatementError('ABA statement: could not find the table header (Date / Description / Money In / Money Out / Balance).');

  const head = lines.slice(0, h0).map((l) => l.text).join('\n');
  const cur = /currency\s*:?\s*([A-Z]{3})\b/i.exec(head);
  if (cur && cur[1].toUpperCase() !== 'USD')
    throw new StatementError(`This ABA statement is in ${cur[1].toUpperCase()}. Only USD accounts are supported. Nothing was saved.`);

  // Account numbers are read from labels anywhere in the PDF: two different accounts in one file is an error.
  const accountLast3 = findAccountLast3(lines, ACCOUNT_LABEL, 'ABA');
  const period = findPeriod(lines, h0);
  const isFurniture = furnitureDetector(lines);

  let opening: number | null = null;
  let closing: number | null = null;
  const rows: ParsedRow[] = [];
  let cols: Cols | null = null;
  /** the last line that belongs to the last row */
  let last: Anchor | null = null;
  /** a wrapped line may still follow on the same page (false once anything else has appeared below the row) */
  let rowOpen = false;
  /** true right after a repeated table header on a new page: a wrapped line may carry over from the last row */
  let afterHeader = false;
  /** description text printed just ABOVE its date line (vertically centred cells) */
  let prefix: string[] = [];
  const pageSum = new Map<number, { in: number; out: number }>();
  const total = { in: 0, out: 0 };

  const rowError = (line: Line, why: string) =>
    new StatementError(`ABA page ${line.page}: couldn't read a row (${why}): "${line.text.slice(0, 80)}". Stopped — nothing was saved.`);

  /** Read the amounts in the Money In / Money Out / Balance columns. Anything unreadable there stops the upload. */
  const readAmounts = (line: Line, zone: Phrase[]) => {
    const out: { col: 'in' | 'out' | 'bal'; v: number }[] = [];
    for (const p of zone) {
      if (DASH_ONLY.test(p.text)) continue; // "-" placeholder in an empty column
      const v = parseAmount(p.text);
      if (v === null) {
        // Something that looks like money but can't be read exactly stops the upload; other text is ignored.
        if (LOOKS_LIKE_MONEY.test(p.text)) throw rowError(line, `unreadable amount "${p.text}"`);
        continue;
      }
      const c = nearestColumn(p, [cols!.in, cols!.out, cols!.bal]);
      out.push({ col: c === cols!.in ? 'in' : c === cols!.out ? 'out' : 'bal', v });
    }
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = matchHeader(line, HEADER) as Cols | null;
    if (header) {
      afterHeader = rows.length > 0;
      cols = header;
      prefix = [];
      continue;
    }

    const first = line.phrases[0];
    const dm = cols && first && first.x < cols.desc.x - 2 ? DATE_AT_START.exec(first.text) : null;
    const date = dm ? parseAbaDate(dm[1].replace(/\s+/g, ' ')) : null;

    if (!date && (OPENING.test(line.text) || CLOSING.test(line.text) || CARRIED.test(line.text))) {
      const amts = line.phrases.map((p) => parseAmount(p.text)).filter((v): v is number => v !== null);
      const v = amts[amts.length - 1];
      if (v !== undefined) {
        if (OPENING.test(line.text)) { if (opening === null && rows.length === 0) opening = v; }
        else if (CLOSING.test(line.text)) closing = v;
        // "carried forward" at the foot of a page is just a checkpoint, not the closing balance
      }
      rowOpen = false;
      continue;
    }
    if (!cols) continue;

    const amountMinX = Math.min(cols.in.x, cols.out.x, cols.bal.x) - 15;
    const zone = line.phrases.filter((p) => center(p) >= amountMinX);

    if (date) {
      const amounts = readAmounts(line, zone);
      const bals = amounts.filter((a) => a.col === 'bal');
      if (bals.length !== 1) throw rowError(line, bals.length ? 'two balances' : 'no running balance');
      const moneyIn = round2(amounts.filter((a) => a.col === 'in').reduce((s, a) => s + Math.abs(a.v), 0));
      const moneyOut = round2(amounts.filter((a) => a.col === 'out').reduce((s, a) => s + Math.abs(a.v), 0));
      if (moneyIn > 0 && moneyOut > 0) throw rowError(line, 'both Money In and Money Out');
      let time: string | null = null;
      const desc: string[] = [...prefix];
      let rest = dm![2];
      const tm = rest ? TIME_AT_START.exec(rest) : null;
      if (tm && parseTime(tm[1])) { time = parseTime(tm[1]); rest = tm[2] ?? ''; }
      if (rest) desc.push(rest);
      for (const p of line.phrases.slice(1)) {
        if (center(p) >= amountMinX) continue;
        const t = center(p) < cols.desc.x ? parseTime(p.text) : null;
        if (t) time = t;
        else desc.push(p.text);
      }
      rows.push({ date, time, description: desc.join(' ').trim(), moneyIn, moneyOut, balance: bals[0].v, section: 0 });
      const ps = pageSum.get(line.page) ?? { in: 0, out: 0 };
      ps.in += moneyIn; ps.out += moneyOut; total.in += moneyIn; total.out += moneyOut;
      pageSum.set(line.page, ps);
      last = { page: line.page, y: line.y, h: line.h };
      rowOpen = true;
      afterHeader = false;
      prefix = [];
      continue;
    }

    const amounts = readAmounts(line, zone);
    if (amounts.length) {
      // Only a totals line may carry amounts without a date, and its figures must match the rows.
      if (TOTALS.test(line.text) && !amounts.some((a) => a.col === 'bal')) {
        const ps = pageSum.get(line.page) ?? { in: 0, out: 0 };
        for (const a of amounts) {
          const want = a.col === 'in' ? [ps.in, total.in] : [ps.out, total.out];
          if (!want.some((w) => sameMoney(round2(w), Math.abs(a.v), 0.01))) throw rowError(line, "a total that doesn't match the rows above");
        }
        rowOpen = false;
        continue;
      }
      throw rowError(line, 'amounts on a line without a date');
    }

    // Text-only line: a wrapped description (below its row, or above the next one), or something else.
    const text = line.text.trim();
    if (NOT_A_PAYEE.test(text) || isNote(text)) { if (last && line.page === last.page) rowOpen = false; prefix = []; continue; }
    const inDescColumn = line.phrases.every((p) => (p.x >= cols!.desc.x - 3 && center(p) < amountMinX) || (center(p) < cols!.desc.x && parseTime(p.text)));
    if (!inDescColumn) { if (last && line.page === last.page) rowOpen = false; continue; }
    const closeBelow = !!last && ((rowOpen && line.page === last.page && line.y - last.y <= Math.max(last.h, line.h) * 2.2) || (afterHeader && line.page > last.page));

    // Vertically centred cells: if this line sits closer to the next date line than to the row above, it belongs below.
    const next = lines.slice(i + 1, i + 4).find((l) => l.page === line.page && cols && l.phrases[0] && l.phrases[0].x < cols.desc.x - 2 && DATE_AT_START.test(l.phrases[0].text));
    const gapAbove = last && line.page === last.page ? line.y - last.y : Infinity;
    // (Not right after a repeated page header: there, a wrapped line carries over from the previous page.)
    if (!(afterHeader && last && line.page > last.page) && next && next.y - line.y < gapAbove && next.y - line.y <= line.h * 1.5) {
      prefix.push(text);
      continue;
    }
    if (closeBelow && rows.length) {
      const row = rows[rows.length - 1];
      for (const p of line.phrases) {
        const t = center(p) < cols.desc.x ? parseTime(p.text) : null;
        if (t) { if (!row.time) row.time = t; }
        else row.description = `${row.description} ${p.text}`.trim();
      }
      last = { page: line.page, y: line.y, h: line.h };
      rowOpen = true;
      afterHeader = false;
      continue;
    }
    if (last && line.page === last.page) rowOpen = false;
    afterHeader = false;
  }

  const ordered = orderRows(rows, opening, notes);
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

/**
 * Oldest first. The running balances decide the order (not the dates, which can all be the same day):
 * whichever order chains without a break is the right one.
 */
function orderRows(rows: ParsedRow[], opening: number | null, notes: string[]): ParsedRow[] {
  if (rows.length < 2) return rows;
  const chains = (rs: ParsedRow[]) => {
    const open = opening ?? round2(rs[0].balance - rs[0].moneyIn + rs[0].moneyOut);
    return firstBalanceBreak(open, rs) === -1;
  };
  const reversed = [...rows].reverse();
  const asPrinted = chains(rows);
  const backwards = chains(reversed);
  if (backwards && (!asPrinted || rows[0].date > rows[rows.length - 1].date)) {
    notes.push('Rows were listed newest-first; reordered.');
    return reversed;
  }
  return rows;
}
