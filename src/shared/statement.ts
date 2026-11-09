import type { ParsedStatement } from '../parsers/types';
import { categorise, type CategoriseContext, type Categorised } from './categorise';
import { hashRows } from './hash';
import { round2 } from './money';
import { maskPayee } from './privacy';
import type { Account, StatementSummary, TxRow } from './types';

export interface PreparedRow extends TxRow {
  reason: Categorised['reason'];
  needsReview: boolean;
}

export interface PreparedStatement {
  summary: StatementSummary & { bank: 'ABA' | 'REV'; last3: string; fx: number };
  rows: PreparedRow[];
}

export function findAccount(parsed: Pick<ParsedStatement, 'bank' | 'accountLast3'>, accounts: Account[]): Account | null {
  return accounts.find((a) => a.bank === parsed.bank && a.last3 === parsed.accountLast3 && a.active) ?? null;
}

/** Turn a parsed statement into rows to store: mask payees, convert to USD, categorise, hash. */
export async function prepareStatement(parsed: ParsedStatement, accountId: string, fxGbpUsd: number, ctx: CategoriseContext): Promise<PreparedStatement> {
  const fx = parsed.currency === 'GBP' ? fxGbpUsd : 1;
  const base = parsed.rows.map((r, i) => {
    const amountOrig = round2(r.moneyOut - r.moneyIn);
    const amountUsd = parsed.currency === 'GBP' ? round2(amountOrig * fx) : amountOrig;
    const payee = maskPayee(r.description) || '(no description)';
    return { date: r.date, time: r.time, payee, amountOrig, amountUsd, balance: r.balance, seq: i };
  });
  const hashes = await hashRows(accountId, base);
  const rows: PreparedRow[] = base.map((b, i) => {
    const c = categorise(b.payee, b.amountUsd, ctx, parsed.accountLast3);
    return { ...b, hash: hashes[i], currency: parsed.currency, category: c.category, savings: c.savings, isCash: c.isCash, reason: c.reason, needsReview: c.needsReview };
  });
  return {
    summary: {
      accountId,
      bank: parsed.bank,
      last3: parsed.accountLast3,
      currency: parsed.currency,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      periodFromHeader: parsed.periodFromHeader,
      opening: parsed.opening,
      closing: parsed.closing,
      fx,
    },
    rows,
  };
}

export function contextFrom(rules: [string, string][], accounts: Account[], settings: { ownNames: string[]; savingsAccountId: string; savingsKeywords: string[] }): CategoriseContext {
  const sav = accounts.find((a) => a.id === settings.savingsAccountId);
  return {
    rules: new Map(rules),
    ownNames: settings.ownNames,
    ownLast3: accounts.map((a) => a.last3),
    savingsLast3: sav?.last3 ?? null,
    savingsKeywords: settings.savingsKeywords,
  };
}
