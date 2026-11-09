import { isCategory } from './categories';
import { isYmd } from './dates';
import { maskPayee } from './privacy';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard against spreadsheet formula injection: anything starting like a formula gets a leading
  // apostrophe, except plain numbers such as -12.50.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export interface HistoryCsvRow {
  date: string;
  account: string;
  payee: string;
  amountUsd: number;
  category: string;
}

/** Parse the history import (date,account,payee,amount_usd,category). Any bad row stops the import. */
export function parseHistoryCsv(text: string): { rows: HistoryCsvRow[]; errors: string[] } {
  const all = parseCsv(text);
  const errors: string[] = [];
  if (!all.length) return { rows: [], errors: ['The file is empty.'] };
  const header = all[0].map((h) => h.trim().toLowerCase());
  const want = ['date', 'account', 'payee', 'amount_usd', 'category'];
  const idx = want.map((w) => header.indexOf(w));
  if (idx.some((i) => i < 0)) return { rows: [], errors: [`Header must be: ${want.join(',')}`] };
  const rows: HistoryCsvRow[] = [];
  all.slice(1).forEach((r, n) => {
    const line = n + 2;
    const [date, account, payee, amt, category] = idx.map((i) => (r[i] ?? '').trim());
    const amountUsd = Number(amt);
    if (!isYmd(date)) errors.push(`Line ${line}: date "${date}" must be YYYY-MM-DD.`);
    else if (!account) errors.push(`Line ${line}: account is empty.`);
    else if (!payee) errors.push(`Line ${line}: payee is empty.`);
    else if (!/^-?\d+(\.\d{1,2})?$/.test(amt) || !Number.isFinite(amountUsd)) errors.push(`Line ${line}: amount "${amt}" isn't a number.`);
    else if (!isCategory(category)) errors.push(`Line ${line}: unknown category "${category}".`);
    else rows.push({ date, account, payee, amountUsd, category });
  });
  return { rows, errors };
}

/** What identifies an imported history row (the server hashes this; re-importing the same file adds nothing). */
export function csvHashable(r: { date: string; account: string; payee: string; amountUsd: number }) {
  return { date: r.date, time: null, payee: `${r.account.trim()}|${maskPayee(r.payee)}`, amountOrig: r.amountUsd, balance: null };
}

/** Rows per import request (keeps each request well under the free plan's CPU limit). */
export const CSV_ROWS_PER_REQUEST = 500;
