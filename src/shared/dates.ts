// All calendar logic uses Asia/Phnom_Penh. Dates are passed around as "YYYY-MM-DD"
// strings (a calendar day in Phnom Penh) and instants as epoch milliseconds.

export const TZ = 'Asia/Phnom_Penh';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface PPParts {
  ymd: string;
  hour: number;
  minute: number;
  second: number;
}

export function ppParts(ms: number): PPParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Phnom Penh calendar date for an instant. */
export function ppDate(ms: number): string {
  return ppParts(ms).ymd;
}

function ymdToUTC(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Offset of Phnom Penh from UTC (ms) at an instant. */
function offsetAt(ms: number): number {
  const p = ppParts(ms);
  const asUTC = ymdToUTC(p.ymd) + p.hour * 3600e3 + p.minute * 60e3 + p.second * 1e3;
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** The instant of a Phnom Penh wall-clock time. */
export function ppInstant(ymd: string, hour = 0, minute = 0): number {
  const guess = ymdToUTC(ymd) + hour * 3600e3 + minute * 60e3;
  return guess - offsetAt(guess - offsetAt(guess));
}

export function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ymdToUTC(s)) &&
    new Date(ymdToUTC(s)).toISOString().slice(0, 10) === s;
}

export function addDays(ymd: string, n: number): string {
  return new Date(ymdToUTC(ymd) + n * 86400e3).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400e3);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(ymd: string): number {
  return new Date(ymdToUTC(ymd)).getUTCDay();
}

/** Scored weeks run Sunday to Saturday. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -dayOfWeek(ymd));
}

export function weekEnd(weekStartYmd: string): string {
  return addDays(weekStartYmd, 6);
}

/** Statements for a week are due the next Sunday at 20:00 Phnom Penh time. */
export function weekDeadline(weekStartYmd: string): number {
  return ppInstant(addDays(weekStartYmd, 7), 20, 0);
}

/** The most recent Saturday strictly before `today` (Sunday → yesterday, Saturday → a week ago). */
export function previousSaturday(today: string): string {
  return addDays(today, -(dayOfWeek(today) + 1));
}

export function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n === 'sept') return 8;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  let i = full.indexOf(n);
  if (i < 0) i = MONTHS.indexOf(n);
  return i;
}

export function makeYmd(year: number, monthIdx0: number, day: number): string | null {
  if (monthIdx0 < 0 || monthIdx0 > 11 || day < 1 || day > 31) return null;
  const s = `${year}-${String(monthIdx0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isYmd(s) ? s : null;
}

const MON_RE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\\.?';

/** "Aug 05, 2026" (ABA) */
export const ABA_DATE_RE = new RegExp(`^${MON_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i');
/** "2 Mar 2026", "2 Sept 2026" (Revolut) */
export const DMY_DATE_RE = new RegExp(`^(\\d{1,2})\\s+${MON_RE}\\s+(\\d{4})$`, 'i');

export function parseAbaDate(s: string): string | null {
  const m = ABA_DATE_RE.exec(s.trim());
  if (!m) return null;
  return makeYmd(Number(m[3]), monthIndex(m[1]), Number(m[2]));
}

export function parseDmyDate(s: string): string | null {
  const m = DMY_DATE_RE.exec(s.trim());
  if (!m) return null;
  return makeYmd(Number(m[3]), monthIndex(m[2]), Number(m[1]));
}

/** Any of the supported human date formats, used for statement period headings. */
export function findDates(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b(?:${MON_RE}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MON_RE}\\s+\\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(re)) {
    const s = m[0].replace(',', ', ').replace(/\s+/g, ' ').replace(' ,', ',');
    const parts = s.replace(',', '').split(' ');
    let d: string | null = null;
    if (/^\d/.test(parts[0])) d = makeYmd(Number(parts[2]), monthIndex(parts[1]), Number(parts[0]));
    else d = makeYmd(Number(parts[2]), monthIndex(parts[0]), Number(parts[1]));
    if (d) out.push(d);
  }
  return out;
}

export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}
