import { addDays, formatDate, previousSaturday } from './dates';
import type { ProofCheck, ProofResult, StatementSummary } from './types';

export interface LastGood {
  periodEnd: string;
  /** closing balance in account currency */
  closing: number;
}

export interface ProofInput {
  statement: StatementSummary;
  /** rows in statement order, with running balance after each row */
  rows: { hash: string; balance: number }[];
  /** latest upload for this account that passed its checks, or null for the first upload */
  lastGood: LastGood | null;
  knownHashes: Set<string>;
  /** Phnom Penh date of the upload */
  today: string;
  /** account in the statement matched a registered account */
  accountOk: boolean;
  accountDetail: string;
}

const money = (n: number, cur: string) => `${cur === 'GBP' ? '£' : '$'}${n.toFixed(2)}`;

export function checkProof(inp: ProofInput): ProofResult {
  const { statement: s, rows, lastGood, knownHashes, today } = inp;
  const checks: ProofCheck[] = [];

  checks.push({ id: 'account', ok: inp.accountOk, label: 'Right account', detail: inp.accountDetail });

  const sat = previousSaturday(today);
  const reaches = s.periodEnd >= sat;
  checks.push({
    id: 'reaches-saturday',
    ok: reaches,
    label: 'Reaches last Saturday',
    detail: reaches
      ? `Runs to ${formatDate(s.periodEnd)} (needed ${formatDate(sat)}).`
      : `Ends ${formatDate(s.periodEnd)} but must reach ${formatDate(sat)}. Download a newer statement.`,
  });

  const firstNew = rows.findIndex((r) => !knownHashes.has(r.hash));
  const newRows = rows.filter((r) => !knownHashes.has(r.hash)).length;

  if (!lastGood) {
    checks.push({
      id: 'baseline',
      ok: true,
      label: 'Baseline',
      detail: `First statement for this account. Its opening balance ${money(s.opening, s.currency)} becomes the starting point.`,
    });
  } else {
    // Balance just before the first row we haven't seen yet.
    const allKnown = firstNew === -1;
    const overlap = firstNew > 0 || (allKnown && rows.length > 0);
    const boundary = allKnown ? s.closing : firstNew === 0 ? s.opening : rows[firstNew - 1].balance;
    const balOk = Math.abs(boundary - lastGood.closing) <= 0.01 + 1e-9;

    let gapOk: boolean;
    let gapDetail: string;
    if (overlap) {
      gapOk = true;
      gapDetail = 'Overlaps the last statement, so there is no gap. Repeated rows are skipped.';
    } else if (s.periodStart <= addDays(lastGood.periodEnd, 1)) {
      gapOk = true;
      gapDetail = `Starts ${formatDate(s.periodStart)}; last statement ended ${formatDate(lastGood.periodEnd)}.`;
    } else if (!s.periodFromHeader && balOk) {
      gapOk = true;
      gapDetail = `First row is ${formatDate(s.periodStart)}, after the last statement ended (${formatDate(lastGood.periodEnd)}), but balances join up exactly, so nothing happened in between.`;
    } else {
      gapOk = false;
      gapDetail = `Starts ${formatDate(s.periodStart)} but the last statement ended ${formatDate(lastGood.periodEnd)}. Days in between are missing.`;
    }
    checks.push({ id: 'no-gap', ok: gapOk, label: 'No gap since last upload', detail: gapDetail });
    checks.push({
      id: 'opening-balance',
      ok: balOk,
      label: 'Opening balance matches',
      detail: balOk
        ? `${money(boundary, s.currency)} matches the last stored balance.`
        : `Statement shows ${money(boundary, s.currency)} where the last stored balance is ${money(lastGood.closing, s.currency)} (difference ${money(Math.abs(boundary - lastGood.closing), s.currency)}).`,
    });
  }

  return { ok: checks.every((c) => c.ok), baseline: !lastGood, checks, newRows };
}
