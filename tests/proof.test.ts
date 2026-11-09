import { describe, expect, it } from 'vitest';
import { checkProof, type ProofInput } from '../src/shared/proof';

const base = (o: Partial<ProofInput> = {}): ProofInput => ({
  statement: { accountId: 'ABA-812', periodStart: '2026-11-08', periodEnd: '2026-11-14', periodFromHeader: true, opening: 100, closing: 80, currency: 'USD' },
  rows: [{ hash: 'a', balance: 90 }, { hash: 'b', balance: 80 }],
  lastGood: { periodEnd: '2026-11-07', closing: 100 },
  knownHashes: new Set(),
  today: '2026-11-15',
  accountOk: true,
  accountDetail: 'ABA 812',
  ...o,
});
const byId = (r: ReturnType<typeof checkProof>, id: string) => r.checks.find((c) => c.id === id)!;

describe('proof checks', () => {
  it('passes a clean follow-on statement', () => {
    const r = checkProof(base());
    expect(r.ok).toBe(true);
    expect(r.newRows).toBe(2);
  });
  it('first upload per account sets the baseline', () => {
    const r = checkProof(base({ lastGood: null, statement: { ...base().statement, opening: 5000 } }));
    expect(r.ok).toBe(true);
    expect(r.baseline).toBe(true);
  });
  it('wrong account fails', () => {
    expect(checkProof(base({ accountOk: false })).ok).toBe(false);
  });
  it('a statement that stops before last Saturday is still saved (late uploads), but does not cover the week', () => {
    const r = checkProof(base({ statement: { ...base().statement, periodEnd: '2026-11-13' } }));
    expect(byId(r, 'reaches-saturday')).toMatchObject({ ok: false, blocking: false });
    expect(r.ok).toBe(true);
    expect(r.covers).toBe(false);
  });
  it('re-uploading an older statement whose rows are all saved is accepted and adds nothing', () => {
    const r = checkProof(base({
      statement: { ...base().statement, periodStart: '2026-10-25', periodEnd: '2026-10-31', opening: 300, closing: 250 },
      rows: [{ hash: 'x', balance: 250 }],
      knownHashes: new Set(['x']),
    }));
    expect(r.ok).toBe(true);
    expect(r.newRows).toBe(0);
  });
  it('a gap since the last upload fails', () => {
    const r = checkProof(base({ statement: { ...base().statement, periodStart: '2026-11-10' } }));
    expect(byId(r, 'no-gap').ok).toBe(false);
  });
  it('opening balance must match the last stored balance within $0.01', () => {
    expect(checkProof(base({ lastGood: { periodEnd: '2026-11-07', closing: 100.01 } })).ok).toBe(true);
    const r = checkProof(base({ lastGood: { periodEnd: '2026-11-07', closing: 100.02 } }));
    expect(byId(r, 'opening-balance').ok).toBe(false);
  });
  it('overlapping statements are fine: balance is checked where the new rows start', () => {
    const r = checkProof(base({
      statement: { ...base().statement, periodStart: '2026-11-01', opening: 150 },
      rows: [{ hash: 'old1', balance: 120 }, { hash: 'old2', balance: 100 }, { hash: 'a', balance: 90 }, { hash: 'b', balance: 80 }],
      knownHashes: new Set(['old1', 'old2']),
    }));
    expect(r.ok).toBe(true);
    expect(r.newRows).toBe(2);
  });
  it('without a header period, a date gap is accepted only if the balances join up exactly', () => {
    const st = { ...base().statement, periodStart: '2026-11-10', periodFromHeader: false };
    expect(checkProof(base({ statement: st })).ok).toBe(true);
    expect(checkProof(base({ statement: { ...st, opening: 99 } })).ok).toBe(false);
  });

  describe('filling in history before the first statement', () => {
    const first = { periodStart: '2026-11-01', opening: 100 };
    const last = { periodEnd: '2026-11-14', closing: 80 };
    it('an older statement whose closing is the earliest opening is accepted', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: first,
        statement: { ...base().statement, periodStart: '2026-10-01', periodEnd: '2026-10-31', opening: 300, closing: 100 },
        rows: [{ hash: 'o1', balance: 200 }, { hash: 'o2', balance: 100 }],
      }));
      expect(r.ok).toBe(true);
      expect(r.newRows).toBe(2);
    });
    it('an older statement that does not join up is refused', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: first,
        statement: { ...base().statement, periodStart: '2026-10-01', periodEnd: '2026-10-31', opening: 300, closing: 101 },
        rows: [{ hash: 'o1', balance: 200 }, { hash: 'o2', balance: 101 }],
      }));
      expect(r.ok).toBe(false);
    });
    it('an older statement with a gap before the earliest one is refused', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: first,
        statement: { ...base().statement, periodStart: '2026-10-01', periodEnd: '2026-10-20', opening: 300, closing: 100 },
        rows: [{ hash: 'o1', balance: 100 }],
      }));
      expect(byId(r, 'no-gap').ok).toBe(false);
    });
    it('one big statement spanning older history, saved rows and newer rows is accepted', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: first,
        statement: { ...base().statement, periodStart: '2026-10-01', periodEnd: '2026-11-21', opening: 300, closing: 70 },
        rows: [{ hash: 'o1', balance: 100 }, { hash: 'a', balance: 90 }, { hash: 'b', balance: 80 }, { hash: 'n1', balance: 70 }],
        knownHashes: new Set(['a', 'b']),
      }));
      expect(r.ok).toBe(true);
      expect(r.newRows).toBe(2);
    });
    it('new rows in the middle of saved ones (statement differs from what is saved) are refused', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: first,
        rows: [{ hash: 'a', balance: 90 }, { hash: 'x', balance: 85 }, { hash: 'b', balance: 80 }],
        knownHashes: new Set(['a', 'b']),
      }));
      expect(r.ok).toBe(false);
    });
    it('new rows before saved ones are refused when the statement does not start before the earliest', () => {
      const r = checkProof(base({
        lastGood: last, firstGood: { periodStart: '2026-10-01', opening: 500 },
        statement: { ...base().statement, periodStart: '2026-11-05' },
        rows: [{ hash: 'x', balance: 95 }, { hash: 'a', balance: 90 }],
        knownHashes: new Set(['a']),
      }));
      expect(r.ok).toBe(false);
    });
  });
});
