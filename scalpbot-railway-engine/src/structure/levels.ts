import type { Candle } from "../indicators/core.js";
import { closeTime, confirmedSwings, M5_MS, type Swing } from "./swings.js";
import { forexDay, localParts, localDay, zonedToUtc } from "./time.js";

export type LevelKind =
  | "pdh" | "pdl" | "pdc" | "asia_high" | "asia_low" | "london_high" | "london_low" | "or_high" | "or_low"
  | "round" | "pivot_p" | "pivot_r1" | "pivot_s1" | "pivot_r2" | "pivot_s2" | "equal_highs" | "equal_lows"
  | "fib_382" | "fib_500" | "fib_618" | "fib_786";

export type Level = {
  kind: LevelKind;
  price: number;
  /** Earliest moment this level was knowable (ISO). */
  availableAt: string;
  /**
   * Identity of the underlying price source. Two levels with the same sourceId are the
   * same evidence (e.g. PDH and pivot inputs share the same day; equal-high reuses swings).
   */
  sourceId: string;
  /** Bar index at which the level became available (for age). */
  availableIndex: number;
};

type Range = { high: number; low: number; close: number; availableAt: string; availableIndex: number; key: string };

function rangeOf(c: Candle[], idx: number[], key: string): Range | null {
  if (idx.length === 0) return null;
  const last = idx.at(-1)!;
  return {
    high: Math.max(...idx.map((i) => c[i]!.high)),
    low: Math.min(...idx.map((i) => c[i]!.low)),
    close: c[last]!.close,
    availableAt: closeTime(c[last]!),
    availableIndex: last,
    key,
  };
}

/** Previous complete forex day (17:00 NY roll) relative to bar asOfIndex. */
export function previousDay(c: Candle[], asOfIndex: number): Range | null {
  const today = forexDay(Date.parse(c[asOfIndex]!.time));
  let prevKey: string | null = null;
  const idx: number[] = [];
  for (let i = asOfIndex; i >= 0; i--) {
    const d = forexDay(Date.parse(c[i]!.time));
    if (d === today) continue;
    if (prevKey === null) prevKey = d;
    if (d !== prevKey) break;
    idx.unshift(i);
  }
  return prevKey ? rangeOf(c, idx, prevKey) : null;
}

/**
 * Session range for the session that has FULLY ended at or before bar asOfIndex's close.
 * Session defined in wall-clock [startH, endH) of tz. Requires every expected M5 bar
 * (no gaps), otherwise unavailable.
 */
export function sessionRange(c: Candle[], asOfIndex: number, tz: string, startH: number, startMin: number, durationMin: number): Range | null {
  const asOfClose = Date.parse(c[asOfIndex]!.time) + M5_MS;
  // most recent session start <= asOf
  for (let back = 0; back < 3; back++) {
    const p = localParts(asOfClose - back * 86_400_000, tz);
    const start = zonedToUtc(p.y, p.m, p.d, startH, startMin, tz);
    const end = start + durationMin * 60_000;
    if (end > asOfClose) continue;
    const idx: number[] = [];
    for (let i = 0; i <= asOfIndex; i++) {
      const t = Date.parse(c[i]!.time);
      if (t >= start && t < end) idx.push(i);
    }
    if (idx.length !== durationMin / 5) return null;
    return rangeOf(c, idx, `${tz}:${localDay(start, tz)}:${startH}`);
  }
  return null;
}

export const asianRange = (c: Candle[], i: number) => sessionRange(c, i, "UTC", 0, 0, 7 * 60);
export const londonRange = (c: Candle[], i: number) => sessionRange(c, i, "Europe/London", 8, 0, 5 * 60);
export const openingRange = (c: Candle[], i: number, window: { tz: string; startH: number; startMin: number }) =>
  sessionRange(c, i, window.tz, window.startH, window.startMin, 30);

export type InstrumentSpec = { roundStep: number; precision: number };
export const INSTRUMENTS: Record<"XAUUSD" | "EURUSD", InstrumentSpec> = {
  XAUUSD: { roundStep: 10, precision: 2 },
  EURUSD: { roundStep: 0.005, precision: 5 },
};

/** Round levels nearest below/above price; computed in integer steps to avoid float drift. */
export function roundLevels(price: number, spec: InstrumentSpec, count = 1): number[] {
  const scale = 10 ** spec.precision;
  const step = Math.round(spec.roundStep * scale);
  const p = Math.round(price * scale);
  const below = Math.floor(p / step);
  const out: number[] = [];
  for (let k = -count + 1; k <= count; k++) out.push(Number((((below + k) * step) / scale).toFixed(spec.precision)));
  return out;
}

export function pivots(h: number, l: number, c: number) {
  const P = (h + l + c) / 3;
  return { P, R1: 2 * P - l, S1: 2 * P - h, R2: P + (h - l), S2: P - (h - l) };
}

/** Equal highs/lows: pairs of confirmed swings within tol=0.1*ATR in the last `window` bars. */
export function equalLevels(c: Candle[], asOfIndex: number, atr: number, window = 60): Level[] {
  if (!(atr > 0)) return [];
  const from = asOfIndex - window + 1;
  const sw = confirmedSwings(c, asOfIndex).filter((s) => s.index >= from);
  const out: Level[] = [];
  for (const kind of ["high", "low"] as const) {
    const s = sw.filter((x) => x.kind === kind);
    for (let a = 0; a < s.length; a++)
      for (let b = a + 1; b < s.length; b++)
        if (Math.abs(s[a]!.price - s[b]!.price) <= 0.1 * atr) {
          out.push({
            kind: kind === "high" ? "equal_highs" : "equal_lows",
            price: (s[a]!.price + s[b]!.price) / 2,
            availableAt: s[b]!.availableAt,
            availableIndex: s[b]!.confirmIndex,
            sourceId: `eq:${kind}:${s[a]!.time}:${s[b]!.time}`,
          });
        }
  }
  return out;
}

export type DirectionalSwing = { direction: "up" | "down"; from: Swing; to: Swing };

/** Last confirmed directional leg: most recent pair of opposite consecutive swings. */
export function lastDirectionalSwing(c: Candle[], asOfIndex: number): DirectionalSwing | null {
  const sw = confirmedSwings(c, asOfIndex);
  for (let k = sw.length - 1; k > 0; k--) {
    const to = sw[k]!;
    const from = sw[k - 1]!;
    if (from.kind === to.kind || from.index === to.index) continue;
    return { direction: to.kind === "high" ? "up" : "down", from, to };
  }
  return null;
}

export const FIB_RATIOS = [0.382, 0.5, 0.618] as const;

/** Up swing L→H: H - r(H-L). Down swing H→L: L + r(H-L). */
export function fibLevel(sw: DirectionalSwing, r: number): number {
  const H = Math.max(sw.from.price, sw.to.price);
  const L = Math.min(sw.from.price, sw.to.price);
  return sw.direction === "up" ? H - r * (H - L) : L + r * (H - L);
}

/**
 * Healthy retracement context (NOT an entry signal): since the swing completed, price
 * reached the 0.382–0.618 zone and no completed close went beyond the 0.786 level.
 */
export function retracementContext(c: Candle[], sw: DirectionalSwing, asOfIndex: number) {
  const z1 = fibLevel(sw, 0.382);
  const z2 = fibLevel(sw, 0.618);
  const deep = fibLevel(sw, 0.786);
  let reachedZone = false;
  let closedBeyond786 = false;
  for (let i = sw.to.confirmIndex + 1; i <= asOfIndex; i++) {
    const k = c[i]!;
    if (sw.direction === "up") {
      if (k.low <= z1) reachedZone = true;
      if (k.close < deep) closedBeyond786 = true;
    } else {
      if (k.high >= z1) reachedZone = true;
      if (k.close > deep) closedBeyond786 = true;
    }
  }
  return { zone: [Math.min(z1, z2), Math.max(z1, z2)] as const, level786: deep, reachedZone, closedBeyond786, healthy: reachedZone && !closedBeyond786 };
}

/** All levels known as of bar asOfIndex. */
export function levelsAt(
  c: Candle[],
  asOfIndex: number,
  opts: { atr: number | null; instrument: InstrumentSpec; openingWindow?: { tz: string; startH: number; startMin: number } },
): Level[] {
  const out: Level[] = [];
  const push = (kind: LevelKind, price: number, r: { availableAt: string; availableIndex: number }, sourceId: string) =>
    out.push({ kind, price, availableAt: r.availableAt, availableIndex: r.availableIndex, sourceId });
  const pd = previousDay(c, asOfIndex);
  if (pd) {
    push("pdh", pd.high, pd, `pd:${pd.key}:high`);
    push("pdl", pd.low, pd, `pd:${pd.key}:low`);
    push("pdc", pd.close, pd, `pd:${pd.key}:close`);
    const pv = pivots(pd.high, pd.low, pd.close);
    push("pivot_p", pv.P, pd, `pv:${pd.key}:P`);
    push("pivot_r1", pv.R1, pd, `pv:${pd.key}:R1`);
    push("pivot_s1", pv.S1, pd, `pv:${pd.key}:S1`);
    push("pivot_r2", pv.R2, pd, `pv:${pd.key}:R2`);
    push("pivot_s2", pv.S2, pd, `pv:${pd.key}:S2`);
  }
  for (const [r, hi, lo] of [
    [asianRange(c, asOfIndex), "asia_high", "asia_low"],
    [londonRange(c, asOfIndex), "london_high", "london_low"],
    [opts.openingWindow ? openingRange(c, asOfIndex, opts.openingWindow) : null, "or_high", "or_low"],
  ] as const) {
    if (!r) continue;
    push(hi, r.high, r, `${r.key}:high`);
    push(lo, r.low, r, `${r.key}:low`);
  }
  const now = { availableAt: closeTime(c[asOfIndex]!), availableIndex: asOfIndex };
  for (const p of roundLevels(c[asOfIndex]!.close, opts.instrument)) push("round", p, now, `round:${p}`);
  if (opts.atr !== null) out.push(...equalLevels(c, asOfIndex, opts.atr));
  const ds = lastDirectionalSwing(c, asOfIndex);
  if (ds) {
    const r = { availableAt: ds.to.availableAt, availableIndex: ds.to.confirmIndex };
    const id = `fib:${ds.from.time}:${ds.to.time}`;
    push("fib_382", fibLevel(ds, 0.382), r, `${id}:382`);
    push("fib_500", fibLevel(ds, 0.5), r, `${id}:500`);
    push("fib_618", fibLevel(ds, 0.618), r, `${id}:618`);
  }
  return out;
}
