import { candleGeometry, type Candle, type Series } from "../indicators/core.js";
import { closeTime } from "./swings.js";

export const PATTERN_VERSION = "1.0.0";

export type Dir = "bull" | "bear";
export type PatternId =
  | "engulfing" | "pin_bar" | "displacement" | "inside_bar_breakout" | "liquidity_sweep" | "fakeout"
  | "breakout_retest" | "compression_breakout";

export type Quality =
  | { status: "ok"; q: number; bodyAtr: number; alignedClosePos: number }
  | { status: "unavailable"; reason: string };

export type Pattern = {
  id: PatternId;
  direction: Dir;
  /** Open time of the pattern (trigger) bar. */
  barTime: string;
  /** Close time of the bar that completed/confirmed the pattern — the earliest usable moment. */
  confirmationTime: string;
  entryMode: "immediate_on_close" | "confirmation";
  keyLevel: number | null;
  quality: Quality;
  invalidation: number;
  /** Open times of every candle read to produce this result. */
  sources: string[];
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Q = 0.5*clamp(body/ATR,0,1) + 0.5*alignedClosePos. Components preserved. */
export function quality(k: Candle, atr: number | null, dir: Dir): Quality {
  const g = candleGeometry(k);
  if (!g) return { status: "unavailable", reason: "zero range" };
  if (atr === null || !(atr > 0)) return { status: "unavailable", reason: "ATR14 unavailable" };
  const bodyAtr = clamp01(g.body / atr);
  const alignedClosePos = clamp01(dir === "bull" ? g.bullAlignedClosePos : g.bearAlignedClosePos);
  return { status: "ok", q: 0.5 * bodyAtr + 0.5 * alignedClosePos, bodyAtr, alignedClosePos };
}

const body = (k: Candle) => Math.abs(k.close - k.open);
const bull = (k: Candle) => k.close > k.open;
const bear = (k: Candle) => k.close < k.open;

type Ctx = { c: Candle[]; atr: Series };
const atrAt = (x: Ctx, i: number) => {
  const a = x.atr[i];
  return a !== null && a !== undefined && a > 0 ? a : null;
};

function mk(x: Ctx, id: PatternId, dir: Dir, trig: number, conf: number, mode: Pattern["entryMode"], level: number | null, inv: number, from: number): Pattern {
  return {
    id, direction: dir, barTime: x.c[trig]!.time, confirmationTime: closeTime(x.c[conf]!), entryMode: mode, keyLevel: level,
    quality: quality(x.c[trig]!, atrAt(x, trig), dir), invalidation: inv,
    sources: x.c.slice(from, conf + 1).map((k) => k.time),
  };
}

// Every detector below reads only candles[0..i] (i = latest completed bar).

export function engulfing(x: Ctx, i: number): Pattern | null {
  const a = atrAt(x, i);
  if (i < 1 || a === null) return null;
  const p = x.c[i - 1]!;
  const k = x.c[i]!;
  if (body(k) < 1.1 * body(p) || body(k) < 0.4 * a) return null;
  if (bear(p) && bull(k) && k.open <= p.close && k.close >= p.open) return mk(x, "engulfing", "bull", i, i, "immediate_on_close", null, Math.min(k.low, p.low), i - 1);
  if (bull(p) && bear(k) && k.open >= p.close && k.close <= p.open) return mk(x, "engulfing", "bear", i, i, "immediate_on_close", null, Math.max(k.high, p.high), i - 1);
  return null;
}

export function pinBar(x: Ctx, i: number): Pattern | null {
  const a = atrAt(x, i);
  const k = x.c[i]!;
  const g = candleGeometry(k);
  if (a === null || !g || g.range < 0.5 * a) return null;
  if (g.lowerWick >= 2 * g.body && g.lowerWick >= 0.55 * g.range && g.closePos >= 0.6) return mk(x, "pin_bar", "bull", i, i, "immediate_on_close", null, k.low, i);
  if (g.upperWick >= 2 * g.body && g.upperWick >= 0.55 * g.range && g.closePos <= 0.4) return mk(x, "pin_bar", "bear", i, i, "immediate_on_close", null, k.high, i);
  return null;
}

export function displacement(x: Ctx, i: number): Pattern | null {
  const a = atrAt(x, i);
  const k = x.c[i]!;
  const g = candleGeometry(k);
  if (a === null || !g || g.body < 0.8 * a || g.range > 3 * a) return null;
  if (g.closePos >= 0.7 && bull(k)) return mk(x, "displacement", "bull", i, i, "immediate_on_close", null, k.low, i);
  if (g.closePos <= 0.3 && bear(k)) return mk(x, "displacement", "bear", i, i, "immediate_on_close", null, k.high, i);
  return null;
}

/** Bar i-1 inside i-2 (high <= mother high AND low >= mother low); bar i closes beyond the mother. */
export function insideBarBreakout(x: Ctx, i: number): Pattern | null {
  const a = atrAt(x, i);
  if (i < 2 || a === null) return null;
  const m = x.c[i - 2]!;
  const ib = x.c[i - 1]!;
  const k = x.c[i]!;
  if (!(ib.high <= m.high && ib.low >= m.low) || body(k) < 0.5 * a) return null;
  if (k.close > m.high) return mk(x, "inside_bar_breakout", "bull", i, i, "immediate_on_close", m.high, m.low, i - 2);
  if (k.close < m.low) return mk(x, "inside_bar_breakout", "bear", i, i, "immediate_on_close", m.low, m.high, i - 2);
  return null;
}

/**
 * Liquidity sweep of `level`. side "sell" = sweep above resistance (bearish result).
 * Immediate: high in [level+0.1ATR, level+1.0ATR], close < level, upperWick >= 0.5 range.
 * Confirmation: sweep bar s = i-1..i-3 had the high in band (and did not qualify as immediate);
 * bar i is the FIRST bar after s to close below s.low. Each mode reports its own timestamp.
 */
export function liquiditySweep(x: Ctx, i: number, level: number, side: "sell" | "buy"): Pattern | null {
  const dir: Dir = side === "sell" ? "bear" : "bull";
  const inBand = (s: number) => {
    const a = atrAt(x, s);
    if (a === null) return false;
    const ex = side === "sell" ? x.c[s]!.high - level : level - x.c[s]!.low;
    return ex >= 0.1 * a && ex <= 1.0 * a;
  };
  const immediate = (s: number) => {
    const g = candleGeometry(x.c[s]!);
    if (!g || !inBand(s)) return false;
    return side === "sell" ? x.c[s]!.close < level && g.upperWick >= 0.5 * g.range : x.c[s]!.close > level && g.lowerWick >= 0.5 * g.range;
  };
  if (immediate(i)) return mk(x, "liquidity_sweep", dir, i, i, "immediate_on_close", level, side === "sell" ? x.c[i]!.high : x.c[i]!.low, i);
  for (let s = i - 1; s >= Math.max(0, i - 3); s--) {
    if (!inBand(s) || immediate(s)) continue;
    const beyond = (j: number) => (side === "sell" ? x.c[j]!.close < x.c[s]!.low : x.c[j]!.close > x.c[s]!.high);
    let firstEarlier = false;
    for (let j = s + 1; j < i; j++) if (beyond(j)) firstEarlier = true;
    if (!firstEarlier && beyond(i)) {
      const p = mk(x, "liquidity_sweep", dir, s, i, "confirmation", level, side === "sell" ? x.c[s]!.high : x.c[s]!.low, s);
      p.quality = quality(x.c[s]!, atrAt(x, s), dir);
      return p;
    }
  }
  return null;
}

/**
 * Fakeout: bar b (i-1..i-3) closed beyond level (prev close not beyond); bar i is the first
 * to close back inside. Direction is toward the inside. barTime = breakout bar.
 */
export function fakeout(x: Ctx, i: number, level: number): Pattern | null {
  const above = (j: number) => x.c[j]!.close > level;
  const below = (j: number) => x.c[j]!.close < level;
  for (let b = i - 1; b >= Math.max(1, i - 3); b--) {
    for (const [out, inside, dir] of [[above, (j: number) => !above(j), "bear"], [below, (j: number) => !below(j), "bull"]] as const) {
      if (!out(b) || out(b - 1)) continue;
      let stayed = true;
      for (let j = b + 1; j < i; j++) if (inside(j)) stayed = false;
      if (stayed && inside(i)) {
        const ext = dir === "bear" ? Math.max(...x.c.slice(b, i + 1).map((k) => k.high)) : Math.min(...x.c.slice(b, i + 1).map((k) => k.low));
        return mk(x, "fakeout", dir, b, i, "confirmation", level, ext, b - 1);
      }
    }
  }
  return null;
}

/**
 * Breakout-retest. Breakout bar b (i-1..i-6): close >= level+0.1ATR (long) and a displacement.
 * Bar i: low <= level+0.15ATR, close > level, and a valid pin or engulfing in the same direction.
 * The first qualifying retest only.
 */
export function breakoutRetest(x: Ctx, i: number, level: number): Pattern | null {
  for (let b = i - 1; b >= Math.max(0, i - 6); b--) {
    const ab = atrAt(x, b);
    const ai = atrAt(x, i);
    if (ab === null || ai === null) continue;
    const d = displacement(x, b);
    if (!d) continue;
    const k = x.c[i]!;
    const rej = (dir: Dir) => [pinBar(x, i), engulfing(x, i)].some((p) => p?.direction === dir);
    if (d.direction === "bull" && x.c[b]!.close >= level + 0.1 * ab && k.low <= level + 0.15 * ai && k.close > level && rej("bull")) {
      return mk(x, "breakout_retest", "bull", b, i, "confirmation", level, k.low, b);
    }
    if (d.direction === "bear" && x.c[b]!.close <= level - 0.1 * ab && k.high >= level - 0.15 * ai && k.close < level && rej("bear")) {
      return mk(x, "breakout_retest", "bear", b, i, "confirmation", level, k.high, b);
    }
  }
  return null;
}

/**
 * Compression breakout: BB width percentile <= 20 on the 6 bars i-6..i-1, then bar i closes
 * beyond the Donchian20 (previous 20 bars, current excluded), M15 bias agrees, body >= 0.6 ATR.
 */
export function compressionBreakout(x: Ctx, i: number, widthPct: Series, don: { upper: Series; lower: Series }, m15Bias: Dir | null): Pattern | null {
  const a = atrAt(x, i);
  if (i < 6 || a === null || m15Bias === null) return null;
  for (let j = i - 6; j < i; j++) {
    const w = widthPct[j];
    if (w === null || w === undefined || w > 20) return null;
  }
  const k = x.c[i]!;
  if (body(k) < 0.6 * a) return null;
  const up = don.upper[i];
  const lo = don.lower[i];
  if (m15Bias === "bull" && up != null && k.close > up) return mk(x, "compression_breakout", "bull", i, i, "immediate_on_close", up, k.low, Math.max(0, i - 20));
  if (m15Bias === "bear" && lo != null && k.close < lo) return mk(x, "compression_breakout", "bear", i, i, "immediate_on_close", lo, k.high, Math.max(0, i - 20));
  return null;
}
