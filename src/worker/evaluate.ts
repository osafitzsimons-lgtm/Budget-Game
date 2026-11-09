// Works out missed deadlines whenever the app is opened (no cron jobs), scores a finished
// week early once every required statement is in, and scores missed weeks when their
// statements arrive late.
import { addDays, ppDate, weekDeadline, weekEnd } from '../shared/dates';
import {
  allStatementsIn,
  applyEvents,
  canEvaluateEarly,
  DEATH_SAVINGS_PENALTY,
  dueWeeks,
  type EvalMode,
  evaluateWeek,
  penaltyMonth,
  REBIRTH_HEALTH,
  savedInWindow,
  savingsMonthForWeek,
  savingsWindow,
  type ScoredTx,
  type UploadRecord,
} from '../shared/scoring';
import { phaseValue, type Settings } from '../shared/settings';
import type { LogEntry, ScoreEvent } from '../shared/types';
import { type DbAccount, type DbCreature, rowToLog, rowToTx } from './db';

export interface EvalContext {
  db: D1Database;
  now: number;
  settings: Settings;
  accounts: DbAccount[];
  uploads: UploadRecord[];
  evaluated: Set<string>;
  awaitingLate: Set<string>;
  creature: DbCreature;
  deaths: { diedAt: number }[];
}

export interface EvalOutcome {
  before: number;
  after: number;
  events: Omit<ScoreEvent, 'id'>[];
  weeks: string[];
  died: boolean;
}

/**
 * Transactions that count for scoring: statement rows, plus spending added by hand. Hand-added money in
 * never offsets spending (there's no proof of it), and the CSV history never counts.
 */
export const SCORED_SOURCES = `(source = 'pdf' OR (source = 'manual' AND amount_usd > 0))`;

export function requiredIds(accounts: DbAccount[]): string[] {
  return accounts.filter((a) => a.active && !a.optional).map((a) => a.id);
}

/** Weeks that can be scored now, oldest first. */
export function weeksToScore(ctx: Pick<EvalContext, 'now' | 'settings' | 'accounts' | 'uploads' | 'evaluated' | 'awaitingLate'>): { week: string; mode: EvalMode }[] {
  if (!ctx.settings.scoringStart) return [];
  const required = requiredIds(ctx.accounts);
  const out: { week: string; mode: EvalMode }[] = [];
  // Missed weeks whose statements have now arrived.
  for (const w of [...ctx.awaitingLate].sort()) if (allStatementsIn(w, ctx.now, required, ctx.uploads, ctx.settings.scoringStart)) out.push({ week: w, mode: 'late' });
  for (const w of dueWeeks(ctx.settings.scoringStart, ctx.now, ctx.evaluated)) out.push({ week: w, mode: 'deadline' });
  // The most recent finished week whose deadline hasn't passed yet.
  let w = ctx.settings.scoringStart;
  while (weekDeadline(w) <= ctx.now) w = addDays(w, 7);
  if (!ctx.evaluated.has(w) && canEvaluateEarly(w, ctx.now, required, ctx.uploads, ctx.settings.scoringStart)) out.push({ week: w, mode: 'early' });
  // In the order they happen: deadline penalties at their deadlines, then early/late scores "now".
  const at = (x: { week: string; mode: EvalMode }) => (x.mode === 'deadline' ? weekDeadline(x.week) : ctx.now);
  return out.sort((a, b) => at(a) - at(b) || (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
}

export async function scoreDueWeeks(ctx: EvalContext): Promise<EvalOutcome | null> {
  const todo = weeksToScore(ctx);
  if (!todo.length) return null;
  const { db, settings } = ctx;
  const required = requiredIds(ctx.accounts);
  const weeks = todo.map((t) => t.week).sort();
  const first = weeks[0];
  const last = weekEnd(weeks[weeks.length - 1]);
  const savingsFrom = addDays(first, -45);

  const lateWeeks = todo.filter((t) => t.mode === 'late').map((t) => t.week);
  const [txRes, logRes, savRes] = await db.batch([
    db.prepare(`SELECT * FROM transactions WHERE ${SCORED_SOURCES} AND date >= ?1 AND date <= ?2`).bind(savingsFrom, last),
    db.prepare(`SELECT * FROM logs WHERE date >= ?1`).bind(addDays(first, -2)),
    db.prepare(`SELECT week_start, SUM(delta) AS d FROM score_events WHERE kind = 'savings' AND week_start IN (SELECT value FROM json_each(?1)) GROUP BY week_start`).bind(JSON.stringify(lateWeeks)),
  ]);
  const txs: ScoredTx[] = (txRes.results as Record<string, unknown>[]).map(rowToTx);
  const logs: LogEntry[] = (logRes.results as Record<string, unknown>[]).map(rowToLog);
  const savingsGiven = new Map((savRes.results as { week_start: string; d: number }[]).map((r) => [r.week_start, Number(r.d)]));
  const savingsTracked = !!settings.savingsAccountId && ctx.uploads.some((u) => u.accountId === settings.savingsAccountId && u.ok);

  let health = ctx.creature.health;
  let creatureId = ctx.creature.id;
  const before = health;
  const events: Omit<ScoreEvent, 'id'>[] = [];
  const deaths = [...ctx.deaths];
  const stmts: D1PreparedStatement[] = [];
  let died = false;

  for (const { week, mode } of todo) {
    const at = mode === 'deadline' ? weekDeadline(week) : ctx.now;
    const end = weekEnd(week);
    // "Write it down" entries count only if written before the deadline (or before an early score).
    const logCutoff = mode === 'late' ? weekDeadline(week) : at;
    const logsAtTime = logs.filter((l) => l.createdAt <= logCutoff);
    let savings: { month: string; saved: number; target: number } | null = null;
    const month = savingsMonthForWeek(week);
    if (month && `${month}-03` >= settings.scoringStart) {
      const win = savingsWindow(month, settings.savingsWindowStartDay);
      const extra = deaths.filter((d) => penaltyMonth(ppDate(d.diedAt)) === month && d.diedAt < at).length * DEATH_SAVINGS_PENALTY;
      savings = {
        month,
        saved: savedInWindow(txs, win.from, win.to, settings.savingsAccountId, savingsTracked),
        target: phaseValue(settings.savingsTarget, `${month}-01`) + extra,
      };
    }
    const result = evaluateWeek({
      weekStart: week,
      atMs: at,
      mode,
      requiredAccountIds: required,
      uploads: ctx.uploads,
      weekTxs: txs.filter((t) => t.date >= week && t.date <= end),
      logs: logsAtTime,
      settings,
      savings,
      savingsPenaltyAtDeadline: savingsGiven.get(week),
    });
    const applied = applyEvents(result.events, health, creatureId, week, at, settings.halveNegativesBefore, mode === 'late' ? weekDeadline(week) : at);
    events.push(...applied.events);
    if (mode === 'late') {
      stmts.push(db.prepare(`INSERT INTO late_evals (week_start, evaluated_at) VALUES (?1, ?2)`).bind(week, ctx.now));
    } else {
      stmts.push(db.prepare(`INSERT INTO week_evals (week_start, evaluated_at, early, data_ok) VALUES (?1, ?2, ?3, ?4)`).bind(week, ctx.now, mode === 'early' ? 1 : 0, result.dataOk ? 1 : 0));
    }
    if (applied.died) {
      died = true;
      deaths.push({ diedAt: at });
      stmts.push(db.prepare(`UPDATE creatures SET died_at = ?1, health = 0 WHERE id = ?2`).bind(at, creatureId));
      stmts.push(db.prepare(`INSERT INTO creatures (id, name, born_at, died_at, start_health, health) VALUES (?1, ?2, ?3, NULL, ?4, ?4)`).bind(applied.creatureId, settings.creatureName, at, REBIRTH_HEALTH));
      events.push({ creatureId: applied.creatureId, weekStart: week, kind: 'birth', delta: 0, reason: `A new sprout starts at ${REBIRTH_HEALTH}.`, at, healthAfter: REBIRTH_HEALTH });
    }
    health = applied.health;
    creatureId = applied.creatureId;
  }
  stmts.push(db.prepare(`UPDATE creatures SET health = ?1 WHERE id = ?2`).bind(health, creatureId));
  if (events.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO score_events (creature_id, week_start, kind, delta, reason, at, health_after)
           SELECT json_extract(value,'$.c'), json_extract(value,'$.w'), json_extract(value,'$.k'), json_extract(value,'$.d'), json_extract(value,'$.r'), json_extract(value,'$.a'), json_extract(value,'$.h') FROM json_each(?1)`,
        )
        .bind(JSON.stringify(events.map((e) => ({ c: e.creatureId, w: e.weekStart, k: e.kind, d: e.delta, r: e.reason, a: e.at, h: e.healthAfter })))),
    );
  }
  try {
    await db.batch(stmts); // one transaction; fails as a whole if another request scored these weeks first
  } catch (e) {
    if (String(e).includes('UNIQUE')) return null;
    throw e;
  }
  return { before, after: health, events, weeks: todo.map((t) => t.week), died };
}
