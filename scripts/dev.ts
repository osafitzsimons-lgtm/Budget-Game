// One command to run everything locally with fake data: npm run dev
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseHistoryCsv } from '../src/shared/csv';
import { hashRows } from '../src/shared/hash';
import { writeSampleData } from './sample-data';

const PORT = 8787;
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', 'LOCAL_DEV=true\n');
const { dir } = writeSampleData();
console.log(`› Fake statements are in ./${dir}/ — upload them on the Upload screen.`);

const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local', '--ip', '127.0.0.1'], { stdio: 'inherit' });
process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });

async function seed() {
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/state`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const { rows } = parseHistoryCsv(readFileSync(`${dir}/sample-history.csv`, 'utf8'));
  const hashes = await hashRows('csv', rows.map((r) => ({ date: r.date, time: null, payee: `${r.account}|${r.payee}`, amountOrig: r.amountUsd, balance: null })));
  const res = await fetch(`${base}/api/import-csv`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ rows: rows.map((r, i) => ({ ...r, hash: hashes[i] })) }) });
  console.log(`\n› Fake history imported (${res.status}). Open ${base} in your browser.\n`);
}
void seed();
