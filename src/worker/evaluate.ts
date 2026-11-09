// Works out missed deadlines whenever the app is opened (no cron jobs), and scores
// a finished week early once every required statement is in.
import { addDays, ppDate, weekDeadline, weekEnd } from '../shared/dates';
import {
  applyEvents,
  canEvaluateEarly,
  dueWeeks,
  evaluateWeek,
  penaltyMonth,
  REBIRTH_HEALTH,
  savedInWindow,
  savingsMonthForWeek,
  savingsWindow,
  DEATH_SAVINGS_PENALTY,
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

/** Weeks that can be scored now: deadline passed, or (early) the week is over and every statement is in. */
export function weeksToScore(ctx: Pick<EvalContext, 'now' | 'settings' | 'accounts' | 'uploads' | 'evaluated'>): { week: string; early: boolean }[] {
  const out = dueWeeks(ctx.settings.scoringStart, ctx.now, ctx.evaluated).map((w) => ({ week: w, early: false }));
  if (!ctx.settings.scoringStart) return out;
  const required = ctx.accounts.filter((a) => a.active && !a.optional).map((a) => a.id);
  // The most recent finished week whose deadline hasn't passed yet.
  let w = ctx.settings.scoringStart;
  while (weekDeadline(w) <= ctx.now) w = addDays(w, 7);
  if (!ctx.evaluated.has(w) && !out.some((x) => x.week === w) && canEvaluateEarly(w, ctx.now, required, ctx.uploads)) out.push({ week: w, early: true });
  return out;
}

export async function scoreDueWeeks(ctx: EvalContext): Promise<EvalOutcome | null> {
  const todo = weeksToScore(ctx);
  if (!todo.length) return null;
  const { db, settings } = ctx;
  const required = ctx.accounts.filter((a) => a.active && !a.optional).map((a) => a.id);
  const first = todo[0].week;
  const last = weekEnd(todo[todo.length - 1].week);
  const savingsFrom = addDays(first, -45);

  const [txRes, logRes] = await db.batch([
    db.prepare(`SELECT * FROM transactions WHERE source = 'pdf' AND date >= ?1 AND date <= ?2`).bind(savingsFrom, last),
    db.prepare(`SELECT * FROM logs WHERE date >= ?1`).bind(addDays(first, -2)),
  ]);
  const txs: ScoredTx[] = (txRes.results as Record<string, unknown>[]).map(rowToTx);
  const logs: LogEntry[] = (logRes.results as Record<string, unknown>[]).map(rowToLog);
  const savingsTracked = !!settings.savingsAccountId && ctx.uploads.some((u) => u.accountId === settings.savingsAccountId && u.ok);

  let health = ctx.creature.health;
  let creatureId = ctx.creature.id;
  const before = health;
  const events: Omit<ScoreEvent, 'id'>[] = [];
  const deaths = [...ctx.deaths];
  const stmts: D1PreparedStatement[] = [];
  let died = false;

  for (const { week, early } of todo) {
    const at = early ? ctx.now : weekDeadline(week);
    const end = weekEnd(week);
    // Logs for the -5 rule must have been written before the deadline/evaluation.
    const logsAtTime = logs.filter((l) => l.createdAt <= at);
    let savings: { month: string; saved: number; target: number } | null = null;
    const month = savingsMonthForWeek(week);
    if (month && `${month}-03` >= settings.scoringStart) {
      const win = savingsWindow(month, settings.savingsWindowStartDay);
      const extra = deaths.filter((d) => penaltyMonth(ppDate(d.diedAt)) === month).length * DEATH_SAVINGS_PENALTY;
      savings = {
        month,
        saved: savedInWindow(txs, win.from, win.to, settings.savingsAccountId, savingsTracked),
        target: phaseValue(settings.savingsTarget, `${month}-01`) + extra,
      };
    }
    const raw = evaluateWeek({
      weekStart: week,
      atMs: at,
      early,
      requiredAccountIds: required,
      uploads: ctx.uploads,
      weekTxs: txs.filter((t) => t.date >= week && t.date <= end),
      logs: logsAtTime,
      settings,
      savings,
    });
    const applied = applyEvents(raw, health, creatureId, week, at, settings.halveNegativesBefore);
    events.push(...applied.events);
    stmts.push(db.prepare(`INSERT INTO week_evals (week_start, evaluated_at, early) VALUES (?1, ?2, ?3)`).bind(week, ctx.now, early ? 1 : 0));
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
