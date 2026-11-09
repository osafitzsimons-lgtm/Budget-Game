import { describe, expect, it } from 'vitest';
import { groupLines, type TextItem } from '../src/parsers/lines';
import { parsePdf } from './helpers/pdf';
import { abaStatement, revolutStatement, rng, type SynthRow } from './helpers/statements';
import { makePdf } from './helpers/pdfgen';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const abaDate = (d: string) => { const [y, m, dd] = d.split('-'); return `${MON[+m - 1]} ${dd}, ${y}`; };
const revDate = (d: string, sept = true) => { const [y, m, dd] = d.split('-'); const mon = +m === 9 && sept ? 'Sept' : MON[+m - 1]; return `${+dd} ${mon} ${y}`; };

describe('line grouping', () => {
  it('groups items by y position and orders by x', () => {
    const items: TextItem[] = [
      { str: 'B', x: 100, y: 50.4, w: 5, h: 9, page: 1 },
      { str: 'A', x: 10, y: 50, w: 5, h: 9, page: 1 },
      { str: 'C', x: 10, y: 62, w: 5, h: 9, page: 1 },
      { str: 'D', x: 10, y: 20, w: 5, h: 9, page: 2 },
    ];
    const lines = groupLines(items);
    expect(lines.map((l) => [l.page, l.text])).toEqual([[1, 'A B'], [1, 'C'], [2, 'D']]);
  });
  it('merges adjacent items into one phrase', () => {
    const lines = groupLines([
      { str: 'Money', x: 10, y: 10, w: 25, h: 9, page: 1 },
      { str: 'In', x: 37, y: 10, w: 8, h: 9, page: 1 },
      { str: 'Balance', x: 200, y: 10, w: 30, h: 9, page: 1 },
    ]);
    expect(lines[0].phrases.map((p) => p.text)).toEqual(['Money In', 'Balance']);
  });
});

describe('ABA parser', () => {
  const rows: SynthRow[] = [
    { date: 'Aug 05, 2026', desc: ['PURCHASE AT CAFE ONE', 'PHNOM PENH KH'], out: 4.5, time: '09:15 AM' },
    { date: 'Aug 05, 2026', desc: ['FUNDS RECEIVED FROM SOMEONE', '(012 345 678)', 'REF 1234'], in: 20 },
    { date: 'Aug 06, 2026', desc: ['GRAB* RIDE'], out: 2.1 },
    { date: 'Aug 07, 2026', desc: ['KHR 20,000 PAYMENT', 'TO SHOP'], out: 5 },
  ];

  it('parses rows, wrapped descriptions, times and the account', async () => {
    const st = await parsePdf(abaStatement({ opening: 100, rows }));
    expect(st.bank).toBe('ABA');
    expect(st.accountLast3).toBe('812');
    expect(st.periodStart).toBe('2026-08-05');
    expect(st.periodEnd).toBe('2026-08-31');
    expect(st.periodFromHeader).toBe(true);
    expect(st.rows).toHaveLength(4);
    expect(st.rows[0]).toMatchObject({ date: '2026-08-05', time: '09:15', description: 'PURCHASE AT CAFE ONE PHNOM PENH KH', moneyOut: 4.5, balance: 95.5 });
    expect(st.rows[1]).toMatchObject({ moneyIn: 20, description: 'FUNDS RECEIVED FROM SOMEONE (012 345 678) REF 1234' });
    expect(st.rows[3].description).toBe('KHR 20,000 PAYMENT TO SHOP');
    expect(st.opening).toBe(100);
    expect(st.closing).toBe(108.4);
  });

  it('skips repeated page headers/footers across many pages', async () => {
    const r = rng(1);
    const many: SynthRow[] = [];
    let day = 5;
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 0) day = Math.min(31, day + 1);
      const isIn = r() < 0.2;
      const amt = Math.round(r() * 5000) / 100 + 0.5;
      many.push({ date: `Aug ${String(day).padStart(2, '0')}, 2026`, desc: r() < 0.5 ? ['SHOP ' + i, 'LINE TWO'] : ['SHOP ' + i], ...(isIn ? { in: amt } : { out: amt }) });
    }
    const st = await parsePdf(abaStatement({ opening: 3000, rows: many, rowsPerPage: 9 }));
    expect(st.rows).toHaveLength(60);
    expect(st.rows.every((x) => !/Page|Advanced Bank/.test(x.description))).toBe(true);
    const tin = many.reduce((a, x) => a + (x.in ?? 0), 0);
    const tout = many.reduce((a, x) => a + (x.out ?? 0), 0);
    expect(st.totalIn).toBeCloseTo(tin, 2);
    expect(st.totalOut).toBeCloseTo(tout, 2);
  });

  it('keeps wrapped lines that repeat at the same height on every page (e.g. "PHNOM PENH KH")', async () => {
    const same: SynthRow[] = Array.from({ length: 36 }, (_, i) => ({ date: `Sep ${String(1 + Math.floor(i / 2)).padStart(2, '0')}, 2026`, desc: [`SHOP ${i}`, 'PHNOM PENH KH'], out: 1 + i }));
    const st = await parsePdf(abaStatement({ opening: 2000, rows: same, rowsPerPage: 12, period: 'Sep 01, 2026 - Sep 30, 2026' }));
    expect(st.rows).toHaveLength(36);
    expect(st.rows.every((r) => r.description.endsWith('PHNOM PENH KH'))).toBe(true);
  });

  it('reorders newest-first statements', async () => {
    const st = await parsePdf(abaStatement({ opening: 100, rows, newestFirst: true }));
    expect(st.rows.map((x) => x.date)).toEqual(['2026-08-05', '2026-08-05', '2026-08-06', '2026-08-07']);
    expect(st.closing).toBe(108.4);
  });

  it('stops when a row breaks the balance chain', async () => {
    await expect(parsePdf(abaStatement({ opening: 100, rows, breakBalanceAt: 2 }))).rejects.toThrow(/balance check failed/i);
  });

  it('falls back to row dates when there is no period, and says so', async () => {
    const st = await parsePdf(abaStatement({ opening: 100, rows, period: null }));
    expect(st.periodFromHeader).toBe(false);
    expect(st.periodEnd).toBe('2026-08-07');
  });

  it('stops on an unknown layout', async () => {
    await expect(parsePdf(abaStatement({ opening: 100, rows, omitHeaderTable: true }))).rejects.toThrow(/Unrecognised statement layout/);
    await expect(parsePdf(makePdf([[{ x: 40, y: 40, text: 'Some other bank statement' }]]))).rejects.toThrow(/Unrecognised/);
  });

  it('stops when the account number is missing or ambiguous', async () => {
    await expect(parsePdf(abaStatement({ opening: 100, rows, accountNumber: 'N/A' }))).rejects.toThrow(/account number/);
  });
});

function revRows(n: number, seed: number, startDay: string, opening: number): { rows: SynthRow[]; out: number; inn: number } {
  const r = rng(seed);
  const rows: SynthRow[] = [];
  let d = new Date(startDay + 'T00:00:00Z');
  let bal = opening;
  let out = 0, inn = 0;
  for (let i = 0; i < n; i++) {
    if (r() < 0.4) d = new Date(d.getTime() + 86400e3);
    const ymd = d.toISOString().slice(0, 10);
    let amt = Math.round(r() * 4000) / 100 + 0.01;
    const isIn = r() < 0.3 || bal - amt < 0;
    if (isIn) { inn += amt; bal += amt; } else { out += amt; bal -= amt; }
    const extra = r() < 0.3 ? ['Revolut Rate £1.00 = $1.33', 'Card: 123456******9999'] : r() < 0.2 ? ['To: SOMEONE', 'Reference: test'] : r() < 0.1 ? ['Fee: £0.00'] : [];
    rows.push({ date: revDate(ymd), desc: r() < 0.15 ? ['Payment to a shop with', 'a long name'] : [`Shop ${seed}-${i}`], ...(isIn ? { in: amt } : { out: amt }), extra });
    amt = 0;
  }
  return { rows, out: Math.round(out * 100) / 100, inn: Math.round(inn * 100) / 100 };
}

describe('Revolut parser', () => {
  it('parses a two-section statement, ignoring reverted tables, detail lines and legal footer', async () => {
    const a = revRows(40, 7, '2026-08-01', 500);
    const closeA = Math.round((500 + a.inn - a.out) * 100) / 100;
    const b = revRows(30, 8, '2026-09-01', closeA);
    const pdf = revolutStatement({
      sections: [
        { opening: 500, from: '1 August 2026', to: '31 August 2026', rows: a.rows, reverted: [{ date: '3 Aug 2026', desc: ['Reverted shop'], out: 99.99 }] },
        { opening: closeA, from: '1 September 2026', to: '30 September 2026', rows: b.rows },
      ],
    });
    const st = await parsePdf(pdf);
    expect(st.bank).toBe('REV');
    expect(st.accountLast3).toBe('554');
    expect(st.currency).toBe('GBP');
    expect(st.sections).toHaveLength(2);
    expect(st.rows).toHaveLength(70);
    expect(st.sections[0]).toMatchObject({ rowCount: 40 });
    expect(st.sections[0].totalOut).toBeCloseTo(a.out, 2);
    expect(st.sections[0].totalIn).toBeCloseTo(a.inn, 2);
    expect(st.sections[1].totalOut).toBeCloseTo(b.out, 2);
    expect(st.periodStart).toBe('2026-08-01');
    expect(st.periodEnd).toBe('2026-09-30');
    expect(st.rows.some((x) => /Reverted|Card:|Revolut Rate|Report lost|Revolut Ltd/.test(x.description))).toBe(false);
    expect(st.rows.find((x) => x.description.startsWith('Payment to a shop'))?.description).toBe('Payment to a shop with a long name');
    // "Sept" dates are read as September
    expect(st.rows.some((x) => x.date.startsWith('2026-09'))).toBe(true);
    expect(st.closing).toBeCloseTo(closeA + b.inn - b.out, 2);
  });

  it('decides money out vs money in from the column position', async () => {
    const st = await parsePdf(revolutStatement({
      sections: [{ opening: 10, from: '1 March 2026', to: '31 March 2026', rows: [
        { date: '2 Mar 2026', desc: ['Coffee'], out: 3.2 },
        { date: '2 Mar 2026', desc: ['Top-up'], in: 50 },
      ] }],
    }));
    expect(st.rows.map((x) => [x.moneyOut, x.moneyIn])).toEqual([[3.2, 0], [0, 50]]);
    expect(st.rows[1].balance).toBe(56.8);
  });

  it('stops when the rows do not add up to the summary', async () => {
    await expect(parsePdf(revolutStatement({ wrongSummaryOut: true, sections: [{ opening: 10, from: '1 March 2026', to: '31 March 2026', rows: [{ date: '2 Mar 2026', desc: ['Coffee'], out: 3.2 }] }] }))).rejects.toThrow(/money out/);
  });

  it('stops when sections do not join up', async () => {
    await expect(parsePdf(revolutStatement({ sections: [
      { opening: 10, from: '1 March 2026', to: '31 March 2026', rows: [{ date: '2 Mar 2026', desc: ['Coffee'], out: 3.2 }] },
      { opening: 99, from: '1 April 2026', to: '30 April 2026', rows: [{ date: '2 Apr 2026', desc: ['Tea'], out: 1 }] },
    ] }))).rejects.toThrow(/don't join up/);
  });

  it('refuses non-GBP statements', async () => {
    await expect(parsePdf(revolutStatement({ currencySymbol: '€', sections: [{ opening: 10, from: '1 March 2026', to: '31 March 2026', rows: [{ date: '2 Mar 2026', desc: ['Coffee'], out: 3.2 }] }] }))).rejects.toThrow(/only GBP/);
  });

  it('refuses a scanned PDF with no text', async () => {
    await expect(parsePdf(makePdf([[]]))).rejects.toThrow(/no readable text/);
  });
});
