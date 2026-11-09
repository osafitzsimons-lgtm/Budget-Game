import { isExcluded, isNegotiable } from './categories';
import { monthOf, weekStart } from './dates';
import { round2 } from './money';

export interface HistoryRow {
  date: string;
  category: string;
  /** "pdf" rows come from uploaded statements, "csv" from the history import */
  source: 'pdf' | 'csv';
  /** bank group used to avoid counting imported history twice: ABA, REV or another label */
  bank: string;
  amountUsd: number;
}

/** Map a CSV account label to a bank group: "ABA", "ABA 812" → ABA; "REV", "Revolut" → REV. */
export function bankForLabel(label: string): string {
  const l = label.trim().toUpperCase();
  if (l.startsWith('ABA')) return 'ABA';
  if (l.startsWith('REV')) return 'REV';
  return l;
}

/**
 * Imported history only fills the past: once a bank has uploaded statements, imported rows
 * for that bank on or after the first uploaded date are ignored so nothing counts twice.
 */
export function mergeHistory(rows: HistoryRow[]): HistoryRow[] {
  const firstPdf = new Map<string, string>();
  for (const r of rows) {
    if (r.source !== 'pdf') continue;
    const f = firstPdf.get(r.bank);
    if (!f || r.date < f) firstPdf.set(r.bank, r.date);
  }
  return rows.filter((r) => {
    if (r.source === 'pdf') return true;
    const f = firstPdf.get(r.bank);
    return !f || r.date < f;
  });
}

/** Total spending per month, excluding Transfer and Investing. */
export function monthlySpending(rows: HistoryRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of mergeHistory(rows)) {
    if (isExcluded(r.category)) continue;
    const k = monthOf(r.date);
    m.set(k, round2((m.get(k) ?? 0) + r.amountUsd));
  }
  return new Map([...m].sort());
}

/** Negotiable spending per Sunday–Saturday week. */
export function weeklyNegotiable(rows: HistoryRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of mergeHistory(rows)) {
    if (!isNegotiable(r.category)) continue;
    const k = weekStart(r.date);
    m.set(k, round2((m.get(k) ?? 0) + r.amountUsd));
  }
  return new Map([...m].sort());
}

/** Average monthly spend per category over the given months. */
export function categoryAverages(rows: HistoryRow[], months: string[]): { category: string; avg: number }[] {
  const set = new Set(months);
  const totals = new Map<string, number>();
  for (const r of mergeHistory(rows)) {
    if (!set.has(monthOf(r.date))) continue;
    totals.set(r.category, (totals.get(r.category) ?? 0) + r.amountUsd);
  }
  return [...totals]
    .map(([category, t]) => ({ category, avg: round2(t / Math.max(1, months.length)) }))
    .sort((a, b) => b.avg - a.avg);
}
