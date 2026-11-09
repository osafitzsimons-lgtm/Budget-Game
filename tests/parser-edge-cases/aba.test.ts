// Parser edge cases found in the security/robustness audit (synthetic layouts, no real data). Each test asserts the correct result or a clear refusal.
import { describe, expect, it } from 'vitest';
import { parseStatementItems } from '../../src/parsers/index';
import { abaPages, type ARow, correctOrRefused, itemsDirect, itemsOf, money, mustParse, mustRefuse, parsePages, right } from './kit';

const base: ARow[] = [
  { date: 'Aug 05, 2026', desc: ['PURCHASE CAFE ONE', 'PHNOM PENH KH'], out: 4.5 },
  { date: 'Aug 06, 2026', desc: ['FUNDS RECEIVED FROM SOMEONE', 'REF 1234'], in: 20 },
  { date: 'Aug 07, 2026', desc: ['GRAB* RIDE'], out: 2.1 },
];

describe('ABA: baseline sanity of the audit kit', () => {
  it('parses the kit layout', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows.map((r) => r.description)).toEqual(['PURCHASE CAFE ONE PHNOM PENH KH', 'FUNDS RECEIVED FROM SOMEONE REF 1234', 'GRAB* RIDE']);
    expect(st.accountLast3).toBe('812');
  });
});

describe('ABA: description text lost or swallowed (silent-wrong)', () => {
  it('A1 continuation line pushed onto the next page (after the repeated header) is silently dropped', async () => {
    // Row 2 is the last row on page 1; its wrapped line lands at the top of page 2.
    const { pages } = abaPages({ opening: 100, pages: [[base[0], { ...base[1], desc: ['FUNDS RECEIVED FROM SOMEONE'] }], [base[2]]] });
    // move a continuation line to page 2, right under the repeated table header, and push the next row down
    pages[1] = pages[1].map((t) => (t.y >= 86 && t.y < 790 ? { ...t, y: t.y + 11 } : t));
    pages[1].push({ x: 125, y: 86, text: 'REF 1234' });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows).toHaveLength(3);
      expect(st.rows[1].description).toBe('FUNDS RECEIVED FROM SOMEONE REF 1234');
    });
  });

  it('A2 single-page statement: bank footer printed ~2 lines under the last row is glued onto the payee', async () => {
    const { pages } = abaPages({
      opening: 100,
      pages: [base],
      footer: null,
      afterRows: (_p, _n, y) => [{ x: 40, y: y + 5, text: 'Advanced Bank of Asia Ltd. Thank you for banking with us.', size: 7 }],
    });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows[2].description).toBe('GRAB* RIDE');
    });
  });

  it('A3 last-page-only note under the table (multi-page) is glued onto the last payee', async () => {
    const { pages } = abaPages({
      opening: 100,
      pages: [[base[0], base[1]], [base[2]]],
      afterRows: (p, n, y) => (p === n - 1 ? [{ x: 125, y: y + 4, text: '*** END OF STATEMENT ***' }] : []),
    });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows[2].description).toBe('GRAB* RIDE');
    });
  });

  const contPages = (x: number) => {
    const pg = (d: number): ARow[] => [0, 1, 2].map((k) => ({ date: `Aug ${String(d + k).padStart(2, '0')}, 2026`, desc: [`SHOP ${d + k}`], out: 1 }));
    return abaPages({ opening: 100, pages: [pg(1), pg(4), pg(7), pg(10)], afterRows: (p, n, y) => (p < n - 1 ? [{ x, y: y + 2, text: 'Continued on next page' }] : []) }).pages;
  };

  it('A3b "Continued on next page" under the last row of each page, indented to the description column -> glued onto every page\'s last payee', async () => {
    await correctOrRefused(() => parsePages(contPages(125)), (st) => {
      expect(st.rows.filter((r) => /Continued/.test(r.description)).map((r) => r.description)).toEqual([]);
    });
  });

  it('A3c same note starting in the date column -> whole statement rejected ("unexpected text in the date column")', async () => {
    await mustParse(() => parsePages(contPages(40)), (st) => expect(st.rows).toHaveLength(12));
  });

  it('A4 wrapped line containing "...ENDING ... BALANCE" (e.g. VENDING/PENDING/SPENDING) is dropped as a "closing balance" line', async () => {
    const rows: ARow[] = [
      { date: 'Aug 05, 2026', desc: ['PURCHASE SNACK CO', 'VENDING MACHINE BALANCE TOPUP', 'PHNOM PENH KH'], out: 1.5 },
      base[2],
    ];
    const { pages } = abaPages({ opening: 100, pages: [rows] });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows[0].description).toBe('PURCHASE SNACK CO VENDING MACHINE BALANCE TOPUP PHNOM PENH KH');
    });
  });

  it('A5 wrapped line mentioning "previous balance" is dropped as an "opening balance" line (and the lines after it too)', async () => {
    const rows: ARow[] = [
      { date: 'Aug 05, 2026', desc: ['CARD REPAYMENT', 'PAYMENT OF PREVIOUS BALANCE', 'REF 99'], out: 30 },
      base[2],
    ];
    const { pages } = abaPages({ opening: 100, pages: [rows] });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows[0].description).toBe('CARD REPAYMENT PAYMENT OF PREVIOUS BALANCE REF 99');
    });
  });

  it('A6 fake-bold (pdf.js returns each word twice, offset 0.3pt) doubles the payee text', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    const items = await itemsOf(pages);
    const bold = items.flatMap((i) => (i.str === 'GRAB* RIDE' ? [i, { ...i, x: i.x + 0.3 }] : [i]));
    await correctOrRefused(() => parseStatementItems(bold), (st) => {
      expect(st.rows[2].description).toBe('GRAB* RIDE');
    });
  });

  it('A7 date and time in one pdf.js item ("Aug 05, 2026 09:15 AM") -> time lost and pasted into the payee', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', dateText: 'Aug 05, 2026 09:15 AM', desc: ['PURCHASE CAFE ONE'], out: 4.5 }];
    const { pages } = abaPages({ opening: 100, pages: [rows] });
    // widen the date column so the one-item "date + time" cell fits (description column moves to x=150)
    const shifted = [pages[0].map((t) => (t.x >= 125 && t.x < 300 ? { ...t, x: t.x + 25 } : t))];
    await correctOrRefused(() => parsePages(shifted), (st) => {
      expect(st.rows[0].description).toBe('PURCHASE CAFE ONE');
      expect(st.rows[0].time).toBe('09:15');
    });
  });

  it('A8 vertically-centred cells (first description line ABOVE the date/amount line) shift text into the previous row', async () => {
    // Row cell content is vertically centred: desc line 1 at y-5.5, date+amounts at y, desc line 2 at y+5.5
    const t = [
      { x: 40, y: 40, text: 'ABA BANK', size: 12 },
      { x: 40, y: 70, text: 'Account Number: 000 111 812' },
      { x: 40, y: 84, text: 'Period: Aug 01, 2026 - Aug 31, 2026' },
      { x: 40, y: 98, text: 'Beginning Balance' }, right(560, money(100), 98),
      { x: 40, y: 120, text: 'Date' }, { x: 125, y: 120, text: 'Description' }, { x: 330, y: 120, text: 'Money In' }, { x: 410, y: 120, text: 'Money Out' }, { x: 515, y: 120, text: 'Balance' },
      // row 1 (single line)
      { x: 40, y: 140, text: 'Aug 05, 2026' }, { x: 125, y: 140, text: 'GRAB* RIDE' }, right(452, '2.00', 140), right(548, '98.00', 140),
      // row 2 (two description lines, date vertically centred)
      { x: 125, y: 154, text: 'PURCHASE CAFE ONE' },
      { x: 40, y: 160, text: 'Aug 06, 2026' }, right(452, '3.00', 160), right(548, '95.00', 160),
      { x: 125, y: 166, text: 'PHNOM PENH KH' },
    ];
    await correctOrRefused(() => parsePages([t]), (st) => {
      expect(st.rows[0].description).toBe('GRAB* RIDE');
      expect(st.rows[1].description).toBe('PURCHASE CAFE ONE PHNOM PENH KH');
    });
  });

  it('A9 a wrapped line repeated at the same height on 2 of 2 pages is treated as page furniture and dropped', async () => {
    // Same normalised text (digits -> #) at the same height on both pages, and nowhere else.
    const p1: ARow[] = [
      { date: 'Aug 05, 2026', desc: ['PURCHASE CAFE ONE', 'PHNOM PENH KH'], out: 4.5 },
      { date: 'Aug 06, 2026', desc: ['FUNDS RECEIVED FROM A', '(012 345 678)'], in: 20 },
    ];
    const p2: ARow[] = [
      { date: 'Aug 07, 2026', desc: ['PURCHASE CAFE ONE', 'PHNOM PENH KH'], out: 4.5 },
      { date: 'Aug 08, 2026', desc: ['PURCHASE CAFE TWO', 'PHNOM PENH KH'], out: 4.5 },
      { date: 'Aug 09, 2026', desc: ['PURCHASE CAFE THREE', 'PHNOM PENH KH'], out: 4.5 },
      { date: 'Aug 10, 2026', desc: ['FUNDS RECEIVED FROM B', '(098 765 432)'], in: 20 },
    ];
    const { pages } = abaPages({ opening: 100, pages: [p1, p2] });
    // align: put page-2 row 4 at the same height as page-1 row 2
    const y1 = pages[0].find((t) => t.text === '(012 345 678)')!.y;
    const y2 = pages[1].find((t) => t.text === '(098 765 432)')!.y;
    pages[1] = pages[1].map((t) => (t.y >= y2 - 11 && t.y <= y2 ? { ...t, y: t.y + (y1 - y2) } : t));
    const fixed = pages; // y1-y2 small shift keeps row order on page 2
    await correctOrRefused(() => parsePages(fixed), (st) => {
      expect(st.rows).toHaveLength(6);
      expect(st.rows[1].description).toBe('FUNDS RECEIVED FROM A (012 345 678)');
      expect(st.rows[5].description).toBe('FUNDS RECEIVED FROM B (098 765 432)');
    });
  });
});

describe('ABA: rows dropped / wrong numbers (silent-wrong)', () => {
  it('A10 transaction rows repeated (digits masked) at the same height on 2 of 2 pages are dropped as page furniture: first+last row -> silently lost', async () => {
    // No "Beginning Balance" line (opening derived from row 1) and no closing line - both are accepted layouts.
    const grab = (date: string): ARow => ({ date, desc: ['GRAB* RIDE'], out: 2.1 });
    const p1: ARow[] = [grab('Aug 05, 2026'), { date: 'Aug 06, 2026', desc: ['SHOP A'], out: 10 }, { date: 'Aug 07, 2026', desc: ['SHOP B'], out: 10 }];
    const p2: ARow[] = [{ date: 'Aug 08, 2026', desc: ['SHOP C', 'PHNOM PENH KH'], out: 10 }, { date: 'Aug 09, 2026', desc: ['SHOP D'], out: 10 }, { date: 'Aug 09, 2026', desc: ['SHOP E'], out: 10 }, grab('Aug 10, 2026')];
    const { pages } = abaPages({ opening: null, pages: [p1, p2] });
    // the printed opening isn't there, so balances start from 0: shift them to a positive 2-digit range
    for (const pg of pages) for (const t of pg) if (t.x > 500 && /^-?[\d,]+\.\d\d$/.test(t.text)) t.text = (Number(t.text.replace(/,/g, '')) + 99.9).toFixed(2);
    const ys = pages.map((pg) => pg.filter((t) => t.text === 'GRAB* RIDE').map((t) => Math.round(t.y / 3)));
    expect(ys[0][0]).toBe(ys[1][0]); // the coincidence we rely on
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows).toHaveLength(7);
    });
  });

  it('A10b same furniture false-positive in the middle of the statement -> misleading "balance check failed" rejection', async () => {
    const p1: ARow[] = [
      { date: 'Aug 05, 2026', desc: ['PURCHASE CAFE ONE'], out: 14.5 },
      { date: 'Aug 06, 2026', desc: ['GRAB* RIDE'], out: 2.1 },
    ];
    const p2: ARow[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => ({ date: `Aug ${String(7 + i).padStart(2, '0')}, 2026`, desc: ['SHOP ' + x], out: 10 }));
    p2.push({ date: 'Aug 13, 2026', desc: ['GRAB* RIDE'], out: 3.4 });
    const { pages } = abaPages({ opening: 100, pages: [p1, p2] });
    await mustParse(() => parsePages(pages), (st) => expect(st.rows).toHaveLength(9));
  });

  it('A19 no opening-balance line: the first row\'s amount is never checked, so an unreadable amount ("+20.00", fake-bold) becomes 0.00', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', desc: ['FUNDS RECEIVED FROM SOMEONE'], in: 20 }, base[2]];
    const got: Record<string, unknown> = {};
    for (const variant of ['plus', 'bold'] as const) {
      const { pages } = abaPages({ opening: null, pages: [rows] });
      const items = (await itemsOf(pages)).flatMap((i) => {
        if (i.str !== '20.00' || i.x > 450) return [i]; // the Money In item only, not the balance
        return variant === 'plus' ? [{ ...i, str: '+20.00', x: i.x - 5 }] : [i, { ...i, x: i.x + 0.3 }];
      });
      const o = await correctOrRefused(() => parseStatementItems(items), () => {});
      got[variant] = o.ok ? { moneyIn: o.st.rows[0].moneyIn, description: o.st.rows[0].description } : 'refused';
    }
    // acceptable per variant: refused, or moneyIn 20
    for (const v of Object.values(got)) if (v !== 'refused') expect(got).toEqual({ plus: expect.objectContaining({ moneyIn: 20 }), bold: expect.objectContaining({ moneyIn: 20 }) });
  });

  it('A11 an undated row whose payee contains "TOTAL" (e.g. TOTAL petrol station) is skipped silently when it is the last row', async () => {
    const rows: ARow[] = [
      base[0],
      { date: '', dateText: '', desc: ['TOTAL CAMBODGE FUEL'], out: 10 }, // same-day row printed without a date
    ];
    const { pages } = abaPages({ opening: 100, pages: [rows] });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows).toHaveLength(2);
    });
  });

  it('A12 KHR account statement is parsed as USD (currency is never checked)', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', desc: ['PURCHASE MARKET'], out: 20000 }];
    const { pages } = abaPages({ opening: 400000, currency: 'KHR', pages: [rows] });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.currency).not.toBe('USD');
    });
  });

  it('A13 period line that also carries the statement/print date -> wrong period end, accepted', async () => {
    const { pages } = abaPages({ opening: 100, period: null, pages: [base], headerLines: [[{ x: 40, y: 0, text: 'Statement Date: Nov 09, 2026' }, { x: 300, y: 0, text: 'Period: Aug 01, 2026 - Aug 31, 2026' }]] });
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect([st.periodStart, st.periodEnd]).toEqual(['2026-08-01', '2026-08-31']);
    });
  });
});

describe('ABA: account number (silent-wrong / false-reject)', () => {
  it('A14 a number printed to the right on the account-number line is fused into the account (wrong last 3)', async () => {
    const pages = abaPages({
      opening: 100,
      pages: [base],
      customHeader: (y) => ({
        items: [
          { x: 40, y, text: 'Customer: TEST PERSON' },
          { x: 40, y: y + 14, text: 'Account Number: 000 111 812' },
          { x: 400, y: y + 14, text: '855 23 225 333' }, // bank hotline in the right-hand column, no label
          { x: 40, y: y + 28, text: 'Period: Aug 01, 2026 - Aug 31, 2026' },
          { x: 40, y: y + 42, text: 'Beginning Balance' }, right(560, money(100), y + 42),
        ],
        y: y + 62,
      }),
    }).pages;
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.accountLast3).toBe('812');
    });
  });

  it('A15 6-digit postal code on the line under "Account Name" -> rejected as two account numbers', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base], headerLines: [[{ x: 40, y: 0, text: 'Address: St 271, Phnom Penh 120101' }]] });
    await mustParse(() => parsePages(pages), (st) => expect(st.accountLast3).toBe('812'));
  });

  it('A16 phone number under "Account Name" and account labelled "A/C No." -> phone digits used as the account', async () => {
    const pages = abaPages({
      opening: 100,
      pages: [base],
      customHeader: (y) => ({
        items: [
          { x: 40, y, text: 'Account Name: TEST PERSON' },
          { x: 40, y: y + 14, text: 'Tel: 012 345 678' },
          { x: 40, y: y + 28, text: 'A/C No: 000 111 812' },
          { x: 40, y: y + 42, text: 'Period: Aug 01, 2026 - Aug 31, 2026' },
          { x: 40, y: y + 56, text: 'Beginning Balance' }, right(560, money(100), y + 56),
        ],
        y: y + 76,
      }),
    }).pages;
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.accountLast3).toBe('812');
    });
  });
});

describe('ABA: false rejects', () => {
  it('A17 "Balance carried forward" at the foot of page 1 (no final closing line) -> rejected', async () => {
    const { pages, balances } = abaPages({
      opening: 100,
      pages: [[base[0], base[1]], [base[2]]],
    });
    pages[0].push({ x: 40, y: 760, text: 'Balance carried forward' }, right(548, money(balances[1]), 760));
    await mustParse(() => parsePages(pages), (st) => expect(st.rows).toHaveLength(3));
  });

  it('A18 newest-first statement where all rows are on the same day -> rejected', async () => {
    const rows: ARow[] = [
      { date: 'Aug 05, 2026', desc: ['A'], out: 1 },
      { date: 'Aug 05, 2026', desc: ['B'], out: 2 },
      { date: 'Aug 05, 2026', desc: ['C'], in: 5 },
    ];
    const { pages, balances } = abaPages({ opening: 100, pages: [rows] });
    // print newest first: reverse the row lines (positions swap)
    const rowYs = [...new Set(pages[0].filter((t) => /^Aug 05/.test(t.text)).map((t) => t.y))];
    const map = new Map(rowYs.map((y, i) => [y, rowYs[rowYs.length - 1 - i]]));
    pages[0] = pages[0].map((t) => (map.has(t.y) ? { ...t, y: map.get(t.y)! } : t));
    expect(balances).toEqual([99, 97, 102]);
    await mustParse(() => parsePages(pages), (st) => expect(st.rows.map((r) => r.description)).toEqual(['A', 'B', 'C']));
  });
});

describe('ABA: things that should hold up', () => {
  it('H continuation line starting with "To:" / "Fee:" is kept', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', desc: ['TRANSFER', 'To: SOMEONE', 'Fee: 0.00 USD'], out: 5 }];
    const st = await mustParse(() => parsePages(abaPages({ opening: 100, pages: [rows] }).pages));
    expect(st.rows[0].description).toBe('TRANSFER To: SOMEONE Fee: 0.00 USD');
  });

  it('H amount formats in amount columns: 1,234.56 / $5.00 / 5.00 USD / (5.00) balance', async () => {
    const t = abaPages({ opening: 2000, pages: [[
      { date: 'Aug 05, 2026', desc: ['BIG'], out: 1234.56 },
      { date: 'Aug 06, 2026', desc: ['DOLLAR'], out: 5 },
      { date: 'Aug 07, 2026', desc: ['USD SUFFIX'], out: 5 },
      { date: 'Aug 08, 2026', desc: ['TO NEGATIVE'], out: 760.44 },
    ]] }).pages;
    t[0] = t[0].map((x) => (x.text === '5.00' && x.y === t[0].find((q) => q.text === 'DOLLAR')!.y ? { ...x, text: '$5.00' } : x));
    t[0] = t[0].map((x) => (x.text === '5.00' && x.y === t[0].find((q) => q.text === 'USD SUFFIX')!.y ? { ...x, text: '5.00 USD' } : x));
    t[0] = t[0].map((x) => (x.text === '-5.00' ? { ...x, text: '(5.00)' } : x));
    const st = await mustParse(() => parsePages(t));
    expect(st.rows.map((r) => r.moneyOut)).toEqual([1234.56, 5, 5, 760.44]);
    expect(st.rows[3].balance).toBe(-5);
  });

  it('H amount-like text inside descriptions (KHR 20,000.00 / Top up 50.00) stays in the description', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', desc: ['KHR 20,000.00 PAYMENT', 'Top up 50.00'], out: 5 }];
    const st = await mustParse(() => parsePages(abaPages({ opening: 100, pages: [rows] }).pages));
    expect(st.rows[0]).toMatchObject({ description: 'KHR 20,000.00 PAYMENT Top up 50.00', moneyOut: 5 });
  });

  it('H a separate amount-looking phrase in the description column is not read as money', async () => {
    const { pages } = abaPages({ opening: 100, pages: [[{ date: 'Aug 05, 2026', desc: ['TOP UP'], out: 5 }]] });
    const y = pages[0].find((t) => t.text === 'TOP UP')!.y;
    pages[0].push({ x: 200, y, text: '50.00' });
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows[0]).toMatchObject({ moneyOut: 5, moneyIn: 0, description: 'TOP UP 50.00' });
  });

  it('H row with no balance / same amount in both columns / balance break -> StatementError', async () => {
    await mustRefuse(() => parsePages(abaPages({ opening: 100, pages: [[{ ...base[0], bal: null }]] }).pages), /no running balance/);
    const { pages } = abaPages({ opening: 100, pages: [[{ date: 'Aug 05, 2026', desc: ['X'], out: 5 }]] });
    const y = pages[0].find((t) => t.text === 'X')!.y;
    pages[0].push(right(368, '5.00', y));
    await mustRefuse(() => parsePages(pages), /both Money In and Money Out/);
  });

  it('H date split into "Aug" "05," "2026" items, and Money In/Out headers merged into one item', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    const split = pages[0].flatMap((t) => {
      if (t.text === 'Aug 06, 2026') return [{ ...t, text: 'Aug' }, { ...t, x: t.x + 19, text: '06,' }, { ...t, x: t.x + 35, text: '2026' }];
      if (t.text === 'Money In') return [{ ...t, text: 'Money In      Money Out' }];
      if (t.text === 'Money Out') return [];
      return [t];
    });
    const st = await mustParse(() => parsePages([split]));
    expect(st.rows.map((r) => [r.date, r.moneyIn, r.moneyOut])).toEqual([['2026-08-05', 0, 4.5], ['2026-08-06', 20, 0], ['2026-08-07', 0, 2.1]]);
  });

  it('H empty / whitespace-only items and NBSP are ignored', async () => {
    const items = itemsDirect(abaPages({ opening: 100, pages: [base] }).pages);
    items.push({ str: '', x: 200, y: 300, w: 0, h: 9, page: 1 }, { str: '   ', x: 60, y: 175, w: 9, h: 9, page: 1 }, { str: ' ', x: 400, y: 160, w: 3, h: 9, page: 1 });
    const st = await mustParse(() => parseStatementItems(items));
    expect(st.rows).toHaveLength(3);
  });

  it('H header repeated mid-page, and column x shifting between pages (header repeated)', async () => {
    const { pages } = abaPages({ opening: 100, pages: [[base[0]], [base[1], base[2]]], colShift: (p) => (p === 1 ? 12 : 0) });
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows.map((r) => [r.moneyIn, r.moneyOut])).toEqual([[0, 4.5], [20, 0], [0, 2.1]]);
  });

  it('H column shift on a page with no repeated header is caught by the balance chain', async () => {
    const { pages } = abaPages({ opening: 100, pages: [[base[0]], [base[1], base[2]]], repeatHeader: false, colShift: (p) => (p === 1 ? -80 : 0) });
    await mustRefuse(() => parsePages(pages));
  });

  it('H zero transactions with an opening balance parses to an empty statement', async () => {
    const st = await mustParse(() => parsePages(abaPages({ opening: 100, pages: [[]] }).pages));
    expect(st.rows).toHaveLength(0);
    expect(st.closing).toBe(100);
  });

  it('H two different account numbers in the header -> StatementError', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base], headerLines: [[{ x: 40, y: 0, text: 'Account Number: 000 222 013' }]] });
    await mustRefuse(() => parsePages(pages), /more than one/);
  });

  it('H "Sept" / "September" / "Sep" row dates', async () => {
    const rows: ARow[] = [
      { date: 'Sep 05, 2026', desc: ['A'], out: 1 },
      { date: 'Sept 06, 2026', desc: ['B'], out: 1 },
      { date: 'September 07, 2026', desc: ['C'], out: 1 },
    ];
    const st = await mustParse(() => parsePages(abaPages({ opening: 100, period: 'Sep 01, 2026 - Sep 30, 2026', pages: [rows] }).pages));
    expect(st.rows.map((r) => r.date)).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
  });

  it('H time printed under the date, newest-first across days', async () => {
    const rows: ARow[] = [
      { date: 'Aug 07, 2026', desc: ['C'], out: 1, time: '09:15 PM' },
      { date: 'Aug 06, 2026', desc: ['B', 'LINE 2'], out: 2, time: '08:00 AM' },
    ];
    const { pages } = abaPages({ opening: 100, pages: [rows] });
    // balances printed for newest-first: B happened first
    pages[0] = pages[0].map((t) => (t.text === '99.00' ? { ...t, text: '97.00' } : t.text === '97.00' ? { ...t, text: '98.00' } : t));
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows.map((r) => [r.date, r.time, r.description])).toEqual([['2026-08-06', '08:00', 'B LINE 2'], ['2026-08-07', '21:15', 'C']]);
  });
});
