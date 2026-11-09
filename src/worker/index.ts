import { verifyAccess, type AuthEnv } from './auth';
import {
  addLog, addManualTx, checkUpload, deleteManualTx, confirmUpload, deleteLog, exportPage, getHistory, getState, HttpError, importCsv, recordFailedUpload, renameCreature, saveAccount, saveSettings,
} from './api';
import { ensureSchema } from './db';

export interface Env extends AuthEnv {
  DB?: D1Database;
  ASSETS: Fetcher;
  IS_PREVIEW?: string;
}

const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: API_HEADERS });

const MAX_BODY = 4 * 1024 * 1024;

async function readJson(req: Request): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get('Content-Type') ?? '')) throw new HttpError(415, 'Expected JSON.');
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Too much data in one request.');
  // Count real bytes as they arrive, so a body without (or lying about) Content-Length can't be bigger.
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'Too much data in one request.'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function idFrom(path: string, prefix: string): string {
  try {
    return decodeURIComponent(path.slice(prefix.length));
  } catch {
    throw new HttpError(400, 'Bad id.');
  }
}

export async function handleApi(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  let auth: Awaited<ReturnType<typeof verifyAccess>>;
  try {
    auth = await verifyAccess(req, env);
  } catch {
    auth = { ok: false, status: 401, error: 'Invalid Access token.' };
  }
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  if (!env.DB) {
    return json({ error: env.IS_PREVIEW === 'true' ? 'This is a preview build. It has no database, so your real data is never touched.' : 'No database is bound (DB). See SETUP.md.' }, 503);
  }
  // Writes must come from this site (blocks cross-site form posts).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-site request refused.' }, 403);
    if (req.headers.get('Sec-Fetch-Site') && !['same-origin', 'none'].includes(req.headers.get('Sec-Fetch-Site')!)) return json({ error: 'Cross-site request refused.' }, 403);
  }

  const db = env.DB;
  try {
    await ensureSchema(db);
    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/api/state') return json(await getState(db, now));
    if (m === 'POST' && p === '/api/uploads/check') return json(await checkUpload(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/uploads/fail') return json(await recordFailedUpload(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/uploads/confirm') return json(await confirmUpload(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/logs') return json(await addLog(db, await readJson(req), now));
    if (m === 'DELETE' && p.startsWith('/api/logs/')) return json(await deleteLog(db, idFrom(p, '/api/logs/'), now));
    if (m === 'POST' && p === '/api/transactions') return json(await addManualTx(db, await readJson(req), now));
    if (m === 'DELETE' && p.startsWith('/api/transactions/')) return json(await deleteManualTx(db, idFrom(p, '/api/transactions/'), now));
    if (m === 'POST' && p === '/api/settings') return json(await saveSettings(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/accounts') return json(await saveAccount(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/creature/name') return json(await renameCreature(db, await readJson(req), now));
    if (m === 'POST' && p === '/api/import-csv') return json(await importCsv(db, await readJson(req), now));
    if (m === 'GET' && p === '/api/history') return json(await getHistory(db));
    if (m === 'GET' && p === '/api/export') return json(await exportPage(db, url.searchParams.get('table') ?? '', url.searchParams.get('after') ?? ''));
    return json({ error: 'Not found.' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('api error', e instanceof Error ? e.message : 'unknown');
    return json({ error: 'Something went wrong on the server. Nothing was changed.' }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
