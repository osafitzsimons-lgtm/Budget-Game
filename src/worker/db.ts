import { mergeSettings, type Settings } from '../shared/settings';
import type { ScoredTx, UploadRecord } from '../shared/scoring';
import type { LogEntry } from '../shared/types';
import { MIGRATIONS, SCHEMA } from './schema';

export interface DbAccount {
  id: string;
  bank: 'ABA' | 'REV';
  last3: string;
  label: string;
  optional: boolean;
  active: boolean;
  sort: number;
}

export interface DbCreature {
  id: number;
  name: string;
  bornAt: number;
  diedAt: number | null;
  startHealth: number;
  health: number;
}

let schemaReady = false;

/** Create tables if needed. One batched query per Worker isolate. */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  if (MIGRATIONS.length) {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first<{ value: string }>();
    let version = Number(row?.value ?? 1);
    for (const m of MIGRATIONS.sort((a, b) => a.version - b.version)) {
      if (m.version <= version) continue;
      await db.batch([...m.statements.map((s) => db.prepare(s)), db.prepare(`UPDATE meta SET value = ?1 WHERE key = 'schema_version'`).bind(String(m.version))]);
      version = m.version;
    }
  }
  schemaReady = true;
}

export function _resetSchemaFlag() {
  schemaReady = false;
}

type Row = Record<string, unknown>;

export const rowToAccount = (r: Row): DbAccount => ({
  id: String(r.id),
  bank: r.bank as 'ABA' | 'REV',
  last3: String(r.last3),
  label: String(r.label),
  optional: !!r.optional,
  active: !!r.active,
  sort: Number(r.sort),
});

export const rowToCreature = (r: Row): DbCreature => ({
  id: Number(r.id),
  name: String(r.name),
  bornAt: Number(r.born_at),
  diedAt: r.died_at === null ? null : Number(r.died_at),
  startHealth: Number(r.start_health),
  health: Number(r.health),
});

export const rowToTx = (r: Row): ScoredTx => ({
  hash: String(r.hash),
  accountId: String(r.account_id),
  date: String(r.date),
  payee: String(r.payee),
  amountUsd: Number(r.amount_usd),
  category: String(r.category),
  isCash: !!r.is_cash,
  savings: !!r.savings,
});

export const rowToLog = (r: Row): LogEntry => ({
  id: String(r.id),
  createdAt: Number(r.created_at),
  date: String(r.date),
  amountUsd: Number(r.amount_usd),
  what: String(r.what),
  why: String(r.why),
  kind: r.kind === 'cash' ? 'cash' : 'planned',
  category: r.category === null ? null : String(r.category),
  urgent: !!r.urgent,
  cashTxHash: r.cash_tx_hash === null ? null : String(r.cash_tx_hash),
});

export const rowToUpload = (r: Row): UploadRecord & { id: string; periodStart: string; closing: number; opening: number; baseline: boolean; rowCount: number; newRows: number; currency: string; checks: unknown } => ({
  id: String(r.id),
  accountId: String(r.account_id),
  uploadedAt: Number(r.uploaded_at),
  periodStart: String(r.period_start),
  periodEnd: String(r.period_end),
  opening: Number(r.opening),
  closing: Number(r.closing),
  currency: String(r.currency),
  rowCount: Number(r.row_count),
  newRows: Number(r.new_rows),
  ok: !!r.ok,
  baseline: !!r.baseline,
  checks: JSON.parse(String(r.checks)),
});

export interface Core {
  settings: Settings;
  accounts: DbAccount[];
  uploads: ReturnType<typeof rowToUpload>[];
  evaluated: Set<string>;
  /** weeks that took a missing/failing penalty and still wait for late statements */
  awaitingLate: Set<string>;
  creature: DbCreature;
  creatures: DbCreature[];
}

/** Everything the scorer needs, in one batched query. Creates the first sprout and scoring start on first open. */
export async function loadCore(db: D1Database, now: number, todayWeekStart: string): Promise<Core> {
  const [s, a, u, w, c] = await db.batch([
    db.prepare(`SELECT value FROM meta WHERE key = 'settings'`),
    db.prepare(`SELECT * FROM accounts ORDER BY sort, id`),
    db.prepare(`SELECT * FROM uploads ORDER BY uploaded_at`),
    db.prepare(`SELECT w.week_start, w.data_ok, (SELECT 1 FROM late_evals l WHERE l.week_start = w.week_start) AS late FROM week_evals w`),
    db.prepare(`SELECT * FROM creatures ORDER BY id`),
  ]);
  const stored = (s.results[0] as Row | undefined)?.value;
  const settings = mergeSettings(stored ? JSON.parse(String(stored)) : null);
  let creatures = (c.results as Row[]).map(rowToCreature);
  const init: D1PreparedStatement[] = [];
  if (!settings.scoringStart) {
    settings.scoringStart = todayWeekStart;
    init.push(db.prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(settings)));
  }
  if (!creatures.length) {
    init.push(db.prepare(`INSERT OR IGNORE INTO creatures (id, name, born_at, died_at, start_health, health) VALUES (1, ?1, ?2, NULL, 70, 70)`).bind(settings.creatureName, now));
    creatures = [{ id: 1, name: settings.creatureName, bornAt: now, diedAt: null, startHealth: 70, health: 70 }];
  }
  if (init.length) await db.batch(init);
  const alive = creatures.filter((x) => x.diedAt === null);
  return {
    settings,
    accounts: (a.results as Row[]).map(rowToAccount),
    uploads: (u.results as Row[]).map(rowToUpload),
    evaluated: new Set((w.results as Row[]).map((r) => String(r.week_start))),
    awaitingLate: new Set((w.results as Row[]).filter((r) => !r.data_ok && !r.late).map((r) => String(r.week_start))),
    creature: alive[alive.length - 1] ?? creatures[creatures.length - 1],
    creatures,
  };
}
