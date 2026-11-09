import { extractItems, parseStatementItems, type PdfJsLike } from '../../src/parsers/index';

let pdfjs: PdfJsLike | null = null;
export async function loadPdfJs(): Promise<PdfJsLike> {
  pdfjs ??= (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsLike;
  return pdfjs;
}

export async function parsePdf(bytes: Uint8Array) {
  return parseStatementItems(await extractItems(await loadPdfJs(), bytes));
}
