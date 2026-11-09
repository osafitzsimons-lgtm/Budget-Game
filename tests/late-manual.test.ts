// Late uploads, savings refunds, hand-added transactions and settings hardening, end to end against local D1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { addDays, ppInstant } from '../src/shared/dates';
import { contextFrom, prepareStatement } from '../src/shared/statement';
import { _resetSchemaFlag } from '../src/worker/db';
import { handleApi } from '../src/worker/index';
import { parsePdf } from './helpers/pdf';
import { abaStatement, revolutStatement, type SynthRow } from './helpers/statements';

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Record<string, unknown>;
beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  env = { DB: proxy.env.DB, LOCAL_DEV: 'true', ASSETS: {} };
  _resetSchemaFlag();
});
afterAll(async () => proxy?.dispose());

const BASE = 'http://localhost:8787';
async function call(method: string, path: string, now: number, body?: unknown) {
  const res = await handleApi(new Request(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, now);
  return { status: res.status, body: (await res.json()) as any };
}
const state = async (now: number) => (await call('GET', '/api/state', now)).body;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const abaD = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${d.slice(8)}, ${d.slice(0, 4)}`;
const revD = (d: string) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const longD = (d: string) => `${+d.slice(8)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

// Running balances so each new statement chains from the last one.
const bal: Record<string, number> = { '812': 1000, '013': 200, '554': 500 };
type R = { date: string; desc: string; out?: number; in?: number };
function stmt(acct: '812' | '013' | '554', from: string, to: string, rows: R[]) {
  const opening = bal[acct];
  for (const r of rows) bal[acct] = Math.round((bal[acct] + (r.in ?? 0) - (r.out ?? 0)) * 100) / 100;
  if (acct === '554') {
    return revolutStatement({ accountNumber: '00000554', sections: [{ opening, from: longD(from), to: longD(to), rows: rows.map((r): SynthRow => ({ date: revD(r.date), desc: [r.desc], out: r.out, in: r.in })) }] });
  }
  return abaStatement({ accountNumber: `000 000 ${acct}`, opening, period: `${abaD(from)} - ${abaD(to)}`, rows: rows.map((r): SynthRow => ({ date: abaD(r.date), desc: [r.desc], out: r.out, in: r.in })) });
}
async function upload(pdf: Uint8Array, now: number, fxOverride?: number) {
  const s = await state(now);
  const parsed = await parsePdf(pdf);
  const acct = s.accounts.find((a: any) => a.bank === parsed.bank && a.last3 === parsed.accountLast3);
  const prep = await prepareStatement(parsed, acct.id, fxOverride ?? s.settings.fxGbpUsd, contextFrom(s.rules, s.accounts, s.settings));
  return call('POST', '/api/uploads/confirm', now, { statement: prep.summary, rows: prep.rows, rules: [] });
}
const kinds = (events: any[]) => events.map((e) => [e.kind, e.delta]);

describe('late uploads', () => {
  it('sets up and scores the first week on time', async () => {
    await state(ppInstant('2026-11-09', 10));
    const t = ppInstant('2026-11-15', 9);
    await upload(stmt('812', '2026-11-01', '2026-11-14', [{ date: '2026-11-10', desc: 'CAFE', out: 20 }]), t);
    await upload(stmt('013', '2026-11-01', '2026-11-14', []), t);
    const r = await upload(stmt('554', '2026-11-01', '2026-11-14', [{ date: '2026-11-12', desc: 'Shop', out: 5 }]), t);
    expect(kinds(r.body.events)).toEqual([['spend', 15]]);
  });

  it('a missed week takes -25 at the deadline and waits for late statements', async () => {
    const s = await state(ppInstant('2026-11-23', 8));
    expect(kinds(s.events.filter((e: any) => e.weekStart === '2026-11-15'))).toEqual([['missing-upload', -12]]); // halved before 29 Nov
    expect(s.awaitingLate).toEqual([{ weekStart: '2026-11-15', weekEnd: '2026-11-21', needed: ['ABA-812', 'ABA-013', 'REV-554'] }]);
  });

  it('late statements get the missed week scored (spending and unlogged), once', async () => {
    const t = ppInstant('2026-11-24', 9);
    const a = await upload(stmt('812', '2026-11-15', '2026-11-23', [{ date: '2026-11-16', desc: 'BIG DINNER', out: 200 }]), t);
    expect(a.body.events).toEqual([]);
    expect((await state(t)).awaitingLate[0].needed).toEqual(['ABA-013', 'REV-554']);
    await upload(stmt('013', '2026-11-15', '2026-11-23', []), t);
    const c = await upload(stmt('554', '2026-11-15', '2026-11-23', []), t);
    // $200 of $161 = 124% → -20, halved to -10; $200 not written down → -5, halved to -2
    expect(kinds(c.body.events)).toEqual([['spend', -10], ['unlogged', -2]]);
    expect(c.body.events[0].reason).toMatch(/late statements/);
    const s = await state(ppInstant('2026-11-24', 10));
    expect(s.awaitingLate).toEqual([]);
    expect(s.events.filter((e: any) => e.weekStart === '2026-11-15')).toHaveLength(3);
  });

  it('missed savings are refunded when late statements prove they were moved by the 3rd', async () => {
    await call('POST', '/api/settings', ppInstant('2026-11-25', 9), { settings: { ...(await state(ppInstant('2026-11-25', 9))).settings, savingsKeywords: ['SAVINGS POT'] } });
    // Week 22–28 Nov: on time, nothing spent
    const t1 = ppInstant('2026-11-29', 10);
    await upload(stmt('812', '2026-11-24', '2026-11-28', []), t1);
    await upload(stmt('013', '2026-11-24', '2026-11-28', []), t1);
    const w = await upload(stmt('554', '2026-11-24', '2026-11-28', []), t1);
    expect(kinds(w.body.events)).toEqual([['spend', 15]]);
    // Week 29 Nov–5 Dec (contains the 3rd) is missed: -25 and -30 (no proof of savings)
    const missed = await state(ppInstant('2026-12-07', 8));
    expect(kinds(missed.events.filter((e: any) => e.weekStart === '2026-11-29').sort((a: any, b: any) => a.id - b.id))).toEqual([['missing-upload', -25], ['savings', -30]]);
    // Late statements show $500 moved to savings on 1 Dec. 013's first statement is older than last Saturday: still saved.
    const t2 = ppInstant('2026-12-08', 9);
    await upload(stmt('812', '2026-11-29', '2026-12-07', [{ date: '2026-12-01', desc: 'TRANSFER TO SAVINGS POT', out: 500 }]), t2);
    const old = await upload(stmt('013', '2026-11-29', '2026-12-03', []), t2);
    expect(old.body.stored).toBe(true);
    expect(old.body.proof.covers).toBe(false);
    await upload(stmt('013', '2026-12-04', '2026-12-07', []), t2);
    const r = await upload(stmt('554', '2026-11-29', '2026-12-07', []), t2);
    expect(kinds(r.body.events)).toEqual([['spend', 15], ['savings', 30]]);
  });

  it('re-uploading an old statement adds nothing and is not a failure', async () => {
    const pdf = abaStatement({ accountNumber: '000 000 013', opening: 200, period: 'Nov 01, 2026 - Nov 14, 2026', rows: [] });
    // 013's first statement had no rows: re-upload is a zero-row statement, compared on dates only
    const r = await upload(pdf, ppInstant('2026-12-08', 10));
    expect(r.status).toBe(200);
  });

  it('refuses a GBP statement converted at a different rate than Settings', async () => {
    const r = await upload(stmt('554', '2026-12-08', '2026-12-08', [{ date: '2026-12-08', desc: 'X', out: 1 }]), ppInstant('2026-12-09', 9), 1.5);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rate changed/);
    bal['554'] += 1; // undo the running balance used by the refused statement
  });
});

describe('older history uploaded after newer statements', () => {
  it('an Oct statement ending at the balance the first Nov statement opened with is filled in', async () => {
    const pdf = abaStatement({ accountNumber: '000 000 812', opening: 1100, period: 'Oct 01, 2026 - Oct 31, 2026', rows: [{ date: 'Oct 10, 2026', desc: ['OLD SHOP'], out: 100 }] });
    const r = await upload(pdf, ppInstant('2026-12-09', 11));
    expect(r.body.stored).toBe(true);
    expect(r.body.inserted).toBe(1);
    expect(r.body.proof.covers).toBe(false);
  });
  it('one that does not join up is refused and saves nothing', async () => {
    const pdf = abaStatement({ accountNumber: '000 000 812', opening: 900, period: 'Sep 01, 2026 - Sep 30, 2026', rows: [{ date: 'Sep 10, 2026', desc: ['OLDER SHOP'], out: 100 }] });
    const r = await upload(pdf, ppInstant('2026-12-09', 11));
    expect(r.body.stored).toBe(false);
  });
});

describe('transactions added by hand', () => {
  const now = ppInstant('2026-12-09', 12);
  it('count in this week’s spending and show in History', async () => {
    const before = (await state(now)).week.spent;
    const r = await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'Dinner paid on a friend’s card', amountUsd: 50, category: 'Eating out and bars' });
    expect(r.status).toBe(200);
    const s = await state(now);
    expect(s.week.spent).toBe(before + 50);
    expect(s.manual[0]).toMatchObject({ payee: 'Dinner paid on a friend’s card', amountUsd: 50 });
    const h = await call('GET', '/api/history', now);
    expect(h.body.rows.some((x: any[]) => x[2] === 'manual')).toBe(true);
  });
  it('count towards the week’s score at the deadline', async () => {
    const t = ppInstant('2026-12-13', 21); // after the 13 Dec 20:00 deadline for 6–12 Dec
    const s = await state(t);
    const ev = s.events.filter((e: any) => e.weekStart === '2026-12-06');
    expect(kinds(ev)).toEqual([['missing-upload', -25]]); // no statements uploaded for that week
  });
  it('money in is only allowed for friends paying back or transfers', async () => {
    expect((await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'Refund', amountUsd: -500, category: 'Eating out and bars' })).status).toBe(400);
    const before = (await state(now)).week.spent;
    expect((await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'Mate paid back', amountUsd: -10, category: 'Friends paying back' })).status).toBe(200);
    // Recorded for History, but money in without a statement never reduces spending
    expect((await state(now)).week.spent).toBe(before);
  });
  it('can never count as savings', async () => {
    const r = await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'To savings', amountUsd: 900, category: 'Transfer', savings: true });
    expect(r.status).toBe(200);
    expect((await state(now)).manual.find((m: any) => m.hash === r.body.hash).savings).toBe(false);
  });
  it('rejects future dates, zero and junk', async () => {
    expect((await call('POST', '/api/transactions', now, { date: '2026-12-10', payee: 'x', amountUsd: 5, category: 'Sport' })).status).toBe(400);
    expect((await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'x', amountUsd: 0, category: 'Sport' })).status).toBe(400);
    expect((await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'x', amountUsd: 5, category: 'Beer' })).status).toBe(400);
  });
  it('can be deleted within a day, not after', async () => {
    const r = await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'Oops', amountUsd: 3, category: 'Sport' });
    expect((await call('DELETE', `/api/transactions/${r.body.hash}`, now + 3600e3)).status).toBe(200);
    const r2 = await call('POST', '/api/transactions', now, { date: '2026-12-09', payee: 'Keep', amountUsd: 3, category: 'Sport' });
    expect((await call('DELETE', `/api/transactions/${r2.body.hash}`, now + 25 * 3600e3)).status).toBe(400);
  });
  it('masks account numbers typed into the payee', async () => {
    const later = now + 60e3;
    const r = await call('POST', '/api/transactions', later, { date: '2026-12-09', payee: 'Paid to 000 123 456 789', amountUsd: 3, category: 'Sport' });
    expect(r.status).toBe(200);
    expect((await state(later)).manual[0].payee).toBe('Paid to •••789');
  });
});

describe('settings hardening', () => {
  it('ignores unknown keys and keeps fixed values', async () => {
    const now = ppInstant('2026-12-09', 13);
    const s = (await state(now)).settings;
    const r = await call('POST', '/api/settings', now, { settings: { ...s, scoringStart: '2020-01-05', halveNegativesBefore: '2030-01-01', evil: '<script>' } });
    expect(r.status).toBe(200);
    expect(r.body.settings.scoringStart).toBe(s.scoringStart);
    expect(r.body.settings.halveNegativesBefore).toBe('2026-11-29');
    expect('evil' in r.body.settings).toBe(false);
  });
  it('rejects nonsense', async () => {
    const now = ppInstant('2026-12-09', 13);
    const s = (await state(now)).settings;
    expect((await call('POST', '/api/settings', now, { settings: { ...s, allowance: 'lots' } })).status).toBe(400);
    expect((await call('POST', '/api/settings', now, { settings: { ...s, allowance: [{ until: 'soon', value: 5 }, { until: null, value: 5 }] } })).status).toBe(400);
    expect((await call('POST', '/api/settings', now, { settings: { ...s, fxGbpUsd: 50 } })).status).toBe(400);
    expect((await call('POST', '/api/settings', now, { settings: { ...s, creatureName: '' } })).status).toBe(400);
  });
});
