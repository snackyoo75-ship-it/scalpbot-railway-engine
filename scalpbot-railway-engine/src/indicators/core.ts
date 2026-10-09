/**
 * ScalpBot indicator library — pure, deterministic, no I/O.
 *
 * Conventions (versioned by INDICATOR_VERSION; changing any of these requires a bump):
 * - Every series function returns an array aligned 1:1 with its input. `null` means
 *   "unavailable at this index" (insufficient history, zero denominator, invalid input).
 *   Zero is NEVER used as a placeholder.
 * - Arithmetic is IEEE-754 float64; outputs are not rounded. Tests compare at 1e-9.
 * - A standard deviation is treated as zero when sd <= ZERO_SD_REL * |mean| (absorbs
 *   float noise from summing identical prices) or sd === 0.
 * - Wilder recurrences reset when a null input appears; they re-seed from the next
 *   n consecutive valid values. Nothing is interpolated or carried over a hole.
 * - The first candle has no previous close/high/low, so TR, change, +DM/-DM are
 *   `null` at index 0. The previous close is never fabricated (e.g. from the open).
 */

export const INDICATOR_VERSION = "1.0.0";
export const ZERO_SD_REL = 1e-12;

export type Candle = {
  /** Candle OPEN time, ISO-8601 UTC. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
};

export type Series = (number | null)[];

function assertPeriod(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid period ${n}`);
}

/** EMA seeded with SMA of first n closes at index n-1. */
export function ema(values: number[], n: number): Series {
  assertPeriod(n);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i]!;
  let e = s / n;
  out[n - 1] = e;
  const a = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    e = a * values[i]! + (1 - a) * e;
    out[i] = e;
  }
  return out;
}

/** TR; index 0 is null by explicit initialization rule (no previous close). */
export function trueRange(c: Candle[]): Series {
  return c.map((k, i) => {
    if (i === 0) return null;
    const pc = c[i - 1]!.close;
    return Math.max(k.high - k.low, Math.abs(k.high - pc), Math.abs(k.low - pc));
  });
}

/** Wilder mean: seed = mean of first n consecutive valid values, then ((n-1)*prev + v)/n. */
export function wilderMean(values: Series, n: number): Series {
  assertPeriod(n);
  const out: Series = new Array(values.length).fill(null);
  let prev: number | null = null;
  let buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v === null || !Number.isFinite(v)) {
      prev = null;
      buf = [];
      continue;
    }
    if (prev === null) {
      buf.push(v);
      if (buf.length === n) {
        prev = buf.reduce((a, b) => a + b, 0) / n;
        out[i] = prev;
        buf = [];
      }
    } else {
      prev = ((n - 1) * prev + v) / n;
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder running sum: seed = sum of first n valid values, then prev - prev/n + v. */
export function wilderSum(values: Series, n: number): Series {
  return wilderSumImpl(values, n);
}
function wilderSumImpl(values: Series, n: number): Series {
  assertPeriod(n);
  const out: Series = new Array(values.length).fill(null);
  let prev: number | null = null;
  let buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v === null || !Number.isFinite(v)) {
      prev = null;
      buf = [];
      continue;
    }
    if (prev === null) {
      buf.push(v);
      if (buf.length === n) {
        prev = buf.reduce((a, b) => a + b, 0);
        out[i] = prev;
        buf = [];
      }
    } else {
      prev = prev - prev / n + v;
      out[i] = prev;
    }
  }
  return out;
}

export function atr(c: Candle[], n = 14): Series {
  return wilderMean(trueRange(c), n);
}

export function atrPercent(atrS: Series, c: Candle[]): Series {
  return atrS.map((a, i) => (a === null || !(c[i]!.close > 0) ? null : (a / c[i]!.close) * 100));
}

/** Wilder RSI with the brief's edge cases. */
export function rsi(closes: number[], n = 14): Series {
  const ch: Series = closes.map((v, i) => (i === 0 ? null : v - closes[i - 1]!));
  const ag = wilderMean(ch.map((d) => (d === null ? null : Math.max(d, 0))), n);
  const al = wilderMean(ch.map((d) => (d === null ? null : Math.max(-d, 0))), n);
  return ag.map((g, i) => {
    const l = al[i]!;
    if (g === null || l === null) return null;
    if (g === 0 && l === 0) return 50;
    if (l === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / l);
  });
}

/** (EMA_t - EMA_{t-k}) / ATR_t ; dimensionless. */
export function normalizedSlope(emaS: Series, atrS: Series, k = 5): Series {
  return emaS.map((e, i) => {
    if (i < k) return null;
    const p = emaS[i - k]!;
    const a = atrS[i]!;
    if (e === null || p === null || a === null || !(a > 0)) return null;
    return (e - p) / a;
  });
}

export type AdxResult = { plusDI: Series; minusDI: Series; dx: Series; adx: Series };

/**
 * ADX(n). Index 0: no movement data. Smoothed TR/±DM seeded with the SUM of the first
 * n values (indices 1..n) → first DI at index n. ADX seeded with the MEAN of the first
 * n valid DX (indices n..2n-1) → first ADX at index 2n-1, then (13*prev + DX)/14.
 * Zero denominators: smoothed TR = 0 → DI/DX unavailable (resets ADX chain);
 * +DI + -DI = 0 with TR > 0 → DX = 0 (no directional movement).
 */
export function adx(c: Candle[], n = 14): AdxResult {
  const tr = trueRange(c);
  const pdm: Series = c.map((k, i) => {
    if (i === 0) return null;
    const up = k.high - c[i - 1]!.high;
    const dn = c[i - 1]!.low - k.low;
    return up > dn && up > 0 ? up : 0;
  });
  const mdm: Series = c.map((k, i) => {
    if (i === 0) return null;
    const up = k.high - c[i - 1]!.high;
    const dn = c[i - 1]!.low - k.low;
    return dn > up && dn > 0 ? dn : 0;
  });
  const sTr = wilderSumImpl(tr, n);
  const sP = wilderSumImpl(pdm, n);
  const sM = wilderSumImpl(mdm, n);
  const plusDI: Series = sTr.map((t, i) => (t === null || !(t > 0) || sP[i]! === null ? null : (100 * (sP[i]! as number)) / t));
  const minusDI: Series = sTr.map((t, i) => (t === null || !(t > 0) || sM[i]! === null ? null : (100 * (sM[i]! as number)) / t));
  const dx: Series = plusDI.map((p, i) => {
    const m = minusDI[i]!;
    if (p === null || m === null) return null;
    const s = p + m;
    return s === 0 ? 0 : (100 * Math.abs(p - m)) / s;
  });
  return { plusDI, minusDI, dx, adx: wilderMean(dx, n) };
}

export type Window = { mean: number; sd: number };

/** Population mean/SD over the trailing window ending at i (inclusive). */
export function rollingPop(values: Series, n: number): (Window | null)[] {
  assertPeriod(n);
  return values.map((_, i) => {
    if (i < n - 1) return null;
    const w = values.slice(i - n + 1, i + 1);
    if (w.some((v) => v === null || !Number.isFinite(v))) return null;
    const nums = w as number[];
    const mean = nums.reduce((a, b) => a + b, 0) / n;
    const v = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return { mean, sd: Math.sqrt(v) };
  });
}

export function isZeroSd(w: Window) {
  return w.sd === 0 || w.sd <= ZERO_SD_REL * Math.abs(w.mean);
}

export type Bollinger = { mid: Series; upper: Series; lower: Series; width: Series };

export function bollinger(closes: number[], n = 20, k = 2): Bollinger {
  const w = rollingPop(closes, n);
  const mid = w.map((x) => (x ? x.mean : null));
  const sd = w.map((x) => (x ? (isZeroSd(x) ? 0 : x.sd) : null));
  const upper = mid.map((m, i) => (m === null ? null : m + k * (sd[i]! as number)));
  const lower = mid.map((m, i) => (m === null ? null : m - k * (sd[i]! as number)));
  const width = mid.map((m, i) => (m === null || m === 0 ? null : ((upper[i]! as number) - (lower[i]! as number)) / m));
  return { mid, upper, lower, width };
}

export function zScore(closes: number[], n = 20): Series {
  const w = rollingPop(closes, n);
  return w.map((x, i) => (x === null || isZeroSd(x) ? null : (closes[i]! - x.mean) / x.sd));
}

/** Donchian over the PREVIOUS n candles (current excluded). */
export function donchian(c: Candle[], n = 20): { upper: Series; lower: Series } {
  assertPeriod(n);
  const upper: Series = [];
  const lower: Series = [];
  for (let i = 0; i < c.length; i++) {
    if (i < n) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n; j < i; j++) {
      hi = Math.max(hi, c[j]!.high);
      lo = Math.min(lo, c[j]!.low);
    }
    upper.push(hi);
    lower.push(lo);
  }
  return { upper, lower };
}

/**
 * Mid-rank empirical percentile in [0,100]:
 *   100 * (count(v < x) + 0.5 * count(v == x)) / N
 * The window includes x itself. Ties therefore share the same rank.
 */
export function percentileRank(window: number[], x: number): number {
  let less = 0;
  let eq = 0;
  for (const v of window) {
    if (v < x) less++;
    else if (v === x) eq++;
  }
  return (100 * (less + 0.5 * eq)) / window.length;
}

/** Last `lookback` VALID values up to and including i, or null if fewer exist / current invalid. */
function lastValid(values: Series, i: number, lookback: number): number[] | null {
  if (values[i]! === null) return null;
  const w: number[] = [];
  for (let j = i; j >= 0 && w.length < lookback; j--) {
    const v = values[j]!;
    if (v !== null && Number.isFinite(v)) w.push(v);
  }
  return w.length === lookback ? w : null;
}

export function rollingPercentile(values: Series, lookback: number): Series {
  return values.map((v, i) => {
    const w = lastValid(values, i, lookback);
    return w === null ? null : percentileRank(w, v as number);
  });
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Realized vol: log returns, SAMPLE standard deviation (divisor n-1) of the last n
 * returns → needs n+1 closes. Non-positive closes make the return unavailable.
 */
export function realizedVol(closes: number[], n = 30): Series {
  const r: Series = closes.map((c, i) => (i === 0 || !(c > 0) || !(closes[i - 1]! > 0) ? null : Math.log(c / closes[i - 1]!)));
  return r.map((_, i) => {
    if (i < n) return null;
    const w = r.slice(i - n + 1, i + 1);
    if (w.some((v) => v === null)) return null;
    const nums = w as number[];
    const mean = nums.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  });
}

/**
 * sigma_1s ≈ sigma_M1 / sqrt(60). ASSUMPTION: returns are i.i.d. within the minute
 * (square-root-of-time scaling). Approximation only; microstructure noise violates it.
 */
export function perSecondVol(sigmaM1: number): number {
  return sigmaM1 / Math.sqrt(60);
}

/** sigma / median(last `lookback` valid sigmas incl. current). */
export function volRatio(sigma: Series, lookback = 200): Series {
  return sigma.map((s, i) => {
    const w = lastValid(sigma, i, lookback);
    if (w === null) return null;
    const m = median(w);
    return m > 0 ? (s as number) / m : null;
  });
}

export type Geometry = {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  closePos: number;
  bullAlignedClosePos: number;
  bearAlignedClosePos: number;
};

export function candleGeometry(k: Candle): Geometry | null {
  const range = k.high - k.low;
  if (!(range > 0)) return null;
  const closePos = (k.close - k.low) / range;
  return {
    range,
    body: Math.abs(k.close - k.open),
    upperWick: k.high - Math.max(k.open, k.close),
    lowerWick: Math.min(k.open, k.close) - k.low,
    closePos,
    bullAlignedClosePos: closePos,
    bearAlignedClosePos: 1 - closePos,
  };
}

export type SpreadObs = { time: string; spread: number };
export type SpreadStatsConfig = { lookbackDays: number; minSamples: number };
export const DEFAULT_SPREAD_CONFIG: SpreadStatsConfig = { lookbackDays: 20, minSamples: 30 };
export const MAD_TO_SIGMA = 1.4826;

export type SpreadStats =
  | { ok: true; hourUtc: number; samples: number; median: number; mad: number; z: number | null; zReason?: string }
  | { ok: false; hourUtc: number; samples: number; reason: string };

/**
 * Spread stats for the UTC hour-of-day of `asOf`.
 * - Time zone: UTC; bucket = getUTCHours() of the observation time.
 * - Eligible: finite spread >= 0, time in (asOf - lookbackDays, asOf]. Older = stale,
 *   later = future (lookahead) — both excluded.
 * - Fewer than minSamples eligible → unavailable (no median, no z).
 * - z = (current - median) / (1.4826 * MAD); MAD = 0 → z unavailable (not Infinity).
 */
export function spreadStats(
  obs: SpreadObs[],
  asOf: string,
  current: number | null,
  cfg: SpreadStatsConfig = DEFAULT_SPREAD_CONFIG,
): SpreadStats {
  const t = Date.parse(asOf);
  const hourUtc = new Date(t).getUTCHours();
  const from = t - cfg.lookbackDays * 86_400_000;
  const xs: number[] = [];
  for (const o of obs) {
    const ot = Date.parse(o.time);
    if (!Number.isFinite(ot) || ot <= from || ot > t) continue;
    if (!Number.isFinite(o.spread) || o.spread < 0) continue;
    if (new Date(ot).getUTCHours() !== hourUtc) continue;
    xs.push(o.spread);
  }
  if (xs.length < cfg.minSamples) {
    return { ok: false, hourUtc, samples: xs.length, reason: `insufficient spread history (${xs.length}/${cfg.minSamples})` };
  }
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  if (current === null || !Number.isFinite(current)) {
    return { ok: true, hourUtc, samples: xs.length, median: med, mad, z: null, zReason: "no current spread" };
  }
  if (mad === 0) return { ok: true, hourUtc, samples: xs.length, median: med, mad, z: null, zReason: "MAD is zero" };
  return { ok: true, hourUtc, samples: xs.length, median: med, mad, z: (current - med) / (MAD_TO_SIGMA * mad) };
}
