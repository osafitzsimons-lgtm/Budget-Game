import { OTHER_CAP } from './categories';

/** A value that changes on a date: `until` is the last day (inclusive) it applies; null = forever. */
export interface Phase<T> {
  until: string | null;
  value: T;
}

export interface Settings {
  creatureName: string;
  allowance: Phase<number>[];
  savingsTarget: Phase<number>[];
  caps: Phase<Record<string, number>>[];
  /** GBP → USD rate used to convert Revolut statements. */
  fxGbpUsd: number;
  /** Account id (e.g. "ABA-811") money is saved into. Empty = not nominated yet. */
  savingsAccountId: string;
  /** Extra words that mark a payee as "moved to savings" (e.g. a savings app's name). */
  savingsKeywords: string[];
  /** Your name as banks print it, used to spot transfers between your own accounts. */
  ownNames: string[];
  /** Savings for month M count if dated from this day of month M-1 through the 3rd of M. */
  savingsWindowStartDay: number;
  /** Negative health changes before this date (Phnom Penh) are halved. */
  halveNegativesBefore: string;
  /** Delivery (Grab orders) weekly cap shown on the Negotiables screen. */
  deliveryWeeklyCap: number;
  /** Week start (Sunday) of the first scored week. Set automatically on first open. */
  scoringStart: string;
}

export const DEFAULT_SETTINGS: Settings = {
  creatureName: 'Sprout',
  allowance: [
    { until: '2027-02-28', value: 161 },
    { until: null, value: 251 },
  ],
  savingsTarget: [
    { until: '2027-02-28', value: 500 },
    { until: null, value: 800 },
  ],
  caps: [
    {
      until: '2027-02-28',
      value: {
        'Eating out and bars': 220,
        'Grab orders': 60,
        'Food shop': 120,
        Rides: 80,
        'School cafe': 60,
        'Street food and small QR': 40,
        Sport: 30,
        Trips: 0,
        [OTHER_CAP]: 89,
      },
    },
    {
      until: null,
      value: {
        'Eating out and bars': 300,
        'Grab orders': 80,
        'Food shop': 130,
        Rides: 90,
        'School cafe': 70,
        'Street food and small QR': 50,
        Sport: 40,
        Trips: 200,
        [OTHER_CAP]: 128,
      },
    },
  ],
  fxGbpUsd: 1.33,
  savingsAccountId: '',
  savingsKeywords: [],
  ownNames: [],
  savingsWindowStartDay: 25,
  halveNegativesBefore: '2026-11-29',
  deliveryWeeklyCap: 15,
  scoringStart: '',
};

export function phaseValue<T>(phases: Phase<T>[], ymd: string): T {
  for (const p of phases) if (p.until === null || ymd <= p.until) return p.value;
  return phases[phases.length - 1].value;
}

export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export function validateSettings(s: Settings): string[] {
  const errs: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (typeof s.creatureName !== 'string' || !s.creatureName.trim() || s.creatureName.length > 40)
    errs.push('Name must be 1–40 characters.');
  for (const key of ['allowance', 'savingsTarget', 'caps'] as const) {
    const phases = s[key] as Phase<unknown>[];
    if (!Array.isArray(phases) || phases.length === 0) errs.push(`${key} needs at least one period.`);
    else if (phases[phases.length - 1].until !== null) errs.push(`${key}: last period must have no end date.`);
  }
  for (const p of s.allowance ?? []) if (!num(p.value)) errs.push('Allowance must be a positive number.');
  for (const p of s.savingsTarget ?? []) if (!num(p.value)) errs.push('Savings target must be a positive number.');
  for (const p of s.caps ?? []) for (const v of Object.values(p.value)) if (!num(v)) errs.push('Caps must be positive numbers.');
  if (!num(s.fxGbpUsd) || s.fxGbpUsd < 0.5 || s.fxGbpUsd > 3) errs.push('GBP→USD rate looks wrong (expected 0.5–3).');
  if (!Number.isInteger(s.savingsWindowStartDay) || s.savingsWindowStartDay < 1 || s.savingsWindowStartDay > 28)
    errs.push('Savings window start day must be 1–28.');
  return errs;
}
