import { change, pct, sentimentShares, shareOfVoice, simpsonDiversity } from '../../../src/analytics/metrics';
import { localDate, localParts, nextRunAt, previousPeriod, zonedToUtc } from '../../../src/analytics/tz';

const iso = (d: Date) => d.toISOString();

describe('time zones', () => {
  it('converts local wall-clock time to UTC for Indonesian zones', () => {
    expect(iso(zonedToUtc(2026, 10, 19, 0, 0, 'Asia/Jakarta'))).toBe('2026-10-18T17:00:00.000Z');   // WIB +7
    expect(iso(zonedToUtc(2026, 10, 19, 0, 0, 'Asia/Makassar'))).toBe('2026-10-18T16:00:00.000Z');  // WITA +8
    expect(iso(zonedToUtc(2026, 10, 19, 0, 0, 'Asia/Jayapura'))).toBe('2026-10-18T15:00:00.000Z');  // WIT +9
  });
  it('handles daylight-saving transitions (gap resolves forward, ambiguous resolves to first)', () => {
    expect(iso(zonedToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin'))).toBe('2026-03-29T01:30:00.000Z');   // 02:30 does not exist
    expect(iso(zonedToUtc(2026, 10, 25, 2, 30, 'Europe/Berlin'))).toBe('2026-10-25T00:30:00.000Z');  // 02:30 occurs twice
    expect(localParts(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin')).toMatchObject({ h: 2, mi: 30 });
  });
  it('previous periods are complete local days, ISO weeks and calendar months', () => {
    const at = new Date('2026-10-19T03:00:00Z');   // Monday 10:00 WIB
    expect(previousPeriod('daily', at, 'Asia/Jakarta')).toEqual({ start: new Date('2026-10-17T17:00:00Z'), end: new Date('2026-10-18T17:00:00Z') });
    expect(previousPeriod('weekly', at, 'Asia/Jakarta')).toEqual({ start: new Date('2026-10-11T17:00:00Z'), end: new Date('2026-10-18T17:00:00Z') });
    expect(previousPeriod('monthly', at, 'Asia/Jakarta')).toEqual({ start: new Date('2026-08-31T17:00:00Z'), end: new Date('2026-09-30T17:00:00Z') });
    expect(previousPeriod('monthly', new Date('2026-01-05T00:00:00Z'), 'Asia/Jakarta').start).toEqual(new Date('2025-11-30T17:00:00Z'));
    // Just after local midnight the "previous day" is yesterday local, not yesterday UTC.
    expect(previousPeriod('daily', new Date('2026-10-18T17:30:00Z'), 'Asia/Jakarta').start).toEqual(new Date('2026-10-17T17:00:00Z'));
  });
  it('next run times honour time of day, weekday, day of month and DST', () => {
    const daily = { frequency: 'daily' as const, timeOfDay: '07:00', dayOfWeek: null, dayOfMonth: null, periodDays: null, timezone: 'Asia/Jakarta' };
    expect(iso(nextRunAt(daily, new Date('2026-10-19T00:00:00Z')))).toBe('2026-10-20T00:00:00.000Z');   // 07:00 WIB = 00:00Z next day
    expect(iso(nextRunAt(daily, new Date('2026-10-18T23:59:00Z')))).toBe('2026-10-19T00:00:00.000Z');
    expect(iso(nextRunAt({ ...daily, frequency: 'weekly', dayOfWeek: 1 }, new Date('2026-10-19T01:00:00Z')))).toBe('2026-10-26T00:00:00.000Z');
    expect(iso(nextRunAt({ ...daily, frequency: 'monthly', dayOfMonth: 1 }, new Date('2026-10-19T01:00:00Z')))).toBe('2026-11-01T00:00:00.000Z');
    expect(iso(nextRunAt({ ...daily, timezone: 'Europe/Berlin' }, new Date('2026-03-28T07:00:00Z')))).toBe('2026-03-29T05:00:00.000Z');   // CEST after the switch
  });
  it('parses local dates', () => { expect(iso(localDate('2026-10-01', 'Asia/Jakarta'))).toBe('2026-09-30T17:00:00.000Z'); });
});

describe('metric formulas', () => {
  it('sentiment shares exclude unknown and unanalysed from the denominator', () => {
    const s = sentimentShares({ positive: 10, negative: 30, neutral: 50, mixed: 10, unknown: 40, unanalysed: 25, uncertain: 20 });
    expect(s.denominator).toBe(100);
    expect(s.shares).toEqual({ positive: 10, negative: 30, neutral: 50, mixed: 10 });
    expect(s.excluded).toEqual({ unknown: 40, unanalysed: 25 });
    expect(s.uncertainShare).toBe(20);
    expect(s.net).toBe(-20);
    expect(sentimentShares({ positive: 0, negative: 0, neutral: 0, mixed: 0, unknown: 5, unanalysed: 0, uncertain: 0 }).shares.positive).toBeNull();
  });
  it('share of voice: denominator is the sum of per-entity article counts; co-mentions reported', () => {
    const s = shareOfVoice([{ id: 'a', articles: 30 }, { id: 'b', articles: 15 }, { id: 'c', articles: 5 }], 45);
    expect(s.denominator).toBe(50);
    expect(s.entities.map((e) => e.share)).toEqual([60, 30, 10]);
    expect(s.coMentionArticles).toBe(5);
    expect(s.entities.reduce((n, e) => n + (e.share ?? 0), 0)).toBe(100);
    expect(shareOfVoice([{ id: 'a', articles: 0 }], 0).entities[0]!.share).toBeNull();
  });
  it('changes, percentages and diversity', () => {
    expect(change(15, 10)).toEqual({ current: 15, previous: 10, delta: 5, pct: 50 });
    expect(change(5, 0).pct).toBeNull();
    expect(pct(1, 3)).toBe(33.3);
    expect(simpsonDiversity([10])).toBe(0);
    expect(simpsonDiversity([5, 5])).toBe(0.5);
    expect(simpsonDiversity([])).toBeNull();
  });
});
