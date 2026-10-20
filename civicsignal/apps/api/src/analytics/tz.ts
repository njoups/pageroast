/**
 * Time-zone arithmetic without external dependencies (Intl only). Reporting periods are defined in the tenant's IANA
 * zone; daylight-saving transitions are handled by re-checking the offset at the computed instant.
 */
export interface LocalParts { y: number; m: number; d: number; h: number; mi: number; weekday: number }  // weekday ISO: 1 = Monday

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

export function localParts(t: Date | number, tz: string): LocalParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), weekday: WD[p.weekday!]! };
}

/** Offset of the zone at instant t, in ms (local wall clock − UTC). */
export function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** UTC instant of a local wall-clock time. Non-existent times (DST gap) resolve forward; ambiguous ones to the first. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // The two offsets in force around this wall-clock time (equal except near a DST transition).
  const candidates = [...new Set([guess - tzOffset(guess - 12 * 3_600_000, tz), guess - tzOffset(guess + 12 * 3_600_000, tz)])];
  const valid = candidates.filter((c) => { const p = localParts(c, tz); return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi; });
  if (valid.length) return new Date(Math.min(...valid));     // ambiguous → first occurrence
  return new Date(Math.max(...candidates));                   // gap → shifted forward by the gap

}

/** Calendar arithmetic on local dates (month rollover via Date.UTC). */
export function addDays(y: number, m: number, d: number, n: number) {
  const x = new Date(Date.UTC(y, m - 1, d + n)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}
export const startOfLocalDay = (t: Date | number, tz: string) => { const p = localParts(t, tz); return zonedToUtc(p.y, p.m, p.d, 0, 0, tz); };
export const localDateString = (t: Date | number, tz: string) => { const p = localParts(t, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

/** Parses YYYY-MM-DD as local midnight in tz. */
export function localDate(s: string, tz: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return zonedToUtc(y, m, d, 0, 0, tz);
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'custom';

/**
 * The complete reporting period that ends at or before `at` (local time in tz):
 *  daily   → the previous local calendar day
 *  weekly  → the previous ISO week, Monday 00:00 – Monday 00:00
 *  monthly → the previous calendar month
 *  custom  → the last `periodDays` local days ending at today's local midnight
 */
export function previousPeriod(freq: Frequency, at: Date, tz: string, periodDays = 7): { start: Date; end: Date } {
  const p = localParts(at, tz);
  const today = { y: p.y, m: p.m, d: p.d };
  if (freq === 'daily') { const s = addDays(today.y, today.m, today.d, -1); return { start: zonedToUtc(s.y, s.m, s.d, 0, 0, tz), end: zonedToUtc(today.y, today.m, today.d, 0, 0, tz) }; }
  if (freq === 'weekly') {
    const mon = addDays(today.y, today.m, today.d, -(p.weekday - 1));
    const prev = addDays(mon.y, mon.m, mon.d, -7);
    return { start: zonedToUtc(prev.y, prev.m, prev.d, 0, 0, tz), end: zonedToUtc(mon.y, mon.m, mon.d, 0, 0, tz) };
  }
  if (freq === 'monthly') {
    const first = { y: today.y, m: today.m, d: 1 };
    const prev = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
    return { start: zonedToUtc(prev.y, prev.m, 1, 0, 0, tz), end: zonedToUtc(first.y, first.m, 1, 0, 0, tz) };
  }
  const s = addDays(today.y, today.m, today.d, -periodDays);
  return { start: zonedToUtc(s.y, s.m, s.d, 0, 0, tz), end: zonedToUtc(today.y, today.m, today.d, 0, 0, tz) };
}

export interface ScheduleSpec { frequency: Frequency; timeOfDay: string; dayOfWeek: number | null; dayOfMonth: number | null; periodDays: number | null; timezone: string }

/** Next local run time strictly after `after`. */
export function nextRunAt(s: ScheduleSpec, after: Date): Date {
  const [hh, mm] = s.timeOfDay.split(':').map(Number) as [number, number];
  const p = localParts(after, s.timezone);
  for (let i = 0; i <= 62; i++) {
    const day = addDays(p.y, p.m, p.d, i);
    const candidate = zonedToUtc(day.y, day.m, day.d, hh, mm, s.timezone);
    if (candidate.getTime() <= after.getTime()) continue;
    const lp = localParts(candidate, s.timezone);
    if (s.frequency === 'weekly' && lp.weekday !== (s.dayOfWeek ?? 1)) continue;
    if (s.frequency === 'monthly' && day.d !== (s.dayOfMonth ?? 1)) continue;
    if (s.frequency === 'custom' && s.periodDays && s.periodDays > 1) {
      // Every N days counted from the epoch day in local time (stable across restarts).
      const epochDay = Math.floor(Date.UTC(day.y, day.m - 1, day.d) / 86_400_000);
      if (epochDay % s.periodDays !== 0) continue;
    }
    return candidate;
  }
  throw new Error('No run time found within 62 days');
}
