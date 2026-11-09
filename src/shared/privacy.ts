// Privacy helpers. Payees and notes are the only free text we store, so anything that
// looks like an account or card number is cut down to its last three digits.
// Every pattern here is linear-time: payees come from PDFs and must not be able to
// make the server spin (the free plan allows 10 ms of CPU per request).

const MASK = '•••';
const MAX_LEN = 300;

/** Invisible characters PDF text extraction often leaves inside numbers. */
const INVISIBLE = /[­​-‏⁠﻿]/g;
/** Khmer digits ០-៩ → 0-9 (full-width digits are handled by NFKC). */
const KHMER = /[០-៩]/g;
/** Characters that can sit between groups of digits in account and card numbers. */
const SEP = '\\s.\\-\\u2010-\\u2015/_';
/** A run of digits, separators and hiding characters (X, *, •). Matches greedily with no backtracking. */
const RUN = new RegExp(`[0-9Xx*•][0-9Xx*•${SEP}]*`, 'g');

function normalise(raw: string): string {
  return raw
    .slice(0, MAX_LEN * 4)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(KHMER, (d) => String(d.charCodeAt(0) - 0x17e0))
    .replace(/\s+/g, ' ')
    .trim();
}

function maskRun(run: string): string {
  // Leave trailing separators alone (e.g. "1234 - " before more text).
  const core = run.replace(new RegExp(`[${SEP}]+$`), '');
  const tail = run.slice(core.length);
  const digits = core.replace(/\D/g, '');
  const hidden = (core.match(/[Xx*•]/g) ?? []).length;
  const contiguous = /\d{6,}/.test(core);
  const separated = digits.length >= 8;
  // Card numbers with hidden digits (412345******1234, XXXX XXXX XXXX 1234), long digit runs, or
  // spaced/dotted/dashed groups of 8+ digits (account numbers like 015 526 659).
  if ((hidden >= 3 && digits.length >= 3) || contiguous || separated) return MASK + digits.slice(-3) + tail;
  return run;
}

/** Replace account and card numbers with •••123, in any spelling we have seen in PDFs. */
export function maskPayee(raw: string): string {
  return normalise(raw).replace(RUN, maskRun).slice(0, MAX_LEN);
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
