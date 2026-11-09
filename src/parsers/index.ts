import { looksLikeAba, parseAba } from './aba';
import { groupLines, StatementError, type TextItem } from './lines';
import { looksLikeRevolut, parseRevolut } from './revolut';
import type { ParsedStatement } from './types';

export { StatementError } from './lines';
export type { TextItem } from './lines';
export type { ParsedStatement, ParsedRow } from './types';

export function parseStatementItems(items: TextItem[]): ParsedStatement {
  if (!items.some((i) => i.str.trim()))
    throw new StatementError('This PDF has no readable text (it may be a scan or photo). Download the statement as a PDF from the bank app instead.');
  const lines = groupLines(items);
  const rev = looksLikeRevolut(lines);
  const aba = looksLikeAba(lines);
  if (rev && aba) throw new StatementError('This PDF looks like both an ABA and a Revolut statement. Upload one statement per PDF. Nothing was saved.');
  if (rev) return parseRevolut(lines);
  if (aba) return parseAba(lines);
  throw new StatementError("Unrecognised statement layout. Only ABA (USD) and Revolut (GBP) PDF statements are supported. Nothing was saved.");
}

/** Minimal shape of the pdf.js API we use, so the same code runs in the browser and in Node tests. */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean; useSystemFonts?: boolean; stopAtErrors?: boolean; [k: string]: unknown }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { height: number };
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}

export async function extractItems(pdfjs: PdfJsLike, data: Uint8Array, extra: Record<string, unknown> = {}): Promise<TextItem[]> {
  const task = pdfjs.getDocument({ ...extra, data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true });
  const doc = await task.promise;
  const out: TextItem[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const height = page.getViewport({ scale: 1 }).height;
      const content = await page.getTextContent();
      for (const raw of content.items) {
        const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        if (typeof it.str !== 'string' || !it.transform) continue;
        const [a, b, , d, e, f] = it.transform;
        const h = it.height || Math.hypot(b, d) || Math.abs(a) || 10;
        out.push({ str: it.str, x: e, y: height - f, w: it.width ?? 0, h, page: n });
      }
    }
  } finally {
    await task.destroy();
  }
  return out;
}
