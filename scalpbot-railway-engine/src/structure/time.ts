/** Time-zone helpers built on Intl (DST-correct, no dependencies). */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type LocalParts = { y: number; m: number; d: number; h: number; min: number };

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute! };
}

function ymd(y: number, m: number, d: number) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10);
}

/**
 * Forex trading day key (YYYY-MM-DD). The day rolls at 17:00 America/New_York
 * (DST-aware): a bar opening at/after 17:00 NY belongs to the NEXT calendar date.
 */
export function forexDay(ms: number): string {
  const p = localParts(ms, "America/New_York");
  return p.h >= 17 ? ymd(p.y, p.m, p.d + 1) : ymd(p.y, p.m, p.d);
}

/** Local calendar date key in tz. */
export function localDay(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return ymd(p.y, p.m, p.d);
}

/** UTC ms for local wall time (y,m,d,h,min) in tz; DST-correct via two-pass offset. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let k = 0; k < 2; k++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += Date.UTC(y, m - 1, d, h, min) - asUtc;
  }
  return guess;
}
