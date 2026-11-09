import { isNegotiable } from './categories';
import { addDays, addMonths, formatDate, monthOf, ppDate, ppInstant, weekDeadline, weekEnd } from './dates';
import { round2, usd } from './money';
import { phaseValue, type Settings } from './settings';
import type { LogEntry, ScoreEvent } from './types';

export const START_HEALTH = 70;
export const REBIRTH_HEALTH = 40;
export const DEATH_SAVINGS_PENALTY = 25;

export interface ScoredTx {
  hash: string;
  accountId: string;
  date: string;
  payee: string;
  amountUsd: number;
  category: string;
  isCash: boolean;
  savings: boolean;
}

export interface UploadRecord {
  accountId: string;
  uploadedAt: number;
  periodEnd: string;
  /** first day the statement covers (missing = treat as covering everything before periodEnd) */
  periodStart?: string;
  ok: boolean;
}

export interface Band { delta: number; label: string }

export function spendBand(spend: number, allowance: number): Band {
  const pct = allowance > 0 ? (spend / allowance) * 100 : spend > 0 ? Infinity : 0;
  const p = Number.isFinite(pct) ? `${Math.round(pct)}%` : 'over';
  if (pct <= 80) return { delta: 15, label: `Spent ${p} of allowance (80% or less)` };
  if (pct <= 100) return { delta: 8, label: `Spent ${p} of allowance (within budget)` };
  if (pct <= 120) return { delta: -10, label: `Spent ${p} of allowance (up to 120%)` };
  if (pct <= 150) return { delta: -20, label: `Spent ${p} of allowance (up to 150%)` };
  return { delta: -35, label: `Spent ${p} of allowance (over 150%)` };
}

/** Before the halving date, negative changes are halved (rounded towards zero). */
export function adjustDelta(delta: number, atMs: number, halveBefore: string): number {
  if (delta < 0 && ppDate(atMs) < halveBefore) return Math.trunc(delta / 2);
  return delta;
}

/** Weekly negotiable spend, with cash that was logged as non-negotiable taken back out. */
export function negotiableSpend(txs: ScoredTx[], cashLogs: LogEntry[]): number {
  let total = 0;
  const byHash = new Map(txs.map((t) => [t.hash, t]));
  for (const t of txs) if (isNegotiable(t.category)) total += t.amountUsd;
  const used = new Map<string, number>();
  for (const l of cashLogs) {
    if (l.kind !== 'cash' || !l.cashTxHash || !l.category) continue;
    const w = byHash.get(l.cashTxHash);
    if (!w || !w.isCash || !isNegotiable(w.category) || isNegotiable(l.category)) continue;
    const already = used.get(w.hash) ?? 0;
    const take = Math.max(0, Math.min(l.amountUsd, w.amountUsd - already));
    used.set(w.hash, already + take);
    total -= take;
  }
  return round2(total);
}

/** Spending of $30+ on a negotiable needs a "write it down" entry first: within $2 and up to 2 days before. */
export function findUnlogged(txs: ScoredTx[], logs: LogEntry[]): ScoredTx[] {
  const planned = logs.filter((l) => l.kind === 'planned');
  const usedLogs = new Set<string>();
  const big = txs
    .filter((t) => isNegotiable(t.category) && t.category !== 'Friends paying back' && t.amountUsd >= 30)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const missing: ScoredTx[] = [];
  for (const t of big) {
    let best: LogEntry | null = null;
    for (const l of planned) {
      if (usedLogs.has(l.id)) continue;
      if (Math.abs(l.amountUsd - t.amountUsd) > 2) continue;
      if (l.date > t.date || l.date < addDays(t.date, -2)) continue;
      if (ppDate(l.createdAt) > t.date) continue; // written after the spending happened
      if (!best || Math.abs(l.amountUsd - t.amountUsd) < Math.abs(best.amountUsd - t.amountUsd)) best = l;
    }
    if (best) usedLogs.add(best.id);
    else missing.push(t);
  }
  return missing;
}

export type AccountStatus = 'ok' | 'missing' | 'failing';

/**
 * Is a week covered for an account? Statements that passed their checks must reach Saturday and, together
 * (they chain without gaps), start on or before `needFrom` (the week's Sunday). The first scored week is
 * exempt from the start rule, because the first statement only sets the baseline.
 */
export function accountStatus(uploads: UploadRecord[], accountId: string, saturday: string, atMs: number, needFrom?: string): AccountStatus {
  const mine = uploads.filter((u) => u.accountId === accountId && u.uploadedAt <= atMs).sort((a, b) => a.uploadedAt - b.uploadedAt);
  const good = mine.filter((u) => u.ok);
  const earliest = good.reduce<string | null>((m, u) => (u.periodStart && (!m || u.periodStart < m) ? u.periodStart : m), null);
  const startsInTime = !needFrom || earliest === null || earliest <= needFrom;
  if (startsInTime && good.some((u) => u.periodEnd >= saturday)) return 'ok';
  // "Failing" only if the latest attempt was meant to cover this week (an old backfill attempt doesn't count).
  const latest = mine[mine.length - 1];
  if (latest && !latest.ok && latest.periodEnd >= saturday) return 'failing';
  return 'missing';
}

/** Which month's savings check (if any) is decided in this week: the week containing the 3rd. */
export function savingsMonthForWeek(weekStartYmd: string): string | null {
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStartYmd, i);
    if (d.endsWith('-03')) return monthOf(d);
  }
  return null;
}

export function savingsWindow(month: string, startDay: number): { from: string; to: string } {
  return { from: `${addMonths(month, -1)}-${String(startDay).padStart(2, '0')}`, to: `${month}-03` };
}

/**
 * Money moved to savings within a window. If the savings account itself is uploaded, count money arriving
 * there (from your own accounts); otherwise count transfers out that are marked as savings.
 */
export function savedInWindow(txs: ScoredTx[], from: string, to: string, savingsAccountId: string, savingsAccountTracked: boolean): number {
  let total = 0;
  for (const t of txs) {
    if (t.date < from || t.date > to) continue;
    if (savingsAccountTracked) {
      if (t.accountId === savingsAccountId && t.amountUsd < 0 && t.category === 'Transfer') total += -t.amountUsd;
    } else if (t.savings && t.amountUsd > 0) total += t.amountUsd;
  }
  return round2(total);
}

/** The savings month a death's $25 penalty is added to: the next "by the 3rd" after the death. */
export function penaltyMonth(deathYmd: string): string {
  return Number(deathYmd.slice(8, 10)) <= 3 ? monthOf(deathYmd) : addMonths(monthOf(deathYmd), 1);
}

export type EvalMode = 'deadline' | 'early' | 'late';

export interface WeekInput {
  weekStart: string;
  /** when the evaluation counts as happening: the deadline, or "now" for early/late evaluations */
  atMs: number;
  /**
   * deadline: Sunday 8pm has passed. early: the week is over and every statement is already in.
   * late: the week took a missing/failing penalty and its statements have now arrived.
   */
  mode: EvalMode;
  requiredAccountIds: string[];
  uploads: UploadRecord[];
  /** statement and hand-added transactions dated in this week */
  weekTxs: ScoredTx[];
  logs: LogEntry[];
  settings: Settings;
  /** set if this week decides a month's savings check */
  savings: { month: string; saved: number; target: number } | null;
  /** late mode only: the savings change given at the deadline (to refund it if late statements prove the savings) */
  savingsPenaltyAtDeadline?: number;
}

export type RawEvent = Pick<ScoreEvent, 'kind' | 'delta' | 'reason'>;

export interface WeekResult {
  events: RawEvent[];
  /** false when the week got a missing/failing penalty and still waits for statements */
  dataOk: boolean;
}

/** Every required account has a statement that passed its checks and reaches this week's Saturday. */
export function allStatementsIn(weekStartYmd: string, atMs: number, requiredAccountIds: string[], uploads: UploadRecord[], scoringStart = ''): boolean {
  const sat = weekEnd(weekStartYmd);
  const needFrom = weekStartYmd > scoringStart ? weekStartYmd : undefined;
  return requiredAccountIds.length > 0 && requiredAccountIds.every((id) => accountStatus(uploads, id, sat, atMs, needFrom) === 'ok');
}

export function canEvaluateEarly(weekStartYmd: string, nowMs: number, requiredAccountIds: string[], uploads: UploadRecord[], scoringStart = ''): boolean {
  if (nowMs < ppInstant(addDays(weekEnd(weekStartYmd), 1), 0, 0)) return false;
  return allStatementsIn(weekStartYmd, nowMs, requiredAccountIds, uploads, scoringStart);
}

export function evaluateWeek(inp: WeekInput): WeekResult {
  const sat = weekEnd(inp.weekStart);
  const events: RawEvent[] = [];
  const range = `${formatDate(inp.weekStart)} – ${formatDate(sat)}`;
  const late = inp.mode === 'late';

  let dataOk = true;
  if (inp.mode === 'deadline') {
    const needFrom = inp.weekStart > inp.settings.scoringStart ? inp.weekStart : undefined;
    const statuses = inp.requiredAccountIds.map((id) => ({ id, s: accountStatus(inp.uploads, id, sat, inp.atMs, needFrom) }));
    const missing = statuses.filter((x) => x.s === 'missing').map((x) => x.id);
    const failing = statuses.filter((x) => x.s === 'failing').map((x) => x.id);
    if (inp.requiredAccountIds.length === 0) {
      events.push({ kind: 'missing-upload', delta: -25, reason: `No required accounts are set, so nothing proves ${range}. Make your main accounts required in Settings.` });
      dataOk = false;
    } else if (missing.length) {
      events.push({ kind: 'missing-upload', delta: -25, reason: `No valid statement by Sunday 8pm for ${range} (${missing.join(', ')}). Upload late to get the week scored.` });
      dataOk = false;
    } else if (failing.length) {
      events.push({ kind: 'proof-failing', delta: -25, reason: `Proof check still failing at the deadline for ${range} (${failing.join(', ')}). Upload a statement that fixes it to get the week scored.` });
      dataOk = false;
    }
  }

  if (dataOk) {
    const allowance = phaseValue(inp.settings.allowance, inp.weekStart);
    const cashLogs = inp.logs.filter((l) => l.kind === 'cash');
    const spend = negotiableSpend(inp.weekTxs, cashLogs);
    const band = spendBand(spend, allowance);
    const tag = late ? ' (late statements)' : '';
    events.push({ kind: 'spend', delta: band.delta, reason: `${range}${tag}: ${usd(spend)} of ${usd(allowance)}. ${band.label}.` });
    for (const t of findUnlogged(inp.weekTxs, inp.logs)) {
      events.push({ kind: 'unlogged', delta: -5, reason: `${usd(t.amountUsd)} at ${t.payee} on ${formatDate(t.date)} wasn't written down first.` });
    }
  }

  if (inp.savings) {
    const { month, saved, target } = inp.savings;
    const ok = saved + 0.005 >= target;
    if (!late) {
      events.push({
        kind: 'savings',
        delta: ok ? 10 : -30,
        reason: ok
          ? `Savings for ${month}: ${usd(saved)} moved by the 3rd (target ${usd(target)}).`
          : `Savings for ${month}: only ${usd(saved)} proven moved by the 3rd (target ${usd(target)}).${dataOk ? '' : ' Statements are missing — if you did save, upload them late to get this back.'}`,
      });
    } else if (ok && (inp.savingsPenaltyAtDeadline ?? 0) < 0) {
      // Late statements prove the savings were moved on time: give the penalty back (no bonus for being late).
      events.push({ kind: 'savings', delta: -(inp.savingsPenaltyAtDeadline as number), reason: `Savings for ${month}: late statements prove ${usd(saved)} was moved by the 3rd. Penalty refunded.` });
    }
  }
  return { events, dataOk };
}

export interface ApplyResult {
  events: Omit<ScoreEvent, 'id'>[];
  health: number;
  creatureId: number;
  died: { creatureId: number; at: number } | null;
}

/** Apply a week's events in order, clamping 0–100. At 0 he dies and a new sprout starts at 40. */
/**
 * `halveAtMs` decides the grace period: a missed week from before 29 Nov keeps its halving even if its
 * statements arrive after that date. It defaults to `atMs`.
 */
export function applyEvents(raw: RawEvent[], health: number, creatureId: number, weekStart: string, atMs: number, halveBefore: string, halveAtMs = atMs): ApplyResult {
  const out: Omit<ScoreEvent, 'id'>[] = [];
  let h = health;
  for (const e of raw) {
    const delta = adjustDelta(e.delta, halveAtMs, halveBefore);
    const halved = delta !== e.delta;
    h = Math.max(0, Math.min(100, h + delta));
    out.push({ ...e, delta, reason: halved ? `${e.reason} (halved: grace period)` : e.reason, creatureId, weekStart, at: atMs, healthAfter: h });
    if (h === 0) {
      out.push({ kind: 'death', delta: 0, reason: `Died. ${usd(DEATH_SAVINGS_PENALTY)} extra to savings next payday.`, creatureId, weekStart, at: atMs, healthAfter: 0 });
      return { events: out, health: REBIRTH_HEALTH, creatureId: creatureId + 1, died: { creatureId, at: atMs } };
    }
  }
  return { events: out, health: h, creatureId, died: null };
}

export function dueWeeks(scoringStart: string, nowMs: number, evaluated: Set<string>): string[] {
  const out: string[] = [];
  if (!scoringStart) return out;
  for (let w = scoringStart; weekDeadline(w) <= nowMs; w = addDays(w, 7)) if (!evaluated.has(w)) out.push(w);
  return out;
}

export type Look = 'thriving' | 'fine' | 'tired' | 'wilting' | 'failing' | 'dead';

export function lookFor(health: number): Look {
  if (health <= 0) return 'dead';
  if (health < 20) return 'failing';
  if (health < 40) return 'wilting';
  if (health < 60) return 'tired';
  if (health < 80) return 'fine';
  return 'thriving';
}
