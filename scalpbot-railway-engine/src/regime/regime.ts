/**
 * M15 regime classifier with M5 hysteresis. Pure and deterministic; the caller passes
 * already-computed indicator values (from src/indicators) and verified news events.
 *
 * PRECEDENCE (first match wins):
 *   1. DATA_UNAVAILABLE — any required value missing/invalid, a source bar forming
 *      (closeTime > asOf) or stale. Blocks new signals.
 *   2. VOLATILE (news)  — verified (or manual) high-impact hard blackout active.
 *   3. VOLATILE         — M5 ATR percentile > 90 or M1 vol ratio > 2.5.
 *   4. DEAD             — M5 ATR percentile < 20 AND BB width percentile < 20.
 *   5. TREND_UP / TREND_DOWN
 *   6. RANGE            — ADX14 < 20 (non-volatile by construction of the order).
 *   7. MIXED
 *
 * HYSTERESIS: a new classification becomes active only after 3 consecutive completed,
 * contiguous M5 evaluations propose it. Safety states (DATA_UNAVAILABLE, news VOLATILE)
 * take effect immediately — blocking is never delayed. Leaving them still needs 3 bars.
 *
 * STALE M15: the M15 context must be the latest completed M15 bar: closeTime <= asOf and
 * asOf - closeTime < 15 min + staleToleranceMs. Otherwise → DATA_UNAVAILABLE (immediate).
 */

export const REGIME_VERSION = "1.0.0";

export type Regime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "VOLATILE" | "DEAD" | "MIXED" | "DATA_UNAVAILABLE";
export type Pair = "XAUUSD" | "EURUSD";

export type NewsEvent = { id: string; currency: string; impact: "high" | "medium" | "low"; time: string; source: string };
export type NewsInput =
  /** From a verified calendar integration with a documented schema. */
  | { status: "verified"; events: NewsEvent[] }
  /** Calendar unavailable: manual blackout windows configured by the admin. */
  | { status: "unavailable"; manualBlackouts: { start: string; end: string; reason: string }[] };

export type RegimeInput = {
  pair: Pair;
  /** Close time of the completed M5 bar being evaluated (ISO). */
  asOf: string;
  m15: { closeTime: string | null; close: number | null; ema20: number | null; ema50: number | null; ema200: number | null; slope50: number | null; adx14: number | null };
  m5: { closeTime: string | null; atrPercentile: number | null; bbWidthPercentile: number | null };
  m1: { closeTime: string | null; volRatio: number | null };
  news: NewsInput;
  /** Other externally-verified volatility block (e.g. broker halt). */
  externalVolatilityBlock?: string | null;
};

export type RegimeConfig = {
  trendSlope: number;
  trendAdx: number;
  rangeAdx: number;
  volAtrPct: number;
  volRatio: number;
  deadAtrPct: number;
  deadBbPct: number;
  confirmBars: number;
  hardNewsMin: number;
  penaltyNewsMin: number;
  staleToleranceMs: number;
  /** Strategy exceptions — disabled until separately validated out of sample. */
  weakCountertrendSweepValidated: boolean;
  orbValidatedRegimes: Regime[];
};

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  trendSlope: 0.3, trendAdx: 22, rangeAdx: 20, volAtrPct: 90, volRatio: 2.5, deadAtrPct: 20, deadBbPct: 20,
  confirmBars: 3, hardNewsMin: 10, penaltyNewsMin: 30, staleToleranceMs: 120_000,
  weakCountertrendSweepValidated: false, orbValidatedRegimes: [],
};

const RELEVANT: Record<Pair, string[]> = { XAUUSD: ["USD", "XAU"], EURUSD: ["EUR", "USD"] };
const M15 = 900_000;
const M5 = 300_000;
const M1 = 60_000;

export type NewsState = { hardBlock: boolean; penalty: boolean; source: "verified" | "manual"; reason: string | null; eventIds: string[] };

/** Hard block |t - event| <= hardNewsMin; penalty window <= penaltyNewsMin (never overrides hard). */
export function newsState(news: NewsInput, pair: Pair, asOf: string, cfg: RegimeConfig = DEFAULT_REGIME_CONFIG): NewsState {
  const t = Date.parse(asOf);
  if (news.status === "unavailable") {
    const hit = news.manualBlackouts.find((b) => Date.parse(b.start) <= t && t <= Date.parse(b.end));
    return { hardBlock: !!hit, penalty: false, source: "manual", reason: hit ? `manual blackout: ${hit.reason}` : null, eventIds: [] };
  }
  const rel = news.events.filter((e) => e.impact === "high" && RELEVANT[pair].includes(e.currency) && Number.isFinite(Date.parse(e.time)));
  const near = (min: number) => rel.filter((e) => Math.abs(t - Date.parse(e.time)) <= min * 60_000);
  const hard = near(cfg.hardNewsMin);
  const pen = near(cfg.penaltyNewsMin);
  return {
    hardBlock: hard.length > 0,
    penalty: pen.length > 0,
    source: "verified",
    reason: hard.length ? `high-impact news ±${cfg.hardNewsMin}m: ${hard.map((e) => e.id).join(",")}` : null,
    eventIds: (hard.length ? hard : pen).map((e) => e.id),
  };
}

const ok = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Returns a reason when a source bar is forming (closeTime > asOf) or older than allowed. */
function freshness(closeTime: string | null, asOf: number, maxAgeMs: number, label: string): string | null {
  if (!closeTime) return `${label} missing`;
  const c = Date.parse(closeTime);
  if (!Number.isFinite(c)) return `${label} invalid timestamp`;
  if (c > asOf) return `${label} bar still forming`;
  if (asOf - c > maxAgeMs) return `${label} stale`;
  return null;
}

export type Classification = { regime: Regime; reason: string; news: NewsState };

export function classify(x: RegimeInput, cfg: RegimeConfig = DEFAULT_REGIME_CONFIG): Classification {
  const asOf = Date.parse(x.asOf);
  const news = newsState(x.news, x.pair, x.asOf, cfg);
  const R = (regime: Regime, reason: string): Classification => ({ regime, reason, news });

  const fr =
    freshness(x.m15.closeTime, asOf, M15 - 1 + cfg.staleToleranceMs, "M15") ??
    freshness(x.m5.closeTime, asOf, cfg.staleToleranceMs, "M5") ??
    freshness(x.m1.closeTime, asOf, M1 + cfg.staleToleranceMs, "M1");
  if (!Number.isFinite(asOf)) return R("DATA_UNAVAILABLE", "invalid asOf");
  if (fr) return R("DATA_UNAVAILABLE", fr);
  const m = x.m15;
  const missing = (
    [["close", m.close], ["ema20", m.ema20], ["ema50", m.ema50], ["ema200", m.ema200], ["slope50", m.slope50], ["adx14", m.adx14],
     ["atrPercentile", x.m5.atrPercentile], ["bbWidthPercentile", x.m5.bbWidthPercentile], ["volRatio", x.m1.volRatio]] as const
  ).filter(([, v]) => !ok(v)).map(([k]) => k);
  if (missing.length) return R("DATA_UNAVAILABLE", `missing: ${missing.join(",")}`);

  if (news.hardBlock) return R("VOLATILE", news.reason!);
  if (x.externalVolatilityBlock) return R("VOLATILE", `volatility block: ${x.externalVolatilityBlock}`);
  const atrP = x.m5.atrPercentile!;
  const bbP = x.m5.bbWidthPercentile!;
  const vr = x.m1.volRatio!;
  if (atrP > cfg.volAtrPct) return R("VOLATILE", `M5 ATR percentile ${atrP} > ${cfg.volAtrPct}`);
  if (vr > cfg.volRatio) return R("VOLATILE", `M1 vol ratio ${vr} > ${cfg.volRatio}`);
  if (atrP < cfg.deadAtrPct && bbP < cfg.deadBbPct) return R("DEAD", `ATR pct ${atrP} and BB width pct ${bbP} < ${cfg.deadAtrPct}`);
  const [c, e20, e50, e200, s, adx] = [m.close!, m.ema20!, m.ema50!, m.ema200!, m.slope50!, m.adx14!];
  if (c > e200 && e20 > e50 && s >= cfg.trendSlope && adx >= cfg.trendAdx) return R("TREND_UP", "close>EMA200, EMA20>EMA50, slope, ADX");
  if (c < e200 && e20 < e50 && s <= -cfg.trendSlope && adx >= cfg.trendAdx) return R("TREND_DOWN", "close<EMA200, EMA20<EMA50, slope, ADX");
  if (adx < cfg.rangeAdx) return R("RANGE", `ADX ${adx} < ${cfg.rangeAdx}`);
  return R("MIXED", "no base condition met");
}

export type StrategyId = "pullback" | "sweep_reversal" | "orb";
export type Permission = { strategy: StrategyId; direction: "long" | "short" | "both" };

export function allowedStrategies(active: Regime, opts: { openingRangeComplete: boolean; weakCountertrend?: boolean }, cfg: RegimeConfig = DEFAULT_REGIME_CONFIG): Permission[] {
  const out: Permission[] = [];
  if (active === "TREND_UP") out.push({ strategy: "pullback", direction: "long" });
  if (active === "TREND_DOWN") out.push({ strategy: "pullback", direction: "short" });
  if (active === "RANGE" || (opts.weakCountertrend && cfg.weakCountertrendSweepValidated && (active === "TREND_UP" || active === "TREND_DOWN"))) {
    out.push({ strategy: "sweep_reversal", direction: active === "RANGE" ? "both" : active === "TREND_UP" ? "short" : "long" });
  }
  if (opts.openingRangeComplete && cfg.orbValidatedRegimes.includes(active) && !["VOLATILE", "DEAD", "MIXED", "DATA_UNAVAILABLE"].includes(active)) {
    out.push({ strategy: "orb", direction: active === "TREND_UP" ? "long" : active === "TREND_DOWN" ? "short" : "both" });
  }
  return out;
}

export type TrackerState = { active: Regime; proposed: Regime | null; count: number; lastM5Close: string | null; activeSince: string | null };
export const INITIAL_TRACKER: TrackerState = { active: "DATA_UNAVAILABLE", proposed: null, count: 0, lastM5Close: null, activeSince: null };

export type Transition = { at: string; from: Regime; to: Regime; reason: string; immediate: boolean };

export type RegimeOutput = {
  version: string;
  active: Regime;
  proposed: Regime | null;
  confirmations: number;
  required: number;
  classification: Classification;
  metrics: { m15: RegimeInput["m15"]; m5: RegimeInput["m5"]; m1: RegimeInput["m1"] };
  sources: { m15: string | null; m5: string | null; m1: string | null };
  transition: Transition | null;
  allowed: Permission[];
};

/**
 * Advance the tracker by one completed M5 evaluation. Re-submitting the same or an older
 * M5 bar is ignored (returns the unchanged state, no transition). A gap between M5 bars
 * resets the confirmation count. Every transition is returned for logging.
 */
export function step(
  state: TrackerState,
  x: RegimeInput,
  opts: { openingRangeComplete: boolean; weakCountertrend?: boolean } = { openingRangeComplete: false },
  cfg: RegimeConfig = DEFAULT_REGIME_CONFIG,
): { state: TrackerState; output: RegimeOutput } {
  const cls = classify(x, cfg);
  let s = { ...state };
  let transition: Transition | null = null;
  const m5c = x.m5.closeTime;
  const fresh = m5c !== null && Date.parse(m5c) <= Date.parse(x.asOf) && (s.lastM5Close === null || Date.parse(m5c) > Date.parse(s.lastM5Close));

  if (fresh || cls.regime === "DATA_UNAVAILABLE") {
    const contiguous = s.lastM5Close !== null && m5c !== null && Date.parse(m5c) - Date.parse(s.lastM5Close) === M5;
    if (fresh && m5c) s.lastM5Close = m5c;
    const immediate = cls.regime === "DATA_UNAVAILABLE" || (cls.regime === "VOLATILE" && (cls.news.hardBlock || !!x.externalVolatilityBlock));
    if (cls.regime === s.active) {
      s.proposed = null;
      s.count = 0;
    } else if (immediate) {
      transition = { at: x.asOf, from: s.active, to: cls.regime, reason: cls.reason, immediate: true };
      s = { ...s, active: cls.regime, proposed: null, count: 0, activeSince: x.asOf };
    } else {
      s.count = s.proposed === cls.regime && contiguous ? s.count + 1 : 1;
      s.proposed = cls.regime;
      if (s.count >= cfg.confirmBars) {
        transition = { at: x.asOf, from: s.active, to: cls.regime, reason: `${cls.reason} (confirmed ${s.count} M5 bars)`, immediate: false };
        s = { ...s, active: cls.regime, proposed: null, count: 0, activeSince: x.asOf };
      }
    }
  }

  return {
    state: s,
    output: {
      version: REGIME_VERSION,
      active: s.active,
      proposed: s.proposed,
      confirmations: s.count,
      required: cfg.confirmBars,
      classification: cls,
      metrics: { m15: x.m15, m5: x.m5, m1: x.m1 },
      sources: { m15: x.m15.closeTime, m5: x.m5.closeTime, m1: x.m1.closeTime },
      transition,
      allowed: allowedStrategies(s.active, opts, cfg),
    },
  };
}
