import { isCategory } from './categories';
import { maskPayee, payeeKey } from './privacy';

export interface CategoriseContext {
  /** payeeKey → category, learned from reviews and CSV imports */
  rules: Map<string, string>;
  ownNames: string[];
  /** last-3 digits of all your accounts */
  ownLast3: string[];
  savingsLast3: string | null;
  savingsKeywords: string[];
}

export interface Categorised {
  category: string;
  /** why this category was chosen, shown in the review list */
  reason: 'grab-refund' | 'grab-ride' | 'grab-order' | 'tada-ride' | 'cash' | 'remembered' | 'own-transfer' | 'small-unknown' | 'unknown' | 'unknown-in';
  needsReview: boolean;
  isCash: boolean;
  savings: boolean;
}

const GRAB = /\bgrab\b/i;
const TADA = /\btada\b/i;
const CASH = /\b(cash withdrawal|atm withdrawal|cash wdl|atm|withdrawal at)\b/i;

/** Payees covered by built-in rules. These are never learned, so the amount rules always win. */
export function isBuiltInPayee(payee: string): boolean {
  return GRAB.test(payee) || TADA.test(payee) || CASH.test(payee);
}

export function lookupRule(rules: Map<string, string>, payee: string): string | undefined {
  const key = payeeKey(payee);
  if (!key) return undefined;
  const exact = rules.get(key);
  if (exact) return exact;
  // Longest remembered payee contained in this one (e.g. "cafe one" inside "purchase cafe one bkk").
  let best: string | undefined;
  let bestLen = 0;
  for (const [k, cat] of rules) {
    if (k.length >= 6 && k.length > bestLen && (` ${key} `).includes(` ${k} `)) {
      best = cat;
      bestLen = k.length;
    }
  }
  return best;
}

function mentionsAccount(payee: string, l3: string): boolean {
  // After masking, account numbers look like •••812. Also accept "xxx812"-style.
  return new RegExp(`(?:•••|[x*]{2,}\\s?)${l3}\\b`, 'i').test(payee);
}

export function isSavingsMove(payee: string, amountUsd: number, ctx: CategoriseContext): boolean {
  if (amountUsd <= 0) return false;
  const p = maskPayee(payee);
  if (ctx.savingsLast3 && mentionsAccount(p, ctx.savingsLast3)) return true;
  return ctx.savingsKeywords.some((k) => k.trim() && p.toLowerCase().includes(k.trim().toLowerCase()));
}

/**
 * amountUsd is spend-positive: money out > 0, money in < 0.
 * Order: built-in Grab/TADA/cash rules, then remembered payee, then own-account transfer, then fallback.
 */
export function categorise(payeeRaw: string, amountUsd: number, ctx: CategoriseContext, thisLast3?: string): Categorised {
  const payee = maskPayee(payeeRaw);
  const base = { needsReview: false, isCash: false, savings: false };
  const out = amountUsd > 0;

  if (GRAB.test(payee)) {
    if (!out) return { ...base, category: 'Rides', reason: 'grab-refund' };
    return amountUsd < 5
      ? { ...base, category: 'Rides', reason: 'grab-ride' }
      : { ...base, category: 'Grab orders', reason: 'grab-order' };
  }
  if (TADA.test(payee) && out && amountUsd < 5) return { ...base, category: 'Rides', reason: 'tada-ride' };
  if (CASH.test(payee) && out) return { ...base, category: 'Unidentified', reason: 'cash', isCash: true };

  const remembered = lookupRule(ctx.rules, payee);
  if (remembered && isCategory(remembered)) {
    const savings = (remembered === 'Transfer' || remembered === 'Investing') && isSavingsMove(payee, amountUsd, ctx);
    return { ...base, category: remembered, reason: 'remembered', savings };
  }

  const lower = payee.toLowerCase();
  const own =
    /\bown account\b/i.test(payee) ||
    ctx.ownNames.some((n) => n.trim().length >= 3 && lower.includes(n.trim().toLowerCase())) ||
    ctx.ownLast3.some((l3) => l3 !== thisLast3 && mentionsAccount(payee, l3)) ||
    isSavingsMove(payee, amountUsd, ctx);
  if (own) return { ...base, category: 'Transfer', reason: 'own-transfer', savings: isSavingsMove(payee, amountUsd, ctx) };

  if (!out) {
    // Unknown money in: not spending. Bigger amounts get reviewed (could be a friend paying back).
    return { ...base, category: 'Transfer', reason: 'unknown-in', needsReview: Math.abs(amountUsd) >= 10 };
  }
  if (amountUsd < 10) return { ...base, category: 'Street food and small QR', reason: 'small-unknown' };
  return { ...base, category: 'Unidentified', reason: 'unknown', needsReview: true };
}

/** Learn rules from categorised rows: most common category per payee wins; Unidentified/built-ins skipped. */
export function learnRules(rows: { payee: string; category: string }[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  rows.forEach((r) => {
    if (r.category === 'Unidentified' || isBuiltInPayee(r.payee) || !isCategory(r.category)) return;
    const key = payeeKey(r.payee);
    if (!key) return;
    const m = counts.get(key) ?? new Map<string, number>();
    m.set(r.category, (m.get(r.category) ?? 0) + 1);
    counts.set(key, m);
  });
  const out = new Map<string, string>();
  for (const [key, m] of counts) {
    let best = '';
    let n = -1;
    for (const [cat, c] of m) if (c >= n) { best = cat; n = c; } // ties: the later-seen category
    out.set(key, best);
  }
  return out;
}
