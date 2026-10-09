/**
 * Phase 10 — backtesting & statistical validation. Pure and deterministic.
 * Passing tests here proves the arithmetic, never strategy profitability.
 */
export const BACKTEST_VERSION = "1.0.0";
export type Side = "BUY" | "SELL";
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/* ---------- 1. Data quality ---------- */
export type Bar = { time: string; open: number; high: number; low: number; close: number; spread?: number };
export type Exclusion = { time: string; reason: "duplicate" | "invalid_ohlc" | "misaligned" | "stale" };
export type DatasetIdentity = { source: string; retrievedAt: string; pair: string; timeframe: string; timezone: "UTC"; synthetic: boolean };

export function qualityCheck(bars: Bar[], tfSec: number, staleRun = 10) {
  const exclusions: Exclusion[] = [];
  const gaps: { from: string; to: string; missing: number }[] = [];
  const seen = new Set<number>();
  const clean: Bar[] = [];
  let run = 0;
  for (const b of [...bars].sort((a, c) => Date.parse(a.time) - Date.parse(c.time))) {
    const t = Date.parse(b.time);
    if (seen.has(t)) { exclusions.push({ time: b.time, reason: "duplicate" }); continue; }
    seen.add(t);
    if (!fin(t) || (t / 1000) % tfSec !== 0) { exclusions.push({ time: b.time, reason: "misaligned" }); continue; }
    const ok = [b.open, b.high, b.low, b.close].every(fin) && b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close) && b.low > 0;
    if (!ok) { exclusions.push({ time: b.time, reason: "invalid_ohlc" }); continue; }
    const prev = clean[clean.length - 1];
    if (prev) {
      const missing = (t - Date.parse(prev.time)) / 1000 / tfSec - 1;
      if (missing > 0) gaps.push({ from: prev.time, to: b.time, missing });
      const flat = b.open === b.high && b.high === b.low && b.low === b.close && b.close === prev.close;
      run = flat ? run + 1 : 0;
      if (run >= staleRun) { exclusions.push({ time: b.time, reason: "stale" }); continue; }
    }
    clean.push(b);
  }
  return { clean, exclusions, gaps };
}

/** Lookahead guard: only bars whose close time <= decision time. */
export function availableAt<T extends { time: string }>(bars: T[], tfSec: number, decisionTime: string): T[] {
  const d = Date.parse(decisionTime);
  return bars.filter((b) => Date.parse(b.time) + tfSec * 1000 <= d);
}

/* ---------- 2/3. Fill & management simulation ---------- */
export type SimConfig = {
  slippageSpreadFrac: number; commissionR: number; partialFrac: number; trailAtr: number;
  minTrailStepAtr: number; timeStopMin: number; timeStopR: number; sameBarPolicy: "SL_FIRST" | "TP_FIRST";
};
export const DEFAULT_SIM: SimConfig = { slippageSpreadFrac: 0.1, commissionR: 0, partialFrac: 0.5, trailAtr: 1, minTrailStepAtr: 0.3, timeStopMin: 45, timeStopR: 0.5, sameBarPolicy: "SL_FIRST" };

export type TradeSpec = { side: Side; decisionTime: string; delaySec: number; entryRef: number; sl: number; tp1: number; tp2: number; atr: number };
export type SimTrade = { status: "FILLED"; netR: number; grossR: number; costR: number; mae: number; mfe: number; ambiguousBars: number; entryTime: string; exitTime: string; exitReason: string }
  | { status: "NOT_FILLED"; reason: string };

/**
 * Bars are mid M5 with spread (bid=mid-s/2, ask=mid+s/2). Entry happens at the open of the first
 * bar starting at/after decision+delay — never at a price that existed before the decision.
 * Spread/slippage are applied once at execution prices; commission once per R.
 */
export function simulateTrade(t: TradeSpec, bars: Bar[], tfSec: number, cfg = DEFAULT_SIM): SimTrade {
  const start = Date.parse(t.decisionTime) + t.delaySec * 1000;
  const i0 = bars.findIndex((b) => Date.parse(b.time) >= start);
  if (i0 < 0) return { status: "NOT_FILLED", reason: "no_bar_after_delay" };
  const dir = t.side === "BUY" ? 1 : -1;
  const b0 = bars[i0]!;
  const sp = (b: Bar) => (fin(b.spread) ? b.spread : 0);
  const entry = b0.open + dir * (sp(b0) / 2 + cfg.slippageSpreadFrac * sp(b0));
  const r = Math.abs(t.entryRef - t.sl);
  if (!(r > 0) || (t.sl - entry) * dir >= 0) return { status: "NOT_FILLED", reason: "invalid_after_delay" };
  let stop = t.sl, open = 1, realized = 0, tp1Hit = false, mae = 0, mfe = 0, amb = 0, fills = 1;
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i]!;
    // executable-side extremes (BUY exits on bid)
    const hi = b.high - dir * sp(b) / 2, lo = b.low - dir * sp(b) / 2;
    const adverse = dir > 0 ? lo : hi, favorable = dir > 0 ? hi : lo;
    mae = Math.min(mae, ((adverse - entry) * dir) / r);
    mfe = Math.max(mfe, ((favorable - entry) * dir) / r);
    const slHit = (adverse - stop) * dir <= 0;
    const tpTarget = tp1Hit ? t.tp2 : t.tp1;
    const tpHit = (favorable - tpTarget) * dir >= 0;
    if (slHit && tpHit) amb++;
    const slFirst = slHit && (!tpHit || cfg.sameBarPolicy === "SL_FIRST");
    // levels are executable-side (bid for BUY exits); only slippage is added here, spread already in trigger
    const close = (fraction: number, level: number, reason: string) => {
      const px = level - dir * cfg.slippageSpreadFrac * sp(b);
      realized += fraction * ((px - entry) * dir) / r; open -= fraction; fills++;
      return reason;
    };
    if (slFirst) { close(open, stop, tp1Hit ? "trail_or_be" : "stop"); return done("stop"); }
    if (tpHit) {
      if (!tp1Hit) {
        close(cfg.partialFrac, t.tp1, "tp1"); tp1Hit = true;
        if ((entry - stop) * dir > 0) stop = entry;
        if (cfg.sameBarPolicy === "SL_FIRST" && (adverse - stop) * dir <= 0) { amb++; close(open, stop, "be"); return done("be_same_bar"); }
      } else { close(open, t.tp2, "tp2"); return done("tp2"); }
    }
    const closeBid = b.close - dir * sp(b) / 2;
    if (tp1Hit) {
      const cand = closeBid - dir * cfg.trailAtr * t.atr;
      if ((cand - stop) * dir >= cfg.minTrailStepAtr * t.atr - 1e-12) stop = cand;
    }
    const mins = (Date.parse(b.time) + tfSec * 1000 - Date.parse(b0.time)) / 60000;
    const curR = ((closeBid - entry) * dir) / r;
    if (!tp1Hit && mins > cfg.timeStopMin && curR < cfg.timeStopR) { close(open, closeBid, "time"); return done("time_stop"); }
    function done(reason: string): SimTrade {
      const costR = fills * cfg.commissionR;
      return { status: "FILLED", grossR: realized, costR, netR: realized - costR, mae, mfe, ambiguousBars: amb, entryTime: b0.time, exitTime: b.time, exitReason: reason };
    }
  }
  return { status: "NOT_FILLED", reason: "unresolved_at_data_end" };
}

/* ---------- 4. Partitions ---------- */
export function chronologicalSplit<T extends { time: string }>(rows: T[], trainFrac = 0.7) {
  const s = [...rows].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const k = Math.floor(s.length * trainFrac);
  const train = s.slice(0, k), test = s.slice(k);
  const bounds = (x: T[]) => ({ count: x.length, from: x[0]?.time ?? null, to: x[x.length - 1]?.time ?? null });
  return { train, test, boundaries: { train: bounds(train), test: bounds(test) } };
}

export function walkForwardFolds(n: number, folds: number, minTrain: number) {
  const out: { trainEnd: number; valStart: number; valEnd: number }[] = [];
  const size = Math.floor((n - minTrain) / folds);
  if (size <= 0) return out;
  for (let f = 0; f < folds; f++) { const vs = minTrain + f * size; out.push({ trainEnd: vs, valStart: vs, valEnd: vs + size }); }
  return out;
}

/* ---------- 5. Metrics ---------- */
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => { if (x.length < 2) return NaN; const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); };

export function wilson(wins: number, n: number, z = 1.96) {
  if (n <= 0) return null;
  const p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { low: (c - m) / d, high: (c + m) / d };
}

/** t critical (two-sided 95%), small-df table then normal approx. */
export function tCrit(df: number) {
  const t = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  return df <= 30 ? t[df - 1]! : 1.96 + 2.4 / df;
}

export function maxDrawdownR(rs: number[]) { let peak = 0, cum = 0, dd = 0; for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); } return dd; }

export function metrics(rs: number[], rejections: Record<string, number> = {}) {
  const n = rs.length;
  if (n === 0) return { status: "INSUFFICIENT_DATA" as const, n, rejections };
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r < 0);
  const m = mean(rs), s = sd(rs);
  const half = n > 1 && fin(s) ? tCrit(n - 1) * s / Math.sqrt(n) : NaN;
  const gl = -losses.reduce((a, b) => a + b, 0);
  let streak = 0, longest = 0; for (const r of rs) { streak = r < 0 ? streak + 1 : 0; longest = Math.max(longest, streak); }
  return {
    status: "OK" as const, n, winRate: wins.length / n, winRateCI: wilson(wins.length, n),
    meanR: m, meanRCI: fin(half) ? { low: m - half, high: m + half } : null,
    avgWinR: wins.length ? mean(wins) : null, avgLossR: losses.length ? mean(losses) : null,
    profitFactor: gl > 0 ? wins.reduce((a, b) => a + b, 0) / gl : null, sdR: fin(s) ? s : null,
    sqn: fin(s) && s > 0 ? Math.sqrt(n) * m / s : null, maxDrawdownR: maxDrawdownR(rs), longestLosingStreak: longest,
    netExpectancyR: m, rejections,
  };
}

/* ---------- 6. Block bootstrap (seeded) ---------- */
export function mulberry32(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;

export function blockBootstrap(rs: number[], opts: { block?: number; resamples?: number; seed?: number; ruinDrawdownR?: number } = {}) {
  const block = opts.block ?? 5, B = opts.resamples ?? 10000, ruin = opts.ruinDrawdownR ?? 10;
  if (rs.length < block * 2) return { status: "INSUFFICIENT_DATA" as const };
  const rnd = mulberry32(opts.seed ?? 42);
  const cums: number[] = [], dds: number[] = [];
  let over = 0;
  for (let b = 0; b < B; b++) {
    const path: number[] = [];
    while (path.length < rs.length) { const st = Math.floor(rnd() * (rs.length - block + 1)); for (let j = 0; j < block && path.length < rs.length; j++) path.push(rs[st + j]!); }
    cums.push(path.reduce((a, c) => a + c, 0));
    const dd = maxDrawdownR(path); dds.push(dd); if (dd > ruin) over++;
  }
  cums.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  return { status: "OK" as const, block, resamples: B, ruinDrawdownR: ruin, medianCumR: q(cums, 0.5), p5CumR: q(cums, 0.05),
    drawdown: { p50: q(dds, 0.5), p95: q(dds, 0.95), p99: q(dds, 0.99) }, probDrawdownExceedsRuin: over / B,
    caveat: "Depends on historical representativeness; not a guarantee of future outcomes." };
}

/* ---------- 7. Multiple testing ---------- */
export type Variant = { id: string; params: Record<string, number>; tStat: number | null };
export const harveyThreshold = (k: number) => (k >= 1 ? Math.sqrt(2 * Math.log(k)) + 1 : NaN);
export function multipleTestingDiagnostic(log: Variant[]) {
  const k = log.length, thr = harveyThreshold(k);
  return { variantsTested: k, threshold: thr, passing: log.filter((v) => fin(v.tStat) && v.tStat >= thr).map((v) => v.id), note: "Diagnostic only, not proof of significance." };
}
/** Neighbours ±20% (continuous) must keep mean R sign and ≥50% of the centre's mean R. */
export function stability(center: number, neighbours: number[]) {
  if (!fin(center) || neighbours.length === 0 || !neighbours.every(fin)) return { stable: false, reason: "insufficient_neighbours" };
  const bad = neighbours.filter((n) => center > 0 ? n < 0.5 * center : true);
  return bad.length ? { stable: false, reason: "unstable_neighbourhood", unstableCount: bad.length } : { stable: true, reason: "ok" };
}

/* ---------- 8. MAE/MFE & CUSUM ---------- */
export function excursionSummary(trades: { netR: number; mae: number; mfe: number }[]) {
  const grp = (x: typeof trades) => x.length ? { n: x.length, meanMAE: mean(x.map((t) => t.mae)), meanMFE: mean(x.map((t) => t.mfe)) } : null;
  return { winners: grp(trades.filter((t) => t.netR > 0)), losers: grp(trades.filter((t) => t.netR <= 0)) };
}
export function cusum(rs: number[], mu = 0.15, k = 0.25, h = 3) {
  let s = 0; const path: number[] = []; let alertAt: number | null = null;
  rs.forEach((r, i) => { s = Math.max(0, s + (mu - r) - k); path.push(s); if (alertAt == null && s >= h) alertAt = i; });
  return { path, alertAt, monitoringOnly: true };
}

/* ---------- 9/10. Eligibility & report ---------- */
export type Gates = { minTrades: number; minMeanR: number; minPF: number; maxDD: number };
export const DEFAULT_GATES: Gates = { minTrades: 100, minMeanR: 0.15, minPF: 1.3, maxDD: 10 };

export function eligibility(oosR: number[], stable: boolean | null, g = DEFAULT_GATES) {
  const m = metrics(oosR);
  if (m.status !== "OK" || m.n < g.minTrades) return { status: "INSUFFICIENT_DATA" as const, failed: ["min_trades"] };
  const failed: string[] = [];
  if (m.meanR < g.minMeanR) failed.push("mean_r");
  if (!m.meanRCI || m.meanRCI.low <= 0) failed.push("ci_lower_bound");
  if (m.profitFactor == null || m.profitFactor < g.minPF) failed.push("profit_factor");
  if (m.maxDrawdownR > g.maxDD) failed.push("max_drawdown");
  if (stable !== true) failed.push("parameter_stability");
  return failed.length ? { status: "FAILED" as const, failed } : { status: "PASSED_SCREENING" as const, failed, note: "Preliminary screen only; requires forward demo testing and manual review." };
}

export function buildReport(input: { dataset: DatasetIdentity; codeVersion: string; configVersion: string; assumptions: string[]; generatedAt: string; oosR: number[]; stable: boolean | null; ambiguousShare: number }) {
  const elig = input.dataset.synthetic ? { status: "INSUFFICIENT_DATA" as const, failed: ["synthetic_data_not_allowed"] } : eligibility(input.oosR, input.stable);
  return { ...input, backtestVersion: BACKTEST_VERSION, sampleSize: input.oosR.length, metrics: metrics(input.oosR), eligibility: elig };
}
