import type { Settings } from '../shared/settings';
import type { Account, LogEntry, ProofResult } from '../shared/types';

export interface ScoreEventView { id: number; creatureId: number; weekStart: string; kind: string; delta: number; reason: string; at: number; healthAfter: number }
export interface CreatureView { id: number; name: string; bornAt: number; diedAt: number | null; startHealth: number; health: number }
export interface UploadView { id: string; accountId: string; uploadedAt: number; periodStart: string; periodEnd: string; closing: number; ok: boolean; currency: string }

export interface AppState {
  now: number;
  today: string;
  settings: Settings;
  accounts: (Account & { sort: number })[];
  creature: CreatureView;
  graveyard: CreatureView[];
  events: ScoreEventView[];
  week: { start: string; end: string; allowance: number; spent: number; pending: number; left: number; unloggedSoFar: { date: string; payee: string; amountUsd: number }[] };
  deadline: { weekStart: string; at: number };
  month: { month: string; caps: Record<string, number>; capSpent: Record<string, number>; delivery: number; otherCapName: string };
  savings: { month: string; from: string; to: string; saved: number; target: number; extra: number; nextMonthExtra: number; tracked: boolean };
  uploads: { accountId: string; lastGood: UploadView | null; latest: UploadView | null }[];
  requiredAccounts: string[];
  rules: [string, string][];
  logs: LogEntry[];
  cash: { hash: string; date: string; payee: string; amountUsd: number; accountId: string; logged: number }[];
  manual: { hash: string; date: string; payee: string; amountUsd: number; category: string; savings: boolean; createdAt: number }[];
  awaitingLate: { weekStart: string; weekEnd: string; needed: string[] }[];
  lastScoring: { before: number; after: number; events: Omit<ScoreEventView, 'id'>[]; died: boolean } | null;
}

export interface ConfirmResult {
  proof: ProofResult;
  inserted: number;
  stored: boolean;
  healthBefore: number;
  healthAfter: number;
  events: Omit<ScoreEventView, 'id'>[];
  died: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  // Cloudflare Access session expired: it answers with a redirect/login page instead of JSON.
  const type = res.headers.get('Content-Type') ?? '';
  if (res.redirected || !type.includes('application/json')) {
    throw new ApiError(401, 'Your sign-in has expired. Reload the app to sign in again.');
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  return data;
}

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  check: (statement: unknown, rows: unknown) => request<ProofResult>('POST', '/api/uploads/check', { statement, rows }),
  confirm: (statement: unknown, rows: unknown, rules: unknown) => request<ConfirmResult>('POST', '/api/uploads/confirm', { statement, rows, rules }),
  addLog: (log: Record<string, unknown>) => request<{ id: string }>('POST', '/api/logs', log),
  deleteLog: (id: string) => request<{ ok: true }>('DELETE', `/api/logs/${encodeURIComponent(id)}`),
  addManual: (t: Record<string, unknown>) => request<{ hash: string; note: string | null }>('POST', '/api/transactions', t),
  deleteManual: (hash: string) => request<{ ok: true }>('DELETE', `/api/transactions/${encodeURIComponent(hash)}`),
  saveSettings: (settings: Settings) => request<{ settings: Settings }>('POST', '/api/settings', { settings }),
  saveAccount: (a: Record<string, unknown>) => request<{ id: string }>('POST', '/api/accounts', a),
  importCsv: (rows: unknown[]) => request<{ inserted: number; skipped: number; rulesLearned: number }>('POST', '/api/import-csv', { rows }),
  history: () => request<{ rows: [string, string, 'pdf' | 'csv', string, number][] }>('GET', '/api/history'),
  exportPage: (table: string, after: string) => request<{ columns: string[]; rows: unknown[][]; done: boolean }>('GET', `/api/export?table=${encodeURIComponent(table)}&after=${encodeURIComponent(after)}`),
};

/** POST helper for the shared statement/history submitters. */
export const post = <T,>(path: string, body: unknown) => request<T>('POST', path, body);
