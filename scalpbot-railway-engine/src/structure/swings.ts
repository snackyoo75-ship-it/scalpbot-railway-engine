import type { Candle } from "../indicators/core.js";

export const M5_MS = 300_000;
export const closeTime = (k: Candle, stepMs = M5_MS) => new Date(Date.parse(k.time) + stepMs).toISOString();

export type Swing = {
  kind: "high" | "low";
  index: number;
  time: string;
  price: number;
  /** Close time of bar index+2 — the earliest moment the swing is knowable. */
  availableAt: string;
  confirmIndex: number;
};

/**
 * Fractal n=2 swings that are CONFIRMED using only candles[0..asOfIndex].
 * Strict inequalities: equal neighbouring highs do not make a swing.
 */
export function confirmedSwings(c: Candle[], asOfIndex: number, n = 2): Swing[] {
  const out: Swing[] = [];
  for (let t = n; t + n <= asOfIndex; t++) {
    let hi = true;
    let lo = true;
    for (let k = 1; k <= n; k++) {
      if (!(c[t]!.high > c[t - k]!.high && c[t]!.high > c[t + k]!.high)) hi = false;
      if (!(c[t]!.low < c[t - k]!.low && c[t]!.low < c[t + k]!.low)) lo = false;
    }
    const base = { index: t, time: c[t]!.time, confirmIndex: t + n, availableAt: closeTime(c[t + n]!) };
    if (hi) out.push({ ...base, kind: "high", price: c[t]!.high });
    if (lo) out.push({ ...base, kind: "low", price: c[t]!.low });
  }
  return out;
}

export type Trend = "bullish" | "bearish" | "mixed";

export function classifyStructure(swings: Swing[]): { trend: Trend; lastHigh: Swing | null; lastLow: Swing | null } {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastHigh = highs.at(-1) ?? null;
  const lastLow = lows.at(-1) ?? null;
  if (highs.length < 2 || lows.length < 2) return { trend: "mixed", lastHigh, lastLow };
  const hh = highs.at(-1)!.price > highs.at(-2)!.price;
  const lh = highs.at(-1)!.price < highs.at(-2)!.price;
  const hl = lows.at(-1)!.price > lows.at(-2)!.price;
  const ll = lows.at(-1)!.price < lows.at(-2)!.price;
  return { trend: hh && hl ? "bullish" : lh && ll ? "bearish" : "mixed", lastHigh, lastLow };
}

export type StructureEvent = {
  type: "BOS" | "CHoCH";
  direction: "bull" | "bear";
  index: number;
  time: string;
  /** Close time of the breaking candle. */
  availableAt: string;
  swing: Swing;
};

/**
 * BOS/CHoCH on bar i using only swings confirmed BEFORE bar i closes (confirmIndex < i).
 * Fires only on the first completed close beyond the swing (previous close not beyond).
 */
export function structureEventAt(c: Candle[], i: number): StructureEvent | null {
  if (i < 1) return null;
  const sw = confirmedSwings(c, i - 1);
  const { trend, lastHigh, lastLow } = classifyStructure(sw);
  const k = c[i]!;
  const prev = c[i - 1]!;
  const mk = (type: StructureEvent["type"], direction: StructureEvent["direction"], swing: Swing): StructureEvent => ({
    type, direction, index: i, time: k.time, availableAt: closeTime(k), swing,
  });
  if (trend === "bullish") {
    if (lastHigh && k.close > lastHigh.price && !(prev.close > lastHigh.price)) return mk("BOS", "bull", lastHigh);
    if (lastLow && k.close < lastLow.price && !(prev.close < lastLow.price)) return mk("CHoCH", "bear", lastLow);
  } else if (trend === "bearish") {
    if (lastLow && k.close < lastLow.price && !(prev.close < lastLow.price)) return mk("BOS", "bear", lastLow);
    if (lastHigh && k.close > lastHigh.price && !(prev.close > lastHigh.price)) return mk("CHoCH", "bull", lastHigh);
  }
  return null;
}
