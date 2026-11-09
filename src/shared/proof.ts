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
  /** earliest upload that passed its checks (to allow filling in older history before it) */
  firstGood?: { periodStart: string; opening: number } | null;
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

  checks.push({ id: 'account', ok: inp.accountOk, blocking: true, label: 'Right account', detail: inp.accountDetail });

  const sat = previousSaturday(today);
  const reaches = s.periodEnd >= sat;
  // Not blocking: an older statement (e.g. a late upload of a missed week) is still saved when its balances
  // join up. Last week only counts as covered once a statement reaching Saturday is in.
  checks.push({
    id: 'reaches-saturday',
    ok: reaches,
    blocking: false,
    label: 'Reaches last Saturday',
    detail: reaches
      ? `Runs to ${formatDate(s.periodEnd)} (needed ${formatDate(sat)}).`
      : `Ends ${formatDate(s.periodEnd)}, before ${formatDate(sat)}. It can still be saved, but last week counts as missing until a statement reaching ${formatDate(sat)} is uploaded.`,
  });

  const known = rows.map((r) => knownHashes.has(r.hash));
  const newRows = known.filter((k) => !k).length;
  const firstKnown = known.indexOf(true);
  const lastKnown = known.lastIndexOf(true);
  const before = (i: number) => (i === 0 ? s.opening : rows[i - 1].balance); // balance just before row i
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-9;
  const gapCheck = (ok: boolean, detail: string) => checks.push({ id: 'no-gap', ok, blocking: true, label: 'No gap', detail });
  const balCheck = (ok: boolean, shown: number, stored: number, what: string) =>
    checks.push({
      id: 'opening-balance',
      ok,
      blocking: true,
      label: 'Balances join up',
      detail: ok
        ? `${money(shown, s.currency)} matches the ${what}.`
        : `Statement shows ${money(shown, s.currency)} where the ${what} is ${money(stored, s.currency)} (difference ${money(Math.abs(shown - stored), s.currency)}).`,
    });
  const firstGood = inp.firstGood;

  let direction: ProofResult['direction'] = 'forward';
  if (!lastGood) {
    direction = 'baseline';
    checks.push({
      id: 'baseline',
      ok: true,
      blocking: true,
      label: 'Baseline',
      detail: `First statement for this account. Its opening balance ${money(s.opening, s.currency)} becomes the starting point.`,
    });
  } else if (rows.length > 0 && newRows === 0) {
    // Uploaded before: nothing to add, nothing to check.
    direction = 'duplicate';
    gapCheck(true, 'Every row in this statement is already saved. Nothing new will be added.');
  } else if (firstKnown === -1) {
    const backfill = firstGood && (s.direction === 'backfill' ? s.periodStart <= firstGood.periodStart : s.periodStart < firstGood.periodStart);
    if (firstGood && backfill) {
      direction = 'backfill';
      // Fills in history before your earliest statement: its closing must be that statement's opening.
      const balOk = near(s.closing, firstGood.opening);
      const gapOk = s.periodEnd >= addDays(firstGood.periodStart, -1) || (!s.periodFromHeader && balOk);
      gapCheck(gapOk, gapOk ? `Ends ${formatDate(s.periodEnd)}, right before your earliest saved statement (${formatDate(firstGood.periodStart)}).` : `Ends ${formatDate(s.periodEnd)} but your earliest saved statement starts ${formatDate(firstGood.periodStart)}. Days in between are missing.`);
      balCheck(balOk, s.closing, firstGood.opening, 'opening balance of your earliest saved statement');
    } else {
      // Carries on after your latest statement: its opening must be that statement's closing.
      const balOk = near(s.opening, lastGood.closing);
      let gapOk = s.periodStart <= addDays(lastGood.periodEnd, 1);
      let detail = gapOk ? `Starts ${formatDate(s.periodStart)}; last statement ended ${formatDate(lastGood.periodEnd)}.` : `Starts ${formatDate(s.periodStart)} but the last statement ended ${formatDate(lastGood.periodEnd)}. Days in between are missing.`;
      if (!gapOk && !s.periodFromHeader && balOk) {
        gapOk = true;
        detail = `First row is ${formatDate(s.periodStart)}, after the last statement ended (${formatDate(lastGood.periodEnd)}), but balances join up exactly, so nothing happened in between.`;
      }
      gapCheck(gapOk, detail);
      balCheck(balOk, s.opening, lastGood.closing, 'last stored balance');
    }
  } else {
    // Overlaps what's saved. The saved rows must be one unbroken run, with new rows only before or after it.
    direction = 'overlap';
    const interiorNew = known.slice(firstKnown, lastKnown + 1).some((k) => !k);
    if (interiorNew) {
      gapCheck(false, 'Some rows in the middle of this statement differ from what is already saved for the same dates. Stopped so nothing is counted twice or lost.');
    } else {
      gapCheck(true, 'Overlaps what is already saved, so there is no gap. Repeated rows are skipped.');
      let ok = true;
      if (firstKnown > 0) {
        // New rows before the saved ones: only allowed when filling in before your earliest statement.
        const fills = !!firstGood && s.periodStart < firstGood.periodStart;
        const b = before(firstKnown);
        if (!fills || !near(b, firstGood.opening)) { ok = false; balCheck(false, b, firstGood?.opening ?? b, 'opening balance of your earliest saved statement'); }
      }
      if (lastKnown < rows.length - 1) {
        const b = rows[lastKnown].balance;
        if (!near(b, lastGood.closing)) { ok = false; balCheck(false, b, lastGood.closing, 'last stored balance'); }
      }
      if (ok) checks.push({ id: 'opening-balance', ok: true, blocking: true, label: 'Balances join up', detail: 'New rows join up exactly with the balances already saved.' });
    }
  }

  return { ok: checks.every((c) => c.ok || !c.blocking), covers: reaches, baseline: !lastGood, checks, newRows, firstKnown, lastKnown, direction };
}
