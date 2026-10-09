/**
 * Scoring, cost model, expected value and publication gate (Phase 8).
 * A score is a rule-based RANKING value, never a probability of winning.
 */
import type { PatternId } from "../structure/patterns.js";
import type { Side, StrategyResult } from "../strategies/strategies.js";

export const SCORING_VERSION = "1.0.0";

/* ------------------------------------------------------------------ cost model */

/**
 * Convention: `entryPrice` is either the reference MID or the EXECUTABLE side (ask for BUY,
 * bid for SELL). Cost vs mid of a round trip = half entry spread + half exit spread.
 * If entry is already executable, its half spread is inside the price and NOT added again.
 * Exit spread is the expected spread at exit (defaults to the entry spread when supplied
 * explicitly as such by the caller — never guessed here).
 */
export type CostInput = {
  bid: number | null;
  ask: number | null;
  entryPriceSide: "mid" | "executable";
  expectedExitSpread: number | null;
  /** Slippage estimate per side, price units. */
  slippagePerSide: number | null;
  /** Commission per side in ACCOUNT currency for the whole position. */
  commissionPerSide: number | null;
  /** Position size in instrument units (e.g. ounces, EUR). */
  units: number | null;
  /** Account currency → quote currency rate (1 when account currency = quote currency). */
  accountToQuote: number | null;
  /** Other verified round-trip costs, price units. */
  otherVerified: number;
};

export type CostEstimate =
  | { status: "complete"; total: number; parts: { spread: number; slippage: number; commission: number; other: number }; costR: number }
  | { status: "incomplete"; missing: string[]; partial: number; costR: null };

const fin = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

export function estimateCost(x: CostInput, stopDistance: number): CostEstimate {
  const missing: string[] = [];
  if (!fin(x.bid) || !fin(x.ask) || x.ask < x.bid) missing.push("bid/ask");
  if (!fin(x.expectedExitSpread) || x.expectedExitSpread < 0) missing.push("exit spread");
  if (!fin(x.slippagePerSide) || x.slippagePerSide < 0) missing.push("slippage");
  if (!fin(x.commissionPerSide) || x.commissionPerSide < 0) missing.push("commission");
  if (!fin(x.units) || x.units <= 0) missing.push("units/contract size");
  if (!fin(x.accountToQuote) || x.accountToQuote <= 0) missing.push("account currency conversion");
  if (!(stopDistance > 0)) missing.push("stop distance");
  const entryHalf = fin(x.bid) && fin(x.ask) ? (x.ask - x.bid) / 2 : 0;
  const spread = (x.entryPriceSide === "executable" ? 0 : entryHalf) + (fin(x.expectedExitSpread) ? x.expectedExitSpread / 2 : 0);
  const slippage = fin(x.slippagePerSide) ? 2 * x.slippagePerSide : 0;
  const commission = fin(x.commissionPerSide) && fin(x.units) && fin(x.accountToQuote) && x.units > 0 ? (2 * x.commissionPerSide * x.accountToQuote) / x.units : 0;
  const total = spread + slippage + commission + x.otherVerified;
  if (missing.length) return { status: "incomplete", missing, partial: total, costR: null };
  return { status: "complete", total, parts: { spread, slippage, commission, other: x.otherVerified }, costR: total / stopDistance };
}

/* ------------------------------------------------------------------ score */

export type ScoreConfig = {
  threshold: number;
  /** Real, documented USD proxy source; null = component omitted and max rescaled. */
  usdProxySource: string | null;
  rsiSpan: number;
  slopeFull: number;
  costEfficientR: number;
};
export const DEFAULT_SCORE_CONFIG: ScoreConfig = { threshold: 65, usdProxySource: null, rsiSpan: 20, slopeFull: 1, costEfficientR: 0.1 };

export type ScoreInput = {
  side: Side;
  m15Bias: "bull" | "bear" | null;
  /** All pattern detections for the trigger; duplicates of one event share barTime. */
  patterns: { id: PatternId; barTime: string; q: number | null }[];
  /** Distance to first opposing key level in R; Infinity when none. */
  clearPathR: number | null;
  rsi14: number | null;
  slope50: number | null;
  atrPercentile: number | null;
  /** Evaluation time (ISO). */
  asOf: string;
  /** USD proxy alignment in [0,1] from the configured source; ignored when source null. */
  usdProxyAlignment: number | null;
  costR: number | null;
  countertrendValidated: boolean;
  newsPenaltyWindow: boolean;
  newsHardBlock: boolean;
};

export type ScoreResult = {
  version: string;
  hardRejects: string[];
  components: Record<string, { points: number; max: number; note: string }>;
  penalties: Record<string, number>;
  rawTotal: number;
  availableMax: number;
  /** 100 × (components − penalties) / availableMax, clamped to [0,100]. */
  score: number;
  threshold: number;
  passes: boolean;
  inputs: ScoreInput;
};

const REVERSAL: PatternId[] = ["engulfing", "pin_bar", "liquidity_sweep", "fakeout"];
const BREAKOUT: PatternId[] = ["displacement", "inside_bar_breakout", "breakout_retest", "compression_breakout"];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** IST is UTC+05:30 all year (no DST). Window [19:00, 21:30). */
export function inPrimeIstWindow(asOf: string): boolean {
  const ms = Date.parse(asOf) + 330 * 60_000;
  const d = new Date(ms);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 19 * 60 && m < 21 * 60 + 30;
}

export function score(x: ScoreInput, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): ScoreResult {
  const c: ScoreResult["components"] = {};
  const hard: string[] = [];
  const buy = x.side === "BUY";

  // 1. M15 bias
  const aligned = x.m15Bias === (buy ? "bull" : "bear");
  const conflict = x.m15Bias !== null && !aligned;
  if (conflict) hard.push("M15 bias conflicts with direction");
  c.bias = { points: aligned ? 25 : x.m15Bias === null ? 10 : 0, max: 25, note: aligned ? "aligned" : x.m15Bias === null ? "neutral" : "conflict" };

  // 2. Pattern: one event counted once (max Q per barTime), best single applicable pattern.
  let best = { pts: 0, note: "no valid pattern" };
  const seen = new Map<string, number>();
  for (const p of x.patterns) {
    if (p.q === null || !Number.isFinite(p.q)) continue;
    const w = REVERSAL.includes(p.id) ? 20 : BREAKOUT.includes(p.id) ? 10 : 0;
    const pts = w * clamp(p.q, 0, 1);
    const prev = seen.get(p.barTime) ?? -1;
    if (pts > prev) seen.set(p.barTime, pts);
    if (pts > best.pts) best = { pts, note: `${p.id} Q=${p.q.toFixed(3)}` };
  }
  c.pattern = { points: best.pts, max: 20, note: best.note };

  // 3. Clear path
  const cp = x.clearPathR;
  if (cp === null || !(cp >= 1.5)) hard.push("path to target blocked before 1.5R");
  c.path = { points: cp !== null && cp >= 2 ? 15 : cp !== null && cp >= 1.5 ? 8 : 0, max: 15, note: cp === null ? "unknown" : `clear to ${cp === Infinity ? "∞" : cp.toFixed(2)}R` };

  // 4. Momentum = 5·clamp(±(RSI−50)/20,0,1) + 5·clamp(±slope50/1,0,1); a missing half scores 0.
  const rsiPart = x.rsi14 === null || !Number.isFinite(x.rsi14) ? null : clamp(((buy ? 1 : -1) * (x.rsi14 - 50)) / cfg.rsiSpan, 0, 1);
  const slopePart = x.slope50 === null || !Number.isFinite(x.slope50) ? null : clamp(((buy ? 1 : -1) * x.slope50) / cfg.slopeFull, 0, 1);
  c.momentum = { points: 5 * (rsiPart ?? 0) + 5 * (slopePart ?? 0), max: 10, note: `rsi ${rsiPart ?? "n/a"}, slope ${slopePart ?? "n/a"}` };

  // 5. ATR percentile 30–80 inclusive
  const ap = x.atrPercentile;
  c.atr = { points: ap !== null && ap >= 30 && ap <= 80 ? 10 : 0, max: 10, note: ap === null ? "unavailable" : `pct ${ap}` };

  // 6. Timing
  const prime = inPrimeIstWindow(x.asOf);
  c.timing = { points: prime ? 10 : 5, max: 10, note: prime ? "19:00–21:30 IST" : "outside prime window" };

  // 7. USD proxy (only with a configured real source)
  if (cfg.usdProxySource) {
    const a = x.usdProxyAlignment;
    c.usdProxy = { points: a === null ? 0 : 5 * clamp(a, 0, 1), max: 5, note: a === null ? `${cfg.usdProxySource}: unavailable` : cfg.usdProxySource };
  }

  // 8. Cost efficiency
  c.cost = { points: x.costR !== null && x.costR <= cfg.costEfficientR ? 5 : 0, max: 5, note: x.costR === null ? "cost incomplete" : `cost_R ${x.costR.toFixed(3)}` };

  if (x.newsHardBlock) hard.push("news hard blackout");
  const penalties: Record<string, number> = {};
  if (x.countertrendValidated) penalties.countertrend = 15;
  if (x.newsPenaltyWindow && !x.newsHardBlock) penalties.news = 20;

  const rawTotal = Object.values(c).reduce((a, b) => a + b.points, 0);
  const availableMax = Object.values(c).reduce((a, b) => a + b.max, 0);
  const pen = Object.values(penalties).reduce((a, b) => a + b, 0);
  const s = clamp((100 * (rawTotal - pen)) / availableMax, 0, 100);
  return { version: SCORING_VERSION, hardRejects: hard, components: c, penalties, rawTotal, availableMax, score: s, threshold: cfg.threshold, passes: hard.length === 0 && s >= cfg.threshold, inputs: x };
}

/* ------------------------------------------------------------------ expected value */

export type EvConfig = { threshold: number; minSamples: number };
export const DEFAULT_EV_CONFIG: EvConfig = { threshold: 0.1, minSamples: 100 };

export type LabelledOutcomes = {
  /** Must match the candidate exactly. */
  key: { strategy: string; pair: string; regime: string; executionPolicy: string };
  /** True only when outcomes come from a chronological, out-of-sample evaluation. */
  outOfSample: boolean;
  netR: number[];
};

export type EvResult =
  | { status: "supported"; mean: number; stderr: number; n: number; passes: boolean }
  | { status: "unavailable"; reason: string };

/** EV_net = mean(net realized R) for the exact strategy/pair/regime/policy, OOS only. */
export function evNet(o: LabelledOutcomes | null, want: LabelledOutcomes["key"], cost: CostEstimate, cfg: EvConfig = DEFAULT_EV_CONFIG): EvResult {
  if (cost.status !== "complete") return { status: "unavailable", reason: `cost estimation incomplete: ${cost.missing.join(", ")}` };
  if (!o) return { status: "unavailable", reason: "no labelled outcomes" };
  const k = o.key;
  if (k.strategy !== want.strategy || k.pair !== want.pair || k.regime !== want.regime || k.executionPolicy !== want.executionPolicy) return { status: "unavailable", reason: "outcomes do not match strategy/pair/regime/policy" };
  if (!o.outOfSample) return { status: "unavailable", reason: "outcomes are not out-of-sample" };
  const xs = o.netR.filter(Number.isFinite);
  if (xs.length < cfg.minSamples) return { status: "unavailable", reason: `insufficient samples ${xs.length}/${cfg.minSamples}` };
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { status: "supported", mean, stderr: sd / Math.sqrt(n), n, passes: mean >= cfg.threshold };
}

/** Diagnostic only: valid when every outcome is a full win W or full loss L (binary exits). */
export function binaryEvDiagnostic(p: number, W: number, L: number, costR: number, exitClasses: "binary" | "multiple"): number | null {
  if (exitClasses !== "binary") return null;
  if (![p, W, L, costR].every(Number.isFinite) || p < 0 || p > 1) return null;
  return p * W - (1 - p) * L - costR;
}

/* ------------------------------------------------------------------ calibration guard */

export type Calibration =
  | { status: "not_validated" }
  | { status: "validated"; modelVersion: string; features: string[]; trainPeriod: string; testBrier: number; baselineBrier: number };

/** Win probability is shown only for a validated model that beat its baseline on untouched test data. */
export function displayableProbability(cal: Calibration, p: number | null): number | null {
  if (cal.status !== "validated" || p === null) return null;
  if (cal.features.length > 8 || !(cal.testBrier < cal.baselineBrier)) return null;
  return p;
}

/* ------------------------------------------------------------------ publication gate */

export type GateInput = {
  candidate: StrategyResult;
  score: ScoreResult | null;
  cost: CostEstimate | null;
  maxCostR: number;
  spreadOk: boolean;
  ev: EvResult | null;
  timingOk: boolean;
  invalidationOk: boolean;
  globalRiskOk: boolean;
  dataQualityOk: boolean;
};

export type GateResult = { publish: true; candidate: Extract<StrategyResult, { status: "candidate" }>; score: number } | { publish: false; reasons: string[] };

export function publicationGate(g: GateInput): GateResult {
  const reasons: string[] = [];
  if (g.candidate.status !== "candidate") reasons.push(`strategy rejected: ${g.candidate.reason}`);
  const regimeRule = g.candidate.rules.find((r) => r.rule === "regime permits strategy/direction");
  if (!regimeRule || !regimeRule.pass) reasons.push("regime does not allow strategy");
  if (!g.score) reasons.push("score missing");
  else {
    if (g.score.hardRejects.length) reasons.push(...g.score.hardRejects.map((h) => `score hard reject: ${h}`));
    if (g.score.score < g.score.threshold) reasons.push(`score ${g.score.score.toFixed(1)} < ${g.score.threshold}`);
  }
  if (!g.spreadOk) reasons.push("spread gate failed");
  if (!g.cost || g.cost.status !== "complete") reasons.push("cost estimation incomplete");
  else if (g.cost.costR > g.maxCostR) reasons.push(`cost_R ${g.cost.costR.toFixed(3)} > ${g.maxCostR}`);
  if (!g.ev || g.ev.status !== "supported") reasons.push(`EV unavailable${g.ev && g.ev.status === "unavailable" ? `: ${g.ev.reason}` : ""}`);
  else if (!g.ev.passes) reasons.push(`EV ${g.ev.mean.toFixed(3)}R below threshold`);
  if (!g.timingOk) reasons.push("entry timing check failed");
  if (!g.invalidationOk) reasons.push("invalidation check failed");
  if (!g.globalRiskOk) reasons.push("global risk check failed");
  if (!g.dataQualityOk) reasons.push("data-quality check failed");
  if (reasons.length || g.candidate.status !== "candidate" || !g.score) return { publish: false, reasons };
  return { publish: true, candidate: g.candidate, score: g.score.score };
}

export type Decision = { result: "PUBLISH"; candidate: Extract<StrategyResult, { status: "candidate" }>; score: number } | { result: "NO_VALID_SETUP"; reasons: { strategy: string; reasons: string[] }[] };

/** Highest-scoring publishable candidate, or NO_VALID_SETUP with every reason. */
export function decide(gates: GateInput[]): Decision {
  const results = gates.map((g) => ({ g, r: publicationGate(g) }));
  const ok = results.filter((x) => x.r.publish).sort((a, b) => (b.r as { score: number }).score - (a.r as { score: number }).score);
  if (ok.length) {
    const r = ok[0]!.r as Extract<GateResult, { publish: true }>;
    return { result: "PUBLISH", candidate: r.candidate, score: r.score };
  }
  return { result: "NO_VALID_SETUP", reasons: results.map((x) => ({ strategy: x.g.candidate.strategy, reasons: (x.r as { reasons: string[] }).reasons })) };
}
