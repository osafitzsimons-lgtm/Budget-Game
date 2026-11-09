// Parser edge cases found in the security/robustness audit (synthetic layouts, no real data). Each test asserts the correct result or a clear refusal.
import { describe, expect, it } from 'vitest';
import { parseStatementItems } from '../../src/parsers/index';
import { correctOrRefused, itemsOf, mustParse, mustRefuse, parsePages, type RevBlock, revPages, revSection, type RRow } from './kit';

const rows: RRow[] = [
  { date: '2 Mar 2026', desc: ['Coffee Shop'], out: 3.2, extra: ['Card: 123456******9999'] },
  { date: '3 Mar 2026', desc: ['Payment from A Friend', 'for dinner'], in: 25, extra: ['From: A FRIEND', 'Reference: dinner'] },
  { date: '4 Mar 2026', desc: ['Supermarket'], out: 12.4 },
];
const sec = (rs: RRow[] = rows, opening = 100) => revSection(opening, '1 March 2026', '31 March 2026', rs);

describe('Revolut: baseline sanity of the audit kit', () => {
  it('parses the kit layout', async () => {
    const st = await mustParse(() => parsePages(revPages({ blocks: sec() })));
    expect(st.rows.map((r) => [r.description, r.moneyOut, r.moneyIn, r.balance])).toEqual([
      ['Coffee Shop', 3.2, 0, 96.8],
      ['Payment from A Friend for dinner', 0, 25, 121.8],
      ['Supermarket', 12.4, 0, 109.4],
    ]);
    expect(st.accountLast3).toBe('554');
  });
});

describe('Revolut: description text lost or swallowed (silent-wrong)', () => {
  it('R1 wrapped description line that falls onto the next page is silently dropped', async () => {
    const blocks = sec([rows[0], { ...rows[1], desc: ['Payment from A Friend'], extra: [] }, rows[2]]);
    // page break right after row 2's first line; its wrap line is the first thing under the repeated header
    const i = blocks.findIndex((b) => b.kind === 'row' && b.row.desc[0] === 'Payment from A Friend');
    blocks.splice(i + 1, 0, { kind: 'pageBreak' }, { kind: 'tableHeader' }, { kind: 'text', x: 120, text: 'for dinner', dy: -4 }, { kind: 'gap', dy: 4 });
    await correctOrRefused(() => parsePages(revPages({ blocks })), (st) => {
      expect(st.rows[1].description).toBe('Payment from A Friend for dinner');
    });
  });

  it('R2 wrapped description line containing a "legal" keyword (e.g. "Revolut Ltd", "+44 20 ...") is dropped, and so is every line after it', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Cashback reward paid by', 'Revolut Ltd', 'March promo'], in: 5 }, rows[2]];
    await correctOrRefused(() => parsePages(revPages({ blocks: sec(rs) })), (st) => {
      expect(st.rows[0].description).toBe('Cashback reward paid by Revolut Ltd March promo');
    });
  });

  it('R3 note/footer indented into the description column right under the last row is glued onto the payee', async () => {
    const blocks: RevBlock[] = [...sec(), { kind: 'text', x: 120, text: 'Your balance includes pending card payments.', dy: -3 }];
    await correctOrRefused(() => parsePages(revPages({ blocks })), (st) => {
      expect(st.rows[2].description).toBe('Supermarket');
    });
  });

  it('R4 fake-bold duplicate items double the payee text', async () => {
    const items = await itemsOf(revPages({ blocks: sec() }));
    const bold = items.flatMap((i) => (i.str === 'Supermarket' ? [i, { ...i, x: i.x + 0.25, y: i.y + 0.1 }] : [i]));
    await correctOrRefused(() => parseStatementItems(bold), (st) => {
      expect(st.rows[2].description).toBe('Supermarket');
    });
  });
});

describe('Revolut: wrong numbers (silent-wrong)', () => {
  it('R5 summary with a savings pocket: Total line used as the account opening/closing -> balances include the pocket', async () => {
    // Current account 100 -> 109.40, Savings vault 1,000 (no movement). Transactions table = current account only.
    const blocks = sec();
    blocks[0] = {
      kind: 'summary', opening: 1100, out: 15.6, in: 25, closing: 1109.4,
      products: [
        { label: 'Account (Current Account)', opening: 100, out: 15.6, in: 25, closing: 109.4 },
        { label: 'Savings (Instant Access)', opening: 1000, out: 0, in: 0, closing: 1000 },
      ],
    };
    await correctOrRefused(() => parsePages(revPages({ blocks })), (st) => {
      expect([st.opening, st.closing]).toEqual([100, 109.4]);
      expect(st.rows.map((r) => r.balance)).toEqual([96.8, 121.8, 109.4]);
    });
  });

  it('R6 rows printed newest-first inside a section: printed Balance column ignored, so row order and running balances come out wrong', async () => {
    // Printed balances are correct for newest-first; parser computes balances top-down from the opening.
    const blocks: RevBlock[] = [
      { kind: 'summary', opening: 100, out: 15.6, in: 25, closing: 109.4 },
      { kind: 'heading', text: 'Account transactions from 1 March 2026 to 31 March 2026' },
      { kind: 'tableHeader' },
      { kind: 'row', row: rows[2], opening: 121.8 }, // 109.40
      { kind: 'row', row: { ...rows[1], extra: [] }, opening: 96.8 }, // 121.80
      { kind: 'row', row: { ...rows[0], extra: [] }, opening: 100 }, // 96.80
    ];
    await correctOrRefused(() => parsePages(revPages({ blocks })), (st) => {
      // whatever order is returned, each row's balance must be what the statement prints next to it
      const printed: Record<string, number> = { Supermarket: 109.4, 'Payment from A Friend for dinner': 121.8, 'Coffee Shop': 96.8 };
      for (const r of st.rows) expect(r.balance, r.description).toBe(printed[r.description]);
    });
  });
});

describe('Revolut: false rejects', () => {
  it('R7 a page-1 transfer detail line mentioning an IBAN -> "more than one account number"', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Transfer to J Smith'], out: 50, extra: ['To: J SMITH, IBAN GB33BUKB20201555555555'] }];
    await mustParse(() => parsePages(revPages({ blocks: sec(rs) })), (st) => expect(st.accountLast3).toBe('554'));
  });

  it('R8 "Account number" and "Sort code" printed side by side on one line -> "more than one account number"', async () => {
    const pages = revPages({ blocks: sec(), account: '' , headerExtra: [[{ x: 40, y: 0, text: 'Account number' }, { x: 120, y: 0, text: '00000554' }, { x: 220, y: 0, text: 'Sort code' }, { x: 300, y: 0, text: '04-00-75' }]] });
    await mustParse(() => parsePages(pages), (st) => expect(st.accountLast3).toBe('554'));
  });

  it('R9 a GBP card payment abroad whose detail line shows the original "€12.35" -> rejected as a non-GBP statement', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Cafe Paris'], out: 10.55, extra: ['Revolut Rate £1.00 = €1.17'] }];
    const blocks = sec(rs);
    const i = blocks.findIndex((b) => b.kind === 'row');
    blocks.splice(i + 1, 0, { kind: 'text', x: 120, text: '€12.35', size: 7, dy: -5 });
    await mustParse(() => parsePages(revPages({ blocks })), (st) => expect(st.rows[0].moneyOut).toBe(10.55));
  });

  it('R10 a payee mentioning "Revolut Ltd" (cashback) makes the whole row vanish -> totals mismatch rejection', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Cashback from Revolut Ltd'], in: 5 }, rows[2]];
    await mustParse(() => parsePages(revPages({ blocks: sec(rs) })), (st) => expect(st.rows).toHaveLength(2));
  });

  it('R11 detail line "Reference: ... transactions to ..." is taken for a table heading -> "unknown table"', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Transfer to J Smith'], out: 50, extra: ['To: J SMITH', 'Reference: split transactions to date'] }];
    await mustParse(() => parsePages(revPages({ blocks: sec(rs) })), (st) => expect(st.rows).toHaveLength(1));
  });

  it('R12 "Pending" / "Reverted" tables whose heading lacks the word "transactions" are read as account rows', async () => {
    for (const heading of ['Pending from 1 March 2026 to 31 March 2026', 'Reverted from 1 March 2026 to 31 March 2026']) {
      const blocks: RevBlock[] = [...sec(), { kind: 'gap', dy: 10 }, { kind: 'heading', text: heading }, { kind: 'tableHeader' }, { kind: 'row', row: { date: '30 Mar 2026', desc: ['Hotel hold'], out: 80 } }];
      await mustParse(() => parsePages(revPages({ blocks })), (st) => expect(st.rows).toHaveLength(3));
    }
  });
});

describe('Revolut: things that should hold up', () => {
  it('H "Pending transactions from ..." table after the account table is ignored', async () => {
    const blocks: RevBlock[] = [...sec(), { kind: 'gap', dy: 10 }, { kind: 'heading', text: 'Pending transactions from 1 March 2026 to 31 March 2026' }, { kind: 'tableHeader' }, { kind: 'row', row: { date: '30 Mar 2026', desc: ['Hotel hold'], out: 80 } }];
    const st = await mustParse(() => parsePages(revPages({ blocks })));
    expect(st.rows).toHaveLength(3);
  });

  it('H sections printed in reverse order are re-chained and balances are right', async () => {
    const a = revSection(100, '1 August 2026', '31 August 2026', [{ date: '2 Aug 2026', desc: ['A'], out: 10 }]);
    const b = revSection(90, '1 September 2026', '30 September 2026', [{ date: '2 Sept 2026', desc: ['B'], in: 5 }]);
    const st = await mustParse(() => parsePages(revPages({ blocks: [...b, ...a] })));
    expect(st.rows.map((r) => [r.date, r.balance])).toEqual([['2026-08-02', 90], ['2026-09-02', 95]]);
    expect([st.periodStart, st.periodEnd, st.opening, st.closing]).toEqual(['2026-08-01', '2026-09-30', 100, 95]);
  });

  it('H "Sept" / "Sep" / "September" row dates and headings', async () => {
    const rs: RRow[] = ['4 Sept 2026', '5 Sep 2026', '6 September 2026'].map((d, i) => ({ date: d, desc: ['X' + i], out: 1 }));
    const st = await mustParse(() => parsePages(revPages({ blocks: revSection(10, '1 Sept 2026', '30 Sept 2026', rs) })));
    expect(st.rows.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
    expect(st.periodFromHeader).toBe(true);
  });

  it('H zero-transaction section', async () => {
    const st = await mustParse(() => parsePages(revPages({ blocks: revSection(10, '1 March 2026', '31 March 2026', []) })));
    expect([st.rows.length, st.opening, st.closing]).toEqual([0, 10, 10]);
  });

  it('H IBAN-only header (no "Account number" line)', async () => {
    const st = await mustParse(() => parsePages(revPages({ blocks: sec(), account: '', iban: 'GB29 REVO 0099 6912 3456 78' })));
    expect(st.accountLast3).toBe('678');
  });

  it('H money out vs in decided by column even when Money out/Money in headers are one merged item', async () => {
    const pages = revPages({ blocks: sec() });
    pages[0] = pages[0].flatMap((t) => (t.text === 'Money out' && t.x === 350 ? [{ ...t, text: 'Money out          Money in' }] : t.text === 'Money in' && t.x === 430 ? [] : [t]));
    const st = await mustParse(() => parsePages(pages));
    expect(st.rows.map((r) => [r.moneyOut, r.moneyIn])).toEqual([[3.2, 0], [0, 25], [12.4, 0]]);
  });

  it('H detail lines (Revolut Rate, To:, Card:, Reference:, Fee:) and the legal footer are not stored', async () => {
    const rs: RRow[] = [{ date: '2 Mar 2026', desc: ['Shop'], out: 1, extra: ['Revolut Rate £1.00 = $1.33', 'To: X', 'Card: 1234******9999', 'Reference: y', 'Fee: £0.00'] }];
    const st = await mustParse(() => parsePages(revPages({ blocks: sec(rs) })));
    expect(st.rows[0].description).toBe('Shop');
  });

  it('H non-GBP statement and summary/rows mismatch -> StatementError', async () => {
    await mustRefuse(() => parsePages(revPages({ blocks: sec(), symbol: '$' })), /only GBP/);
    const blocks = sec();
    blocks[0] = { kind: 'summary', opening: 100, out: 15.6, in: 26, closing: 110.4 };
    await mustRefuse(() => parsePages(revPages({ blocks })), /money in/);
  });

  it('H detail line falling onto the next page is ignored without harm', async () => {
    const blocks = sec([{ ...rows[0], extra: [] }, rows[2]]);
    const i = blocks.findIndex((b) => b.kind === 'row');
    blocks.splice(i + 1, 0, { kind: 'pageBreak' }, { kind: 'tableHeader' }, { kind: 'text', x: 120, text: 'Card: 123456******9999', size: 7, dy: -4 });
    const st = await mustParse(() => parsePages(revPages({ blocks })));
    expect(st.rows.map((r) => r.description)).toEqual(['Coffee Shop', 'Supermarket']);
  });
});
