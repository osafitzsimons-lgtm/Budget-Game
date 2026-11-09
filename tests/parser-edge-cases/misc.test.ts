// Parser edge cases found in the security/robustness audit (synthetic layouts, no real data). Each test asserts the correct result or a clear refusal.
// Each test asserts what the spec requires; a FAILING test is a reproduced bug.
import { describe, expect, it } from 'vitest';
import { parseStatementItems, type TextItem } from '../../src/parsers/index';
import { abaPages, type ARow, correctOrRefused, itemsDirect, itemsOf, money, mustParse, mustRefuse, parsePages, revPages, revSection, right, type RRow } from './kit';

const base: ARow[] = [
  { date: 'Aug 05, 2026', desc: ['PURCHASE CAFE ONE', 'PHNOM PENH KH'], out: 4.5 },
  { date: 'Aug 06, 2026', desc: ['FUNDS RECEIVED FROM SOMEONE'], in: 20 },
  { date: 'Aug 07, 2026', desc: ['GRAB* RIDE'], out: 2.1 },
];

describe('odd pdf.js output', () => {
  it('M1 a stamp/watermark item ("COPY") between two rows is appended to the row above', async () => {
    const items = await itemsOf(abaPages({ opening: 100, pages: [base] }).pages);
    const y = items.find((i) => i.str === 'FUNDS RECEIVED FROM SOMEONE')!.y;
    items.push({ str: 'COPY', x: 230, y: y + 9, w: 60, h: 24, page: 1 });
    await correctOrRefused(() => parseStatementItems(items), (st) => {
      expect(st.rows[1].description).toBe('FUNDS RECEIVED FROM SOMEONE');
    });
  });

  it('M2 "-" placeholders printed in the empty Money In/Out column are pasted into the payee', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    for (const r of base) {
      const y = pages[0].find((t) => t.text === r.date)!.y;
      pages[0].push(r.in ? right(452, '-', y) : right(368, '-', y));
    }
    await correctOrRefused(() => parsePages(pages), (st) => {
      expect(st.rows.map((r) => r.description)).toEqual(['PURCHASE CAFE ONE PHNOM PENH KH', 'FUNDS RECEIVED FROM SOMEONE', 'GRAB* RIDE']);
    });
  });

  it('H a long (70-char) wrapped description line is kept (ABA)', async () => {
    const rows: ARow[] = [{ date: 'Aug 05, 2026', desc: ['TRANSFER TO SOMEONE', 'REMARK: RENT FOR AUGUST 2026 APARTMENT 12B BOREY PENG HUOTH THE STAR'], out: 300 }];
    await correctOrRefused(() => parsePages(abaPages({ opening: 1000, pages: [rows] }).pages), (st) => {
      expect(st.rows[0].description).toContain('REMARK: RENT');
    });
  });

  it('M4 overlapping hidden OCR text layer (same words again at the same spot) doubles every payee', async () => {
    const items = itemsDirect(abaPages({ opening: 100, pages: [base] }).pages);
    const ocr: TextItem[] = items.filter((i) => /[A-Z]{3}/.test(i.str) && i.x >= 125 && i.x < 300 && i.y > 150).map((i) => ({ ...i, x: i.x + 0.5, w: i.w - 1 }));
    await correctOrRefused(() => parseStatementItems([...items, ...ocr]), (st) => {
      expect(st.rows[2].description).toBe('GRAB* RIDE');
    });
  });
});

describe('layout detection', () => {
  it('M5 another bank\'s statement that mentions "ABA" in a payee is parsed as an ABA USD statement', async () => {
    const t = [
      { x: 40, y: 40, text: 'ACLEDA BANK PLC.', size: 12 },
      { x: 40, y: 70, text: 'Account Number: 0001-02-345678-9-1' },
      { x: 40, y: 84, text: 'Currency: KHR' },
      { x: 40, y: 98, text: 'Opening Balance' }, right(560, '100.00', 98),
      { x: 40, y: 120, text: 'Date' }, { x: 125, y: 120, text: 'Description' }, { x: 330, y: 120, text: 'Credit' }, { x: 410, y: 120, text: 'Debit' }, { x: 515, y: 120, text: 'Balance' },
      { x: 40, y: 140, text: 'Aug 05, 2026' }, { x: 125, y: 140, text: 'FUNDS TRANSFER FROM ABA BANK' }, right(368, '50.00', 140), right(548, '150.00', 140),
    ];
    await correctOrRefused(() => parsePages([t]), (st) => {
      expect(st.bank).not.toBe('ABA');
    });
  });

  it('M6 an ABA statement titled "Account Transactions" with a Revolut top-up row is routed to the Revolut parser and rejected', async () => {
    const { pages } = abaPages({ opening: 100, pages: [[...base, { date: 'Aug 08, 2026', desc: ['TRANSFER TO REVOLUT'], out: 10 }]] });
    pages[0] = pages[0].map((t) => (t.text === 'ACCOUNT STATEMENT' ? { ...t, text: 'Account Transactions' } : t));
    await mustParse(() => parsePages(pages), (st) => expect(st.bank).toBe('ABA'));
  });
});

describe('multi-account PDFs', () => {
  const second = (opening: number) => abaPages({ opening, account: '000 222 013', pages: [[{ date: 'Aug 10, 2026', desc: ['OTHER ACCOUNT SPEND'], out: 1 }]] }).pages[0];

  it('H two ABA statements for different accounts in one PDF -> StatementError (balance chain breaks)', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    await mustRefuse(() => parsePages([...pages, second(500)]));
  });

  it('M7 ... but when account B happens to open at account A\'s closing balance the two accounts are merged under A', async () => {
    const { pages, balances } = abaPages({ opening: 100, pages: [base] });
    await correctOrRefused(() => parsePages([...pages, second(balances[balances.length - 1])]), (st) => {
      expect(st.rows.every((r) => r.description !== 'OTHER ACCOUNT SPEND')).toBe(true);
    });
  });
});

describe('performance', () => {
  const N = 6000;
  it(`H ABA with ${N} rows (2-line descriptions, 20 rows/page) parses in < 3 s`, async () => {
    const rows: ARow[] = Array.from({ length: N }, (_, i) => ({ date: `Aug ${String(1 + (Math.floor(i / 200) % 31)).padStart(2, '0')}, 2026`, desc: [`SHOP ${i}`, 'PHNOM PENH KH'], ...(i % 5 ? { out: 1.25 } : { in: 7 }) }));
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const pages: ARow[][] = [];
    for (let i = 0; i < N; i += 20) pages.push(rows.slice(i, i + 20));
    const items = itemsDirect(abaPages({ opening: 10000, pages }).pages);
    const t0 = performance.now();
    const st = parseStatementItems(items);
    const ms = performance.now() - t0;
    expect(st.rows).toHaveLength(N);
    expect(ms).toBeLessThan(3000);
  });

  it(`H Revolut with ${N} rows parses in < 3 s`, async () => {
    const rows: RRow[] = Array.from({ length: N }, (_, i) => ({ date: `${1 + Math.floor(i / 200)} Mar 2026`, desc: [`Shop ${i}`], ...(i % 4 ? { out: 0.5 } : { in: 3 }), extra: i % 3 ? ['Card: 123456******9999'] : [] }));
    const blocks = revSection(100, '1 March 2026', '31 March 2026', rows, { pageBreakAfter: rows.map((_, i) => i).filter((i) => i % 25 === 24) });
    const items = itemsDirect(revPages({ blocks }));
    const t0 = performance.now();
    const st = parseStatementItems(items);
    const ms = performance.now() - t0;
    expect(st.rows).toHaveLength(N);
    expect(ms).toBeLessThan(3000);
  });
});

describe('misc things that should hold up', () => {
  it('H header repeated mid-page between rows', async () => {
    const { pages } = abaPages({ opening: 100, pages: [base] });
    const y = pages[0].find((t) => t.text === 'GRAB* RIDE')!.y;
    pages[0] = pages[0].map((t) => (t.y >= y && t.y < 700 ? { ...t, y: t.y + 20 } : t));
    pages[0].push({ x: 40, y: y + 2, text: 'Date' }, { x: 125, y: y + 2, text: 'Description' }, { x: 330, y: y + 2, text: 'Money In' }, { x: 410, y: y + 2, text: 'Money Out' }, { x: 515, y: y + 2, text: 'Balance' });
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows.map((r) => r.description)).toEqual(['PURCHASE CAFE ONE PHNOM PENH KH', 'FUNDS RECEIVED FROM SOMEONE', 'GRAB* RIDE']);
  });

  it('H very long one-line payee on the date line is kept whole', async () => {
    const long = 'PAYMENT TO A MERCHANT WITH A VERY VERY LONG NAME';
    const st = await mustParse(() => parsePages(abaPages({ opening: 100, pages: [[{ date: 'Aug 05, 2026', desc: [long], out: 1 }]] }).pages));
    expect(st.rows[0].description).toBe(long);
  });

  it('H no-text PDF and unrecognised layout -> StatementError (not a crash)', async () => {
    await mustRefuse(() => parseStatementItems([]), /no readable text/);
    await mustRefuse(() => parseStatementItems([{ str: ' ', x: 0, y: 0, w: 1, h: 1, page: 1 }]), /no readable text/);
    await mustRefuse(() => parsePages([[{ x: 40, y: 40, text: 'ABA BANK' }, { x: 40, y: 60, text: money(1) }]]), /Unrecognised/);
  });

  it('H garbage coordinates (NaN / negative / zero widths) never throw a non-StatementError', async () => {
    const items = itemsDirect(abaPages({ opening: 100, pages: [base] }).pages).map((i, k) => (k % 7 === 0 ? { ...i, w: 0 } : k % 11 === 0 ? { ...i, x: Number.NaN } : i));
    await correctOrRefused(() => parseStatementItems(items), () => {});
  });
});
