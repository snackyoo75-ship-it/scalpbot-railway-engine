import {
  INDICATOR_VERSION,
  adx,
  atr,
  atrPercent,
  bollinger,
  candleGeometry,
  donchian,
  ema,
  normalizedSlope,
  perSecondVol,
  realizedVol,
  rollingPercentile,
  rsi,
  spreadStats,
  volRatio,
  zScore,
  DEFAULT_SPREAD_CONFIG,
  type Candle,
  type Series,
  type SpreadObs,
  type SpreadStatsConfig,
} from "./core.js";

export type Ind<T = number> =
  | { status: "ok"; value: T; sourceTime: string }
  | { status: "unavailable"; value: null; sourceTime: string | null; reason: string };

export type IndicatorConfig = {
  /** Extra EMA periods per timeframe; part of configVersion. */
  emaPeriods: { M5: number[]; M15: number[] };
  configVersion: string;
  spread: SpreadStatsConfig;
};

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  emaPeriods: { M5: [20, 50], M15: [20, 50, 200] },
  configVersion: "cfg-1",
  spread: DEFAULT_SPREAD_CONFIG,
};

const STEP_MS = { M1: 60_000, M5: 300_000, M15: 900_000 } as const;
type Tf = keyof typeof STEP_MS;
/** Gaps longer than this are treated as market closures, not missing data. */
const MARKET_CLOSED_GAP_MS = 36 * 3_600_000;

/**
 * Keeps only completed candles whose close time <= asOf (no forming bars, no lookahead),
 * validates OHLC and ordering, and reports intra-session gaps (missing candles).
 */
export function prepareSeries(raw: Candle[], tf: Tf, asOf: string): { candles: Candle[]; problem: string | null } {
  const t = Date.parse(asOf);
  const candles = raw.filter((k) => k.complete && Date.parse(k.time) + STEP_MS[tf] <= t);
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i]!;
    const vals = [k.open, k.high, k.low, k.close];
    if (vals.some((v) => !Number.isFinite(v)) || k.high < Math.max(k.open, k.close) || k.low > Math.min(k.open, k.close)) {
      return { candles, problem: `invalid OHLC at ${k.time}` };
    }
    if (i > 0) {
      const d = Date.parse(k.time) - Date.parse(candles[i - 1]!.time);
      if (d <= 0) return { candles, problem: `non-increasing timestamps at ${k.time}` };
      if (d !== STEP_MS[tf] && d < MARKET_CLOSED_GAP_MS) return { candles, problem: `missing ${tf} candles before ${k.time}; backfill first` };
    }
  }
  return { candles, problem: null };
}

function last(s: Series, c: Candle[], problem: string | null, need: string): Ind {
  const i = c.length - 1;
  const sourceTime = i >= 0 ? c[i]!.time : null;
  if (problem) return { status: "unavailable", value: null, sourceTime, reason: problem };
  const v = i >= 0 ? s[i]! : null;
  if (v === null || v === undefined) return { status: "unavailable", value: null, sourceTime, reason: need };
  return { status: "ok", value: v, sourceTime: sourceTime as string };
}

export type Snapshot = {
  version: string;
  configVersion: string;
  asOf: string;
  M1: Record<string, Ind>;
  M5: Record<string, Ind>;
  M15: Record<string, Ind>;
  geometryM5: Ind<NonNullable<ReturnType<typeof candleGeometry>>>;
  spread: Ind<{ hourUtc: number; samples: number; median: number; mad: number; z: number | null; zReason?: string }>;
};

export function computeSnapshot(input: {
  asOf: string;
  m1: Candle[];
  m5: Candle[];
  m15: Candle[];
  spreads: SpreadObs[];
  currentSpread: number | null;
  config?: IndicatorConfig;
}): Snapshot {
  const cfg = input.config ?? DEFAULT_INDICATOR_CONFIG;
  const m1 = prepareSeries(input.m1, "M1", input.asOf);
  const m5 = prepareSeries(input.m5, "M5", input.asOf);
  const m15 = prepareSeries(input.m15, "M15", input.asOf);

  const tfBlock = (p: { candles: Candle[]; problem: string | null }, periods: number[]) => {
    const c = p.candles;
    const closes = c.map((k) => k.close);
    const out: Record<string, Ind> = {};
    for (const n of periods) out[`ema${n}`] = last(ema(closes, n), c, p.problem, `needs ${n} completed candles`);
    const a = atr(c, 14);
    out.atr14 = last(a, c, p.problem, "needs 15 candles (14 TR values)");
    out.atrPct = last(atrPercent(a, c), c, p.problem, "ATR14 unavailable");
    out.slope50 = last(normalizedSlope(ema(closes, 50), a, 5), c, p.problem, "needs EMA50 at t and t-5 and ATR14 > 0");
    return { out, c, closes, a };
  };

  const b5 = tfBlock(m5, cfg.emaPeriods.M5);
  const b15 = tfBlock(m15, cfg.emaPeriods.M15);
  const c5 = b5.c;
  const p5 = m5.problem;

  b5.out.atrPercentile200 = last(rollingPercentile(b5.a, 200), c5, p5, "needs 200 valid M5 ATR14 values");
  b5.out.rsi14 = last(rsi(b5.closes, 14), c5, p5, "needs 15 closes");
  b15.out.rsi14 = last(rsi(b15.closes, 14), b15.c, m15.problem, "needs 15 closes");
  for (const [b, p] of [[b5, p5], [b15, m15.problem]] as const) {
    const d = adx(b.c, 14);
    b.out.adx14 = last(d.adx, b.c, p, "needs 28 candles (14 DX values) with non-zero range");
    b.out.plusDI14 = last(d.plusDI, b.c, p, "needs 15 candles");
    b.out.minusDI14 = last(d.minusDI, b.c, p, "needs 15 candles");
  }
  const bb = bollinger(b5.closes, 20, 2);
  b5.out.bbMid = last(bb.mid, c5, p5, "needs 20 closes");
  b5.out.bbUpper = last(bb.upper, c5, p5, "needs 20 closes");
  b5.out.bbLower = last(bb.lower, c5, p5, "needs 20 closes");
  b5.out.bbWidth = last(bb.width, c5, p5, "needs 20 closes and SMA20 != 0");
  b5.out.bbWidthPercentile100 = last(rollingPercentile(bb.width, 100), c5, p5, "needs 100 valid widths");
  const dc = donchian(c5, 20);
  b5.out.donchianUpper20 = last(dc.upper, c5, p5, "needs 20 previous candles");
  b5.out.donchianLower20 = last(dc.lower, c5, p5, "needs 20 previous candles");
  b5.out.zScore20 = last(zScore(b5.closes, 20), c5, p5, "needs 20 closes and SD20 > 0");

  const closes1 = m1.candles.map((k) => k.close);
  const sig = realizedVol(closes1, 30);
  const M1: Record<string, Ind> = {
    sigmaM1: last(sig, m1.candles, m1.problem, "needs 31 valid M1 closes"),
    sigma1sApprox: last(sig.map((s) => (s === null ? null : perSecondVol(s))), m1.candles, m1.problem, "needs 31 valid M1 closes"),
    volRatio200: last(volRatio(sig, 200), m1.candles, m1.problem, "needs 200 rolling sigma values and non-zero median"),
  };

  const lastM5 = c5[c5.length - 1]!;
  const geo = lastM5 ? candleGeometry(lastM5) : null;
  const geometryM5: Snapshot["geometryM5"] =
    p5 || !lastM5 || !geo
      ? { status: "unavailable", value: null, sourceTime: lastM5?.time ?? null, reason: p5 ?? (lastM5 ? "zero range" : "no candle") }
      : { status: "ok", value: geo, sourceTime: lastM5.time };

  const ss = spreadStats(input.spreads, input.asOf, input.currentSpread, cfg.spread);
  const spread: Snapshot["spread"] = ss.ok
    ? { status: "ok", value: { hourUtc: ss.hourUtc, samples: ss.samples, median: ss.median, mad: ss.mad, z: ss.z, zReason: ss.zReason }, sourceTime: input.asOf }
    : { status: "unavailable", value: null, sourceTime: input.asOf, reason: ss.reason };

  return { version: INDICATOR_VERSION, configVersion: cfg.configVersion, asOf: input.asOf, M1, M5: b5.out, M15: b15.out, geometryM5, spread };
}
