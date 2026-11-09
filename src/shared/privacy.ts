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

const NON_ASCII = /[^\x00-\x7F]/;

function normalise(raw: string): string {
  let s = raw.slice(0, MAX_LEN * 4);
  if (NON_ASCII.test(s)) s = s.normalize('NFKC').replace(INVISIBLE, '').replace(KHMER, (d) => String(d.charCodeAt(0) - 0x17e0));
  return s.replace(/\s+/g, ' ').trim();
}

function maskRun(run: string): string {
  // Cheap first pass: count digits and hiding characters in one go.
  let digitCount = 0;
  let hidden = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 48 && c <= 57) digitCount++;
    else if (c === 88 || c === 120 || c === 42 || c === 0x2022) hidden++;
  }
  if (digitCount < 3) return run;
  // Leave trailing separators alone (e.g. "1234 - " before more text). Scanned by hand: linear time.
  let end = run.length;
  while (end > 0 && !/[0-9Xx*•]/.test(run[end - 1])) end--;
  const core = run.slice(0, end);
  const tail = run.slice(end);
  const digits = core.replace(/\D/g, '');
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
