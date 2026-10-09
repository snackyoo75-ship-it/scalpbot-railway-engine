/**
 * Strategy engine (Phase 7). Each strategy returns a typed CANDIDATE or an explicit
 * REJECTION with a full rule-by-rule breakdown. Strategies never publish; every candidate
 * must still pass the global risk, cost, timing gates and the publication validator.
 *
 * Conventions:
 * - Index i = the latest COMPLETED M5 bar; it must close exactly at ctx.asOf.
 * - All distances are in instrument price units. spreadBuffer = spread * spreadBufferMult.
 * - Stops are structural and never tightened to make a setup qualify: when the structural
 *   stop gives a distance outside [0.8, 2.0] × ATR14 the candidate is rejected.
 */
import type { Candle, Series } from "../indicators/core.js";
import { closeTime, confirmedSwings, type Swing } from "../structure/swings.js";
import { fibLevel } from "../structure/levels.js";
import type { Cluster } from "../structure/cluster.js";
import { breakoutRetest, displacement, engulfing, fakeout, liquiditySweep, pinBar, type Pattern } from "../structure/patterns.js";
import { allowedStrategies, DEFAULT_REGIME_CONFIG, type Pair, type Regime, type RegimeConfig } from "../regime/regime.js";

export const STRATEGY_VERSION = "1.0.0";

export type Side = "BUY" | "SELL";
export type StrategyKey = "trend_pullback" | "sweep_reversal" | "orb_retest";
export type RuleResult = { rule: string; pass: boolean; detail: string };

export type StrategyConfig = {
  stopAtrMin: number;
  stopAtrMax: number;
  stopAtrPad: number;
  spreadBufferMult: number;
  minGrossRR: number;
  cooldownMs: number;
  pullbackLookback: number;
  sweepEntryMode: Pattern["entryMode"];
  countertrendSlopeMax: number;
  orWidthAtrMin: number;
  orWidthAtrMax: number;
  regime: RegimeConfig;
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  stopAtrMin: 0.8, stopAtrMax: 2.0, stopAtrPad: 0.2, spreadBufferMult: 1, minGrossRR: 1.5,
  cooldownMs: 15 * 60_000, pullbackLookback: 8, sweepEntryMode: "immediate_on_close",
  countertrendSlopeMax: 0.6, orWidthAtrMin: 1.5, orWidthAtrMax: 6, regime: DEFAULT_REGIME_CONFIG,
};

export type StrategyContext = {
  pair: Pair;
  /** Close time of the latest completed M5 bar. */
  asOf: string;
  m5: Candle[];
  atr14: Series;
  ema20: Series;
  ema50: Series;
  rsi14: Series;
  slope50: number | null;
  regime: Regime;
  m15Bias: "bull" | "bear" | null;
  spread: number | null;
  keyLevels: Cluster[];
  previousDay: { high: number; low: number } | null;
  openingRange: { high: number; low: number; availableAt: string; dayKey: string } | null;
  /** Previously emitted candidates, for cooldown. */
  recent: { pair: Pair; side: Side; time: string }[];
  /** ORB attempts already used: `${dayKey}:${side}`. */
  orbAttempts: string[];
  weakCountertrend?: boolean;
  /** Round-trip cost in price units (spread + commission + slippage estimate). */
  roundTripCost: number | null;
  /** Out-of-sample estimated win rate for TP2; null → net EV unavailable. */
  estimatedWinRate: number | null;
};

export type Candidate = {
  status: "candidate";
  strategy: StrategyKey;
  version: string;
  pair: Pair;
  side: Side;
  regime: Regime;
  triggerCandle: string;
  referencePrice: number;
  structuralInvalidation: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  stopAtr: number;
  targetDistances: { tp1: number; tp2: number };
  grossRR: number;
  netEV: { status: "ok"; perTradeR: number } | { status: "unavailable"; reason: string };
  keyLevelConflicts: Cluster[];
  timestamps: { asOf: string; trigger: string; confirmation: string; levelAvailable?: string };
  entryMode: Pattern["entryMode"];
  rules: RuleResult[];
};
export type Rejection = { status: "rejected"; strategy: StrategyKey; version: string; pair: Pair; side: Side | null; regime: Regime; reason: string; rules: RuleResult[]; asOf: string };
export type StrategyResult = Candidate | Rejection;

class Rules {
  list: RuleResult[] = [];
  check(rule: string, pass: boolean, detail = "") {
    this.list.push({ rule, pass, detail });
    return pass;
  }
  get firstFail() {
    return this.list.find((r) => !r.pass);
  }
}

const num = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

function reject(ctx: StrategyContext, strategy: StrategyKey, side: Side | null, r: Rules): Rejection {
  const f = r.firstFail!;
  return { status: "rejected", strategy, version: STRATEGY_VERSION, pair: ctx.pair, side, regime: ctx.regime, reason: `${f.rule}${f.detail ? `: ${f.detail}` : ""}`, rules: r.list, asOf: ctx.asOf };
}

/** Freshness and input validity shared by all strategies. Returns i or null. */
function baseInputs(ctx: StrategyContext, r: Rules): number | null {
  const i = ctx.m5.length - 1;
  if (!r.check("candles present", i >= 1)) return null;
  const k = ctx.m5[i]!;
  r.check("trigger candle completed", k.complete, k.time);
  r.check("trigger candle is latest closed bar", closeTime(k) === ctx.asOf, `${closeTime(k)} vs ${ctx.asOf}`);
  r.check("series aligned", [ctx.atr14, ctx.ema20, ctx.ema50, ctx.rsi14].every((s) => s.length === ctx.m5.length));
  r.check("ATR14 valid", num(ctx.atr14[i]) && ctx.atr14[i]! > 0);
  r.check("spread valid", num(ctx.spread) && ctx.spread >= 0);
  return r.firstFail ? null : i;
}

function regimeAllows(ctx: StrategyContext, key: "pullback" | "sweep_reversal" | "orb", side: Side, cfg: StrategyConfig, r: Rules) {
  const perms = allowedStrategies(ctx.regime, { openingRangeComplete: !!ctx.openingRange && Date.parse(ctx.openingRange.availableAt) <= Date.parse(ctx.asOf), weakCountertrend: ctx.weakCountertrend }, cfg.regime);
  const want = side === "BUY" ? "long" : "short";
  const p = perms.find((x) => x.strategy === key);
  return r.check("regime permits strategy/direction", !!p && (p.direction === "both" || p.direction === want), `${ctx.regime}`);
}

/** Common candidate validation: stop band, targets, RR, key-level path, cooldown, net EV. */
function finalize(
  ctx: StrategyContext, strategy: StrategyKey, side: Side, i: number, entry: number, invalidation: number, stop: number,
  pat: { barTime: string; confirmationTime: string; entryMode: Pattern["entryMode"] }, r: Rules, cfg: StrategyConfig, levelAvailable?: string,
): StrategyResult {
  const atr = ctx.atr14[i]!;
  const dir = side === "BUY" ? 1 : -1;
  const risk = (entry - stop) * dir;
  r.check("stop on correct side", risk > 0, `risk ${risk}`);
  const stopAtr = risk / atr;
  r.check("stop distance within ATR band", stopAtr >= cfg.stopAtrMin && stopAtr <= cfg.stopAtrMax, `${stopAtr.toFixed(3)} ATR (allowed ${cfg.stopAtrMin}-${cfg.stopAtrMax})`);
  const tp1 = entry + dir * risk;
  const tp2 = entry + dir * 2 * risk;
  const grossRR = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  r.check("gross TP2 reward/risk", grossRR >= cfg.minGrossRR, grossRR.toFixed(2));
  const conflicts = ctx.keyLevels.filter((c) => c.isKey && (dir === 1 ? c.price > entry && c.price <= tp1 : c.price < entry && c.price >= tp1));
  r.check("no qualified opposing key level before TP1", conflicts.length === 0, conflicts.map((c) => c.price.toFixed(5)).join(","));
  const t = Date.parse(ctx.asOf);
  const dup = ctx.recent.find((x) => x.pair === ctx.pair && x.side === side && t - Date.parse(x.time) < cfg.cooldownMs && Date.parse(x.time) <= t);
  r.check("outside duplicate cooldown", !dup, dup?.time ?? "");
  if (r.firstFail) return reject(ctx, strategy, side, r);

  let netEV: Candidate["netEV"];
  if (!num(ctx.roundTripCost)) netEV = { status: "unavailable", reason: "round-trip cost unknown" };
  else if (!num(ctx.estimatedWinRate)) netEV = { status: "unavailable", reason: "no validated win-rate estimate" };
  else {
    const c = ctx.roundTripCost / risk;
    netEV = { status: "ok", perTradeR: ctx.estimatedWinRate * 2 - (1 - ctx.estimatedWinRate) * 1 - c };
  }
  return {
    status: "candidate", strategy, version: STRATEGY_VERSION, pair: ctx.pair, side, regime: ctx.regime,
    triggerCandle: ctx.m5[i]!.time, referencePrice: entry, structuralInvalidation: invalidation, stopLoss: stop, tp1, tp2,
    stopAtr, targetDistances: { tp1: risk, tp2: 2 * risk }, grossRR, netEV, keyLevelConflicts: conflicts,
    timestamps: { asOf: ctx.asOf, trigger: pat.barTime, confirmation: pat.confirmationTime, levelAvailable }, entryMode: pat.entryMode, rules: r.list,
  };
}

/** Impulse leg L→H (BUY) or H→L (SELL) followed by a confirmed pullback swing P. */
function impulseAndPullback(c: Candle[], i: number, side: Side): { L: Swing; H: Swing; P: Swing } | null {
  const sw = confirmedSwings(c, i);
  const pk = side === "BUY" ? "low" : "high";
  const ik = side === "BUY" ? "high" : "low";
  const P = [...sw].reverse().find((s) => s.kind === pk);
  if (!P) return null;
  const H = [...sw].reverse().find((s) => s.kind === ik && s.index < P.index);
  if (!H) return null;
  const L = [...sw].reverse().find((s) => s.kind === pk && s.index < H.index);
  if (!L) return null;
  return { L, H, P };
}

export function trendPullback(ctx: StrategyContext, cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG): StrategyResult {
  const r = new Rules();
  const side: Side | null = ctx.regime === "TREND_UP" ? "BUY" : ctx.regime === "TREND_DOWN" ? "SELL" : null;
  r.check("eligible regime", side !== null, ctx.regime);
  if (!side) return reject(ctx, "trend_pullback", null, r);
  const i = baseInputs(ctx, r);
  if (i === null) return reject(ctx, "trend_pullback", side, r);
  const buy = side === "BUY";
  const c = ctx.m5;
  const atr = ctx.atr14[i]!;
  regimeAllows(ctx, "pullback", side, cfg, r);
  r.check("M15 bias agrees", ctx.m15Bias === (buy ? "bull" : "bear"), String(ctx.m15Bias));
  const from = i - cfg.pullbackLookback + 1;
  const win = Array.from({ length: cfg.pullbackLookback }, (_, k) => from + k).filter((j) => j >= 0);
  const emaOk = win.every((j) => num(ctx.ema20[j]) && num(ctx.ema50[j]));
  r.check("EMA20/EMA50 valid over pullback window", emaOk && win.length === cfg.pullbackLookback);
  if (r.firstFail) return reject(ctx, "trend_pullback", side, r);
  r.check("pulled toward EMA20 within window", win.some((j) => (buy ? c[j]!.low <= ctx.ema20[j]! : c[j]!.high >= ctx.ema20[j]!)));
  const beyond = win.find((j) => (buy ? c[j]!.close < ctx.ema50[j]! : c[j]!.close > ctx.ema50[j]!));
  r.check("no pullback close beyond EMA50", beyond === undefined, beyond !== undefined ? c[beyond]!.time : "");
  const leg = impulseAndPullback(c, i, side);
  r.check("confirmed impulse and pullback swing", !!leg);
  if (!leg) return reject(ctx, "trend_pullback", side, r);
  const ds = { direction: buy ? ("up" as const) : ("down" as const), from: leg.L, to: leg.H };
  const f382 = fibLevel(ds, 0.382);
  const f786 = fibLevel(ds, 0.786);
  const inZone = buy ? leg.P.price <= f382 && leg.P.price > f786 : leg.P.price >= f382 && leg.P.price < f786;
  r.check("retracement in 0.382–0.786 context of last swing", inZone, `P ${leg.P.price} vs 0.382 ${f382.toFixed(5)} / 0.786 ${f786.toFixed(5)}`);
  const ctxP = { c, atr: ctx.atr14 };
  const trig = [engulfing(ctxP, i), pinBar(ctxP, i), displacement(ctxP, i)].find((p) => p?.direction === (buy ? "bull" : "bear")) ?? null;
  r.check("valid trigger pattern", !!trig, trig?.id ?? "none");
  r.check("trigger closes beyond previous candle boundary", buy ? c[i]!.close > c[i - 1]!.high : c[i]!.close < c[i - 1]!.low);
  const r0 = ctx.rsi14[i - 1];
  const r1 = ctx.rsi14[i];
  r.check("RSI14 valid", num(r0) && num(r1));
  r.check(buy ? "RSI14 > 50 and rising" : "RSI14 < 50 and falling", num(r0) && num(r1) && (buy ? r1 > 50 && r1 > r0 : r1 < 50 && r1 < r0), `${r0} → ${r1}`);
  if (r.firstFail) return reject(ctx, "trend_pullback", side, r);
  const buf = ctx.spread! * cfg.spreadBufferMult;
  const stop = buy ? leg.P.price - cfg.stopAtrPad * atr - buf : leg.P.price + cfg.stopAtrPad * atr + buf;
  return finalize(ctx, "trend_pullback", side, i, c[i]!.close, leg.P.price, stop, trig!, r, cfg, leg.P.availableAt);
}

export function sweepReversal(ctx: StrategyContext, cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG): StrategyResult {
  const r = new Rules();
  const i = baseInputs(ctx, r);
  if (i === null) return reject(ctx, "sweep_reversal", null, r);
  const c = ctx.m5;
  const atr = ctx.atr14[i]!;
  const pc = { c, atr: ctx.atr14 };
  let found: { p: Pattern; level: Cluster } | null = null;
  for (const lv of ctx.keyLevels.filter((x) => x.isKey && Date.parse(x.availableAt) <= Date.parse(ctx.asOf))) {
    const p = liquiditySweep(pc, i, lv.price, "sell") ?? liquiditySweep(pc, i, lv.price, "buy") ?? fakeout(pc, i, lv.price);
    if (p) {
      found = { p, level: lv };
      break;
    }
  }
  r.check("sweep or fakeout at qualified key level", !!found);
  if (!found) return reject(ctx, "sweep_reversal", null, r);
  const { p, level } = found;
  const side: Side = p.direction === "bull" ? "BUY" : "SELL";
  regimeAllows(ctx, "sweep_reversal", side, cfg, r);
  r.check("confirmation candle fully closed", p.confirmationTime === ctx.asOf);
  r.check("entry mode matches configuration", p.entryMode === cfg.sweepEntryMode || p.id === "fakeout", `${p.entryMode} vs ${cfg.sweepEntryMode}`);
  const s = ctx.slope50;
  r.check("slope50 valid", num(s));
  const against = num(s) && (side === "SELL" ? s >= cfg.countertrendSlopeMax : s <= -cfg.countertrendSlopeMax);
  const tol = 0.15 * atr;
  const atPdExtreme = !!ctx.previousDay && (side === "SELL" ? Math.abs(level.price - ctx.previousDay.high) <= tol : Math.abs(level.price - ctx.previousDay.low) <= tol);
  r.check("countertrend slope filter", !against || atPdExtreme, against ? (atPdExtreme ? "exception: previous-day extreme" : `|slope50| ${s} >= ${cfg.countertrendSlopeMax}`) : "");
  const barIdx = c.findIndex((k) => k.time === p.barTime);
  const inval = p.invalidation;
  let broken = false;
  for (let j = barIdx + 1; j <= i; j++) if (side === "SELL" ? c[j]!.high > inval : c[j]!.low < inval) broken = true;
  r.check("setup not invalidated", !broken);
  if (r.firstFail) return reject(ctx, "sweep_reversal", side, r);
  const buf = ctx.spread! * cfg.spreadBufferMult;
  const stop = side === "SELL" ? inval + cfg.stopAtrPad * atr + buf : inval - cfg.stopAtrPad * atr - buf;
  return finalize(ctx, "sweep_reversal", side, i, c[i]!.close, inval, stop, p, r, cfg, level.availableAt);
}

/**
 * ORB retest. Stop = retest extreme (structural) beyond by the spread buffer only. The
 * OR boundary is NOT substituted to get a better R; if the structural stop fails the
 * ATR band the setup is rejected.
 */
export function orbRetest(ctx: StrategyContext, cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG): StrategyResult {
  const r = new Rules();
  const i = baseInputs(ctx, r);
  if (i === null) return reject(ctx, "orb_retest", null, r);
  const or = ctx.openingRange;
  r.check("opening range fully formed", !!or && Date.parse(or.availableAt) <= Date.parse(ctx.asOf));
  if (!or) return reject(ctx, "orb_retest", null, r);
  const atr = ctx.atr14[i]!;
  const w = (or.high - or.low) / atr;
  r.check("OR width / ATR14 within band", w >= cfg.orWidthAtrMin && w <= cfg.orWidthAtrMax, w.toFixed(3));
  const pc = { c: ctx.m5, atr: ctx.atr14 };
  const up = breakoutRetest(pc, i, or.high);
  const dn = up?.direction === "bull" ? null : breakoutRetest(pc, i, or.low);
  const p = up?.direction === "bull" ? up : dn?.direction === "bear" ? dn : null;
  r.check("displacement breakout + valid retest within 6 bars", !!p);
  if (r.firstFail || !p) return reject(ctx, "orb_retest", p ? (p.direction === "bull" ? "BUY" : "SELL") : null, r);
  const side: Side = p.direction === "bull" ? "BUY" : "SELL";
  r.check("breakout after opening range completed", Date.parse(p.barTime) >= Date.parse(or.availableAt));
  r.check("one attempt per direction per day", !ctx.orbAttempts.includes(`${or.dayKey}:${side}`), `${or.dayKey}:${side}`);
  regimeAllows(ctx, "orb", side, cfg, r);
  if (r.firstFail) return reject(ctx, "orb_retest", side, r);
  const buf = ctx.spread! * cfg.spreadBufferMult;
  const stop = side === "BUY" ? p.invalidation - buf : p.invalidation + buf;
  return finalize(ctx, "orb_retest", side, i, ctx.m5[i]!.close, p.invalidation, stop, p, r, cfg, or.availableAt);
}

export function runStrategies(ctx: StrategyContext, cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG): StrategyResult[] {
  return [trendPullback(ctx, cfg), sweepReversal(ctx, cfg), orbRetest(ctx, cfg)];
}
