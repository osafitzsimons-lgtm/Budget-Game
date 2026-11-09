// Tiny PDF writer for synthetic test statements: places text at exact positions
// using the built-in Helvetica font. Coordinates are from the TOP-left in points.

export interface PlacedText {
  x: number;
  y: number;
  text: string;
  size?: number;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Encode text to WinAnsi bytes (so £ and • work). */
function winAnsi(s: string): string {
  const map: Record<string, number> = { '£': 0xa3, '•': 0x95, '–': 0x96, '—': 0x97, '©': 0xa9, '€': 0x80 };
  let out = '';
  for (const ch of s) {
    const code = map[ch] ?? ch.charCodeAt(0);
    out += code < 128 ? ch : `\\${code.toString(8).padStart(3, '0')}`;
  }
  return out;
}

export function makePdf(pages: PlacedText[][], width = 595, height = 842): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const items of pages) {
    const body = items
      .map((t) => `BT /F1 ${t.size ?? 9} Tf 1 0 0 1 ${t.x.toFixed(2)} ${(height - t.y).toFixed(2)} Tm (${winAnsi(esc(t.text))}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0));
}
