export const COMMITTED = [
  'Rent and bills',
  'Internet and phone',
  'Student loan',
  'Chan',
  'Claude',
  'Other subscriptions',
  'Virgin Money card',
] as const;

export const NEGOTIABLE = [
  'Eating out and bars',
  'Grab orders',
  'Food shop',
  'Rides',
  'School cafe',
  'Street food and small QR',
  'Sport',
  'Trips',
  'Clothes and kit',
  'Gaming',
  'Medical',
  'Unidentified',
  'Friends paying back',
] as const;

export const EXCLUDED = ['Transfer', 'Investing'] as const;

export const ALL_CATEGORIES: string[] = [...COMMITTED, ...NEGOTIABLE, ...EXCLUDED];

export type Group = 'committed' | 'negotiable' | 'excluded';

export function groupOf(category: string): Group {
  if ((COMMITTED as readonly string[]).includes(category)) return 'committed';
  if ((NEGOTIABLE as readonly string[]).includes(category)) return 'negotiable';
  if ((EXCLUDED as readonly string[]).includes(category)) return 'excluded';
  throw new Error(`Unknown category "${category}"`);
}

export function isCategory(c: string): boolean {
  return ALL_CATEGORIES.includes(c);
}

export const isNegotiable = (c: string) => (NEGOTIABLE as readonly string[]).includes(c);
export const isExcluded = (c: string) => (EXCLUDED as readonly string[]).includes(c);

/** Categories with their own monthly cap. Every other negotiable shares the "Everything else" cap. */
export const CAPPED = [
  'Eating out and bars',
  'Grab orders',
  'Food shop',
  'Rides',
  'School cafe',
  'Street food and small QR',
  'Sport',
  'Trips',
] as const;

export const OTHER_CAP = 'Everything else';

export function capBucket(category: string): string {
  return (CAPPED as readonly string[]).includes(category) ? category : OTHER_CAP;
}
