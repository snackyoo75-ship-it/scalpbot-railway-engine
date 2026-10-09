/**
 * Phase 9 — risk, trade management and entry timing.
 * Pure, deterministic functions. No order placement. No invented broker specs.
 */
export const RISK_VERSION = "1.0.0";

export type Side = "BUY" | "SELL";
export type PriceBasis = "mid" | "bid" | "ask";
export type Fail = { ok: false; reasons: string[] };
export type Ok<T> = { ok: true; value: T };
export type Res<T> = Ok<T> | Fail;
const fail = (...reasons: string[]): Fail => ({ ok: false, reasons });
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/* ---------------- A. Price convention ---------------- */
export type Quote = { bid: number; ask: number; time: string };
export type PriceConvention = {
  referenceSource: string;
  referenceTime: string;
  referenceBasis: PriceBasis;
  /** BUY executes at ask, SELL executes at bid; stops/targets for BUY trigger on bid, SELL on ask. */
  executableSide: { entry: "ask" | "bid"; exit: "bid" | "ask" };
  spreadAtAnalysis: number;
  spreadAtPublication: number | null;
};

export function executableConvention(side: Side) {
  return side === "BUY" ? { entry: "ask", exit: "bid" } as const : { entry: "bid", exit: "ask" } as const;
}

/** Convert a mid-based level to the executable entry price for the side. */
export function midToExecutableEntry(side: Side, mid: number, spread: number): number {
  return side === "BUY" ? mid + spread / 2 : mid - spread / 2;
}

/* ---------------- B. Stop and target rules ---------------- */
export type LevelConfig = { tp1R: number; tp2R: number; minStopAtr: number; maxStopAtr: number; minRR: number };
export const DEFAULT_LEVEL_CONFIG: LevelConfig = { tp1R: 1, tp2R: 2, minStopAtr: 0.8, maxStopAtr: 2.0, minRR: 1.5 };

export type Levels = { side: Side; entry: number; sl: number; tp1: number; tp2: number; r: number; rr: number };

/**
 * Builds levels from the executable entry and the *structural* stop. Never moves the stop.
 * `blockingLevels` = key levels considered relevant to the path.
 * `spread` is subtracted from exits because BUY exits fill at bid (and SELL at ask).
 */
export function buildLevels(input: {
  side: Side; entry: number; structuralStop: number; atr14: number | null; spread: number;
  blockingLevels?: number[]; cfg?: LevelConfig;
}): Res<Levels> {
  const cfg = input.cfg ?? DEFAULT_LEVEL_CONFIG;
  const { side, entry, structuralStop: sl, atr14, spread } = input;
  if (!fin(entry) || !fin(sl) || entry <= 0 || sl <= 0) return fail("invalid_price");
  if (!fin(atr14) || atr14 <= 0) return fail("atr_unavailable");
  if (!fin(spread) || spread < 0) return fail("invalid_spread");
  const dir = side === "BUY" ? 1 : -1;
  if ((entry - sl) * dir <= 0) return fail(side === "BUY" ? "sl_not_below_entry" : "sl_not_above_entry");
  const r = Math.abs(entry - sl);
  const reasons: string[] = [];
  const atrMult = r / atr14;
  if (atrMult < cfg.minStopAtr - 1e-12) reasons.push("stop_too_tight_vs_atr");
  if (atrMult > cfg.maxStopAtr + 1e-12) reasons.push("stop_too_wide_vs_atr");
  const tp1 = entry + dir * cfg.tp1R * r;
  const tp2 = entry + dir * cfg.tp2R * r;
  const rr = Math.abs(tp2 - entry) / r;
  if (rr < cfg.minRR) reasons.push("rr_below_min");
  for (const lvl of input.blockingLevels ?? []) {
    if (!fin(lvl)) continue;
    const d = (lvl - entry) * dir;
    if (d > 0 && d < r) { reasons.push("key_level_blocks_tp1"); break; }
  }
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, value: { side, entry, sl, tp1, tp2, r, rr } };
}

/** Net reward/risk once the exit-side spread is paid (BUY exits at bid). */
export function netRewardRisk(levels: Levels, spread: number, targetR = 2): number {
  return (targetR * levels.r - spread) / (levels.r + spread);
}

/* ---------------- B. Management policy (intended, for backtests & alerts) ---------------- */
export type MgmtConfig = { partialFraction: number; trailAtr: number; minTrailStepAtr: number; timeStopMin: number; timeStopR: number };
export const DEFAULT_MGMT: MgmtConfig = { partialFraction: 0.5, trailAtr: 1, minTrailStepAtr: 0.3, timeStopMin: 45, timeStopR: 0.5 };

export type MgmtState = { side: Side; entry: number; r: number; stop: number; tp1Hit: boolean; openedAt: string };
export type MgmtAction =
  | { type: "PARTIAL_AND_BREAKEVEN"; fraction: number; newStop: number }
  | { type: "TRAIL"; newStop: number }
  | { type: "TIME_STOP_ALERT"; minutesOpen: number; currentR: number };

/** Evaluate one completed M5 close. Stops only ever tighten. Alerts are for manual decision. */
export function manageOnM5Close(s: MgmtState, bar: { close: number; high: number; low: number; closeTime: string; closed: boolean }, atr14: number | null, cfg = DEFAULT_MGMT): { state: MgmtState; actions: MgmtAction[] } {
  if (!bar.closed) return { state: s, actions: [] };
  const dir = s.side === "BUY" ? 1 : -1;
  const actions: MgmtAction[] = [];
  let st = { ...s };
  const tp1 = s.entry + dir * s.r;
  const reached = s.side === "BUY" ? bar.high >= tp1 : bar.low <= tp1;
  if (!st.tp1Hit && reached) {
    const be = (st.entry - st.stop) * dir > 0 ? st.entry : st.stop;
    st = { ...st, tp1Hit: true, stop: be };
    actions.push({ type: "PARTIAL_AND_BREAKEVEN", fraction: cfg.partialFraction, newStop: be });
  }
  if (st.tp1Hit && fin(atr14) && atr14 > 0) {
    const cand = bar.close - dir * cfg.trailAtr * atr14;
    const improvement = (cand - st.stop) * dir;
    if (improvement >= cfg.minTrailStepAtr * atr14 - 1e-12) {
      st = { ...st, stop: cand };
      actions.push({ type: "TRAIL", newStop: cand });
    }
  }
  const mins = (Date.parse(bar.closeTime) - Date.parse(s.openedAt)) / 60000;
  const curR = ((bar.close - s.entry) * dir) / s.r;
  if (mins > cfg.timeStopMin && curR < cfg.timeStopR) actions.push({ type: "TIME_STOP_ALERT", minutesOpen: mins, currentR: curR });
  return { state: st, actions };
}

/* ---------------- D. Latency and max-chase ---------------- */
export type TimingEvents = { requestStart: string; analysisDone: string; publishedAt?: string; deliveredAt?: string };

/** Measured elapsed seconds between recorded events (never negative / never double counted). */
export function measuredLatency(ev: TimingEvents) {
  const t = (x?: string) => (x ? Date.parse(x) : NaN);
  const seg = (a?: string, b?: string) => { const d = (t(b) - t(a)) / 1000; return fin(d) && d >= 0 ? d : null; };
  return { analysis: seg(ev.requestStart, ev.analysisDone), publication: seg(ev.analysisDone, ev.publishedAt), delivery: seg(ev.publishedAt, ev.deliveredAt) };
}

/** L_total = elapsed since reference quote time (measured) + estimated *remaining* future delay. */
export function totalLatency(referenceTime: string, now: string, remainingDelaySec: number): number | null {
  const elapsed = (Date.parse(now) - Date.parse(referenceTime)) / 1000;
  if (!fin(elapsed) || elapsed < 0 || !fin(remainingDelaySec) || remainingDelaySec < 0) return null;
  return elapsed + remainingDelaySec;
}

export function predictedMoveQuantile(sigmaM1: number | null, lTotalSec: number | null, referencePrice: number): number | null {
  if (!fin(sigmaM1) || sigmaM1 < 0 || !fin(lTotalSec) || lTotalSec < 0 || !fin(referencePrice) || referencePrice <= 0) return null;
  return 1.28 * (sigmaM1 / Math.sqrt(60)) * Math.sqrt(lTotalSec) * referencePrice;
}

/** Hard cap is strategy-specific & validated; predicted move never enlarges it. */
export function permittedDeviation(capAtr: number | null, atr14: number | null): number | null {
  if (!fin(capAtr) || capAtr <= 0 || !fin(atr14) || atr14 <= 0) return null;
  return capAtr * atr14;
}

/* ---------------- C. Entry timing & revalidation ---------------- */
export type EntryPlan = {
  side: Side; entryTime: string; expiresAt: string; zoneLow: number; zoneHigh: number;
  maxDeviation: number; invalidationLevel: number; proposedEntry: number;
};
export type Revalidation = { status: "VALID"; plan: EntryPlan } | { status: "NO_VALID_SETUP"; reasons: string[] };

export function planEntry(input: {
  side: Side; proposedEntry: number; invalidationLevel: number; now: string;
  nextOpportunity: string; windowSec: number; expectedDelaySec: number | null; minLeadSec: number;
  capAtr: number | null; atr14: number | null;
}): Revalidation {
  const r: string[] = [];
  const dev = permittedDeviation(input.capAtr, input.atr14);
  if (dev == null) r.push("deviation_cap_unavailable");
  if (!fin(input.expectedDelaySec)) r.push("latency_stats_unavailable");
  const now = Date.parse(input.now), opp = Date.parse(input.nextOpportunity);
  if (!fin(now) || !fin(opp)) r.push("invalid_time");
  else if (fin(input.expectedDelaySec) && opp - now < (input.expectedDelaySec + input.minLeadSec) * 1000) r.push("insufficient_lead_time");
  if (r.length || dev == null) return { status: "NO_VALID_SETUP", reasons: r };
  return { status: "VALID", plan: {
    side: input.side, entryTime: new Date(opp).toISOString(), expiresAt: new Date(opp + input.windowSec * 1000).toISOString(),
    zoneLow: input.proposedEntry - dev, zoneHigh: input.proposedEntry + dev, maxDeviation: dev,
    invalidationLevel: input.invalidationLevel, proposedEntry: input.proposedEntry,
  } };
}

/** Immediately before publication: latest completed candle + live quote. */
export function revalidate(plan: EntryPlan, input: {
  now: string; quote: Quote | null; maxQuoteAgeSec: number;
  latestClosed: { closeTime: string; low: number; high: number; closed: boolean } | null;
  alreadyPublishedKeys?: Set<string>; publicationKey: string;
}): Revalidation {
  const r: string[] = [];
  const now = Date.parse(input.now);
  if (now > Date.parse(plan.expiresAt)) r.push("entry_expired");
  if (input.alreadyPublishedKeys?.has(input.publicationKey)) r.push("duplicate_publication");
  const q = input.quote;
  if (!q || !fin(q.bid) || !fin(q.ask) || q.ask < q.bid) r.push("quote_unavailable");
  else {
    const age = (now - Date.parse(q.time)) / 1000;
    if (!fin(age) || age < 0 || age > input.maxQuoteAgeSec) r.push("stale_quote");
    const px = plan.side === "BUY" ? q.ask : q.bid;
    if (Math.abs(px - plan.proposedEntry) > plan.maxDeviation) r.push("price_runaway");
    const exitPx = plan.side === "BUY" ? q.bid : q.ask;
    if (plan.side === "BUY" ? exitPx <= plan.invalidationLevel : exitPx >= plan.invalidationLevel) r.push("setup_invalidated");
  }
  const c = input.latestClosed;
  if (!c || !c.closed) r.push("no_closed_candle");
  else if (plan.side === "BUY" ? c.low <= plan.invalidationLevel : c.high >= plan.invalidationLevel) r.push("setup_invalidated");
  const reasons = [...new Set(r)];
  return reasons.length ? { status: "NO_VALID_SETUP", reasons } : { status: "VALID", plan };
}

/* ---------------- E. Risk sizing ---------------- */
export type BrokerSpec = {
  verified: boolean; contractSize: number; minVolume: number; volumeStep: number;
  tickSize: number; tickValue: number; /** tick value in account currency per 1.0 lot */
  accountCurrency: string;
};

export function sizePosition(input: {
  balance: number | null; balanceVerified: boolean; riskFraction: number | null;
  stopDistance: number; spec: BrokerSpec | null; demoOnly: boolean;
}): Res<{ riskCash: number; riskPerLot: number; volume: number; actualRiskCash: number; demoOnly: true }> {
  const s = input.spec;
  if (!input.demoOnly) return fail("production_sizing_disabled");
  if (!s || !s.verified) return fail("broker_spec_unverified");
  if (!input.balanceVerified || !fin(input.balance) || input.balance <= 0) return fail("balance_unverified");
  if (!fin(input.riskFraction) || input.riskFraction <= 0 || input.riskFraction > 0.05) return fail("invalid_risk_fraction");
  if (!fin(s.tickSize) || s.tickSize <= 0 || !fin(s.tickValue) || s.tickValue <= 0) return fail("invalid_tick_economics");
  if (!fin(s.volumeStep) || s.volumeStep <= 0 || !fin(s.minVolume) || s.minVolume <= 0) return fail("invalid_volume_spec");
  if (!fin(input.stopDistance) || input.stopDistance <= 0) return fail("invalid_stop_distance");
  const riskCash = input.balance * input.riskFraction;
  const riskPerLot = (input.stopDistance / s.tickSize) * s.tickValue;
  const raw = riskCash / riskPerLot;
  const volume = Math.floor(raw / s.volumeStep + 1e-9) * s.volumeStep;
  const v = Number(volume.toFixed(8));
  if (v < s.minVolume) return fail("below_min_volume");
  return { ok: true, value: { riskCash, riskPerLot, volume: v, actualRiskCash: v * riskPerLot, demoOnly: true } };
}

/** EURUSD-style tick value: quote-currency value converted to account currency. Rate must be supplied. */
export function tickValueFromQuote(contractSize: number, tickSize: number, quoteToAccountRate: number | null): number | null {
  if (!fin(contractSize) || contractSize <= 0 || !fin(tickSize) || tickSize <= 0 || !fin(quoteToAccountRate) || quoteToAccountRate <= 0) return null;
  return contractSize * tickSize * quoteToAccountRate;
}

/* ---------------- F. Account and trade limits ---------------- */
export type Limits = { maxOpen: number; maxConsecLosses: number; maxPerDay: number; maxPerSession: number; dailyLossFraction: number; cooldownMin: number };
export const DEFAULT_LIMITS: Limits = { maxOpen: 2, maxConsecLosses: 3, maxPerDay: 8, maxPerSession: 3, dailyLossFraction: 0.03, cooldownMin: 15 };
export type AccountState = {
  killSwitch: boolean; openTrades: number; consecutiveNetLosses: number; signalsToday: number; signalsThisSession: number;
  dailyNetPnl: number; dayStartBalance: number | null; lastSameSignalAt: string | null;
};

export function checkLimits(acct: AccountState | null, limits: Limits | null, now: string): Res<true> {
  if (!acct) return fail("account_data_missing");
  if (!limits) return fail("limits_missing");
  const r: string[] = [];
  if (acct.killSwitch) r.push("kill_switch_active");
  if (acct.openTrades >= limits.maxOpen) r.push("max_open_trades");
  if (acct.consecutiveNetLosses >= limits.maxConsecLosses) r.push("loss_streak_pause");
  if (acct.signalsToday >= limits.maxPerDay) r.push("daily_signal_cap");
  if (acct.signalsThisSession >= limits.maxPerSession) r.push("session_signal_cap");
  if (!fin(acct.dayStartBalance) || acct.dayStartBalance <= 0) r.push("account_data_missing");
  else if (acct.dailyNetPnl <= -limits.dailyLossFraction * acct.dayStartBalance) r.push("daily_loss_stop");
  if (acct.lastSameSignalAt && Date.parse(now) - Date.parse(acct.lastSameSignalAt) < limits.cooldownMin * 60000) r.push("same_direction_cooldown");
  return r.length ? { ok: false, reasons: r } : { ok: true, value: true };
}

/* ---------------- G. Manual ledger ---------------- */
export type Fill = { kind: "ENTRY" | "EXIT"; price: number; volume: number; time: string; commission: number };
export type LedgerTrade = { side: Side; fills: Fill[]; swaps: number; valuePerPriceUnitPerLot: number; riskBasisCash: number | null };

/** Authoritative realized P&L from recorded fills & costs. */
export function reconcileLedger(t: LedgerTrade): Res<{ grossPnl: number; costs: number; netPnl: number; openVolume: number; rMultiple: number | null; riskBasis: string }> {
  const entries = t.fills.filter((f) => f.kind === "ENTRY");
  const exits = t.fills.filter((f) => f.kind === "EXIT");
  if (!entries.length) return fail("no_entry_fill");
  if (t.fills.some((f) => !fin(f.price) || !fin(f.volume) || f.volume <= 0 || !fin(f.commission))) return fail("invalid_fill");
  const inVol = entries.reduce((a, f) => a + f.volume, 0);
  const outVol = exits.reduce((a, f) => a + f.volume, 0);
  if (outVol > inVol + 1e-9) return fail("exit_exceeds_entry");
  const avgIn = entries.reduce((a, f) => a + f.price * f.volume, 0) / inVol;
  const dir = t.side === "BUY" ? 1 : -1;
  const grossPnl = exits.reduce((a, f) => a + (f.price - avgIn) * dir * f.volume * t.valuePerPriceUnitPerLot, 0);
  const costs = t.fills.reduce((a, f) => a + f.commission, 0) - t.swaps;
  const netPnl = grossPnl - costs;
  const rMultiple = fin(t.riskBasisCash) && t.riskBasisCash > 0 ? netPnl / t.riskBasisCash : null;
  return { ok: true, value: { grossPnl, costs, netPnl, openVolume: Number((inVol - outVol).toFixed(8)), rMultiple, riskBasis: rMultiple == null ? "unavailable" : "initial_planned_risk_cash" } };
}
