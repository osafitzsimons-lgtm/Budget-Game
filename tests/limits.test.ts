// Free plan: 10 ms of CPU per request. Runs the real handler on an in-process SQLite stand-in and
// subtracts the time spent inside SQLite (in production that work happens in D1, not in the Worker).
// Node is not workerd, so these are estimates: the limits below leave a safety margin.
import { describe, expect, it } from 'vitest';
import { ppInstant } from '../src/shared/dates';
import { round2 } from '../src/shared/money';
import { dupIndexes, hashRows } from '../src/shared/hash';
import { csvHashable, CSV_ROWS_PER_REQUEST } from '../src/shared/csv';
import { MAX_ROWS_PER_PART, planParts } from '../src/shared/submit';
import type { StatementSummary } from '../src/shared/types';
import { _resetSchemaFlag } from '../src/worker/db';
import { handleApi } from '../src/worker/index';
import { sqliteD1 } from './helpers/sqlite-d1';

const BASE = 'http://localhost:8787';
const MON9 = ppInstant('2026-11-09', 10);
const SUN15 = ppInstant('2026-11-15', 9);
const env = (db: D1Database) => ({ DB: db, LOCAL_DEV: 'true', ASSETS: {} }) as never;

async function statement(n: number, payee: (i: number) => string) {
  let bal = 1_000_000;
  const base = Array.from({ length: n }, (_, i) => {
    const amountOrig = round2(1 + (i % 50) * 0.37);
    bal = round2(bal - amountOrig);
    return { date: '2026-11-10', time: null, payee: payee(i), amountOrig, amountUsd: amountOrig, balance: bal, seq: i, category: 'Eating out and bars', savings: false, isCash: false };
  });
  const dups = dupIndexes('ABA-812', base);
  const hashes = await hashRows('ABA-812', base, dups);
  const rows = base.map((b, i) => ({ ...b, dup: dups[i], hash: hashes[i] }));
  return {
    statement: { accountId: 'ABA-812', bank: 'ABA', last3: '812', currency: 'USD', periodStart: '2026-11-01', periodEnd: '2026-11-14', periodFromHeader: true, opening: 1_000_000, closing: bal, fx: 1 },
    rows,
  };
}

/** Fastest of several runs: other tests run in parallel, and the fastest run is the closest to the real cost. */
async function cpuMs(path: string, body: unknown, runs = 7) {
  const out: number[] = [];
  let status = 0;
  for (let i = 0; i < runs; i++) {
    _resetSchemaFlag();
    const { db, meter } = sqliteD1();
    await handleApi(new Request(BASE + '/api/state'), env(db), MON9);
    const req = new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const s0 = meter.sqlMs;
    const t0 = performance.now();
    const res = await handleApi(req, env(db), SUN15);
    await res.text();
    out.push(performance.now() - t0 - (meter.sqlMs - s0));
    status = res.status;
  }
  out.sort((a, b) => a - b);
  return { ms: out[0], status };
}

describe('CPU per request stays well under 10 ms', () => {
  it('confirming one full part of a big statement', async () => {
    const body = await statement(MAX_ROWS_PER_PART, (i) => `PURCHASE SHOP NUMBER ${i} PHNOM PENH KH`);
    const r = await cpuMs('/api/uploads/confirm', { ...body, rules: [] });
    console.log(`confirm ${MAX_ROWS_PER_PART} rows: ${r.ms.toFixed(1)} ms`);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(8);
  });
  it('checking a whole 849-row statement (no hashing or masking on the server)', async () => {
    const body = await statement(849, (i) => `PURCHASE SHOP NUMBER ${i} PHNOM PENH KH`);
    const r = await cpuMs('/api/uploads/check', body);
    console.log(`check 849 rows: ${r.ms.toFixed(1)} ms`);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(8);
  });
  it('the worst payees (long runs of x or *) cost no more than normal ones', async () => {
    const body = await statement(MAX_ROWS_PER_PART, (i) => (i % 2 ? 'x*'.repeat(150) : `1${'-'.repeat(280)}1 9${'.'.repeat(10)}`));
    const r = await cpuMs('/api/uploads/confirm', { ...body, rules: [{ payee: '*'.repeat(30000), category: 'Sport' }] });
    console.log(`confirm ${MAX_ROWS_PER_PART} rows of worst-case payees: ${r.ms.toFixed(1)} ms`);
    expect(r.ms).toBeLessThan(8);
  });
  it('one CSV import request', async () => {
    const rows = Array.from({ length: CSV_ROWS_PER_REQUEST }, (_, i) => ({ date: '2026-09-01', account: 'ABA', payee: `Shop ${i % 300}`, amountUsd: 5 + (i % 7), category: 'Eating out and bars' }));
    const dups = dupIndexes('csv', rows.map(csvHashable));
    const r = await cpuMs('/api/import-csv', { rows: rows.map((x, i) => ({ ...x, dup: dups[i] })) });
    console.log(`import ${CSV_ROWS_PER_REQUEST} CSV rows: ${r.ms.toFixed(1)} ms`);
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(9);
  });
  it('oversized requests are refused before doing the work', async () => {
    const body = await statement(301, () => "SHOP");
    expect((await cpuMs('/api/uploads/confirm', { ...body, rules: [] }, 1)).status).toBe(400);
  });
});

describe('big statements are sent in parts that each chain on', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ hash: String(i), date: `2026-10-${String(1 + Math.floor(i / 40)).padStart(2, '0')}`, balance: 1000 - i - 1, amountOrig: 1 }));
  const summary: StatementSummary = { accountId: 'ABA-812', periodStart: '2026-10-01', periodEnd: '2026-10-31', periodFromHeader: true, opening: 1000, closing: 151, currency: 'USD' };
  it('a new 849-row statement goes oldest-first, each part opening where the last closed', () => {
    const parts = planParts(summary, rows(849), { firstKnown: -1, lastKnown: -1, direction: 'forward', newRows: 849 });
    expect(parts.map((p) => p.rows.length)).toEqual([250, 250, 250, 99]);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].summary.opening).toBe(parts[i - 1].summary.closing);
      expect(parts[i].summary.periodStart <= parts[i - 1].summary.periodEnd).toBe(true);
    }
    expect(parts[0].summary.periodStart).toBe('2026-10-01');
    expect(parts[parts.length - 1].summary.periodEnd).toBe('2026-10-31');
  });
  it('older history goes newest-first and skips rows already saved', () => {
    const parts = planParts(summary, rows(849), { firstKnown: 700, lastKnown: 848, direction: 'overlap', newRows: 700 });
    expect(parts.map((p) => [p.rows.length, p.summary.direction])).toEqual([[200, 'backfill'], [250, 'backfill'], [250, 'backfill']]);
    expect(parts[0].summary.closing).toBe(rows(849)[699].balance);
    expect(parts[parts.length - 1].summary.periodStart).toBe('2026-10-01');
  });
});
