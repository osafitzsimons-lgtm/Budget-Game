// Writes synthetic (fake) statements and history to ./sample-data for trying the app locally.
import { mkdirSync, writeFileSync } from 'node:fs';
import { addDays, ppDate, previousSaturday } from '../src/shared/dates';
import { abaStatement, revolutStatement, rng, type SynthRow } from '../tests/helpers/statements';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const aba = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${d.slice(8)}, ${d.slice(0, 4)}`;
const rev = (d: string) => `${+d.slice(8)} ${+d.slice(5, 7) === 9 ? 'Sept' : MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const long = (d: string) => `${+d.slice(8)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

export function writeSampleData(dir = 'sample-data', today = ppDate(Date.now())) {
  mkdirSync(dir, { recursive: true });
  const end = previousSaturday(today);
  const start = addDays(end, -13);
  const r = rng(42);
  const payees = ['SAMPLE CAFE', 'SAMPLE MART', 'GRAB', 'STREET NOODLES', 'SAMPLE GYM', 'TADA', 'BOOK SHOP'];
  const rows: SynthRow[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const p = payees[Math.floor(r() * payees.length)];
      rows.push({ date: aba(d), desc: [`PURCHASE ${p}`, 'PHNOM PENH KH'], out: Math.round((1 + r() * (p === 'SAMPLE GYM' ? 40 : 14)) * 100) / 100 });
    }
  }
  rows.push({ date: aba(end), desc: ['CASH WITHDRAWAL ATM 0001'], out: 40 });
  writeFileSync(`${dir}/aba-812-sample.pdf`, abaStatement({ accountNumber: '000 000 812', opening: 800, rows, period: `${aba(start)} - ${aba(end)}` }));
  writeFileSync(`${dir}/aba-013-sample.pdf`, abaStatement({ accountNumber: '000 000 013', opening: 120, rows: [{ date: aba(addDays(end, -3)), desc: ['PHONE TOP UP'], out: 5 }], period: `${aba(start)} - ${aba(end)}` }));
  writeFileSync(`${dir}/revolut-554-sample.pdf`, revolutStatement({ accountNumber: '00000554', sections: [{ opening: 300, from: long(start), to: long(end), rows: [
    { date: rev(addDays(end, -6)), desc: ['Sample Streaming'], out: 9.99, extra: ['Card: 000000******0000'] },
    { date: rev(addDays(end, -2)), desc: ['Sample Bookshop'], out: 24.5, extra: ['Revolut Rate £1.00 = $1.33'] },
  ] }] }));
  const csv = ['date,account,payee,amount_usd,category'];
  for (let i = 0; i < 120; i++) {
    const d = addDays(start, -1 - i);
    csv.push(`${d},ABA,Sample Cafe,${(4 + r() * 10).toFixed(2)},Eating out and bars`);
    if (i % 7 === 0) csv.push(`${d},ABA,Sample Market,${(10 + r() * 30).toFixed(2)},Food shop`);
    if (i % 30 === 0) csv.push(`${d},REV,Sample Landlord,600.00,Rent and bills`);
  }
  writeFileSync(`${dir}/sample-history.csv`, csv.join('\n') + '\n');
  return { dir, start, end };
}

if (process.argv[1]?.endsWith('sample-data.ts')) {
  const { dir, start, end } = writeSampleData();
  console.log(`Fake statements for ${start} to ${end} written to ./${dir}/ (ABA 812, ABA 013, Revolut 554) plus sample-history.csv`);
}
