/**
 * One analysis pass for one pair, as of the latest completed M5 bar. Pure: no I/O, injected clock.
 *
 * Wires the existing pure modules together in the fixed workflow order (feed → candles → indicators →
 * structure → patterns → regime → strategies → gates → entry → publish). It never relaxes a gate:
 * publication still needs a complete cost estimate AND supported out-of-sample EV, so without validated
 * history every pass ends in NO_VALID_SETUP with the reasons recorded.
 */
import { atr, ema, INDICATOR_VERSION, rsi, type Candle, type SpreadObs } from "../indicators/core.js";
import { computeSnapshot, prepareSeries, type Ind, type Snapshot } from "../indicators/snapshot.js";
import { closeTime } from "../structure/swings.js";
import { INSTRUMENTS, levelsAt, openingRange, previousDay } from "../structure/levels.js";
import { clusterLevels, type Cluster } from "../structure/cluster.js";
import { displacement, engulfing, pinBar } from "../structure/patterns.js";
import { REGIME_VERSION, step, type NewsInput, type Pair, type RegimeInput, type RegimeOutput, type TrackerState } from "../regime/regime.js";
import { DEFAULT_STRATEGY_CONFIG, runStrategies, STRATEGY_VERSION, type Candidate, type Side, type StrategyConfig, type StrategyResult } from "../strategies/strategies.js";
import {
  decide, DEFAULT_SCORE_CONFIG, estimateCost, evNet, score as scoreImpl, SCORING_VERSION,
  type CostEstimate, type Decision, type EvResult, type GateInput, type LabelledOutcomes, type ScoreConfig, type ScoreResult,
} from "../scoring/scoring.js";

export const ANALYSIS_VERSION = "1.0.0";
export const CONFIG_VERSION = `s${STRATEGY_VERSION}-c${SCORING_VERSION}-r${REGIME_VERSION}-i${INDICATOR_VERSION}`;

export type StageKey = "accepted" | "feed" | "candles" | "indicators" | "structure" | "patterns" | "regime" | "strategies" | "gates" | "entry" | "publish";
export type StageReport = { stage: StageKey; status: "done" | "failed" | "unavailable" | "skipped"; detail: string; started_at: string; completed_at: string };

/** Broker cost inputs. Every field must be supplied for a complete cost estimate; any null → no publication. */
export type BrokerCosts = { commissionPerSide: number | null; units: number | null; accountToQuote: number | null; slippagePerSide: number | null };

export type AnalysisInput = {
  pair: Pair;
  /** Close time of the latest completed M5 bar. */
  asOf: string;
  m1: Candle[];
  m5: Candle[];
  m15: Candle[];
  spreads: SpreadObs[];
  /** Latest live tradeable quote; null when the stream has none. */
  quote: { bid: number; ask: number; time: string } | null;
  feedFresh: boolean;
  feedDetail: string;
  tracker: TrackerState;
  news: NewsInput;
  recent: { pair: Pair; side: Side; time: string }[];
  orbAttempts: string[];
  costs: BrokerCosts;
  /** Out-of-sample labelled outcomes from a validation report; null until validated history exists. */
  outcomes: (LabelledOutcomes & { reportId: string }) | null;
  /** Engine-side view of global risk state (pause, pair enabled, risk config present). The app re-checks everything. */
  globalRisk: { ok: boolean; detail: string };
  maxCostR?: number;
  maxSpreadZ?: number;
  maxDecisionLatencyMs?: number;
  strategyConfig?: StrategyConfig;
  scoreConfig?: ScoreConfig;
  openingWindow?: { tz: string; startH: number; startMin: number };
};

export type IngestSignalPayload = {
  idempotency_key: string; pair: "XAU_USD" | "EUR_USD"; side: "long" | "short"; strategy: string; regime: string;
  entry_price: number; entry_price_convention: "mid"; proposed_entry_at: string; stop_loss: number; take_profit_1: number; take_profit_2: number | null;
  score: number; score_components: Record<string, number>; est_cost_r: number; expected_value_r: number | null; ev_validation_report_id: string | null;
  valid_until: string; invalidation_conditions: string[]; source_candle_ts: string[]; config_version: string; model_version: null;
  calibrated_probability: null; calibration_version: null; analysis_started_at: string; analysis_completed_at: string;
  features: { feature_set_version: string; values: Record<string, unknown>; computed_at: string };
};

export type AnalysisResult = {
  pair: Pair;
  asOf: string;
  stages: StageReport[];
  tracker: TrackerState;
  regime: RegimeOutput | null;
  results: StrategyResult[];
  scored: { strategy: string; score: number | null; cost: CostEstimate["status"]; ev: EvResult["status"] }[];
  decision: Decision | { result: "NO_VALID_SETUP"; reasons: { strategy: string; reasons: string[] }[] };
  payload: IngestSignalPayload | null;
};

export const toOandaPair = (p: Pair): "XAU_USD" | "EUR_USD" => (p === "XAUUSD" ? "XAU_USD" : "EUR_USD");
export const fromOandaPair = (p: string): Pair | null => (p === "XAU_USD" ? "XAUUSD" : p === "EUR_USD" ? "EURUSD" : null);

const val = (i: Ind | undefined): number | null => (i && i.status === "ok" ? i.value : null);
const fin = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const lastClose = (c: Candle[], stepMs: number) => (c.length ? new Date(Date.parse(c[c.length - 1]!.time) + stepMs).toISOString() : null);

/** M15 bias: bull when close > EMA50 and EMA20 > EMA50, bear when both below; otherwise neutral. */
export function m15BiasOf(s: Snapshot, m15Close: number | null): "bull" | "bear" | null {
  const e20 = val(s.M15["ema20"]), e50 = val(s.M15["ema50"]);
  if (!fin(e20) || !fin(e50) || !fin(m15Close)) return null;
  if (m15Close > e50 && e20 > e50) return "bull";
  if (m15Close < e50 && e20 < e50) return "bear";
  return null;
}

/** Distance in R from entry to the first opposing key cluster; Infinity when none. */
export function clearPathR(c: Candidate, clusters: Cluster[]): number | null {
  const risk = Math.abs(c.referencePrice - c.stopLoss);
  if (!(risk > 0)) return null;
  const buy = c.side === "BUY";
  const d = clusters
    .filter((k) => k.isKey && Date.parse(k.availableAt) <= Date.parse(c.timestamps.asOf))
    .map((k) => (buy ? k.low - c.referencePrice : c.referencePrice - k.high))
    .filter((x) => x > 0);
  return d.length ? Math.min(...d) / risk : Infinity;
}

export function analyze(input: AnalysisInput, now: () => Date = () => new Date()): AnalysisResult {
  const stages: StageReport[] = [];
  const started = now().toISOString();
  let t0 = started;
  const mark = (stage: StageKey, status: StageReport["status"], detail: string) => {
    const t1 = now().toISOString();
    stages.push({ stage, status, detail: detail.slice(0, 500), started_at: t0, completed_at: t1 });
    t0 = t1;
  };
  const noSetup = (reason: string, rest: StageKey[], tracker = input.tracker, regime: RegimeOutput | null = null): AnalysisResult => {
    for (const s of rest) mark(s, "skipped", `not run: ${reason}`);
    return { pair: input.pair, asOf: input.asOf, stages, tracker, regime, results: [], scored: [], decision: { result: "NO_VALID_SETUP", reasons: [{ strategy: "all", reasons: [reason] }] }, payload: null };
  };

  mark("accepted", "done", `${input.pair} as of ${input.asOf}`);

  // Feed
  if (!input.feedFresh) {
    mark("feed", "failed", input.feedDetail);
    return noSetup("market feed not fresh", ["candles", "indicators", "structure", "patterns", "regime", "strategies", "gates", "entry", "publish"]);
  }
  mark("feed", "done", input.feedDetail);

  // Candles
  const p1 = prepareSeries(input.m1, "M1", input.asOf);
  const p5 = prepareSeries(input.m5, "M5", input.asOf);
  const p15 = prepareSeries(input.m15, "M15", input.asOf);
  const m5 = p5.candles;
  const i = m5.length - 1;
  const problems = [p1.problem && `M1: ${p1.problem}`, p5.problem && `M5: ${p5.problem}`, p15.problem && `M15: ${p15.problem}`].filter(Boolean) as string[];
  const latestOk = i >= 0 && closeTime(m5[i]!) === input.asOf;
  if (problems.length || !latestOk) {
    mark("candles", "failed", problems.length ? problems.join("; ") : `latest completed M5 does not close at ${input.asOf}`);
    return noSetup("candle data incomplete", ["indicators", "structure", "patterns", "regime", "strategies", "gates", "entry", "publish"]);
  }
  mark("candles", "done", `M1 ${p1.candles.length}, M5 ${m5.length}, M15 ${p15.candles.length} completed candles`);

  // Indicators
  const currentSpread = input.quote ? input.quote.ask - input.quote.bid : null;
  const snap = computeSnapshot({ asOf: input.asOf, m1: p1.candles, m5, m15: p15.candles, spreads: input.spreads, currentSpread });
  const closes = m5.map((k) => k.close);
  const atr14 = atr(m5, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atrNow = atr14[i] ?? null;
  const unavailable = [...Object.entries(snap.M5), ...Object.entries(snap.M15).map(([k, v]) => [`M15.${k}`, v] as const)].filter(([, v]) => v.status !== "ok").map(([k]) => k);
  mark("indicators", fin(atrNow) ? "done" : "unavailable", fin(atrNow) ? `computed; unavailable: ${unavailable.length ? unavailable.join(", ") : "none"}` : "ATR14 unavailable");
  if (!fin(atrNow)) return noSetup("ATR14 unavailable", ["structure", "patterns", "regime", "strategies", "gates", "entry", "publish"]);

  // Structure & levels
  const openingWindow = input.openingWindow ?? { tz: "Europe/London", startH: 8, startMin: 0 };
  const clusters = clusterLevels(levelsAt(m5, i, { atr: atrNow, instrument: INSTRUMENTS[input.pair], openingWindow }), atrNow, i);
  const pd = previousDay(m5, i);
  const or = openingRange(m5, i, openingWindow);
  mark("structure", "done", `${clusters.filter((c) => c.isKey).length} key clusters of ${clusters.length}; previous day ${pd ? "available" : "unavailable"}`);

  // Patterns (evidence for scoring)
  const pctx = { c: m5, atr: atr14 };
  const patterns = [engulfing(pctx, i), pinBar(pctx, i), displacement(pctx, i)].filter((p): p is NonNullable<typeof p> => p !== null);
  mark("patterns", "done", patterns.length ? patterns.map((p) => `${p.id}/${p.direction}`).join(", ") : "none on trigger bar");

  // Regime
  const m15c = p15.candles;
  const rin: RegimeInput = {
    pair: input.pair,
    asOf: input.asOf,
    m15: { closeTime: lastClose(m15c, 900_000), close: m15c.at(-1)?.close ?? null, ema20: val(snap.M15["ema20"]), ema50: val(snap.M15["ema50"]), ema200: val(snap.M15["ema200"]), slope50: val(snap.M15["slope50"]), adx14: val(snap.M15["adx14"]) },
    m5: { closeTime: lastClose(m5, 300_000), atrPercentile: val(snap.M5["atrPercentile200"]), bbWidthPercentile: val(snap.M5["bbWidthPercentile100"]) },
    m1: { closeTime: lastClose(p1.candles, 60_000), volRatio: val(snap.M1["volRatio200"]) },
    news: input.news,
  };
  const { state: tracker, output: regime } = step(input.tracker, rin, { openingRangeComplete: or !== null });
  mark("regime", regime.active === "DATA_UNAVAILABLE" ? "unavailable" : "done", `${regime.active} (${regime.classification.reason}); proposed ${regime.proposed ?? "none"} ${regime.confirmations}/${regime.required}`);

  // Strategies
  const m15Bias = m15BiasOf(snap, m15c.at(-1)?.close ?? null);
  const results = runStrategies(
    {
      pair: input.pair, asOf: input.asOf, m5, atr14, ema20, ema50, rsi14, slope50: val(snap.M5["slope50"]), regime: regime.active, m15Bias,
      spread: currentSpread, keyLevels: clusters, previousDay: pd ? { high: pd.high, low: pd.low } : null,
      openingRange: or ? { high: or.high, low: or.low, availableAt: or.availableAt, dayKey: or.key } : null,
      recent: input.recent, orbAttempts: input.orbAttempts, roundTripCost: null, estimatedWinRate: null,
    },
    input.strategyConfig ?? DEFAULT_STRATEGY_CONFIG,
  );
  const cands = results.filter((r): r is Candidate => r.status === "candidate");
  mark("strategies", "done", results.map((r) => (r.status === "candidate" ? `${r.strategy}: candidate ${r.side}` : `${r.strategy}: ${r.reason}`)).join(" | "));

  // Gates
  const nowMs = now().getTime();
  const spreadZ = snap.spread.status === "ok" ? snap.spread.value.z : null;
  const spreadOk = fin(spreadZ) && spreadZ <= (input.maxSpreadZ ?? 3);
  const timingOk = nowMs - Date.parse(input.asOf) <= (input.maxDecisionLatencyMs ?? 60_000);
  const mid = input.quote ? (input.quote.bid + input.quote.ask) / 2 : null;
  const scored: AnalysisResult["scored"] = [];
  const extra = new Map<Candidate, { score: ScoreResult; cost: CostEstimate; ev: EvResult }>();
  const gates: GateInput[] = results.map((r) => {
    if (r.status !== "candidate") {
      scored.push({ strategy: r.strategy, score: null, cost: "incomplete", ev: "unavailable" });
      return { candidate: r, score: null, cost: null, maxCostR: input.maxCostR ?? 0.25, spreadOk, ev: null, timingOk, invalidationOk: false, globalRiskOk: input.globalRisk.ok, dataQualityOk: true };
    }
    const risk = Math.abs(r.referencePrice - r.stopLoss);
    const cost = estimateCost({
      bid: input.quote?.bid ?? null, ask: input.quote?.ask ?? null, entryPriceSide: "mid",
      expectedExitSpread: currentSpread, // documented choice: current live spread used as the exit-spread estimate
      slippagePerSide: input.costs.slippagePerSide, commissionPerSide: input.costs.commissionPerSide,
      units: input.costs.units, accountToQuote: input.costs.accountToQuote, otherVerified: 0,
    }, risk);
    const dir = r.side === "BUY" ? "bull" : "bear";
    const sc = scoreCandidate(r, dir, patterns, clusters, snap, m15Bias, cost, regime, input.scoreConfig ?? DEFAULT_SCORE_CONFIG);
    const ev = evNet(input.outcomes, { strategy: r.strategy, pair: input.pair, regime: r.regime, executionPolicy: CONFIG_VERSION }, cost);
    extra.set(r, { score: sc, cost, ev });
    scored.push({ strategy: r.strategy, score: sc.score, cost: cost.status, ev: ev.status });
    const invalidationOk = fin(mid) && (r.side === "BUY" ? mid > r.stopLoss && mid < r.tp1 : mid < r.stopLoss && mid > r.tp1);
    return { candidate: r, score: sc, cost, maxCostR: input.maxCostR ?? 0.25, spreadOk, ev, timingOk, invalidationOk, globalRiskOk: input.globalRisk.ok, dataQualityOk: problems.length === 0 && input.feedFresh };
  });
  const decision = decide(gates);
  mark("gates", decision.result === "PUBLISH" ? "done" : "failed",
    decision.result === "PUBLISH" ? `${decision.candidate.strategy} passed all gates (score ${decision.score.toFixed(1)})` : cands.length ? decision.reasons.map((x) => `${x.strategy}: ${x.reasons.join("; ")}`).join(" | ") : "no strategy candidate");

  if (decision.result !== "PUBLISH") {
    mark("entry", "skipped", "no candidate passed the gates");
    mark("publish", "done", "NO_VALID_SETUP");
    return { pair: input.pair, asOf: input.asOf, stages, tracker, regime, results, scored, decision, payload: null };
  }

  // Entry feasibility: the trigger bar just closed; the plan is valid for one M5 bar.
  const c = decision.candidate;
  const x = extra.get(c)!;
  const completed = now().toISOString();
  const validUntil = new Date(Date.parse(input.asOf) + 300_000).toISOString();
  if (Date.parse(validUntil) <= Date.parse(completed)) {
    mark("entry", "failed", "analysis finished after the entry window closed");
    mark("publish", "done", "NO_VALID_SETUP");
    return { pair: input.pair, asOf: input.asOf, stages, tracker, regime, results, scored, decision: { result: "NO_VALID_SETUP", reasons: [{ strategy: c.strategy, reasons: ["entry window expired"] }] }, payload: null };
  }
  mark("entry", "done", `valid until ${validUntil}`);

  const comps: Record<string, number> = {};
  for (const [k, v] of Object.entries(x.score.components)) comps[k] = v.points;
  for (const [k, v] of Object.entries(x.score.penalties)) comps[`penalty_${k}`] = -v;
  const ev = x.ev.status === "supported" ? x.ev : null;
  const payload: IngestSignalPayload = {
    idempotency_key: `eng:${toOandaPair(input.pair)}:${c.strategy}:${c.side}:${input.asOf}`.slice(0, 128),
    pair: toOandaPair(input.pair),
    side: c.side === "BUY" ? "long" : "short",
    strategy: c.strategy,
    regime: c.regime,
    entry_price: c.referencePrice,
    entry_price_convention: "mid",
    proposed_entry_at: completed,
    stop_loss: c.stopLoss,
    take_profit_1: c.tp1,
    take_profit_2: c.tp2,
    score: Math.round(decision.score),
    score_components: comps,
    est_cost_r: x.cost.status === "complete" ? x.cost.costR : 0,
    expected_value_r: ev ? ev.mean : null,
    ev_validation_report_id: ev && input.outcomes ? input.outcomes.reportId : null,
    valid_until: validUntil,
    invalidation_conditions: [`Price trades ${c.side === "BUY" ? "at or below" : "at or above"} ${c.stopLoss}`, `Not entered by ${validUntil}`],
    source_candle_ts: [...m5.slice(-20).map((k) => k.time), ...(m15c.at(-1) ? [m15c.at(-1)!.time] : []), ...(p1.candles.at(-1) ? [p1.candles.at(-1)!.time] : [])],
    config_version: CONFIG_VERSION,
    model_version: null,
    calibrated_probability: null,
    calibration_version: null,
    analysis_started_at: started,
    analysis_completed_at: completed,
    features: { feature_set_version: `snapshot-${INDICATOR_VERSION}`, values: compactSnapshot(snap), computed_at: completed },
  };
  mark("publish", "done", `submitting ${c.strategy} ${c.side} to the app`);
  return { pair: input.pair, asOf: input.asOf, stages, tracker, regime, results, scored, decision, payload };
}

function scoreCandidate(
  c: Candidate, dir: "bull" | "bear", patterns: ReturnType<typeof engulfing>[], clusters: Cluster[], snap: Snapshot,
  m15Bias: "bull" | "bear" | null, cost: CostEstimate, regime: RegimeOutput, cfg: ScoreConfig,
): ScoreResult {
  return scoreImpl({
    side: c.side,
    m15Bias,
    patterns: patterns.filter((p): p is NonNullable<typeof p> => !!p && p.direction === dir).map((p) => ({ id: p.id, barTime: p.barTime, q: p.quality.status === "ok" ? p.quality.q : null })),
    clearPathR: clearPathR(c, clusters),
    rsi14: val(snap.M5["rsi14"]),
    slope50: val(snap.M5["slope50"]),
    atrPercentile: val(snap.M5["atrPercentile200"]),
    asOf: c.timestamps.asOf,
    usdProxyAlignment: null,
    costR: cost.status === "complete" ? cost.costR : null,
    countertrendValidated: false,
    newsPenaltyWindow: regime.classification.news.penalty,
    newsHardBlock: regime.classification.news.hardBlock,
  }, cfg);
}

function compactSnapshot(s: Snapshot): Record<string, unknown> {
  const pick = (r: Record<string, Ind>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status === "ok" ? v.value : null]));
  return { version: s.version, configVersion: s.configVersion, asOf: s.asOf, M1: pick(s.M1), M5: pick(s.M5), M15: pick(s.M15), spread: s.spread.status === "ok" ? s.spread.value : null };
}
