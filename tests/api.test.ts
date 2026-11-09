// Integration tests: the real Worker API against a local D1 (SQLite) database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { ppInstant } from '../src/shared/dates';
import { hashRows } from '../src/shared/hash';
import { contextFrom, prepareStatement } from '../src/shared/statement';
import { handleApi } from '../src/worker/index';
import { _resetSchemaFlag } from '../src/worker/db';
import { parsePdf } from './helpers/pdf';
import { abaStatement, revolutStatement } from './helpers/statements';

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: { DB: D1Database; LOCAL_DEV: string; ASSETS: Fetcher };

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  env = { DB: proxy.env.DB, LOCAL_DEV: 'true', ASSETS: {} as Fetcher };
  _resetSchemaFlag();
}, 60000);
afterAll(async () => proxy?.dispose());

const BASE = 'http://localhost:8787';
async function call(method: string, path: string, now: number, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handleApi(new Request(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never, now);
  return { status: res.status, body: (await res.json()) as any };
}
const state = async (now: number) => (await call('GET', '/api/state', now)).body;

async function prepare(pdf: Uint8Array, now: number) {
  const st = await state(now);
  const parsed = await parsePdf(pdf);
  const acct = st.accounts.find((a: any) => a.bank === parsed.bank && a.last3 === parsed.accountLast3);
  const prep = await prepareStatement(parsed, acct.id, st.settings.fxGbpUsd, contextFrom(st.rules, st.accounts, st.settings));
  return prep;
}
async function upload(pdf: Uint8Array, now: number) {
  const prep = await prepare(pdf, now);
  const check = await call('POST', '/api/uploads/check', now, { statement: prep.summary, rows: prep.rows });
  const confirm = await call('POST', '/api/uploads/confirm', now, { statement: prep.summary, rows: prep.rows, rules: [] });
  return { prep, check: check.body, confirm: confirm.body, status: confirm.status };
}

const aba812 = (opening: number, rows: { date: string; desc: string[]; in?: number; out?: number }[], period: string) => abaStatement({ accountNumber: '000 111 812', opening, rows, period });
const aba013 = (period: string, date: string) => abaStatement({ accountNumber: '000 222 013', opening: 50, rows: [{ date, desc: ['COFFEE'], out: 2 }], period });
const rev = (from: string, to: string, date: string) => revolutStatement({ sections: [{ opening: 100, from, to, rows: [{ date, desc: ['Lunch'], out: 10 }] }] });

const MON9 = ppInstant('2026-11-09', 10);
const SUN15 = ppInstant('2026-11-15', 9);

describe('API flow', () => {
  it('first open sets up the sprout at 70 and the first scored week', async () => {
    const s = await state(MON9);
    expect(s.creature.health).toBe(70);
    expect(s.settings.scoringStart).toBe('2026-11-08');
    expect(s.accounts.map((a: any) => a.id)).toEqual(['ABA-812', 'ABA-013', 'ABA-811', 'REV-554']);
    expect(s.deadline.at).toBe(ppInstant('2026-11-15', 20));
  });

  it('refuses cross-site writes', async () => {
    const r = await call('POST', '/api/logs', MON9, { amountUsd: 5, what: 'x' }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('baseline uploads for every account score the finished week early', async () => {
    const period = 'Nov 01, 2026 - Nov 14, 2026';
    const a = await upload(aba812(1000, [
      { date: 'Nov 09, 2026', desc: ['CAFE ONE'], out: 20 },
      { date: 'Nov 10, 2026', desc: ['SHOP TWO'], out: 30 },
      { date: 'Nov 11, 2026', desc: ['GRAB'], out: 3 },
    ], period), SUN15);
    expect(a.check.ok).toBe(true);
    expect(a.confirm.stored).toBe(true);
    expect(a.confirm.inserted).toBe(3);
    const b = await upload(aba013(period, 'Nov 12, 2026'), SUN15);
    expect(b.confirm.stored).toBe(true);
    expect(b.confirm.events).toEqual([]); // Revolut still missing, so nothing scored yet
    const c = await upload(rev('1 November 2026', '14 November 2026', '12 Nov 2026'), SUN15);
    expect(c.confirm.stored).toBe(true);
    // 20 + 30 + 3 + 2 + £10×1.33 = 68.30 of 161 → +15; SHOP TWO $30 not written down → -5 (halved to -2)
    expect(c.confirm.events.map((e: any) => [e.kind, e.delta])).toEqual([['spend', 15], ['unlogged', -2]]);
    expect(c.confirm.healthBefore).toBe(70);
    expect(c.confirm.healthAfter).toBe(83);
  });

  it('overlapping statements are deduped and still pass', async () => {
    const r = await upload(aba812(1000, [
      { date: 'Nov 09, 2026', desc: ['CAFE ONE'], out: 20 },
      { date: 'Nov 10, 2026', desc: ['SHOP TWO'], out: 30 },
      { date: 'Nov 11, 2026', desc: ['GRAB'], out: 3 },
      { date: 'Nov 16, 2026', desc: ['NEW SHOP'], out: 7 },
    ], 'Nov 01, 2026 - Nov 21, 2026'), ppInstant('2026-11-22', 9));
    expect(r.check.ok).toBe(true);
    expect(r.confirm.inserted).toBe(1);
  });

  it('a statement whose opening balance does not match fails and stores nothing', async () => {
    const r = await upload(aba812(5000, [{ date: 'Nov 17, 2026', desc: ['X'], out: 1 }], 'Nov 17, 2026 - Nov 21, 2026'), ppInstant('2026-11-22', 10));
    expect(r.confirm.stored).toBe(false);
    expect(r.confirm.proof.checks.find((c: any) => c.id === 'opening-balance').ok).toBe(false);
  });

  it('missed deadlines are worked out when the app is opened (no cron)', async () => {
    // Week 15–21 Nov: ABA 013 and Revolut never uploaded → -25, halved to -12 (before 29 Nov)
    const s = await state(ppInstant('2026-11-23', 8));
    const ev = s.events.filter((e: any) => e.weekStart === '2026-11-15');
    expect(ev.map((e: any) => [e.kind, e.delta])).toEqual([['missing-upload', -12]]);
    expect(s.creature.health).toBe(71);
    // Opening again does not double-count
    expect((await state(ppInstant('2026-11-23', 9))).creature.health).toBe(71);
  });

  it('after 29 Nov penalties are not halved, and several missed weeks are all scored', async () => {
    const s = await state(ppInstant('2026-12-08', 8));
    const byWeek = (w: string) => s.events.filter((e: any) => e.weekStart === w).sort((a: any, b: any) => a.id - b.id).map((e: any) => [e.kind, e.delta]);
    expect(byWeek('2026-11-22')).toEqual([['missing-upload', -25]]);
    // Week 29 Nov–5 Dec contains 3 Dec: savings check too (nothing saved → -30)
    // 71 - 25 = 46, - 25 = 21, - 30 → 0: he dies and a new sprout starts at 40
    expect(byWeek('2026-11-29')).toEqual([['missing-upload', -25], ['savings', -30], ['death', 0], ['birth', 0]]);
    expect(s.creature.health).toBe(40);
    expect(s.creature.id).toBe(2);
    expect(s.graveyard).toHaveLength(1);
    expect(s.savings.nextMonthExtra + s.savings.extra).toBe(25);
    expect(s.events.some((e: any) => e.kind === 'death')).toBe(true);
  });

  it('write it down: logs a planned spend and refuses back-dated ones', async () => {
    const now = ppInstant('2026-12-08', 9);
    expect((await call('POST', '/api/logs', now, { kind: 'planned', amountUsd: 45, what: 'Dinner', why: 'birthday', date: '2026-12-08' })).status).toBe(200);
    expect((await call('POST', '/api/logs', now, { kind: 'planned', amountUsd: 45, what: 'Dinner', date: '2026-12-01' })).status).toBe(400);
    const s = await state(now);
    expect(s.logs[0]).toMatchObject({ what: 'Dinner', amountUsd: 45 });
    expect(s.week.pending).toBe(45);
  });

  it('CSV history import teaches rules and fills history but never changes health', async () => {
    const now = ppInstant('2026-12-08', 10);
    const before = (await state(now)).creature.health;
    const rows = [
      { date: '2026-09-01', account: 'ABA', payee: 'Cafe Test', amountUsd: 12.5, category: 'Eating out and bars' },
      { date: '2026-09-02', account: 'REV', payee: 'Cafe Test', amountUsd: 7.5, category: 'Eating out and bars' },
      { date: '2026-09-03', account: 'ABA', payee: 'Move', amountUsd: 900, category: 'Transfer' },
    ];
    const hashes = await hashRows('csv', rows.map((r) => ({ ...r, time: null, amountOrig: r.amountUsd, balance: null, payee: `${r.account}|${r.payee}` })));
    const r = await call('POST', '/api/import-csv', now, { rows: rows.map((x, i) => ({ ...x, hash: hashes[i] })) });
    expect(r.body).toMatchObject({ inserted: 3, rulesLearned: 2 });
    const again = await call('POST', '/api/import-csv', now, { rows: rows.map((x, i) => ({ ...x, hash: hashes[i] })) });
    expect(again.body.inserted).toBe(0);
    const s = await state(now);
    expect(s.creature.health).toBe(before);
    expect(s.rules).toContainEqual(['cafe test', 'Eating out and bars']);
    const h = await call('GET', '/api/history', now);
    expect(h.body.rows.some((x: any[]) => x[0] === '2026-09-01' && x[2] === 'csv')).toBe(true);
  });

  it('exports every table in pages', async () => {
    const r = await call('GET', '/api/export?table=transactions&after=', ppInstant('2026-12-08', 11));
    expect(r.body.columns[0]).toBe('date');
    expect(r.body.rows.length).toBeGreaterThan(5);
    expect((await call('GET', '/api/export?table=nope', 0)).status).toBe(400);
  });

  it('rejects an account that is not set up', async () => {
    const r = await upload(abaStatement({ accountNumber: '000 999 999', opening: 1, rows: [{ date: 'Dec 01, 2026', desc: ['X'], out: 1 }], period: 'Dec 01, 2026 - Dec 07, 2026' }), ppInstant('2026-12-08', 12)).catch((e) => e);
    expect(String(r)).toMatch(/TypeError|undefined/); // prepare() can't find it; the UI shows a clear message instead
  });

  it('fails closed without Access config, and previews have no database', async () => {
    const res = await handleApi(new Request('https://budget-guy.x.workers.dev/api/state'), { ASSETS: {} as Fetcher, DB: env.DB } as never);
    expect(res.status).toBe(503);
    const prev = await handleApi(new Request('http://localhost/api/state'), { ASSETS: {} as Fetcher, LOCAL_DEV: 'true', IS_PREVIEW: 'true' } as never);
    expect(prev.status).toBe(503);
    expect(((await prev.json()) as any).error).toMatch(/preview/);
  });
});
