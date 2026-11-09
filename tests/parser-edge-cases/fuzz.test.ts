// Seeded fuzz: random damage to valid ABA/Revolut item streams must never throw anything but StatementError.
import { describe, expect, it } from 'vitest';
import { parseStatementItems, StatementError, type TextItem } from '../../src/parsers/index';
import { rng } from '../helpers/statements';
import { abaPages, type ARow, itemsDirect, revPages, revSection, type RRow } from './kit';

const abaRows: ARow[] = Array.from({ length: 30 }, (_, i) => ({ date: `Aug ${String(1 + Math.floor(i / 2)).padStart(2, '0')}, 2026`, desc: [`SHOP ${i}`, ...(i % 3 ? [] : ['PHNOM PENH KH'])], ...(i % 4 ? { out: 1.5 + i } : { in: 20 }), ...(i % 5 ? {} : { time: '09:15 AM' }) }));
const revRows: RRow[] = Array.from({ length: 30 }, (_, i) => ({ date: `${1 + Math.floor(i / 2)} Mar 2026`, desc: [`Shop ${i}`, ...(i % 4 ? [] : ['long name'])], ...(i % 4 ? { out: 1.5 + i } : { in: 20 }), extra: i % 3 ? ['Card: 1234******9999'] : [] }));

const sources: [string, TextItem[]][] = [
  ['aba', itemsDirect(abaPages({ opening: 1000, pages: [abaRows.slice(0, 15), abaRows.slice(15)] }).pages)],
  ['rev', itemsDirect(revPages({ blocks: revSection(1000, '1 March 2026', '31 March 2026', revRows, { pageBreakAfter: [14] }) }))],
];

const junk = ['', ' ', '£', '$5.00', '(1.00)', 'Balance', 'Date', 'Money In', 'Money out', 'Total', 'Account transactions from 1 March 2026 to 31 March 2026', 'Balance summary', 'Reverted transactions from 1 March 2026 to 2 March 2026', '1 Mar 2026', 'Aug 05, 2026', '12:00', 'IBAN GB12 REVO 1234 5678 9012 34', 'Account Number: 1'];

describe('fuzz: only StatementError may escape', () => {
  for (const [name, items] of sources) {
    it(`${name}: 1500 damaged variants`, () => {
      const r = rng(name === 'aba' ? 11 : 12);
      const bad: string[] = [];
      let accepted = 0;
      for (let n = 0; n < 1500; n++) {
        let its = items.map((i) => ({ ...i }));
        const ops = 1 + Math.floor(r() * 4);
        for (let k = 0; k < ops; k++) {
          const op = Math.floor(r() * 6);
          const j = Math.floor(r() * its.length);
          if (op === 0) its.splice(j, 1);
          else if (op === 1) its[j] = { ...its[j], y: its[j].y + (r() - 0.5) * 30 };
          else if (op === 2) its[j] = { ...its[j], x: its[j].x + (r() - 0.5) * 120 };
          else if (op === 3) its.push({ ...its[j], str: junk[Math.floor(r() * junk.length)] });
          else if (op === 4) its[j] = { ...its[j], page: its[j].page + 1 };
          else its = its.map((i) => (r() < 0.05 ? { ...i, w: 0, h: r() < 0.5 ? 0 : i.h } : i));
        }
        try {
          parseStatementItems(its);
          accepted++;
        } catch (e) {
          if (!(e instanceof StatementError)) bad.push(`${n}: ${String(e)}`);
        }
      }
      expect(bad).toEqual([]);
      expect(accepted).toBeGreaterThan(0);
    });
  }
});
