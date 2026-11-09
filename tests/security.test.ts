// Regression tests for the security audit findings, against the real handler and a local D1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { csvEscape } from '../src/shared/csv';
import { ppInstant } from '../src/shared/dates';
import { dupIndexes, hashRows } from '../src/shared/hash';
import { round2 } from '../src/shared/money';
import { maskPayee } from '../src/shared/privacy';
import { submitStatement, type Post } from '../src/shared/submit';
import { verifyAccess } from '../src/worker/auth';
import { _resetSchemaFlag } from '../src/worker/db';
import { handleApi } from '../src/worker/index';

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Record<string, unknown>;
beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  env = { DB: proxy.env.DB, LOCAL_DEV: 'true', ASSETS: {} };
  _resetSchemaFlag();
});
afterAll(async () => proxy?.dispose());

const BASE = 'http://localhost:8787';
async function call(method: string, path: string, now: number, body?: unknown, init: RequestInit = {}) {
  const res = await handleApi(new Request(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...init }), env as never, now);
  return { status: res.status, body: (await res.json()) as any };
}
const postAt = (now: number): Post => async <T,>(path: string, body: unknown) => {
  const r = await call('POST', path, now, body);
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${r.body.error}`);
  return r.body as T;
};

type Acct = { accountId: string; bank: 'ABA' | 'REV'; last3: string };
const A812: Acct = { accountId: 'ABA-812', bank: 'ABA', last3: '812' };
const A013: Acct = { accountId: 'ABA-013', bank: 'ABA', last3: '013' };
const R554: Acct = { accountId: 'REV-554', bank: 'REV', last3: '554' };

/** A statement exactly as the browser prepares one. */
async function stmt(a: Acct, o: { periodStart: string; periodEnd: string; opening: number; rows: { date: string; payee: string; amount: number; category?: string; savings?: boolean; isCash?: boolean }[]; currency?: string; fx?: number; periodFromHeader?: boolean }) {
  const currency = o.currency ?? (a.bank === 'REV' ? 'GBP' : 'USD');
  const fx = o.fx ?? (currency === 'GBP' ? 1.33 : 1);
  let bal = o.opening;
  const base = o.rows.map((r, i) => {
    bal = round2(bal - r.amount);
    return { date: r.date, time: null, payee: maskPayee(r.payee), amountOrig: r.amount, amountUsd: currency === 'GBP' ? round2(r.amount * fx) : r.amount, balance: bal, seq: i, category: r.category ?? 'Eating out and bars', savings: !!r.savings, isCash: !!r.isCash, currency };
  });
  const dups = dupIndexes(a.accountId, base);
  const hashes = await hashRows(a.accountId, base, dups);
  return {
    summary: { ...a, currency, periodStart: o.periodStart, periodEnd: o.periodEnd, periodFromHeader: o.periodFromHeader ?? true, opening: o.opening, closing: bal, fx } as any,
    rows: base.map((b, i) => ({ ...b, dup: dups[i], hash: hashes[i] })),
  };
}

const MON9 = ppInstant('2026-11-09', 10);
/** The last saved closing balance for an account (statements chain on from it). */
async function closing(accountId: string, now: number): Promise<number> {
  const st = await call('GET', '/api/state', now);
  return st.body.uploads.find((u: any) => u.accountId === accountId).lastGood.closing;
}
const SUN15 = ppInstant('2026-11-15', 9);

describe('upload integrity', () => {
  it('sets up', async () => {
    expect((await call('GET', '/api/state', MON9)).status).toBe(200);
  });

  it('refuses a statement that ends after today', async () => {
    const s = await stmt(A812, { periodStart: '2026-11-01', periodEnd: '2099-12-31', opening: 1000, rows: [] });
    const r = await call('POST', '/api/uploads/confirm', SUN15, { statement: s.summary, rows: s.rows });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/after today/);
  });

  it('refuses a statement with no rows and no dates from its header', async () => {
    const s = await stmt(A812, { periodStart: '2026-11-01', periodEnd: '2026-11-14', opening: 1000, rows: [], periodFromHeader: false });
    expect((await call('POST', '/api/uploads/confirm', SUN15, { statement: s.summary, rows: s.rows })).status).toBe(400);
  });

  it('refuses the wrong currency for a bank', async () => {
    const s = await stmt(R554, { periodStart: '2026-11-01', periodEnd: '2026-11-14', opening: 100, rows: [{ date: '2026-11-10', payee: 'Shop', amount: 100 }], currency: 'USD', fx: 1 });
    const r = await call('POST', '/api/uploads/confirm', SUN15, { statement: s.summary, rows: s.rows });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must be in GBP/);
  });

  it('works out row ids itself: another account’s ids or a CSV import can’t swallow statement rows', async () => {
    const a = await stmt(A812, { periodStart: '2026-11-01', periodEnd: '2026-11-14', opening: 1000, rows: [{ date: '2026-11-10', payee: 'CAFE', amount: 20 }, { date: '2026-11-11', payee: 'BAR', amount: 150 }] });
    // A CSV import that claims the statement's ids first…
    await call('POST', '/api/import-csv', SUN15, { rows: a.rows.map((r) => ({ hash: r.hash, date: r.date, account: 'ABA', payee: r.payee, amountUsd: r.amountUsd, category: 'Transfer' })) });
    // …and a different account's statement that re-uses them.
    const b = await stmt(A013, { periodStart: '2026-11-01', periodEnd: '2026-11-14', opening: 900, rows: [{ date: '2026-11-12', payee: 'SHOP', amount: 500 }] });
    const bForged = { ...b, rows: b.rows.map((r) => ({ ...r, hash: a.rows[0].hash })) };
    const rb = await call('POST', '/api/uploads/confirm', SUN15, { statement: bForged.summary, rows: bForged.rows });
    expect(rb.body.inserted).toBe(1);
    const ra = await call('POST', '/api/uploads/confirm', SUN15, { statement: a.summary, rows: a.rows });
    expect(ra.body.inserted).toBe(2);
    const ex = await call('GET', '/api/export?table=transactions&after=', SUN15);
    const col = (n: string) => ex.body.columns.indexOf(n);
    const pdf = ex.body.rows.filter((x: any[]) => x[col('source')] === 'pdf').map((x: any[]) => [x[col('account_id')], x[col('amount_usd')]]);
    expect(pdf.sort()).toEqual([['ABA-013', 500], ['ABA-812', 150], ['ABA-812', 20]]);
  });

  it('decides "cash" and "savings" itself', async () => {
    const s = await stmt(R554, { periodStart: '2026-11-01', periodEnd: '2026-11-14', opening: 2000, rows: [
      { date: '2026-11-12', payee: 'Fancy restaurant', amount: 300, savings: true, isCash: true },
      { date: '2026-11-12', payee: 'To savings pot', amount: 100, category: 'Transfer', savings: true },
    ] });
    const r = await call('POST', '/api/uploads/confirm', SUN15, { statement: s.summary, rows: s.rows });
    expect(r.body.stored).toBe(true);
    const ex = await call('GET', '/api/export?table=transactions&after=', SUN15);
    const col = (n: string) => ex.body.columns.indexOf(n);
    const restaurant = ex.body.rows.find((x: any[]) => x[col('payee')] === 'Fancy restaurant');
    const pot = ex.body.rows.find((x: any[]) => x[col('payee')] === 'To savings pot');
    expect([restaurant[col('savings')], restaurant[col('is_cash')]]).toEqual([0, 0]);
    expect(pot[col('savings')]).toBe(1);
  });

  it('two statements racing for the same account can’t both be saved', async () => {
    const s1 = await stmt(A812, { periodStart: '2026-11-14', periodEnd: '2026-11-15', opening: 830, rows: [{ date: '2026-11-15', payee: 'ONE', amount: 5 }] });
    const s2 = await stmt(A812, { periodStart: '2026-11-14', periodEnd: '2026-11-15', opening: 830, rows: [{ date: '2026-11-15', payee: 'TWO', amount: 400 }] });
    const t = ppInstant('2026-11-15', 11);
    const [r1, r2] = await Promise.all([
      call('POST', '/api/uploads/confirm', t, { statement: s1.summary, rows: s1.rows }),
      call('POST', '/api/uploads/confirm', t, { statement: s2.summary, rows: s2.rows }),
    ]);
    const stored = [r1, r2].filter((r) => r.status === 200 && r.body.stored).length;
    expect(stored).toBe(1);
  });

  it('masks card numbers in every spelling, in statement rows, hand-added rows and notes', async () => {
    const t = ppInstant('2026-11-16', 9);
    await call('POST', '/api/transactions', t, { date: '2026-11-16', payee: 'card 4111.1111.1111.1111', amountUsd: 5, category: 'Sport' });
    await call('POST', '/api/logs', t, { kind: 'planned', amountUsd: 40, what: 'pay 4111–1111–1111–1111', why: 'acct 000​123​456​789', date: '2026-11-16' });
    const tx = await call('GET', '/api/export?table=transactions&after=', t);
    const logs = await call('GET', '/api/export?table=logs&after=', t);
    const text = JSON.stringify([tx.body.rows, logs.body.rows]);
    expect(text).not.toMatch(/4111\D?1111/);
    expect(text).not.toMatch(/123\D?456/);
  });

  it('a "write it down" entry used by a scored week can’t be deleted', async () => {
    // Week 15–21 Nov: log $60 dinner, spend it, then everything gets scored early.
    const t = ppInstant('2026-11-17', 9);
    const log = await call('POST', '/api/logs', t, { kind: 'planned', amountUsd: 60, what: 'Dinner', date: '2026-11-17' });
    const t2 = ppInstant('2026-11-22', 9);
    const post = postAt(t2);
    for (const [a, rows] of [
      [A812, [{ date: '2026-11-17', payee: 'DINNER', amount: 60 }]],
      [A013, []],
      [R554, []],
    ] as const) {
      const s = await stmt(a, { periodStart: '2026-11-15', periodEnd: '2026-11-21', opening: await closing(a.accountId, t2), rows: [...rows] });
      const r = await submitStatement(post, s.summary, s.rows);
      expect(r.stored).toBe(true);
    }
    const st = await call('GET', '/api/state', t2);
    expect(st.body.events.some((e: any) => e.weekStart === '2026-11-15' && e.kind === 'spend')).toBe(true);
    const del = await call('DELETE', `/api/logs/${log.body.id}`, t + 3600e3);
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/has to stay/);
  });
});

describe('big statements are saved in parts', () => {
  it('an 849-row statement is checked once and saved in 4 parts, each re-checked by the server', async () => {
    const t = ppInstant('2026-12-06', 9);
    const rows = Array.from({ length: 849 }, (_, i) => ({ date: `2026-11-${String(22 + Math.floor(i / 125)).padStart(2, '0')}`, payee: `SHOP ${i}`, amount: 0.5 + (i % 7) }));
    const s = await stmt(A812, { periodStart: '2026-11-22', periodEnd: '2026-12-05', opening: await closing('ABA-812', t), rows });
    const calls: string[] = [];
    const post = postAt(t);
    const res = await submitStatement(async (path, body) => { calls.push(path); return post(path, body); }, s.summary, s.rows);
    expect(res.stored).toBe(true);
    expect(res.inserted).toBe(849);
    expect(calls).toEqual(['/api/uploads/check', '/api/uploads/confirm', '/api/uploads/confirm', '/api/uploads/confirm', '/api/uploads/confirm']);
    // Uploading the same statement again adds nothing and still passes.
    const again = await submitStatement(post, s.summary, s.rows);
    expect([again.stored, again.inserted]).toEqual([true, 0]);
  });
});

describe('request handling', () => {
  it('malformed or junk inputs give 4xx, never a crash', async () => {
    expect((await call('GET', '/api/export?table=constructor', MON9)).status).toBe(400);
    expect((await call('GET', '/api/export?table=__proto__', MON9)).status).toBe(400);
    expect((await call('DELETE', '/api/logs/%E0%A4%A', MON9)).status).toBe(400);
    expect((await call('DELETE', '/api/transactions/%zz', MON9)).status).toBe(400);
  });
  it('the 4 MB body limit counts real bytes, even without a Content-Length', async () => {
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(32)); c.close(); } });
    const res = await handleApi(new Request(BASE + '/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big, duplex: 'half' } as RequestInit), env as never, MON9);
    expect(res.status).toBe(413);
  });
  it('malformed Access tokens are a clean 401', async () => {
    const e = { TEAM_DOMAIN: 'x.cloudflareaccess.com', POLICY_AUD: 'a', ALLOWED_EMAIL: 'a@b.c' };
    const tok = (h: string, p = 'e30', s = 'AA') => new Request('https://x.workers.dev/api/state', { headers: { 'Cf-Access-Jwt-Assertion': `${h}.${p}.${s}` } });
    const nul = Buffer.from('null').toString('base64url');
    expect(await verifyAccess(tok(nul), e)).toMatchObject({ ok: false, status: 401 });
    expect(await verifyAccess(tok(Buffer.from('{"alg":"RS256","kid":"k"}').toString('base64url'), 'e30', '!!!'), e)).toMatchObject({ ok: false, status: 401 });
  });
  it('changing the budget shows up in the score log', async () => {
    const t = ppInstant('2026-12-06', 10);
    const s = (await call('GET', '/api/state', t)).body.settings;
    await call('POST', '/api/settings', t, { settings: { ...s, allowance: [{ until: '2027-02-28', value: 500 }, { until: null, value: 251 }] } });
    const ev = (await call('GET', '/api/state', t)).body.events.find((e: any) => e.kind === 'settings');
    expect(ev.reason).toMatch(/weekly allowance \$161\.00 until 2027-02-28.*→ \$500\.00/);
  });
});

describe('CSV export', () => {
  it('neutralises formulas, including ones that start with a minus and a number', () => {
    expect(csvEscape('-1+HYPERLINK("http://x")')).toBe(`"'-1+HYPERLINK(""http://x"")"`);
    expect(csvEscape("-1+cmd|' /C calc'!A0")).toBe(`'-1+cmd|' /C calc'!A0`);
    expect(csvEscape('-12.50')).toBe('-12.50');
    expect(csvEscape('=1+1')).toBe("'=1+1");
  });
});
