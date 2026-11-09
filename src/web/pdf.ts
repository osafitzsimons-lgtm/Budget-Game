// PDF text extraction in the browser. The PDF bytes never leave this device.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { extractItems, parseStatementItems, type ParsedStatement, type PdfJsLike } from '../parsers/index';

let lib: Promise<PdfJsLike> | null = null;

function loadPdfJs(): Promise<PdfJsLike> {
  lib ??= import('pdfjs-dist/legacy/build/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m as unknown as PdfJsLike;
  });
  return lib;
}

export async function parsePdfFile(file: File): Promise<ParsedStatement> {
  if (file.size > 30 * 1024 * 1024) throw new Error('That PDF is over 30 MB. Is it really a bank statement?');
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfJs();
  let items;
  try {
    items = await extractItems(pdfjs, data, { standardFontDataUrl: '/pdfjs/standard_fonts/', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, enableXfa: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) throw new Error('This PDF is password-protected. Download it again without a password.');
    throw new Error(`Couldn't open this PDF (${msg}).`);
  }
  return parseStatementItems(items);
}
