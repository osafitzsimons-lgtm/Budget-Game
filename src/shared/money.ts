export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const sameMoney = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

/**
 * Parse an amount printed on a statement: "1,234.56", "$12.00", "£5.20", "(5.00)", "-5.00", "5.00 USD".
 * Returns null if the text is not exactly an amount.
 */
export function parseAmount(text: string): number | null {
  let s = text.replace(/\s+/g, '').replace(/(USD|GBP|US\$)/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-') || s.startsWith('−')) { neg = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/^[£$]/, '');
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(s)) return null;
  const v = Number(s.replace(/,/g, ''));
  return neg ? -v : v;
}

export function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function usd0(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}
