import { findDates } from '../shared/dates';
import { parseAmount, round2, sameMoney } from '../shared/money';
import { type Line, type Phrase, StatementError } from './lines';

const IBAN = /^[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?/;
const ACCOUNT_DIGITS = /^\d(?:[\s-]?\d){5,}/;

/** The account number at the very start of some text (an IBAN or a run of 6+ digits), as its last 3 digits. */
function leadingAccount(text: string): string | null {
  const t = text.replace(/^[\s:.#-]+/, '');
  const m = IBAN.exec(t) ?? ACCOUNT_DIGITS.exec(t);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return d.length >= 6 ? d.slice(-3) : null;
}

/**
 * Find the account number printed right after a label ("Account No:", "A/C No.", "IBAN") — in the same
 * piece of text, the next piece on the line, or directly under the label — and return only its last 3
 * digits. Numbers that aren't next to a label (phone numbers, postcodes, other people's IBANs) are ignored.
 */
export function findAccountLast3(lines: Line[], label: RegExp, what: string): string {
  const found = new Set<string>();
  const re = new RegExp(label.source, label.flags.replace('g', ''));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    l.phrases.forEach((ph, k) => {
      const m = re.exec(ph.text);
      if (!m) return;
      const rest = ph.text.slice(m.index + m[0].length);
      let v = leadingAccount(rest);
      if (!v && !rest.trim()) {
        const next = l.phrases[k + 1];
        if (next) v = leadingAccount(next.text);
      }
      if (!v && !rest.trim() && !l.phrases[k + 1]) {
        const below = lines[i + 1];
        if (below && below.page === l.page && below.y - l.y < l.h * 2.5) {
          const under = below.phrases.find((p) => Math.abs(p.x - ph.x) < 40);
          if (under) v = leadingAccount(under.text);
        }
      }
      if (v) found.add(v);
    });
  }
  if (found.size === 0) throw new StatementError(`Couldn't find the ${what} account number in the statement header. Nothing was saved.`);
  if (found.size > 1)
    throw new StatementError(`Found more than one ${what} account number (ending ${[...found].join(', ')}). Upload one account per PDF. Nothing was saved.`);
  return [...found][0];
}

/**
 * The statement period from the header: the two dates after "Period", or "from … to …", or else a header
 * line holding exactly two dates. Other dates on the same line (statement or print date) are ignored.
 */
export function findPeriod(lines: Line[], beforeIndex: number): { start: string; end: string } | null {
  const head = lines.slice(0, beforeIndex);
  const order = (a: string, b: string) => (a <= b ? { start: a, end: b } : { start: b, end: a });
  for (const l of head) {
    const m = /\bperiod\b\s*:?\s*(.*)$/i.exec(l.text);
    if (m) {
      const d = findDates(m[1]);
      if (d.length >= 2) return order(d[0], d[1]);
    }
  }
  for (const l of head) {
    const m = /\bfrom\b(.*)\bto\b(.*)$/i.exec(l.text);
    if (m) {
      const a = findDates(m[1]);
      const b = findDates(m[2]);
      if (a.length >= 1 && b.length >= 1) return order(a[0], b[0]);
    }
  }
  const two = head.map((l) => findDates(l.text)).filter((d) => d.length === 2);
  return two.length === 1 ? order(two[0][0], two[0][1]) : null;
}

/** Text that is never part of a payee, even right under a row: page notes, footers, end markers. */
export const NOT_A_PAYEE = /continued (?:on|over)(?: the)? next page|continued overleaf|end of statement|^page \d+(?: of \d+)?$|\*{3}|thank you for banking|regulated by|licensed by|registered in england|authori[sz]ed by|financial conduct authority|prudential regulation|report lost or stolen|get help directly|scan the qr|deposit insurance|financial services compensation|balance on your statement might differ|www\.|computer.generated|printed on/i;

/** A whole sentence (5+ words ending in a full stop) is a note, not a wrapped payee. */
export function isNote(text: string): boolean {
  const t = text.trim();
  return /[.!]$/.test(t) && t.split(/\s+/).length >= 5;
}

export const DASH_ONLY = /^[-–—]+$/;

export function amountPhrases(line: Line): { p: Phrase; v: number }[] {
  return line.phrases.map((p) => ({ p, v: parseAmount(p.text) })).filter((x): x is { p: Phrase; v: number } => x.v !== null);
}

export const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i;

export function parseTime(s: string): string | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  if (m[4]) {
    const pm = m[4].toUpperCase() === 'PM';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Verify prev + in − out = balance for every row, in the given order. Returns the index of the first failure or -1. */
export function firstBalanceBreak(opening: number, rows: { moneyIn: number; moneyOut: number; balance: number }[]): number {
  let prev = opening;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!sameMoney(round2(prev + r.moneyIn - r.moneyOut), r.balance)) return i;
    prev = r.balance;
  }
  return -1;
}

export const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
