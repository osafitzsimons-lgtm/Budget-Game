// Checks against your real files, if you put them in private-fixtures/ (never committed).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHistoryCsv } from '../src/shared/csv';
import { bankForLabel, monthlySpending } from '../src/shared/history';
import { parsePdf } from './helpers/pdf';

const dir = 'private-fixtures';
const has = (f: string) => existsSync(`${dir}/${f}`);

describe.skipIf(!has('budget_guy_seed_transactions.csv'))('your history CSV', () => {
  it('September–October spending averages $3,968 a month (excluding Transfer and Investing), within $1', () => {
    const { rows, errors } = parseHistoryCsv(readFileSync(`${dir}/budget_guy_seed_transactions.csv`, 'utf8'));
    expect(errors).toEqual([]);
    const m = monthlySpending(rows.map((r) => ({ date: r.date, category: r.category, source: 'csv', bank: bankForLabel(r.account), amountUsd: r.amountUsd })));
    const avg = ((m.get('2026-09') ?? 0) + (m.get('2026-10') ?? 0)) / 2;
    expect(Math.abs(avg - 3968)).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!has('aba-812.pdf'))('your ABA 812 statement', () => {
  it('849 rows, in 9,565.64, out 9,146.68, closing 418.96', async () => {
    const st = await parsePdf(new Uint8Array(readFileSync(`${dir}/aba-812.pdf`)));
    expect(st.accountLast3).toBe('812');
    expect(st.periodStart).toBe('2026-08-05');
    expect(st.periodEnd).toBe('2026-10-31');
    expect(st.rows).toHaveLength(849);
    expect(st.totalIn).toBeCloseTo(9565.64, 2);
    expect(st.totalOut).toBeCloseTo(9146.68, 2);
    expect(st.closing).toBeCloseTo(418.96, 2);
  });
});

describe.skipIf(!has('revolut.pdf'))('your Revolut statement', () => {
  it('433 rows in two sections with the expected totals', async () => {
    const st = await parsePdf(new Uint8Array(readFileSync(`${dir}/revolut.pdf`)));
    expect(st.accountLast3).toBe('554');
    expect(st.rows).toHaveLength(433);
    const [a, b] = st.sections;
    expect([a.totalOut, a.totalIn, a.closing]).toEqual([11834.75, 10219.34, 57.56]);
    expect([b.totalOut, b.totalIn, b.closing]).toEqual([9269.99, 9232.59, 20.16]);
  });
});
