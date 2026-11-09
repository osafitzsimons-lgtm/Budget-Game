import { findDates } from '../shared/dates';
import { parseAmount, round2, sameMoney } from '../shared/money';
import { type Line, type Phrase, StatementError } from './lines';

/**
 * Find the account number near a label (same line, or the line below) and return only its last 3 digits.
 * The full number is never returned or stored.
 */
export function findAccountLast3(lines: Line[], label: RegExp, what: string): string {
  const found = new Set<string>();
  const digitsIn = (text: string) => {
    const out: string[] = [];
    // IBANs (e.g. GB12 REVO 0099 …) and plain/spaced account numbers of 6+ digits
    const iban = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
    for (const m of text.matchAll(iban)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length >= 6) out.push(d.slice(-3));
    }
    const plain = text.replace(iban, ' ');
    for (const m of plain.matchAll(/\d(?:[\s-]?\d){5,}/g)) out.push(m[0].replace(/\D/g, '').slice(-3));
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = label.exec(l.text);
    if (!m) continue;
    const after = l.text.slice(m.index + m[0].length);
    let ds = digitsIn(after);
    if (!ds.length && lines[i + 1] && lines[i + 1].page === l.page) {
      // value printed under the label
      const below = lines[i + 1].phrases.filter((p) => Math.abs(p.x - (l.phrases.find((ph) => label.test(ph.text))?.x ?? p.x)) < 60);
      ds = digitsIn(below.map((p) => p.text).join(' '));
    }
    ds.forEach((d) => found.add(d));
  }
  if (found.size === 0) throw new StatementError(`Couldn't find the ${what} account number in the statement header. Nothing was saved.`);
  if (found.size > 1)
    throw new StatementError(`Found more than one ${what} account number (ending ${[...found].join(', ')}). Upload one account per PDF. Nothing was saved.`);
  return [...found][0];
}

/** First line (before `beforeIndex`) that contains two dates, preferring lines mentioning a period. */
export function findPeriod(lines: Line[], beforeIndex: number): { start: string; end: string } | null {
  const candidates = lines.slice(0, beforeIndex).map((l) => ({ l, d: findDates(l.text) })).filter((x) => x.d.length >= 2);
  const pick = candidates.find((x) => /period|from|statement|between|date range/i.test(x.l.text)) ?? candidates[0];
  if (!pick) return null;
  const [a, b] = pick.d;
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

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
