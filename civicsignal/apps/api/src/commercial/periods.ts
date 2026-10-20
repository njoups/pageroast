import { localDateString, localParts, zonedToUtc } from '../analytics/tz';

/**
 * Usage periods are monthly windows anchored on the subscription's usage anchor (local day and time of day in the
 * tenant's time zone). Anchors on the 29th–31st clamp to the last day of shorter months, so every period is contiguous:
 * the end of one period is exactly the start of the next. Annual and custom contracts still reset usage monthly.
 */
export interface UsagePeriod { start: Date; end: Date }

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function anchorIn(y: number, m: number, anchor: { d: number; h: number; mi: number }, tz: string): Date {
  // Normalise month overflow (m may be 0 or 13).
  const yy = y + Math.floor((m - 1) / 12); const mm = ((m - 1) % 12 + 12) % 12 + 1;
  return zonedToUtc(yy, mm, Math.min(anchor.d, daysInMonth(yy, mm)), anchor.h, anchor.mi, tz);
}

export function usagePeriod(anchorAt: Date, at: Date, tz: string): UsagePeriod {
  const a = localParts(anchorAt, tz);
  const anchor = { d: a.d, h: a.h, mi: a.mi };
  const p = localParts(at, tz);
  let start = anchorIn(p.y, p.m, anchor, tz);
  let y = p.y; let m = p.m;
  if (start > at) { m -= 1; start = anchorIn(y, m, anchor, tz); }
  // Normalise for the end computation.
  if (m < 1) { m += 12; y -= 1; }
  return { start, end: anchorIn(y, m + 1, anchor, tz) };
}

/** Tenant-local calendar day of an instant (for daily aggregates). */
export const usageDay = (at: Date, tz: string) => localDateString(at, tz);

/** Adds whole local months, clamping the day (used for subscription billing periods). */
export function addMonths(at: Date, months: number, tz: string): Date {
  const p = localParts(at, tz);
  return anchorIn(p.y, p.m + months, { d: p.d, h: p.h, mi: p.mi }, tz);
}
