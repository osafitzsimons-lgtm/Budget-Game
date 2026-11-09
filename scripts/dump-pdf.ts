// Print how the app sees a PDF statement: one line per text line, with x positions.
// Useful when a real statement is refused. Runs locally; nothing is uploaded.
//   npx tsx scripts/dump-pdf.ts private-fixtures/aba-812.pdf 80
import { readFileSync } from 'node:fs';
import { extractItems } from '../src/parsers/index';
import { groupLines } from '../src/parsers/lines';
import { loadPdfJs } from '../tests/helpers/pdf';

const f = process.argv[2];
if (!f) {
  console.error('Usage: npx tsx scripts/dump-pdf.ts <file.pdf> [lines]');
  process.exit(1);
}
const items = await extractItems(await loadPdfJs(), new Uint8Array(readFileSync(f)));
const lines = groupLines(items);
for (const l of lines.slice(0, Number(process.argv[3] ?? 60))) {
  console.log(l.page, l.y.toFixed(1), l.h.toFixed(1), l.phrases.map((p) => `[${p.x.toFixed(0)}-${p.right.toFixed(0)}:${p.text}]`).join(' '));
}
