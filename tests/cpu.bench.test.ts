// Rough CPU check for the heaviest request (confirming an 849-row statement), excluding D1 I/O time.
import { expect, it } from 'vitest';
import { checkProof } from '../src/shared/proof';
import { maskPayee } from '../src/shared/privacy';
import { round2 } from '../src/shared/money';

it('confirming 849 rows needs only a few ms of CPU', () => {
  let bal = 5000;
  const rows = Array.from({ length: 849 }, (_, i) => {
    const amt = round2(1 + (i % 50) * 0.37);
    bal = round2(bal - amt);
    return { hash: i.toString(16).padStart(64, '0'), date: '2026-10-01', time: null, payee: `PURCHASE SHOP NUMBER ${i} PHNOM PENH KH`, amountOrig: amt, amountUsd: amt, balance: bal, category: 'Eating out and bars', savings: false, isCash: false };
  });
  const body = JSON.stringify({ statement: {}, rows });
  const runs: number[] = [];
  for (let k = 0; k < 15; k++) {
    const t = performance.now();
    const parsed = JSON.parse(body) as { rows: typeof rows };
    let b = 5000;
    for (const r of parsed.rows) { maskPayee(r.payee); b = round2(b - r.amountOrig); if (Math.abs(b - r.balance) > 0.005) throw new Error('chain'); }
    const known = new Set(parsed.rows.slice(0, 300).map((r) => r.hash));
    checkProof({ statement: { accountId: 'A', periodStart: '2026-10-01', periodEnd: '2026-11-07', periodFromHeader: true, opening: 5000, closing: b, currency: 'USD' }, rows: parsed.rows, lastGood: { periodEnd: '2026-10-31', closing: 1 }, knownHashes: known, today: '2026-11-08', accountOk: true, accountDetail: '' });
    JSON.stringify(parsed.rows.map((r) => ({ h: r.hash, d: r.date, p: r.payee, u: r.amountUsd, b: r.balance, c: r.category })));
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  console.log(`median CPU for 849-row confirm: ${median.toFixed(2)} ms`);
  expect(median).toBeLessThan(8);
});
