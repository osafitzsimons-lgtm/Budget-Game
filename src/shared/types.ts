export type Bank = 'ABA' | 'REV';

export interface Account {
  id: string; // e.g. "ABA-812"
  bank: Bank;
  last3: string;
  label: string;
  optional: boolean;
  active: boolean;
}

/** One row ready to store. amountUsd is spend-positive (out > 0, in < 0). */
export interface TxRow {
  hash: string;
  date: string;
  time: string | null;
  payee: string;
  amountOrig: number;
  currency: 'USD' | 'GBP';
  amountUsd: number;
  /** running balance after this row, in the account's own currency */
  balance: number | null;
  category: string;
  savings: boolean;
  isCash: boolean;
  seq: number;
}

export interface StatementSummary {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  periodFromHeader: boolean;
  opening: number;
  closing: number;
  currency: 'USD' | 'GBP';
}

export interface ProofCheck {
  id: 'account' | 'reaches-saturday' | 'no-gap' | 'opening-balance' | 'baseline';
  ok: boolean;
  /** false = informational: the statement is still saved if this fails (it just doesn't cover last week yet) */
  blocking: boolean;
  label: string;
  detail: string;
}

export interface ProofResult {
  /** every blocking check passed: the rows are saved */
  ok: boolean;
  /** reaches last Saturday */
  covers: boolean;
  baseline: boolean;
  checks: ProofCheck[];
  newRows: number;
}

export interface LogEntry {
  id: string;
  createdAt: number;
  date: string;
  amountUsd: number;
  what: string;
  why: string;
  kind: 'planned' | 'cash';
  category: string | null;
  urgent: boolean;
  /** cash logs: hash of the withdrawal this cash came from */
  cashTxHash: string | null;
}

export interface ScoreEvent {
  id?: number;
  creatureId: number;
  weekStart: string;
  kind: 'missing-upload' | 'proof-failing' | 'spend' | 'unlogged' | 'savings' | 'death' | 'birth';
  delta: number;
  reason: string;
  at: number;
  healthAfter: number;
}

export interface Creature {
  id: number;
  name: string;
  bornAt: number;
  diedAt: number | null;
  startHealth: number;
  health: number;
}
