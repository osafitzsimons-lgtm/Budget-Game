import { capBucket, isCategory, isNegotiable, OTHER_CAP } from '../shared/categories';
import { isBuiltInPayee, isCashPayee, learnRules } from '../shared/categorise';
import { addDays, formatDate, isYmd, monthOf, ppDate, weekDeadline, weekEnd, weekStart } from '../shared/dates';
import { bankForLabel } from '../shared/history';
import { CSV_ROWS_PER_REQUEST, csvHashable } from '../shared/csv';
import { round2, sameMoney, usd } from '../shared/money';
import { maskPayee, payeeKey } from '../shared/privacy';
import { hashRows, sha256Hex, sha256HexSync, txIdentity } from '../shared/hash';
import { checkProof } from '../shared/proof';
import { accountStatus, findUnlogged, penaltyMonth, savedInWindow, savingsWindow, DEATH_SAVINGS_PENALTY } from '../shared/scoring';
import { DEFAULT_SETTINGS, phaseValue, validateSettings, type Phase, type Settings } from '../shared/settings';
import type { StatementSummary } from '../shared/types';
import { type Core, loadCore, rowToLog, rowToTx } from './db';
import { requiredIds, SCORED_SOURCES, scoreDueWeeks, type EvalOutcome } from './evaluate';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bad = (msg: string) => new HttpError(400, msg);
const HEX64 = /^[0-9a-f]{64}$/;

function str(v: unknown, name: string, max = 200, allowEmpty = false): string {
  if (typeof v !== 'string') throw bad(`${name} must be text.`);
  const s = v.trim();
  if (!allowEmpty && !s) throw bad(`${name} is required.`);
  if (s.length > max) throw bad(`${name} is too long.`);
  return s;
}
function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) throw bad(`${name} must be a number.`);
  return v;
}
function ymd(v: unknown, name: string): string {
  if (typeof v !== 'string' || !isYmd(v)) throw bad(`${name} must be a date (YYYY-MM-DD).`);
  return v;
}

async function evaluateAndLoad(db: D1Database, now: number): Promise<{ core: Core; outcome: EvalOutcome | null }> {
  const today = ppDate(now);
  let core = await loadCore(db, now, weekStart(today));
  let outcome: EvalOutcome | null = null;
  // A second pass catches a week that was penalised at its deadline in pass one and whose statements are already in.
  for (let pass = 0; pass < 2; pass++) {
    const deaths = core.creatures.filter((c) => c.diedAt !== null).map((c) => ({ diedAt: c.diedAt! }));
    const o = await scoreDueWeeks({ db, now, settings: core.settings, accounts: core.accounts, uploads: core.uploads, evaluated: core.evaluated, awaitingLate: core.awaitingLate, creature: core.creature, deaths });
    if (!o) break;
    outcome = outcome ? { before: outcome.before, after: o.after, events: [...outcome.events, ...o.events], weeks: [...outcome.weeks, ...o.weeks], died: outcome.died || o.died } : o;
    core = await loadCore(db, now, weekStart(today));
  }
  return { core, outcome };
}

export async function getState(db: D1Database, now: number) {
  const { core, outcome } = await evaluateAndLoad(db, now);
  return { ...(await buildState(db, core, now)), lastScoring: outcome };
}

async function buildState(db: D1Database, core: Core, now: number) {
  const today = ppDate(now);
  const ws = weekStart(today);
  const we = weekEnd(ws);
  const month = monthOf(today);
  const s = core.settings;
  const win = savingsWindow(month, s.savingsWindowStartDay);
  const from = [addDays(ws, -2), `${month}-01`, win.from].sort()[0];

  const [txRes, logRes, ruleRes, evRes, cashRes, manualRes] = await db.batch([
    db.prepare(`SELECT * FROM transactions WHERE ${SCORED_SOURCES} AND date >= ?1`).bind(from),
    db.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT 300`),
    db.prepare(`SELECT key, category FROM payee_rules`),
    db.prepare(`SELECT * FROM score_events ORDER BY id DESC LIMIT 400`),
    db.prepare(`SELECT t.hash, t.date, t.payee, t.amount_usd, t.account_id, (SELECT COALESCE(SUM(l.amount_usd),0) FROM logs l WHERE l.cash_tx_hash = t.hash) AS logged
                FROM transactions t WHERE t.is_cash = 1 AND t.date >= ?1 ORDER BY t.date DESC`).bind(addDays(today, -60)),
    db.prepare(`SELECT hash, date, payee, amount_usd, category, savings, created_at FROM transactions WHERE source = 'manual' ORDER BY created_at DESC LIMIT 100`),
  ]);
  const txs = (txRes.results as Record<string, unknown>[]).map(rowToTx);
  const logs = (logRes.results as Record<string, unknown>[]).map(rowToLog);

  const weekTxs = txs.filter((t) => t.date >= ws && t.date <= we);
  const allowance = phaseValue(s.allowance, ws);
  let spent = 0;
  for (const t of weekTxs) if (isNegotiable(t.category)) spent += t.amountUsd;
  // Cash logged as non-negotiable comes back off this week's spending.
  for (const l of logs) {
    if (l.kind !== 'cash' || !l.cashTxHash || !l.category || isNegotiable(l.category)) continue;
    if (weekTxs.some((t) => t.hash === l.cashTxHash)) spent -= l.amountUsd;
  }
  // Planned spending written down this week that isn't in a statement yet.
  const plannedThisWeek = logs.filter((l) => l.kind === 'planned' && l.date >= ws && l.date <= we);
  const unmatched = plannedThisWeek.filter((l) => !weekTxs.some((t) => isNegotiable(t.category) && Math.abs(t.amountUsd - l.amountUsd) <= 2 && t.date >= l.date && t.date <= addDays(l.date, 2)));
  const pending = round2(unmatched.reduce((a, l) => a + l.amountUsd, 0));

  // Monthly caps
  const caps = phaseValue(s.caps, `${month}-01`);
  const capSpent: Record<string, number> = {};
  for (const k of Object.keys(caps)) capSpent[k] = 0;
  for (const t of txs) {
    if (monthOf(t.date) !== month || !isNegotiable(t.category)) continue;
    const b = capBucket(t.category);
    capSpent[b] = round2((capSpent[b] ?? 0) + t.amountUsd);
  }
  let delivery = 0;
  for (const t of weekTxs) if (t.category === 'Grab orders') delivery += t.amountUsd;

  // Savings this month
  const savingsTracked = !!s.savingsAccountId && core.uploads.some((u) => u.accountId === s.savingsAccountId && u.ok);
  const deaths = core.creatures.filter((c) => c.diedAt !== null);
  const extra = deaths.filter((c) => penaltyMonth(ppDate(c.diedAt!)) === month).length * DEATH_SAVINGS_PENALTY;
  const nextMonthExtra = deaths.filter((c) => penaltyMonth(ppDate(c.diedAt!)) > month).length * DEATH_SAVINGS_PENALTY;
  const saved = savedInWindow(txs, win.from, win.to, s.savingsAccountId, savingsTracked);

  // Countdown: the first unscored week whose deadline is still ahead.
  let dw = s.scoringStart || ws;
  while (core.evaluated.has(dw) || weekDeadline(dw) <= now) dw = addDays(dw, 7);

  const required = core.accounts.filter((a) => a.active && !a.optional);
  const requiredList = requiredIds(core.accounts);
  // Missed weeks still waiting for late statements, with what is still needed.
  const awaitingLate = [...core.awaitingLate].sort().map((w) => ({
    weekStart: w,
    weekEnd: weekEnd(w),
    needed: requiredList.filter((id) => accountStatus(core.uploads, id, weekEnd(w), now, w > s.scoringStart ? w : undefined) !== 'ok'),
  }));
  const lastByAccount = core.accounts.map((a) => {
    const mine = core.uploads.filter((u) => u.accountId === a.id);
    const good = mine.filter((u) => u.ok).sort((x, y) => (x.periodEnd < y.periodEnd ? -1 : 1));
    const lastGood = good[good.length - 1] ?? null;
    const latest = mine[mine.length - 1] ?? null;
    return { accountId: a.id, lastGood, latest };
  });

  return {
    now,
    today,
    settings: s,
    accounts: core.accounts,
    creature: core.creature,
    graveyard: core.creatures.filter((c) => c.diedAt !== null),
    events: (evRes.results as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), creatureId: Number(r.creature_id), weekStart: String(r.week_start), kind: String(r.kind), delta: Number(r.delta), reason: String(r.reason), at: Number(r.at), healthAfter: Number(r.health_after),
    })),
    week: {
      start: ws, end: we, allowance, spent: round2(spent), pending, left: round2(allowance - spent - pending),
      unloggedSoFar: findUnlogged(weekTxs, logs).map((t) => ({ date: t.date, payee: t.payee, amountUsd: t.amountUsd })),
    },
    deadline: { weekStart: dw, at: weekDeadline(dw) },
    month: { month, caps, capSpent, delivery: round2(delivery), otherCapName: OTHER_CAP },
    savings: { month, from: win.from, to: win.to, saved, target: phaseValue(s.savingsTarget, `${month}-01`) + extra, extra, nextMonthExtra, tracked: savingsTracked },
    uploads: lastByAccount,
    requiredAccounts: required.map((a) => a.id),
    rules: (ruleRes.results as { key: string; category: string }[]).map((r) => [r.key, r.category] as [string, string]),
    logs,
    cash: (cashRes.results as Record<string, unknown>[]).map((r) => ({ hash: String(r.hash), date: String(r.date), payee: String(r.payee), amountUsd: Number(r.amount_usd), accountId: String(r.account_id), logged: Number(r.logged) })),
    manual: (manualRes.results as Record<string, unknown>[]).map((r) => ({ hash: String(r.hash), date: String(r.date), payee: String(r.payee), amountUsd: Number(r.amount_usd), category: String(r.category), savings: !!r.savings, createdAt: Number(r.created_at) })),
    awaitingLate,
  };
}

// ---------- Uploads ----------

const BANK_CURRENCY = { ABA: 'USD', REV: 'GBP' } as const;
/** Rows per confirm request. Bigger statements are sent in parts (see shared/submit.ts) to stay under 10 ms CPU. */
const MAX_CONFIRM_ROWS = 300;
const MAX_CHECK_ROWS = 6000;

interface StatementIn extends StatementSummary {
  bank: 'ABA' | 'REV';
  last3: string;
  fx: number;
}

function parseStatementIn(v: unknown, today: string): StatementIn {
  const o = (v ?? {}) as Record<string, unknown>;
  const bank = o.bank === 'ABA' || o.bank === 'REV' ? o.bank : null;
  if (!bank) throw bad('Unknown bank.');
  // Each bank's statements have one currency: ABA in USD, Revolut in GBP.
  if (o.currency !== BANK_CURRENCY[bank]) throw bad(`${bank === 'REV' ? 'Revolut' : 'ABA'} statements must be in ${BANK_CURRENCY[bank]}.`);
  const last3 = str(o.last3, 'last3', 3);
  if (!/^\d{3}$/.test(last3)) throw bad('Account digits must be 3 numbers.');
  const st: StatementIn = {
    bank, currency: BANK_CURRENCY[bank], last3,
    accountId: str(o.accountId, 'accountId', 40),
    periodStart: ymd(o.periodStart, 'periodStart'),
    periodEnd: ymd(o.periodEnd, 'periodEnd'),
    periodFromHeader: !!o.periodFromHeader,
    opening: num(o.opening, 'opening'),
    closing: num(o.closing, 'closing'),
    fx: num(o.fx, 'fx'),
    direction: o.direction === 'backfill' ? 'backfill' : undefined,
  };
  if (st.periodEnd < st.periodStart) throw bad('Statement period is backwards.');
  // A statement can't prove days that haven't happened yet.
  if (st.periodEnd > today) throw bad(`The statement runs to ${formatDate(st.periodEnd)}, which is after today. Nothing was saved.`);
  return st;
}

interface RowIn {
  clientHash: string | null; date: string; time: string | null; payee: string; amountOrig: number; amountUsd: number; balance: number;
  category: string; savings: boolean; isCash: boolean; dup: number; seq: number;
}

function parseRows(v: unknown, st: StatementIn, max: number): RowIn[] {
  if (!Array.isArray(v) || v.length > max) throw bad(`Too many rows in one request (max ${max}).`);
  if (v.length === 0 && !st.periodFromHeader) throw bad('A statement with no rows needs its dates from the statement header.');
  return v.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const clientHash = typeof o.hash === 'string' && HEX64.test(o.hash) ? o.hash : null;
    const date = ymd(o.date, `Row ${i + 1} date`);
    if (date < st.periodStart || date > st.periodEnd) throw bad(`Row ${i + 1} is outside the statement period.`);
    const time = o.time === null || o.time === undefined ? null : str(o.time, 'time', 5);
    if (time !== null && !/^\d{2}:\d{2}$/.test(time)) throw bad(`Row ${i + 1}: bad time.`);
    const category = str(o.category, 'category', 40);
    if (!isCategory(category)) throw bad(`Row ${i + 1}: unknown category.`);
    const dup = o.dup === undefined ? 0 : num(o.dup, 'dup');
    if (!Number.isInteger(dup) || dup < 0 || dup > 1000) throw bad(`Row ${i + 1}: bad duplicate number.`);
    const payee = maskPayee(str(o.payee, 'payee', 300, true)) || '(no description)';
    const amountOrig = num(o.amountOrig, 'amountOrig');
    const amountUsd = num(o.amountUsd, 'amountUsd');
    return {
      clientHash, date, time, payee, amountOrig, amountUsd,
      balance: num(o.balance, 'balance'),
      category, dup, seq: i,
      // Worked out here, never taken from the browser: cash is a cash withdrawal going out;
      // savings can only be money going out as a Transfer or Investing.
      isCash: amountUsd > 0 && isCashPayee(payee),
      savings: !!o.savings && amountUsd > 0 && (category === 'Transfer' || category === 'Investing'),
    };
  });
}

function checkFx(core: Core, st: StatementIn) {
  if (st.currency === 'GBP' && Math.abs(st.fx - core.settings.fxGbpUsd) > 1e-9)
    throw bad(`The GBP→USD rate changed to ${core.settings.fxGbpUsd} since this file was read. Pick the file again.`);
  if (st.currency === 'USD' && st.fx !== 1) throw bad('USD statements must not be converted.');
}

function accountFor(core: Core, st: StatementIn) {
  const acct = core.accounts.find((a) => a.id === st.accountId);
  const ok = !!acct && acct.active && acct.bank === st.bank && acct.last3 === st.last3;
  return {
    ok,
    detail: ok ? `${acct!.label} (ending ${acct!.last3}).` : `This statement is for ${st.bank === 'REV' ? 'Revolut' : 'ABA'} ending ${st.last3}, which isn't an active account in Settings.`,
  };
}

function goodUploads(core: Core, accountId: string) {
  return core.uploads.filter((u) => u.accountId === accountId && u.ok);
}

async function proofFor(db: D1Database, core: Core, st: StatementIn, rows: { hash: string; balance: number }[], now: number) {
  const acct = accountFor(core, st);
  const good = goodUploads(core, st.accountId);
  const lastGood = [...good].sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : a.uploadedAt - b.uploadedAt)).pop() ?? null;
  const firstGood = [...good].sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : a.uploadedAt - b.uploadedAt))[0] ?? null;
  const known = new Set<string>();
  if (rows.length) {
    // Only this account's statement rows count as "already saved".
    const r = await db.prepare(`SELECT hash FROM transactions WHERE account_id = ?2 AND source = 'pdf' AND hash IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(rows.map((x) => x.hash)), st.accountId).all<{ hash: string }>();
    for (const x of r.results) known.add(x.hash);
  }
  return checkProof({
    statement: st, rows, knownHashes: known, today: ppDate(now), accountOk: acct.ok, accountDetail: acct.detail,
    lastGood: lastGood ? { periodEnd: lastGood.periodEnd, closing: lastGood.closing } : null,
    firstGood: firstGood ? { periodStart: firstGood.periodStart, opening: firstGood.opening } : null,
  });
}

/** The rows must chain from the opening balance to the closing balance; otherwise reject. */
function checkChain(st: StatementIn, rows: RowIn[]) {
  let bal = st.opening;
  for (const r of rows) {
    bal = round2(bal - r.amountOrig); // amountOrig is spend-positive
    if (!sameMoney(bal, r.balance)) throw bad('Rows do not add up to their running balances.');
    const expectUsd = st.currency === 'GBP' ? round2(r.amountOrig * st.fx) : r.amountOrig;
    if (!sameMoney(expectUsd, r.amountUsd, 0.011)) throw bad('USD amounts do not match the exchange rate.');
  }
  if (!sameMoney(bal, st.closing)) throw bad('Rows do not add up to the closing balance.');
}

/**
 * Read a statement for checking only. Nothing is stored from it, and every part is fully re-checked
 * on confirm, so only row ids and balances are needed: this keeps a 6000-row check cheap.
 */
async function readForCheck(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  const st = parseStatementIn(o.statement, ppDate(now));
  if (!Array.isArray(o.rows) || o.rows.length > MAX_CHECK_ROWS) throw bad(`Too many rows (max ${MAX_CHECK_ROWS}).`);
  if (o.rows.length === 0 && !st.periodFromHeader) throw bad('A statement with no rows needs its dates from the statement header.');
  const rows = (o.rows as Record<string, unknown>[]).map((r, i) => {
    if (typeof r?.hash !== 'string' || !HEX64.test(r.hash)) throw bad(`Row ${i + 1}: bad id. Pick the file again.`);
    return { hash: r.hash, balance: num(r.balance, 'balance') };
  });
  if (rows.length && !sameMoney(rows[rows.length - 1].balance, st.closing)) throw bad('Rows do not add up to the closing balance.');
  const core = await loadCore(db, now, weekStart(ppDate(now)));
  checkFx(core, st);
  const acct = accountFor(core, st);
  if (!acct.ok) throw bad(acct.detail);
  const proof = await proofFor(db, core, st, rows, now);
  return { st, rows, proof };
}

export async function checkUpload(db: D1Database, body: unknown, now: number) {
  return (await readForCheck(db, body, now)).proof;
}

/** Record that a statement failed its proof check (so the deadline counts it as "failing"). Stores no rows. */
export async function recordFailedUpload(db: D1Database, body: unknown, now: number) {
  const { st, rows, proof } = await readForCheck(db, body, now);
  if (proof.ok) throw bad('This statement passes its checks now. Confirm it instead.');
  await db.prepare(`INSERT INTO uploads (id, account_id, uploaded_at, period_start, period_end, opening, closing, currency, row_count, new_rows, ok, baseline, checks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, 0, ?10)`)
    .bind(crypto.randomUUID(), st.accountId, now, st.periodStart, st.periodEnd, st.opening, st.closing, st.currency, rows.length, JSON.stringify(proof.checks)).run();
  return { proof, stored: false };
}

/** Save one statement, or one part of a big one. Row ids are computed here, never taken from the browser. */
export async function confirmUpload(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  const st = parseStatementIn(o.statement, ppDate(now));
  const rows = parseRows(o.rows, st, MAX_CONFIRM_ROWS);
  checkChain(st, rows);
  const hashes = await hashRows(st.accountId, rows, rows.map((r) => r.dup));
  const rules = Array.isArray(o.rules) ? o.rules.slice(0, 500) : [];

  // Score any weeks whose deadline passed BEFORE this upload, so a late upload can't rescue them.
  const first = await evaluateAndLoad(db, now);
  const core = first.core;
  checkFx(core, st);
  const acct = accountFor(core, st);
  if (!acct.ok) throw bad(acct.detail);
  const proof = await proofFor(db, core, st, rows.map((r, i) => ({ hash: hashes[i], balance: r.balance })), now);

  const uploadId = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  if (proof.ok) {
    // Two uploads for one account at the same moment would both chain from the same balance.
    // Each saved upload takes the next number for its account; a clash rolls the whole batch back.
    const seq = goodUploads(core, st.accountId).length + 1;
    stmts.push(db.prepare(`INSERT INTO upload_seq (account_id, seq) VALUES (?1, ?2)`).bind(st.accountId, seq));
  }
  stmts.push(
    db.prepare(`INSERT INTO uploads (id, account_id, uploaded_at, period_start, period_end, opening, closing, currency, row_count, new_rows, ok, baseline, checks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
      .bind(uploadId, st.accountId, now, st.periodStart, st.periodEnd, st.opening, st.closing, st.currency, rows.length, proof.ok ? proof.newRows : 0, proof.ok ? 1 : 0, proof.baseline ? 1 : 0, JSON.stringify(proof.checks)),
  );
  const insertAt = stmts.length;
  if (proof.ok && rows.length) {
    const data = rows.map((r, i) => ({ h: hashes[i], d: r.date, t: r.time, p: r.payee, o: r.amountOrig, u: r.amountUsd, b: r.balance, c: r.category, s: r.savings ? 1 : 0, x: r.isCash ? 1 : 0, q: r.seq }));
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO transactions (hash, account_id, bank, source, date, time, payee, amount_orig, currency, amount_usd, balance, category, savings, is_cash, upload_id, seq)
         SELECT json_extract(value,'$.h'), ?2, ?3, 'pdf', json_extract(value,'$.d'), json_extract(value,'$.t'), json_extract(value,'$.p'), json_extract(value,'$.o'), ?4, json_extract(value,'$.u'), json_extract(value,'$.b'), json_extract(value,'$.c'), json_extract(value,'$.s'), json_extract(value,'$.x'), ?5, json_extract(value,'$.q')
         FROM json_each(?1)`,
      ).bind(JSON.stringify(data), st.accountId, st.bank, st.currency, uploadId),
    );
  }
  if (proof.ok) {
    const ruleRows: { k: string; c: string }[] = [];
    for (const r of rules as Record<string, unknown>[]) {
      if (typeof r?.payee !== 'string' || r.payee.length > 300 || typeof r?.category !== 'string' || !isCategory(r.category) || r.category === 'Unidentified') continue;
      if (isBuiltInPayee(r.payee)) continue;
      const k = payeeKey(r.payee);
      if (k) ruleRows.push({ k, c: r.category });
    }
    if (ruleRows.length) {
      stmts.push(
        db.prepare(
          `INSERT INTO payee_rules (key, category, source, updated_at) SELECT json_extract(value,'$.k'), json_extract(value,'$.c'), 'review', ?2 FROM json_each(?1) WHERE true
           ON CONFLICT(key) DO UPDATE SET category = excluded.category, source = 'review', updated_at = excluded.updated_at`,
        ).bind(JSON.stringify(ruleRows), now),
      );
    }
  }
  let res: D1Result[];
  try {
    res = await db.batch(stmts);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Another statement for this account was saved at the same moment. Pick the file again.');
    throw e;
  }
  const inserted = proof.ok && rows.length ? (res[insertAt].meta.changes ?? 0) : 0;

  // Now score the finished week early if every statement is in.
  const second = await evaluateAndLoad(db, now);
  const before = first.outcome?.before ?? core.creature.health;
  const scored = [first.outcome, second.outcome].filter(Boolean) as EvalOutcome[];
  return {
    proof,
    inserted,
    stored: proof.ok,
    healthBefore: before,
    healthAfter: second.core.creature.health,
    events: scored.flatMap((x) => x.events),
    died: scored.some((x) => x.died),
  };
}

// ---------- Logs ----------

export async function addLog(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  const kind = o.kind === 'cash' ? 'cash' : 'planned';
  const amount = num(o.amountUsd, 'Amount');
  if (amount <= 0 || amount > 100000) throw bad('Amount must be more than $0.');
  const category = o.category === null || o.category === undefined || o.category === '' ? null : str(o.category, 'category', 40);
  if (category && !isCategory(category)) throw bad('Unknown category.');
  const cashTxHash = kind === 'cash' ? str(o.cashTxHash, 'Cash withdrawal', 64) : null;
  if (cashTxHash && !HEX64.test(cashTxHash)) throw bad('Pick a cash withdrawal.');
  if (kind === 'cash' && !category) throw bad('Pick what the cash was spent on.');
  const date = o.date ? ymd(o.date, 'Date') : ppDate(now);
  if (kind === 'planned' && date < addDays(ppDate(now), -1)) throw bad('Write it down before paying: the date can be at most yesterday.');
  if (date > addDays(ppDate(now), 7)) throw bad('That date is more than a week away.');
  const id = crypto.randomUUID();
  if (cashTxHash) {
    const w = await db.prepare(`SELECT amount_usd, (SELECT COALESCE(SUM(amount_usd),0) FROM logs WHERE cash_tx_hash = ?1) AS logged FROM transactions WHERE hash = ?1 AND is_cash = 1`).bind(cashTxHash).first<{ amount_usd: number; logged: number }>();
    if (!w) throw bad('That cash withdrawal was not found.');
    if (w.logged + amount > w.amount_usd + 0.01) throw bad(`Only $${(w.amount_usd - w.logged).toFixed(2)} of that withdrawal is left to log.`);
  }
  await db.prepare(`INSERT INTO logs (id, created_at, date, amount_usd, what, why, kind, category, urgent, cash_tx_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, now, date, round2(amount), maskPayee(str(o.what, 'What', 120)), maskPayee(str(o.why ?? '', 'Why', 300, true)), kind, category, o.urgent ? 1 : 0, cashTxHash).run();
  return { id };
}

/** Has this week already been scored (on time, early or late)? Its inputs must then stay as they were. */
async function weekScored(db: D1Database, weekStartYmd: string): Promise<boolean> {
  const r = await db.prepare(`SELECT (SELECT data_ok FROM week_evals WHERE week_start = ?1) AS ok, (SELECT 1 FROM late_evals WHERE week_start = ?1) AS late`).bind(weekStartYmd).first<{ ok: number | null; late: number | null }>();
  return !!r && (r.ok === 1 || r.late === 1);
}

export async function deleteLog(db: D1Database, id: string, now: number) {
  // Entries a scored week relied on are kept, so the score log stays honest.
  if (id.length > 64) throw bad('Bad id.');
  const l = await db.prepare(`SELECT l.created_at, l.date, l.kind, t.date AS cash_date FROM logs l LEFT JOIN transactions t ON t.hash = l.cash_tx_hash WHERE l.id = ?1`).bind(id).first<{ created_at: number; date: string; kind: string; cash_date: string | null }>();
  if (!l) throw new HttpError(404, 'Not found.');
  if (now - l.created_at > 24 * 3600e3) throw bad('Entries older than a day can’t be deleted.');
  // A "before I pay" note can match spending up to 2 days later; a cash note changes the withdrawal's week.
  const weeks = l.kind === 'cash' && l.cash_date ? [weekStart(l.cash_date)] : [weekStart(l.date), weekStart(addDays(l.date, 2))];
  for (const w of weeks) if (await weekScored(db, w)) throw bad('This entry was used when a week was scored, so it has to stay.');
  await db.prepare(`DELETE FROM logs WHERE id = ?1`).bind(id).run();
  return { ok: true };
}

// ---------- Settings & accounts ----------

function cleanPhases<T>(v: unknown, name: string, cleanValue: (x: unknown) => T): Phase<T>[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 6) throw bad(`${name}: needs 1–6 periods.`);
  const out = v.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const until = i === v.length - 1 ? null : ymd(o.until, `${name} end date`);
    return { until, value: cleanValue(o.value) };
  });
  for (let i = 1; i < out.length - 1; i++) if ((out[i].until as string) <= (out[i - 1].until as string)) throw bad(`${name}: end dates must go forwards.`);
  return out;
}

/** Only known settings, with the right types. Anything else in the request is ignored. */
function cleanSettings(incoming: Record<string, unknown>, current: Settings): Settings {
  const pick = <K extends keyof Settings>(k: K): unknown => (k in incoming ? incoming[k] : current[k]);
  const money = (x: unknown) => { const n = num(x, 'Amount'); if (n < 0 || n > 1e6) throw bad('Amounts must be between 0 and 1,000,000.'); return Math.round(n * 100) / 100; };
  const capKeys = Object.keys(DEFAULT_SETTINGS.caps[0].value);
  const caps = (x: unknown) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return Object.fromEntries(capKeys.map((k) => [k, money(o[k] ?? 0)]));
  };
  const words = (x: unknown, max: number) => (Array.isArray(x) ? x : []).map((w) => str(w, 'Word', 60, true)).filter(Boolean).slice(0, max);
  return {
    creatureName: str(pick('creatureName'), 'Name', 40),
    allowance: cleanPhases(pick('allowance'), 'Allowance', money),
    savingsTarget: cleanPhases(pick('savingsTarget'), 'Savings target', money),
    caps: cleanPhases(pick('caps'), 'Caps', caps),
    fxGbpUsd: num(pick('fxGbpUsd'), 'GBP→USD rate'),
    savingsAccountId: str(pick('savingsAccountId') ?? '', 'Savings account', 40, true),
    savingsKeywords: words(pick('savingsKeywords'), 20),
    ownNames: words(pick('ownNames'), 10),
    savingsWindowStartDay: num(pick('savingsWindowStartDay'), 'Savings start day'),
    deliveryWeeklyCap: money(pick('deliveryWeeklyCap')),
    // Fixed once set: the halving date and when scoring started.
    halveNegativesBefore: current.halveNegativesBefore,
    scoringStart: current.scoringStart,
  };
}

export async function saveSettings(db: D1Database, body: unknown, now: number) {
  const core = await loadCore(db, now, weekStart(ppDate(now)));
  const incoming = ((body ?? {}) as { settings?: unknown }).settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw bad('Expected settings.');
  const next = cleanSettings(incoming as Record<string, unknown>, core.settings);
  if (next.savingsAccountId && !core.accounts.some((a) => a.id === next.savingsAccountId)) throw bad('Savings account must be one of your accounts.');
  const errs = validateSettings(next);
  if (errs.length) throw bad(errs.join(' '));
  const stmts = [
    db.prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(next)),
    db.prepare(`UPDATE creatures SET name = ?1 WHERE died_at IS NULL`).bind(next.creatureName),
  ];
  // Changing the rules is allowed, but it shows up in the score log so it's never invisible.
  const changes = settingsChanges(core.settings, next);
  if (changes.length) stmts.push(settingsEvent(db, core, now, `Settings changed: ${changes.join('; ')}.`));
  await db.batch(stmts);
  return { settings: next };
}

function phasesText(p: Phase<number>[]): string {
  return p.map((x) => `${usd(x.value)}${x.until ? ` until ${x.until}` : ''}`).join(', then ');
}

function settingsChanges(a: Settings, b: Settings): string[] {
  const out: string[] = [];
  if (JSON.stringify(a.allowance) !== JSON.stringify(b.allowance)) out.push(`weekly allowance ${phasesText(a.allowance)} → ${phasesText(b.allowance)}`);
  if (JSON.stringify(a.savingsTarget) !== JSON.stringify(b.savingsTarget)) out.push(`savings target ${phasesText(a.savingsTarget)} → ${phasesText(b.savingsTarget)}`);
  if (JSON.stringify(a.caps) !== JSON.stringify(b.caps)) out.push('monthly caps edited');
  if (a.fxGbpUsd !== b.fxGbpUsd) out.push(`GBP→USD rate ${a.fxGbpUsd} → ${b.fxGbpUsd}`);
  if (a.deliveryWeeklyCap !== b.deliveryWeeklyCap) out.push(`delivery cap ${usd(a.deliveryWeeklyCap)} → ${usd(b.deliveryWeeklyCap)}`);
  if (a.savingsAccountId !== b.savingsAccountId || JSON.stringify(a.savingsKeywords) !== JSON.stringify(b.savingsKeywords)) out.push('savings account or keywords changed');
  return out;
}

function settingsEvent(db: D1Database, core: Core, now: number, reason: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO score_events (creature_id, week_start, kind, delta, reason, at, health_after) VALUES (?1, ?2, 'settings', 0, ?3, ?4, ?5)`)
    .bind(core.creature.id, weekStart(ppDate(now)), reason.slice(0, 500), now, core.creature.health);
}

// ---------- Transactions added by hand ----------

const MONEY_IN_OK = new Set(['Friends paying back', 'Transfer', 'Investing']);

/**
 * For spending that will never appear on an uploaded statement (another card, someone else paid, etc.).
 * Spending counts towards the week like statement rows. Money in is recorded for History only (no proof),
 * and only as Friends paying back or Transfer/Investing.
 */
export async function addManualTx(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  const today = ppDate(now);
  const date = ymd(o.date, 'Date');
  if (date > today) throw bad('The date can’t be in the future.');
  if (date < addDays(today, -400)) throw bad('That date is too far back.');
  const payee = maskPayee(str(o.payee, 'What / where', 120));
  const amountUsd = Math.round(num(o.amountUsd, 'Amount') * 100) / 100;
  if (amountUsd === 0 || Math.abs(amountUsd) > 100000) throw bad('Amount must be non-zero and under $100,000.');
  const category = str(o.category, 'Category', 40);
  if (!isCategory(category)) throw bad('Unknown category.');
  if (amountUsd < 0 && !MONEY_IN_OK.has(category)) throw bad('Money in can only be “Friends paying back”, Transfer or Investing.');
  // Savings must be proven by a statement, so hand-added rows never count as saved.
  const savings = false;
  const hash = await sha256Hex(`manual|${crypto.randomUUID()}`);
  await db.prepare(
    `INSERT INTO transactions (hash, account_id, bank, source, date, time, payee, amount_orig, currency, amount_usd, balance, category, savings, is_cash, upload_id, seq, created_at)
     VALUES (?1, 'manual', 'MANUAL', 'manual', ?2, NULL, ?3, ?4, 'USD', ?4, NULL, ?5, ?6, 0, NULL, 0, ?7)`,
  ).bind(hash, date, payee, amountUsd, category, savings ? 1 : 0, now).run();
  const closed = await db.prepare(`SELECT data_ok FROM week_evals WHERE week_start = ?1`).bind(weekStart(date)).first<{ data_ok: number }>();
  return { hash, note: closed && closed.data_ok ? `The week of ${formatDate(weekStart(date))} was already scored, so this only shows in History.` : null };
}

export async function deleteManualTx(db: D1Database, hash: string, now: number) {
  if (!HEX64.test(hash)) throw bad('Bad id.');
  const t = await db.prepare(`SELECT created_at, date FROM transactions WHERE hash = ?1 AND source = 'manual'`).bind(hash).first<{ created_at: number; date: string }>();
  if (!t) throw new HttpError(404, 'Not found.');
  if (now - Number(t.created_at) > 24 * 3600e3) throw bad('Hand-added transactions older than a day can’t be deleted.');
  if (await weekScored(db, weekStart(t.date))) throw bad('That week has already been scored with this transaction, so it has to stay.');
  await db.prepare(`DELETE FROM transactions WHERE hash = ?1 AND source = 'manual'`).bind(hash).run();
  return { ok: true };
}

export async function saveAccount(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  const bank = o.bank === 'ABA' || o.bank === 'REV' ? o.bank : null;
  if (!bank) throw bad('Bank must be ABA or Revolut.');
  const last3 = str(o.last3, 'Last 3 digits', 3);
  if (!/^\d{3}$/.test(last3)) throw bad('Enter exactly the last 3 digits.');
  const id = `${bank}-${last3}`;
  const label = str(o.label ?? `${bank === 'REV' ? 'Revolut' : 'ABA'} ${last3}`, 'Label', 40);
  const core = await loadCore(db, now, weekStart(ppDate(now)));
  const prev = core.accounts.find((a) => a.id === id);
  const optional = !!o.optional;
  const active = o.active !== false;
  const stmts = [
    db.prepare(`INSERT INTO accounts (id, bank, last3, label, optional, active, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(sort),0)+1 FROM accounts))
                ON CONFLICT(id) DO UPDATE SET label = excluded.label, optional = excluded.optional, active = excluded.active`)
      .bind(id, bank, last3, maskPayee(label), optional ? 1 : 0, active ? 1 : 0),
  ];
  const changes: string[] = [];
  if (!prev) changes.push(`added ${label}${optional ? ' (optional)' : ''}`);
  else {
    if (prev.optional !== optional) changes.push(`${prev.label} is now ${optional ? 'optional' : 'required'}`);
    if (prev.active !== active) changes.push(`${prev.label} ${active ? 'switched on' : 'switched off'}`);
  }
  if (changes.length) stmts.push(settingsEvent(db, core, now, `Accounts changed: ${changes.join('; ')}.`));
  await db.batch(stmts);
  return { id };
}

// ---------- History import / export ----------

export async function importCsv(db: D1Database, body: unknown, now: number) {
  const o = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.rows) || o.rows.length === 0 || o.rows.length > CSV_ROWS_PER_REQUEST) throw bad(`Expected 1–${CSV_ROWS_PER_REQUEST} rows per request.`);
  const core = await loadCore(db, now, weekStart(ppDate(now)));
  const parsed = (o.rows as Record<string, unknown>[]).map((r, i) => {
    const account = str(r.account, 'account', 40);
    const category = str(r.category, 'category', 40);
    if (!isCategory(category)) throw bad(`Row ${i + 1}: unknown category.`);
    const dup = r.dup === undefined ? 0 : num(r.dup, 'dup');
    if (!Number.isInteger(dup) || dup < 0 || dup > 10000) throw bad(`Row ${i + 1}: bad duplicate number.`);
    const payee = str(r.payee, 'payee', 300);
    return { account, category, dup, payee, date: ymd(r.date, `Row ${i + 1} date`), amountUsd: round2(num(r.amountUsd, 'amount')) };
  });
  // Ids are computed here from the row itself (prefixed "csv"), so imported rows can never take the
  // place of statement rows, and importing the same file twice adds nothing.
  const hashes = parsed.map((r) => sha256HexSync(txIdentity('csv', csvHashable(r), r.dup)));
  const rows = parsed.map((r, i) => {
    const match = /^\d{3}$/.test(r.account) ? core.accounts.find((a) => a.last3 === r.account) : core.accounts.find((a) => a.id === r.account);
    return {
      h: hashes[i],
      a: match ? match.id : `csv:${r.account}`,
      k: match ? match.bank : bankForLabel(r.account),
      d: r.date,
      p: maskPayee(r.payee),
      u: r.amountUsd,
      c: r.category,
    };
  });
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO transactions (hash, account_id, bank, source, date, time, payee, amount_orig, currency, amount_usd, balance, category, savings, is_cash, upload_id, seq)
         SELECT json_extract(value,'$.h'), json_extract(value,'$.a'), json_extract(value,'$.k'), 'csv', json_extract(value,'$.d'), NULL, json_extract(value,'$.p'), json_extract(value,'$.u'), 'USD', json_extract(value,'$.u'), NULL, json_extract(value,'$.c'), 0, 0, NULL, 0
         FROM json_each(?1)`,
      ).bind(JSON.stringify(rows.slice(i, i + 500))),
    );
  }
  const learned = [...learnRules(rows.map((r) => ({ payee: r.p, category: r.c })))].map(([k, c]) => ({ k, c }));
  if (learned.length) {
    stmts.push(
      db.prepare(
        `INSERT INTO payee_rules (key, category, source, updated_at) SELECT json_extract(value,'$.k'), json_extract(value,'$.c'), 'csv', ?2 FROM json_each(?1) WHERE true
         ON CONFLICT(key) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at WHERE payee_rules.source = 'csv'`,
      ).bind(JSON.stringify(learned), now),
    );
  }
  const res = await db.batch(stmts);
  const inserted = res.slice(0, Math.ceil(rows.length / 500)).reduce((a, r) => a + (r.meta.changes ?? 0), 0);
  return { inserted, skipped: rows.length - inserted, rulesLearned: learned.length };
}

export async function getHistory(db: D1Database) {
  const r = await db.prepare(`SELECT date, category, source, bank, ROUND(SUM(amount_usd), 2) AS amount FROM transactions GROUP BY date, category, source, bank ORDER BY date`).raw();
  return { rows: r };
}

const EXPORT_TABLES = new Map<string, string>(Object.entries({
  transactions: `SELECT date, time, account_id, source, payee, amount_orig, currency, amount_usd, balance, category, savings, is_cash, hash FROM transactions WHERE hash > ?1 ORDER BY hash LIMIT 1000`,
  logs: `SELECT date, created_at, kind, amount_usd, what, why, category, urgent, cash_tx_hash, id FROM logs WHERE id > ?1 ORDER BY id LIMIT 1000`,
  score_events: `SELECT week_start, at, creature_id, kind, delta, health_after, reason, printf('%012d', id) AS cursor FROM score_events WHERE printf('%012d', id) > ?1 ORDER BY id LIMIT 1000`,
  uploads: `SELECT uploaded_at, account_id, period_start, period_end, opening, closing, currency, row_count, new_rows, ok, baseline, id FROM uploads WHERE id > ?1 ORDER BY id LIMIT 1000`,
  creatures: `SELECT id, name, born_at, died_at, start_health, health, printf('%012d', id) AS cursor FROM creatures WHERE printf('%012d', id) > ?1 ORDER BY id LIMIT 1000`,
  payee_rules: `SELECT key, category, source, updated_at, key AS cursor FROM payee_rules WHERE key > ?1 ORDER BY key LIMIT 1000`,
}));

/** Paged export (the browser builds the CSV, keeping Worker CPU low). The last column is the paging cursor. */
export async function exportPage(db: D1Database, table: string, after: string) {
  const sql = EXPORT_TABLES.get(table);
  if (!sql) throw bad('Unknown table.');
  const stmt = db.prepare(sql).bind(after.slice(0, 200));
  const [columns, ...rows] = await stmt.raw({ columnNames: true });
  return { columns, rows, done: rows.length < 1000 };
}

export async function renameCreature(db: D1Database, body: unknown, now: number) {
  const name = str(((body ?? {}) as Record<string, unknown>).name, 'Name', 40);
  const core = await loadCore(db, now, weekStart(ppDate(now)));
  return saveSettings(db, { settings: { ...core.settings, creatureName: name } }, now);
}
