import { describe, expect, it } from 'vitest';
import { categorise, learnRules, type CategoriseContext } from '../src/shared/categorise';
import { maskPayee, payeeKey } from '../src/shared/privacy';

const ctx = (rules: [string, string][] = [], extra: Partial<CategoriseContext> = {}): CategoriseContext => ({
  rules: new Map(rules), ownNames: ['TESTNAME'], ownLast3: ['812', '013', '811', '554'], savingsLast3: '811', savingsKeywords: [], ...extra,
});

describe('categorising', () => {
  it('remembered payee comes first', () => {
    expect(categorise('Cafe One!', 25, ctx([[payeeKey('Cafe One!'), 'Eating out and bars']])).category).toBe('Eating out and bars');
    expect(categorise('PURCHASE CAFE ONE BKK1', 25, ctx([['cafe one', 'Eating out and bars']])).category).toBe('Eating out and bars');
  });
  it('Grab and TADA amount rules', () => {
    expect(categorise('Grab', 4.99, ctx()).category).toBe('Rides');
    expect(categorise('GRAB* A-1234', 5, ctx()).category).toBe('Grab orders');
    expect(categorise('TADA Cambodia', 3, ctx()).category).toBe('Rides');
    expect(categorise('Grab refund', -2.11, ctx()).category).toBe('Rides');
    // remembered rules never override the Grab amount rule
    expect(categorise('Grab', 12, ctx([['grab', 'Rides']])).category).toBe('Grab orders');
  });
  it('unknown payees: small → street food, $10+ → Unidentified for review', () => {
    expect(categorise('Random stall', 9.99, ctx())).toMatchObject({ category: 'Street food and small QR', needsReview: false });
    expect(categorise('Random shop', 10, ctx())).toMatchObject({ category: 'Unidentified', needsReview: true });
  });
  it('moves between my own accounts are Transfer, and the nominated savings account counts as saved', () => {
    expect(categorise('Transfer to TESTNAME', 100, ctx()).category).toBe('Transfer');
    expect(categorise('FUNDS TRANSFERRED TO 000 111 013', 50, ctx(), '812').category).toBe('Transfer');
    const s = categorise('FUNDS TRANSFERRED TO 000 222 811', 500, ctx(), '812');
    expect(s).toMatchObject({ category: 'Transfer', savings: true });
  });
  it('cash withdrawals count as negotiable spending when withdrawn', () => {
    expect(categorise('Cash withdrawal at Main Street', 100, ctx([['cash withdrawal at main street', 'Transfer']]))).toMatchObject({ category: 'Unidentified', isCash: true, needsReview: false });
  });
  it('unknown money in is not spending, and bigger amounts get reviewed', () => {
    expect(categorise('Someone', -50, ctx())).toMatchObject({ category: 'Transfer', needsReview: true });
  });
  it('learns rules by majority, skipping Unidentified and built-ins', () => {
    const r = learnRules([
      { payee: 'Cafe A', category: 'Eating out and bars' }, { payee: 'Cafe A', category: 'Eating out and bars' }, { payee: 'Cafe A', category: 'Unidentified' },
      { payee: 'Grab', category: 'Rides' }, { payee: 'Mystery', category: 'Unidentified' },
    ]);
    expect([...r]).toEqual([['cafe a', 'Eating out and bars']]);
  });
});

describe('privacy', () => {
  it('masks account and card numbers to the last 3 digits', () => {
    expect(maskPayee('FUNDS RECEIVED FROM A PERSON (012 345 678)')).toBe('FUNDS RECEIVED FROM A PERSON (•••678)');
    expect(maskPayee('Card 412345******1234')).toBe('Card •••234');
    expect(maskPayee('Shop 12')).toBe('Shop 12');
    expect(maskPayee('Ref 20260805123456')).toBe('Ref •••456');
  });
});
