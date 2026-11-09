export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Transaction identity. The running balance makes each row unique, so overlapping
 * statements for the same account produce identical hashes and are stored once.
 */
export function txIdentity(accountId: string, r: { date: string; time: string | null; payee: string; amountOrig: number; balance: number | null }, dup: number): string {
  return [accountId, r.date, r.time ?? '', r.payee.toLowerCase(), r.amountOrig.toFixed(2), r.balance === null ? '' : r.balance.toFixed(2), dup].join('|');
}

/** Hash rows, numbering exact duplicates so they stay distinct. */
export async function hashRows<T extends { date: string; time: string | null; payee: string; amountOrig: number; balance: number | null }>(accountId: string, rows: T[]): Promise<string[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    rows.map((r) => {
      const base = txIdentity(accountId, r, 0);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return sha256Hex(txIdentity(accountId, r, n));
    }),
  );
}
