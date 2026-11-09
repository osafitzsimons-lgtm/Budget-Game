import { describe, expect, it } from 'vitest';
import { ppInstant, weekDeadline } from '../src/shared/dates';
import { accountStatus, adjustDelta, applyEvents, canEvaluateEarly, dueWeeks, evaluateWeek, findUnlogged, lookFor, negotiableSpend, penaltyMonth, savedInWindow, savingsMonthForWeek, spendBand, type ScoredTx, type WeekInput } from '../src/shared/scoring';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { LogEntry } from '../src/shared/types';

const tx = (o: Partial<ScoredTx>): ScoredTx => ({ hash: Math.random().toString(16), accountId: 'ABA-812', date: '2026-12-08', payee: 'Shop', amountUsd: 10, category: 'Eating out and bars', isCash: false, savings: false, ...o });
const log = (o: Partial<LogEntry>): LogEntry => ({ id: Math.random().toString(16), createdAt: ppInstant('2026-12-07', 10), date: '2026-12-07', amountUsd: 40, what: 'x', why: '', kind: 'planned', category: null, urgent: false, cashTxHash: null, ...o });
const settings = { ...DEFAULT_SETTINGS, scoringStart: '2026-11-08' };
const evw = (i: WeekInput) => evaluateWeek(i).events;

describe('spend bands (allowance $161)', () => {
  const cases: [number, number][] = [[0, 15], [128.8, 15], [128.81, 8], [161, 8], [161.01, -10], [193.2, -10], [193.21, -20], [241.5, -20], [241.51, -35], [1000, -35], [-20, 15]];
  for (const [spend, delta] of cases) it(`$${spend} → ${delta}`, () => expect(spendBand(spend, 161).delta).toBe(delta));
});

describe('halving before 29 Nov 2026', () => {
  it('halves negatives (towards zero) only before the date', () => {
    const before = ppInstant('2026-11-22', 20);
    const on = ppInstant('2026-11-29', 20);
    expect(adjustDelta(-25, before, '2026-11-29')).toBe(-12);
    expect(adjustDelta(-35, before, '2026-11-29')).toBe(-17);
    expect(adjustDelta(-5, before, '2026-11-29')).toBe(-2);
    expect(adjustDelta(15, before, '2026-11-29')).toBe(15);
    expect(adjustDelta(-25, on, '2026-11-29')).toBe(-25);
  });
});

describe('week evaluation', () => {
  const week = '2026-12-06';
  const input = (o: Partial<WeekInput> = {}): WeekInput => ({
    weekStart: week, atMs: weekDeadline(week), mode: 'deadline', requiredAccountIds: ['ABA-812'],
    uploads: [{ accountId: 'ABA-812', uploadedAt: ppInstant('2026-12-13', 9), periodEnd: '2026-12-12', ok: true }],
    weekTxs: [], logs: [], settings, savings: null, ...o,
  });

  it('no valid upload by the deadline: -25 once, no spend score', () => {
    const ev = evw(input({ uploads: [], requiredAccountIds: ['ABA-812', 'REV-554'] }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'missing-upload', delta: -25 });
  });
  it('an upload after the deadline does not count', () => {
    const ev = evw(input({ uploads: [{ accountId: 'ABA-812', uploadedAt: weekDeadline(week) + 1000, periodEnd: '2026-12-12', ok: true }] }));
    expect(ev[0].kind).toBe('missing-upload');
  });
  it('proof check still failing at the deadline: -25', () => {
    const ev = evw(input({ uploads: [{ accountId: 'ABA-812', uploadedAt: ppInstant('2026-12-13', 9), periodEnd: '2026-12-12', ok: false }] }));
    expect(ev).toEqual([expect.objectContaining({ kind: 'proof-failing', delta: -25 })]);
  });
  it('scores spending and ignores committed/excluded categories', () => {
    const ev = evw(input({ weekTxs: [tx({ amountUsd: 100 }), tx({ amountUsd: 500, category: 'Rent and bills' }), tx({ amountUsd: 900, category: 'Transfer' })] }));
    expect(ev.find((e) => e.kind === 'spend')!.delta).toBe(15); // 100/161 = 62%
  });
  it('friends paying back reduce spending', () => {
    expect(negotiableSpend([tx({ amountUsd: 200 }), tx({ amountUsd: -60, category: 'Friends paying back' })], [])).toBe(140);
  });
  it('cash counts when withdrawn unless logged as non-negotiable', () => {
    const w = tx({ hash: 'cash1', amountUsd: 100, category: 'Unidentified', isCash: true });
    expect(negotiableSpend([w], [])).toBe(100);
    expect(negotiableSpend([w], [log({ kind: 'cash', cashTxHash: 'cash1', amountUsd: 70, category: 'Rent and bills' })])).toBe(30);
    expect(negotiableSpend([w], [log({ kind: 'cash', cashTxHash: 'cash1', amountUsd: 70, category: 'Food shop' })])).toBe(100);
  });
  it('$30+ negotiable with no prior log within $2 and 2 days: -5 each', () => {
    const t1 = tx({ amountUsd: 41, date: '2026-12-08', payee: 'Bar' });
    const t2 = tx({ amountUsd: 35, date: '2026-12-09', payee: 'Shoes', category: 'Clothes and kit' });
    const t3 = tx({ amountUsd: 29.99, date: '2026-12-09' });
    const t4 = tx({ amountUsd: 31, date: '2026-12-09', category: 'Rent and bills' });
    const logs = [log({ amountUsd: 40, date: '2026-12-07' })]; // matches t1 (within $2, 1 day before)
    expect(findUnlogged([t1, t2, t3, t4], logs).map((t) => t.payee)).toEqual(['Shoes']);
    // too early (3 days before), too different, or written after spending → no match
    expect(findUnlogged([t1], [log({ amountUsd: 40, date: '2026-12-05' })])).toHaveLength(1);
    expect(findUnlogged([t1], [log({ amountUsd: 38.9, date: '2026-12-08' })])).toHaveLength(1);
    expect(findUnlogged([t1], [log({ amountUsd: 41, date: '2026-12-08', createdAt: ppInstant('2026-12-09', 9) })])).toHaveLength(1);
    const ev = evw(input({ weekTxs: [t1, t2], logs }));
    expect(ev.filter((e) => e.kind === 'unlogged')).toEqual([expect.objectContaining({ delta: -5 })]);
  });
  it('savings moved by the 3rd: +10, otherwise -30', () => {
    expect(savingsMonthForWeek('2026-11-29')).toBe('2026-12');
    expect(savingsMonthForWeek('2026-12-06')).toBeNull();
    const ok = evw(input({ savings: { month: '2026-12', saved: 500, target: 500 } }));
    expect(ok.find((e) => e.kind === 'savings')!.delta).toBe(10);
    const no = evw(input({ savings: { month: '2026-12', saved: 499, target: 500 } }));
    expect(no.find((e) => e.kind === 'savings')!.delta).toBe(-30);
  });
  it('counts savings into the nominated account', () => {
    const txs = [tx({ amountUsd: 300, category: 'Transfer', savings: true, date: '2026-11-28' }), tx({ amountUsd: 250, category: 'Transfer', savings: true, date: '2026-12-03' }), tx({ amountUsd: 999, category: 'Transfer', savings: true, date: '2026-12-04' })];
    expect(savedInWindow(txs, '2026-11-25', '2026-12-03', 'ABA-811', false)).toBe(550);
    const into = [tx({ accountId: 'ABA-811', amountUsd: -500, category: 'Transfer', date: '2026-12-01' })];
    expect(savedInWindow(into, '2026-11-25', '2026-12-03', 'ABA-811', true)).toBe(500);
  });
  it('a week only counts as covered if statements start by its Sunday (except the first scored week)', () => {
    const ups = [{ accountId: 'REV-554', uploadedAt: 1, periodStart: '2026-12-01', periodEnd: '2026-12-12', ok: true }];
    expect(accountStatus(ups, 'REV-554', '2026-11-21', 2, '2026-11-15')).toBe('missing'); // baseline started after that week
    expect(accountStatus(ups, 'REV-554', '2026-12-12', 2, '2026-12-06')).toBe('ok');
    expect(accountStatus(ups, 'REV-554', '2026-12-05', 2)).toBe('ok'); // first scored week: no start rule
  });
  it('account status and early scoring', () => {
    const ups = [{ accountId: 'ABA-812', uploadedAt: 1, periodEnd: '2026-12-12', ok: true }];
    expect(accountStatus(ups, 'ABA-812', '2026-12-12', 2)).toBe('ok');
    expect(accountStatus(ups, 'REV-554', '2026-12-12', 2)).toBe('missing');
    expect(canEvaluateEarly(week, ppInstant('2026-12-12', 23), ['ABA-812'], ups)).toBe(false); // week not over
    expect(canEvaluateEarly(week, ppInstant('2026-12-13', 9), ['ABA-812'], ups)).toBe(true);
    expect(canEvaluateEarly(week, ppInstant('2026-12-13', 9), ['ABA-812', 'REV-554'], ups)).toBe(false);
  });
  it('due weeks are those whose Sunday 8pm deadline has passed', () => {
    expect(dueWeeks('2026-11-08', ppInstant('2026-11-15', 19, 59), new Set())).toEqual([]);
    expect(dueWeeks('2026-11-08', ppInstant('2026-11-15', 20, 0), new Set())).toEqual(['2026-11-08']);
    expect(dueWeeks('2026-11-08', ppInstant('2026-11-30', 9), new Set(['2026-11-08']))).toEqual(['2026-11-15', '2026-11-22']);
  });
});

describe('health', () => {
  it('starts at 70, clamps at 100', () => {
    const r = applyEvents([{ kind: 'spend', delta: 15, reason: '' }, { kind: 'savings', delta: 10, reason: '' }, { kind: 'spend', delta: 15, reason: '' }], 70, 1, '2026-12-06', ppInstant('2026-12-13', 20), '2026-11-29');
    expect(r.events.map((e) => e.healthAfter)).toEqual([85, 95, 100]);
  });
  it('dies at 0, a new sprout starts at 40, and $25 goes to next savings', () => {
    const at = ppInstant('2026-12-13', 20);
    const r = applyEvents([{ kind: 'spend', delta: -35, reason: '' }, { kind: 'unlogged', delta: -5, reason: '' }], 20, 1, '2026-12-06', at, '2026-11-29');
    expect(r.died).toEqual({ creatureId: 1, at });
    expect(r.health).toBe(40);
    expect(r.creatureId).toBe(2);
    expect(r.events.map((e) => e.kind)).toEqual(['spend', 'death']);
    expect(penaltyMonth('2026-12-13')).toBe('2027-01');
    expect(penaltyMonth('2026-12-02')).toBe('2026-12');
  });
  it('a late-scored week keeps the grace-period halving of its own deadline', () => {
    const late = applyEvents([{ kind: 'spend', delta: -20, reason: '' }], 70, 1, '2026-11-15', ppInstant('2026-12-02', 9), '2026-11-29', weekDeadline('2026-11-15'));
    expect(late.events[0].delta).toBe(-10);
  });
  it('with no required accounts, a week is never a free +15', () => {
    const ev = evaluateWeek({ weekStart: '2026-12-06', atMs: weekDeadline('2026-12-06'), mode: 'deadline', requiredAccountIds: [], uploads: [], weekTxs: [], logs: [], settings, savings: null }).events;
    expect(ev).toEqual([expect.objectContaining({ kind: 'missing-upload', delta: -25 })]);
  });
  it('looks by health band', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 20, 19, 1, 0].map(lookFor)).toEqual(['thriving', 'thriving', 'fine', 'fine', 'tired', 'tired', 'wilting', 'wilting', 'failing', 'failing', 'dead']);
  });
});
