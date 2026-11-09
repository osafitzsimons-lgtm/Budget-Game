import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, findDates, parseAbaDate, parseDmyDate, ppDate, ppInstant, previousSaturday, weekDeadline, weekStart } from '../src/shared/dates';

describe('Phnom Penh dates', () => {
  it('uses UTC+7 for the calendar day', () => {
    // 2026-11-07 17:00 UTC = Sun 8 Nov 00:00 in Phnom Penh
    expect(ppDate(Date.UTC(2026, 10, 7, 16, 59, 59))).toBe('2026-11-07');
    expect(ppDate(Date.UTC(2026, 10, 7, 17, 0, 0))).toBe('2026-11-08');
    expect(ppInstant('2026-11-08', 0, 0)).toBe(Date.UTC(2026, 10, 7, 17, 0, 0));
  });

  it('weeks run Sunday to Saturday at the Phnom Penh boundary', () => {
    expect(dayOfWeek('2026-11-08')).toBe(0);
    expect(weekStart('2026-11-08')).toBe('2026-11-08');
    expect(weekStart('2026-11-14')).toBe('2026-11-08');
    expect(weekStart('2026-11-15')).toBe('2026-11-15');
    // Saturday 23:59 Phnom Penh is still last week, even though it is Saturday 16:59 UTC
    const satLate = Date.UTC(2026, 10, 14, 16, 59);
    const sunEarly = Date.UTC(2026, 10, 14, 17, 1);
    expect(weekStart(ppDate(satLate))).toBe('2026-11-08');
    expect(weekStart(ppDate(sunEarly))).toBe('2026-11-15');
  });

  it('statements are due the next Sunday at 20:00 Phnom Penh time', () => {
    expect(weekDeadline('2026-11-08')).toBe(Date.UTC(2026, 10, 15, 13, 0, 0));
    expect(new Date(weekDeadline('2026-11-22')).toISOString()).toBe('2026-11-29T13:00:00.000Z');
  });

  it('previous Saturday', () => {
    expect(previousSaturday('2026-11-15')).toBe('2026-11-14'); // Sunday
    expect(previousSaturday('2026-11-11')).toBe('2026-11-07'); // Wednesday
    expect(previousSaturday('2026-11-14')).toBe('2026-11-07'); // Saturday → a week ago
  });

  it('parses statement dates including "Sept"', () => {
    expect(parseAbaDate('Aug 05, 2026')).toBe('2026-08-05');
    expect(parseAbaDate('Feb 30, 2026')).toBeNull();
    expect(parseDmyDate('2 Mar 2026')).toBe('2026-03-02');
    expect(parseDmyDate('14 Sept 2026')).toBe('2026-09-14');
    expect(parseDmyDate('14 Sep 2026')).toBe('2026-09-14');
    expect(findDates('Account transactions from 1 August 2026 to 31 October 2026')).toEqual(['2026-08-01', '2026-10-31']);
    expect(findDates('Period: Aug 05, 2026 - Oct 31, 2026')).toEqual(['2026-08-05', '2026-10-31']);
  });

  it('addDays crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
});
