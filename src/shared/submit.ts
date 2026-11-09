// Splits a statement into parts small enough for the free plan's 10 ms CPU limit per request.
// Every part is a complete mini-statement that chains on to what is already saved, so the server
// checks each one exactly like a whole statement.
import { csvHashable, CSV_ROWS_PER_REQUEST, type HistoryCsvRow } from './csv';
import { dupIndexes } from './hash';
import { round2 } from './money';
import type { ProofResult, ScoreEvent, StatementSummary } from './types';

export const MAX_ROWS_PER_PART = 250;

export interface PartRow {
  date: string;
  hash: string;
  /** statement rows always have a running balance */
  balance: number | null;
  amountOrig: number;
}

export interface Part<R extends PartRow, S extends StatementSummary = StatementSummary> {
  summary: S;
  rows: R[];
}

/**
 * Plan the requests for a statement that passed its check.
 * - Rows already saved are not sent again.
 * - New rows after the saved ones go oldest-first, each part starting where the last one ended.
 * - New rows before the saved ones (older history) go newest-first, each part ending where the next one starts.
 */
export function planParts<R extends PartRow, S extends StatementSummary>(summary: S, rows: R[], proof: Pick<ProofResult, 'firstKnown' | 'lastKnown' | 'direction' | 'newRows'>, max = MAX_ROWS_PER_PART): Part<R, S>[] {
  const n = rows.length;
  const bal = (i: number) => {
    const b = rows[i].balance;
    if (b === null) throw new Error('Statement rows need running balances.');
    return b;
  };
  const before = (i: number) => (i === 0 ? summary.opening : bal(i - 1));
  const part = (a: number, b: number, periodStart: string, periodEnd: string, extra: Partial<StatementSummary> = {}): Part<R, S> => ({
    summary: { ...summary, ...extra, periodStart, periodEnd, opening: round2(before(a)), closing: round2(bal(b - 1)) },
    rows: rows.slice(a, b),
  });
  if (n === 0) return [{ summary, rows }];
  if (proof.newRows === 0) {
    // Nothing new; send the last row so the statement's dates still count as covered.
    return [part(n - 1, n, rows[n - 1].date, summary.periodEnd)];
  }

  const { firstKnown: fk, lastKnown: lk } = proof;
  const parts: Part<R, S>[] = [];

  // Older history before what's saved: [0, prefixEnd)
  const prefixEnd = fk > 0 ? fk : fk === -1 && proof.direction === 'backfill' ? n : 0;
  if (prefixEnd > 0) {
    const chunks: [number, number][] = [];
    for (let a = 0; a < prefixEnd; a += max) chunks.push([a, Math.min(prefixEnd, a + max)]);
    for (let j = chunks.length - 1; j >= 0; j--) {
      const [a, b] = chunks[j];
      const start = j === 0 ? summary.periodStart : rows[a].date;
      const end = j === chunks.length - 1 ? (fk > 0 ? rows[fk].date : summary.periodEnd) : rows[b].date;
      parts.push(part(a, b, start, end, { direction: 'backfill' }));
    }
  }

  // New rows after what's saved (or a whole new statement): [suffixStart, n)
  const suffixStart = lk >= 0 ? lk + 1 : proof.direction === 'backfill' ? n : 0;
  for (let a = suffixStart; a < n; a += max) {
    const b = Math.min(n, a + max);
    const start = a === suffixStart ? (lk >= 0 ? rows[lk].date : summary.periodStart) : rows[a - 1].date;
    const end = b === n ? summary.periodEnd : rows[b - 1].date;
    parts.push(part(a, b, start, end));
  }
  return parts;
}

// ---------- Sending a statement (used by the app, the dev script and the tests) ----------


export type Post = <T>(path: string, body: unknown) => Promise<T>;

export interface ConfirmResponse {
  proof: ProofResult;
  inserted: number;
  stored: boolean;
  healthBefore: number;
  healthAfter: number;
  events: Omit<ScoreEvent, 'id'>[];
  died: boolean;
}

export interface SubmitResult extends Omit<ConfirmResponse, 'healthBefore' | 'healthAfter'> {
  healthBefore: number | null;
  healthAfter: number | null;
  parts: number;
}

/**
 * Check a statement, then either record the failed proof or save it in parts. The server re-checks
 * every part against what is saved, so a part can never slip something past the checks.
 */
export async function submitStatement<R extends PartRow, S extends StatementSummary>(post: Post, summary: S, rows: R[], rules: { payee: string; category: string }[] = [], onProgress?: (done: number, total: number) => void): Promise<SubmitResult> {
  // The check only needs each row's id and balance (everything is re-checked when each part is saved).
  const slim = rows.map((r) => ({ hash: r.hash, balance: r.balance }));
  const proof = await post<ProofResult>('/api/uploads/check', { statement: summary, rows: slim });
  if (!proof.ok) {
    const r = await post<{ proof: ProofResult }>('/api/uploads/fail', { statement: summary, rows: slim });
    return { proof: r.proof, inserted: 0, stored: false, healthBefore: null, healthAfter: null, events: [], died: false, parts: 0 };
  }
  const parts = planParts(summary, rows, proof);
  const out: SubmitResult = { proof, inserted: 0, stored: true, healthBefore: null, healthAfter: null, events: [], died: false, parts: parts.length };
  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i, parts.length);
    const p = parts[i];
    const r = await post<ConfirmResponse>('/api/uploads/confirm', { statement: p.summary, rows: p.rows, rules: i === parts.length - 1 ? rules : [] });
    out.healthBefore ??= r.healthBefore;
    out.healthAfter = r.healthAfter;
    out.inserted += r.inserted;
    out.events.push(...r.events);
    out.died ||= r.died;
    if (!r.stored) return { ...out, stored: false, proof: r.proof };
  }
  onProgress?.(parts.length, parts.length);
  return out;
}

/** Import history rows in requests of at most CSV_ROWS_PER_REQUEST rows. */
export async function importHistory(post: Post, rows: HistoryCsvRow[]): Promise<{ inserted: number; skipped: number; rulesLearned: number }> {
  const dups = dupIndexes('csv', rows.map(csvHashable));
  const total = { inserted: 0, skipped: 0, rulesLearned: 0 };
  for (let i = 0; i < rows.length; i += CSV_ROWS_PER_REQUEST) {
    const chunk = rows.slice(i, i + CSV_ROWS_PER_REQUEST).map((r, j) => ({ ...r, dup: dups[i + j] }));
    const res = await post<typeof total>('/api/import-csv', { rows: chunk });
    total.inserted += res.inserted;
    total.skipped += res.skipped;
    total.rulesLearned += res.rulesLearned;
  }
  return total;
}
