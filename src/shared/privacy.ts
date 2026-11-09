// Privacy helpers. Payees are the only free text we store, so scrub anything that
// looks like an account or card number down to its last three digits.

const MASK = '•••';

/** Replace long digit runs (account/card numbers, optionally spaced or dashed) with •••123. */
export function maskPayee(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Card numbers with stars/x's, e.g. 412345******1234 or XXXX-XXXX-XXXX-1234
  s = s.replace(/[0-9Xx*•][0-9Xx*•\s-]{6,}[0-9]/g, (m) => {
    const hidden = (m.match(/[Xx*•]/g) ?? []).length;
    const digits = m.replace(/\D/g, '');
    if (hidden < 3 || digits.length < 3) return m;
    return MASK + digits.slice(-3);
  });
  // Plain digit runs of 6+ digits, allowing single spaces or dashes between groups.
  s = s.replace(/\d(?:[\s-]?\d){5,}/g, (m) => MASK + m.replace(/\D/g, '').slice(-3));
  return s.slice(0, 120);
}

/** Normalised key used to remember a payee's category. */
export function payeeKey(payee: string): string {
  return maskPayee(payee)
    .toLowerCase()
    .replace(/•••\d{3}/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep only the last three digits of an account number. */
export function last3(accountNumber: string): string | null {
  const d = accountNumber.replace(/\D/g, '');
  return d.length >= 3 ? d.slice(-3) : null;
}
